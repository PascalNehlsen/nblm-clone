import "server-only";

import { validateCitations, type ValidCitation } from "@/lib/rag/citations";
import { ABSTENTION, buildChatInput } from "@/lib/rag/prompt";
import type { RetrievalResult } from "@/lib/rag/retrieve";
import { createMarkerFilter } from "@/lib/rag/stream-filter";
import { normalizeText } from "@/lib/server/ingest/normalize";
import type { ModelCallRequest, ModelCallResult } from "@/lib/server/model/call";

// One chat turn (block D, ADR 0011): retrieve, ask the model with the sources as delimited
// data, check every citation on the server, save question, answer and citations with the
// user's login, return the checked message. The streamed deltas hide citation markers; the
// final message replaces them. Logs carry counts only, never question, source or answer text.

export interface MessageStore {
  saveTurn(args: {
    notebookId: string;
    question: string;
    answerId: string;
    answer: string;
    citations: ValidCitation[];
  }): Promise<void>;
}

export interface TurnLogEvent {
  event: "chat_turn";
  outcome: "ok" | "failed";
  reason: string | null;
  chunks: number | null;
  citations: number | null;
  dropped: number | null;
  abstained: boolean | null;
  ms: number;
}

export interface TurnDeps {
  retrieve: (notebookId: string, question: string) => Promise<RetrievalResult>;
  callChat: (req: ModelCallRequest<"chat">) => Promise<ModelCallResult<"chat">>;
  store: MessageStore;
  log: (e: TurnLogEvent) => void;
  now: () => number;
  nonce: () => string;
  newId: () => string;
}

export interface TurnMessage {
  id: string;
  content: string;
  citations: ValidCitation[];
  abstained: boolean;
}

export type TurnResult = { ok: true; message: TurnMessage } | { ok: false; reason: string };

export async function runTurn(
  deps: TurnDeps,
  args: { notebookId: string; question: string; onDelta?: (text: string) => void },
): Promise<TurnResult> {
  const startedAt = deps.now();
  const stats = {
    chunks: null as number | null,
    citations: null as number | null,
    dropped: null as number | null,
    abstained: null as boolean | null,
  };
  const finish = (result: TurnResult): TurnResult => {
    deps.log({
      event: "chat_turn",
      outcome: result.ok ? "ok" : "failed",
      reason: result.ok ? null : result.reason,
      ...stats,
      ms: Math.max(0, Math.round(deps.now() - startedAt)),
    });
    return result;
  };

  const retrieval = await deps.retrieve(args.notebookId, args.question);
  if (!retrieval.ok) return finish({ ok: false, reason: retrieval.reason });
  const { chunks } = retrieval;
  stats.chunks = chunks.length;
  // The same normalized text retrieval checked: no NUL or control characters reach the model
  // or Postgres.
  const question = normalizeText(args.question).trim();

  // Nothing retrieved: the sources cannot answer, so no model call (and no cost).
  if (chunks.length === 0) {
    const id = deps.newId();
    try {
      await deps.store.saveTurn({ notebookId: args.notebookId, question, answerId: id, answer: ABSTENTION, citations: [] });
    } catch {
      return finish({ ok: false, reason: "db_failed" });
    }
    stats.citations = 0;
    stats.dropped = 0;
    stats.abstained = true;
    return finish({ ok: true, message: { id, content: ABSTENTION, citations: [], abstained: true } });
  }

  const filter = createMarkerFilter(args.onDelta ?? (() => undefined));
  let saved: TurnMessage | null = null;

  const result = await deps.callChat({
    kind: "chat",
    notebookId: args.notebookId,
    input: buildChatInput(question, chunks, deps.nonce()),
    onDelta: (text) => filter.push(text),
    linkMessage: async (output) => {
      const checked = validateCitations(output.text, chunks);
      // An answer without one valid citation is not grounded in the sources: abstain.
      const abstained = checked.citations.length === 0;
      const message: TurnMessage = {
        id: deps.newId(),
        content: abstained ? ABSTENTION : checked.text,
        citations: abstained ? [] : checked.citations,
        abstained,
      };
      await deps.store.saveTurn({
        notebookId: args.notebookId,
        question,
        answerId: message.id,
        answer: message.content,
        citations: message.citations,
      });
      stats.citations = message.citations.length;
      stats.dropped = checked.dropped;
      stats.abstained = abstained;
      saved = message;
      return message.id;
    },
  });

  if (!result.ok) return finish({ ok: false, reason: result.category });
  filter.end();
  if (!saved) return finish({ ok: false, reason: "message_link_failed" });
  return finish({ ok: true, message: saved });
}
