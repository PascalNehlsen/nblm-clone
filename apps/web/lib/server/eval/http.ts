import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";
import { EVAL_CASES } from "./corpus";
import type { EvalResult } from "./run";

// The eval route's logic (ADR 0017), the canary's pattern (ADR 0014): off (404) unless
// configured, POST only, a secret header compared in constant time, no request body read,
// booleans out.

function sameSecret(given: string, expected: string): boolean {
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

function empty(status: number): Response {
  return new Response(null, { status, headers: { "cache-control": "no-store" } });
}

function allIds(): string[] {
  return [...EVAL_CASES.facts, ...EVAL_CASES.abstention, ...EVAL_CASES.security].map((c) => c.id);
}

export async function handleEvalRequest(
  request: Request,
  deps: { secret: string | undefined; run: () => Promise<EvalResult> | null },
): Promise<Response> {
  const secret = deps.secret?.trim() ?? "";
  if (secret === "") return empty(404);
  if (request.method !== "POST") return empty(405);
  if (!sameSecret(request.headers.get("x-eval-secret") ?? "", secret)) return empty(401);
  let running: Promise<EvalResult> | null;
  try {
    running = deps.run();
  } catch {
    running = Promise.reject(new Error("eval run failed to start"));
  }
  if (running === null) return empty(404);
  let result: EvalResult;
  try {
    result = await running;
  } catch {
    // A deterministic failure must not look like a server error the script would retry.
    const ids = allIds();
    result = { cases: Object.fromEntries(ids.map((id) => [id, false])), errored: ids.length };
  }
  const cases: Record<string, boolean> = {};
  for (const [id, passed] of Object.entries(result.cases)) cases[id] = passed === true;
  return Response.json({ cases, errored: result.errored }, { status: 200, headers: { "cache-control": "no-store" } });
}
