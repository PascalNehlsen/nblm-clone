// D2 chat turn (spec .git/D2-API-SPEC.md "Chat turn / turn.ts"). Everything is injected,
// so the cases use plain fakes. The fake chat caller imitates the model wrapper: it
// streams deltas, then runs linkMessage and maps a throw to message_link_failed.
import { describe, expect, it, vi } from "vitest";
import { ABSTENTION } from "@/lib/rag/prompt";
import type { RetrievalResult, RetrievedChunk } from "@/lib/rag/retrieve";
import { runTurn, type MessageStore, type TurnDeps, type TurnLogEvent } from "@/lib/server/chat/turn";
import type { ModelCallRequest, ModelCallResult } from "@/lib/server/model/call";

const NOTEBOOK_ID = "11111111-1111-4111-8111-111111111111";
const ANSWER_ID = "22222222-2222-4222-8222-222222222222";
const QUESTION_SENTINEL = "QSENTINEL-frage-9183";
const CHUNK_SENTINEL = "CSENTINEL-inhalt-4471";
const ANSWER_SENTINEL = "ASENTINEL-antwort-6620";

function chunk(n: number, content: string): RetrievedChunk {
  return { id: `chunk-${n}`, sourceId: `source-${n}`, ordinal: n, page: null, content, score: 0.9 };
}

const CHUNKS = [chunk(1, `${CHUNK_SENTINEL} Die Fiktiva GmbH sitzt in Bonn.`), chunk(2, "Der Kaffee schmeckt nach Nuss.")];

type ChatBehaviour =
  | { kind: "ok"; deltas: string[]; text?: string }
  | { kind: "refused"; category: "budget_exceeded" | "provider_error" | "kill_switch_on" };

interface Harness {
  deps: TurnDeps;
  saveTurn: ReturnType<typeof vi.fn>;
  callChat: ReturnType<typeof vi.fn>;
  retrieve: ReturnType<typeof vi.fn>;
  logs: TurnLogEvent[];
  requests: ModelCallRequest<"chat">[];
}

function harness(opts: {
  retrieval?: RetrievalResult;
  chat?: ChatBehaviour;
  saveThrows?: boolean;
} = {}): Harness {
  const logs: TurnLogEvent[] = [];
  const requests: ModelCallRequest<"chat">[] = [];
  const behaviour: ChatBehaviour = opts.chat ?? {
    kind: "ok",
    deltas: [`${ANSWER_SENTINEL} in Bonn [1: "sitzt in Bonn"].`],
  };
  const saveTurn = vi.fn(async () => {
    if (opts.saveThrows) throw new Error("db down");
  });
  const retrieve = vi.fn(async (): Promise<RetrievalResult> => opts.retrieval ?? { ok: true, chunks: CHUNKS, usageId: "u-r" });
  const callChat = vi.fn(async (req: ModelCallRequest<"chat">): Promise<ModelCallResult<"chat">> => {
    requests.push(req);
    if (behaviour.kind === "refused") return { ok: false, category: behaviour.category, usageId: null };
    for (const d of behaviour.deltas) req.onDelta?.(d);
    const text = behaviour.text ?? behaviour.deltas.join("");
    try {
      const id = await req.linkMessage?.({ text });
      void id;
    } catch {
      return { ok: false, category: "message_link_failed", usageId: "u-1" };
    }
    return { ok: true, output: { text }, usageId: "u-1", inputTokens: 10, outputTokens: 5, costUsd: 0.001, latencyMs: 3, settled: true };
  });
  const store: MessageStore = { saveTurn };
  const deps: TurnDeps = {
    retrieve,
    callChat,
    store,
    log: (e) => logs.push(e),
    now: () => 1000,
    nonce: () => "0123456789abcdef",
    newId: () => ANSWER_ID,
  };
  return { deps, saveTurn, callChat, retrieve, logs, requests };
}

describe("runTurn: retrieval", () => {
  it("passes a retrieval failure reason through, no model call, nothing saved", async () => {
    const h = harness({ retrieval: { ok: false, reason: "not_found" } });
    const r = await runTurn(h.deps, { notebookId: NOTEBOOK_ID, question: "Frage?" });
    expect(r).toEqual({ ok: false, reason: "not_found" });
    expect(h.callChat).not.toHaveBeenCalled();
    expect(h.saveTurn).not.toHaveBeenCalled();
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).toMatchObject({ event: "chat_turn", outcome: "failed", reason: "not_found" });
  });

  it("calls retrieve with the notebook id and the question", async () => {
    const h = harness();
    await runTurn(h.deps, { notebookId: NOTEBOOK_ID, question: "Frage?" });
    expect(h.retrieve).toHaveBeenCalledWith(NOTEBOOK_ID, "Frage?");
  });
});

describe("runTurn: zero chunks", () => {
  it("saves the abstention without a model call", async () => {
    const h = harness({ retrieval: { ok: true, chunks: [], usageId: "u-r" } });
    const r = await runTurn(h.deps, { notebookId: NOTEBOOK_ID, question: " Frage? " });
    expect(h.callChat).not.toHaveBeenCalled();
    expect(h.saveTurn).toHaveBeenCalledTimes(1);
    expect(h.saveTurn).toHaveBeenCalledWith(
      expect.objectContaining({ notebookId: NOTEBOOK_ID, answer: ABSTENTION, citations: [], answerId: ANSWER_ID }),
    );
    expect(r).toEqual({ ok: true, message: { id: ANSWER_ID, content: ABSTENTION, citations: [], abstained: true } });
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).toMatchObject({ outcome: "ok", chunks: 0, citations: 0, abstained: true });
  });

  it("saveTurn throwing gives db_failed", async () => {
    const h = harness({ retrieval: { ok: true, chunks: [], usageId: "u-r" }, saveThrows: true });
    const r = await runTurn(h.deps, { notebookId: NOTEBOOK_ID, question: "Frage?" });
    expect(r).toEqual({ ok: false, reason: "db_failed" });
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).toMatchObject({ outcome: "failed", reason: "db_failed" });
  });
});

describe("runTurn: model call", () => {
  it("builds the chat request from the trimmed question, with onDelta and linkMessage, nothing else", async () => {
    const h = harness();
    await runTurn(h.deps, { notebookId: NOTEBOOK_ID, question: "  Wo sitzt die Firma?  " });
    const req = h.requests[0];
    expect(req?.kind).toBe("chat");
    expect(req?.notebookId).toBe(NOTEBOOK_ID);
    expect(typeof req?.onDelta).toBe("function");
    expect(typeof req?.linkMessage).toBe("function");
    expect(req?.input.messages).toHaveLength(1);
    const content = req?.input.messages[0]?.content ?? "";
    expect(content).toContain("<quelle-0123456789abcdef nr=\"1\">");
    expect(content).toContain("<frage-0123456789abcdef>\nWo sitzt die Firma?\n</frage-0123456789abcdef>");
    expect(Object.keys(req ?? {}).sort()).toEqual(["input", "kind", "linkMessage", "notebookId", "onDelta"]);
  });

  it("success saves question, validated answer and citations; the message carries the saved id", async () => {
    const h = harness();
    const r = await runTurn(h.deps, { notebookId: NOTEBOOK_ID, question: "Wo?" });
    expect(h.saveTurn).toHaveBeenCalledTimes(1);
    expect(h.saveTurn).toHaveBeenCalledWith({
      notebookId: NOTEBOOK_ID,
      question: "Wo?",
      answerId: ANSWER_ID,
      answer: `${ANSWER_SENTINEL} in Bonn [1].`,
      citations: [{ ordinal: 1, chunkId: "chunk-1", quote: "sitzt in Bonn" }],
    });
    expect(r).toEqual({
      ok: true,
      message: {
        id: ANSWER_ID,
        content: `${ANSWER_SENTINEL} in Bonn [1].`,
        citations: [{ ordinal: 1, chunkId: "chunk-1", quote: "sitzt in Bonn" }],
        abstained: false,
      },
    });
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).toMatchObject({ outcome: "ok", reason: null, chunks: 2, citations: 1, dropped: 0, abstained: false });
  });

  it("0 valid citations gives the abstention, saved without citations", async () => {
    const h = harness({ chat: { kind: "ok", deltas: ['Erfunden [1: "gibt es nicht"] und [5: "x"].'] } });
    const r = await runTurn(h.deps, { notebookId: NOTEBOOK_ID, question: "Wo?" });
    expect(h.saveTurn).toHaveBeenCalledWith(
      expect.objectContaining({ answer: ABSTENTION, citations: [], answerId: ANSWER_ID }),
    );
    expect(r).toEqual({ ok: true, message: { id: ANSWER_ID, content: ABSTENTION, citations: [], abstained: true } });
    expect(h.logs[0]).toMatchObject({ outcome: "ok", citations: 0, dropped: 2, abstained: true });
  });

  it("an answer without any marker also gives the abstention", async () => {
    const h = harness({ chat: { kind: "ok", deltas: ["Freie Antwort ohne Beleg."] } });
    const r = await runTurn(h.deps, { notebookId: NOTEBOOK_ID, question: "Wo?" });
    expect(r).toMatchObject({ ok: true, message: { content: ABSTENTION, abstained: true } });
  });

  it("a refused budget saves nothing and returns the category", async () => {
    const h = harness({ chat: { kind: "refused", category: "budget_exceeded" } });
    const r = await runTurn(h.deps, { notebookId: NOTEBOOK_ID, question: "Wo?" });
    expect(r).toEqual({ ok: false, reason: "budget_exceeded" });
    expect(h.saveTurn).not.toHaveBeenCalled();
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).toMatchObject({ outcome: "failed", reason: "budget_exceeded" });
  });

  it("saveTurn throwing inside linkMessage gives message_link_failed", async () => {
    const h = harness({ saveThrows: true });
    const r = await runTurn(h.deps, { notebookId: NOTEBOOK_ID, question: "Wo?" });
    expect(r).toEqual({ ok: false, reason: "message_link_failed" });
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).toMatchObject({ outcome: "failed", reason: "message_link_failed" });
  });

  it("onDelta receives filtered deltas only: markers never reach it, even when split", async () => {
    const answer = 'Sitz in Bonn [1: "sitzt in Bonn"] ok.';
    const h = harness({ chat: { kind: "ok", deltas: answer.split("") } });
    const seen: string[] = [];
    await runTurn(h.deps, { notebookId: NOTEBOOK_ID, question: "Wo?", onDelta: (t) => seen.push(t) });
    const streamed = seen.join("");
    expect(streamed).toBe("Sitz in Bonn  ok.");
    expect(streamed).not.toContain("[1");
    expect(streamed).not.toContain("sitzt in Bonn");
  });

  it("works without an onDelta callback", async () => {
    const h = harness();
    const r = await runTurn(h.deps, { notebookId: NOTEBOOK_ID, question: "Wo?" });
    expect(r.ok).toBe(true);
  });
});

describe("runTurn: logs", () => {
  it("contain counts only, never question, chunk or answer text", async () => {
    const scenarios: Harness[] = [
      harness(),
      harness({ retrieval: { ok: true, chunks: [], usageId: "u" } }),
      harness({ chat: { kind: "refused", category: "provider_error" } }),
      harness({ saveThrows: true }),
      harness({ chat: { kind: "ok", deltas: [`${ANSWER_SENTINEL} ohne Beleg`] } }),
    ];
    for (const h of scenarios) {
      await runTurn(h.deps, { notebookId: NOTEBOOK_ID, question: QUESTION_SENTINEL });
      expect(h.logs).toHaveLength(1);
      const text = JSON.stringify(h.logs);
      expect(text).not.toContain(QUESTION_SENTINEL);
      expect(text).not.toContain(CHUNK_SENTINEL);
      expect(text).not.toContain(ANSWER_SENTINEL);
      expect(Object.keys(h.logs[0] ?? {}).sort()).toEqual(
        ["abstained", "chunks", "citations", "dropped", "event", "ms", "outcome", "reason"].sort(),
      );
    }
  });
});
