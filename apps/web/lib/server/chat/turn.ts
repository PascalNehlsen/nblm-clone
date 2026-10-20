import "server-only";

import { validateCitations, type ValidCitation } from "@/lib/rag/citations";
import { buildChatInput } from "@/lib/rag/prompt";
import { ABSTENTION, UNGROUNDED, type Abstention } from "@/lib/chat/abstention";
import type { RetrievalResult } from "@/lib/rag/retrieve";
import { createMarkerFilter } from "@/lib/rag/stream-filter";
import { stripEcho } from "@/lib/rag/echo";
import { createEchoFilter } from "@/lib/rag/echo-filter";
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
  // Why the answer was replaced by a fixed sentence (ADR 0026); an enum, never text.
  abstention: Abstention;
  // Why citations were dropped, and how many needed folding (ADR 0016). Counts only.
  droppedUnknownChunk: number | null;
  droppedNotInChunk: number | null;
  droppedMalformed: number | null;
  droppedOverLimit: number | null;
  citationsFolded: number | null;
  // Echoed prompt blocks, stray tags and nonce occurrences removed from the answer (ADR 0018).
  echoStripped: number | null;
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
  abstention: Abstention;
}

export type TurnResult = { ok: true; message: TurnMessage } | { ok: false; reason: string };

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

function classify(text: string, valid: number, dropped: number): Abstention {
  if (valid > 0) return null;
  const answer = squash(text);
  if (answer === "" || answer.includes(ABSTENTION)) return "model";
  return dropped === 0 ? "no_marker" : "dropped";
}

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
    abstention: null as Abstention,
    droppedUnknownChunk: null as number | null,
    droppedNotInChunk: null as number | null,
    droppedMalformed: null as number | null,
    droppedOverLimit: null as number | null,
    citationsFolded: null as number | null,
    echoStripped: null as number | null,
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
    stats.abstention = "no_sources";
    stats.droppedUnknownChunk = 0;
    stats.droppedNotInChunk = 0;
    stats.droppedMalformed = 0;
    stats.droppedOverLimit = 0;
    stats.citationsFolded = 0;
    stats.echoStripped = 0;
    return finish({ ok: true, message: { id, content: ABSTENTION, citations: [], abstained: true, abstention: "no_sources" } });
  }

  // One nonce per turn: it delimits the blocks in the prompt and is stripped from the answer.
  const nonce = deps.nonce();
  const markers = createMarkerFilter(args.onDelta ?? (() => undefined));
  const filter = createEchoFilter(nonce, (text) => markers.push(text));
  let saved: TurnMessage | null = null;

  const result = await deps.callChat({
    kind: "chat",
    notebookId: args.notebookId,
    input: buildChatInput(question, chunks, nonce),
    onDelta: (text) => filter.push(text),
    linkMessage: async (output) => {
      // Echoed source blocks go first, so markers inside them never count as citations.
      const echo = stripEcho(output.text, nonce);
      const checked = validateCitations(echo.text, chunks);
      // An answer without one valid citation is not grounded in the sources. It is replaced by
      // a fixed sentence: the abstention when the model abstained itself, otherwise the notice
      // that the answer could not be backed by quotes (ADR 0026).
      const abstention = classify(echo.text, checked.citations.length, checked.dropped);
      const abstained = abstention !== null;
      const message: TurnMessage = {
        id: deps.newId(),
        content: abstention === null ? checked.text : abstention === "model" ? ABSTENTION : UNGROUNDED,
        citations: abstained ? [] : checked.citations,
        abstained,
        abstention,
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
      stats.abstention = abstention;
      stats.droppedUnknownChunk = checked.droppedBy.unknown_chunk;
      stats.droppedNotInChunk = checked.droppedBy.not_in_chunk;
      stats.droppedMalformed = checked.droppedBy.malformed;
      stats.droppedOverLimit = checked.droppedBy.over_limit;
      stats.citationsFolded = checked.folded;
      stats.echoStripped = echo.stripped;
      saved = message;
      return message.id;
    },
  });

  if (!result.ok) return finish({ ok: false, reason: result.category });
  filter.end();
  markers.end();
  if (!saved) return finish({ ok: false, reason: "message_link_failed" });
  return finish({ ok: true, message: saved });
}
