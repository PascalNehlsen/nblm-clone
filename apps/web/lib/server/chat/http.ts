import "server-only";

import { isUuid } from "@/lib/notebooks/roles";
import { CATEGORY_LABELS } from "@/lib/ops/categories";
import type { TurnResult } from "./turn";

// The HTTP side of a chat turn (block D). A route handler gets no Server Action origin
// check, so this one checks the origin itself (CSRF). The body carries the question only:
// model, prompt, temperature and history never come from the client (AGENTS.md). The answer
// streams as NDJSON: delta lines, then one done or one error line.

export const MAX_BODY_BYTES = 16 * 1024;

export interface ChatHttpDeps {
  getUserId: () => Promise<string | null>;
  runTurn: (args: { notebookId: string; question: string; onDelta: (text: string) => void }) => Promise<TurnResult>;
}

const GENERIC = "Das hat nicht geklappt. Bitte versuche es noch einmal.";
const LABELS: Readonly<Record<string, string>> = {
  ...CATEGORY_LABELS,
  invalid_input: "Bitte stelle eine Frage mit 1 bis 2.000 Zeichen.",
  not_found: "Notizbuch nicht gefunden.",
};

export function reasonLabel(reason: string): string {
  return Object.hasOwn(LABELS, reason) ? LABELS[reason]! : GENERIC;
}

function status(code: number): Response {
  return new Response(null, { status: code, headers: { "cache-control": "no-store" } });
}

// The origin this request was sent to, as the browser saw it: behind a proxy (Vercel) from
// x-forwarded-host and x-forwarded-proto, else from the Host header. request.url can name an
// internal host (next start binds 127.0.0.1 but reports localhost), so it is the last resort.
function expectedOrigin(request: Request): string {
  const url = new URL(request.url);
  const first = (value: string | null) => value?.split(",")[0]?.trim() || null;
  const host = first(request.headers.get("x-forwarded-host")) ?? first(request.headers.get("host")) ?? url.host;
  const proto = first(request.headers.get("x-forwarded-proto")) ?? url.protocol.replace(/:$/, "");
  return `${proto}://${host}`;
}

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin || origin !== expectedOrigin(request)) return false;
  const site = request.headers.get("sec-fetch-site");
  return site === null || site === "same-origin";
}

// Reads at most MAX_BODY_BYTES bytes; null when the body is larger.
async function readBody(request: Request): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    parts.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function questionOf(body: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const question = (parsed as Record<string, unknown>).question;
  return typeof question === "string" ? question : null;
}

export async function handleChatRequest(request: Request, notebookId: string, deps: ChatHttpDeps): Promise<Response> {
  if (request.method !== "POST") return status(405);
  if (!sameOrigin(request)) return status(403);
  const type = request.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith("application/json")) return status(415);
  const length = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) return status(413);
  const body = await readBody(request);
  if (body === null) return status(413);
  const question = questionOf(body);
  if (question === null) return status(400);
  if (!isUuid(notebookId)) return status(404);
  if (!(await deps.getUserId())) return status(401);

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // After a client disconnect the stream is closed and enqueue throws. The turn still
      // runs to the end and is saved (plan decision), so writing never throws into it.
      let open = true;
      const write = (line: unknown) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
        } catch {
          open = false;
        }
      };
      try {
        const result = await deps.runTurn({ notebookId, question, onDelta: (text) => write({ type: "delta", text }) });
        write(result.ok ? { type: "done", message: result.message } : { type: "error", label: reasonLabel(result.reason) });
      } catch {
        write({ type: "error", label: GENERIC });
      } finally {
        if (open) {
          try {
            controller.close();
          } catch {
            // already closed by a disconnect
          }
        }
      }
    },
    cancel() {
      // The client went away; the turn keeps running and is saved.
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" },
  });
}
