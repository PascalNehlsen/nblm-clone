// D2 chat turn (spec .git/D2-API-SPEC.md "Chat turn / turn.ts"). Everything is injected,
// so the cases use plain fakes. The fake chat caller imitates the model wrapper: it
// streams deltas, then runs linkMessage and maps a throw to message_link_failed.
import { describe, expect, it, vi } from "vitest";
import { ABSTENTION, UNGROUNDED } from "@/lib/chat/abstention";
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
    expect(r).toEqual({
      ok: true,
      message: { id: ANSWER_ID, content: ABSTENTION, citations: [], abstained: true, abstention: "no_sources" },
    });
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).toMatchObject({ outcome: "ok", chunks: 0, citations: 0, abstained: true, abstention: "no_sources" });
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
        abstention: null,
      },
    });
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).toMatchObject({
      outcome: "ok",
      reason: null,
      chunks: 2,
      citations: 1,
      dropped: 0,
      abstained: false,
      abstention: null,
    });
  });

  // Ungrounded answer (plan feat/notebook-layout, Part B, ADR 0026): the abstention sentence is
  // reserved for "the sources have no answer"; an answer the checks threw away gets its own
  // fixed sentence. These two cases changed from ABSTENTION to UNGROUNDED on purpose.
  it("markers that all fail the check (dropped) give the UNGROUNDED sentence, saved without citations", async () => {
    const h = harness({ chat: { kind: "ok", deltas: ['Erfunden [1: "gibt es nicht"] und [5: "x"].'] } });
    const r = await runTurn(h.deps, { notebookId: NOTEBOOK_ID, question: "Wo?" });
    expect(h.saveTurn).toHaveBeenCalledWith(
      expect.objectContaining({ answer: UNGROUNDED, citations: [], answerId: ANSWER_ID }),
    );
    expect(r).toEqual({
      ok: true,
      message: { id: ANSWER_ID, content: UNGROUNDED, citations: [], abstained: true, abstention: "dropped" },
    });
    expect(h.logs[0]).toMatchObject({ outcome: "ok", citations: 0, dropped: 2, abstained: true, abstention: "dropped" });
  });

  it("an answer without any marker gives the UNGROUNDED sentence (no_marker)", async () => {
    const h = harness({ chat: { kind: "ok", deltas: ["Freie Antwort ohne Beleg."] } });
    const r = await runTurn(h.deps, { notebookId: NOTEBOOK_ID, question: "Wo?" });
    expect(h.saveTurn).toHaveBeenCalledWith(expect.objectContaining({ answer: UNGROUNDED, citations: [] }));
    expect(r).toMatchObject({ ok: true, message: { content: UNGROUNDED, abstained: true, abstention: "no_marker" } });
    expect(h.logs[0]).toMatchObject({ outcome: "ok", citations: 0, dropped: 0, abstained: true, abstention: "no_marker" });
  });

  it("the model writing the abstention sentence itself stays the ABSTENTION (model)", async () => {
    const h = harness({ chat: { kind: "ok", deltas: [ABSTENTION] } });
    const r = await runTurn(h.deps, { notebookId: NOTEBOOK_ID, question: "Wo?" });
    expect(h.saveTurn).toHaveBeenCalledWith(expect.objectContaining({ answer: ABSTENTION, citations: [] }));
    expect(r).toMatchObject({ ok: true, message: { content: ABSTENTION, abstained: true, abstention: "model" } });
    expect(h.logs[0]).toMatchObject({ abstained: true, abstention: "model" });
  });

  it("the abstention sentence with extra text or odd whitespace still counts as model", async () => {
    const squashed = ABSTENTION.replace(/ /g, "  \n ");
    for (const text of [`Hinweis: ${ABSTENTION} Mehr weiß ich nicht.`, squashed, `  ${ABSTENTION}\n`]) {
      const h = harness({ chat: { kind: "ok", deltas: [text] } });
      const r = await runTurn(h.deps, { notebookId: NOTEBOOK_ID, question: "Wo?" });
      expect(h.saveTurn, text).toHaveBeenCalledWith(expect.objectContaining({ answer: ABSTENTION, citations: [] }));
      expect(r, text).toMatchObject({ ok: true, message: { content: ABSTENTION, abstained: true, abstention: "model" } });
    }
  });

  it("an empty answer (nothing after the echo strip) is model, not ungrounded", async () => {
    for (const deltas of [[""], ["   \n "]]) {
      const h = harness({ chat: { kind: "ok", deltas } });
      const r = await runTurn(h.deps, { notebookId: NOTEBOOK_ID, question: "Wo?" });
      expect(r).toMatchObject({ ok: true, message: { content: ABSTENTION, abstained: true, abstention: "model" } });
    }
  });

  it("the abstention sentence next to an invalid marker is model: the model abstained, nothing was dropped to hide", async () => {
    const h = harness({ chat: { kind: "ok", deltas: [`${ABSTENTION} [9: "x"]`] } });
    const r = await runTurn(h.deps, { notebookId: NOTEBOOK_ID, question: "Wo?" });
    expect(r).toMatchObject({ ok: true, message: { content: ABSTENTION, abstained: true, abstention: "model" } });
  });

  it("a valid citation gives a normal answer: abstention null and no fixed sentence stored", async () => {
    const h = harness({ chat: { kind: "ok", deltas: [`Sitz in Bonn [1: "sitzt in Bonn"].`] } });
    const r = await runTurn(h.deps, { notebookId: NOTEBOOK_ID, question: "Wo?" });
    expect(r).toMatchObject({ ok: true, message: { abstained: false, abstention: null } });
    expect(JSON.stringify(h.saveTurn.mock.calls)).not.toContain(UNGROUNDED);
  });

  it("UNGROUNDED and ABSTENTION are the two fixed German sentences", () => {
    expect(ABSTENTION).toBe("Dazu finde ich in den Quellen keine Antwort.");
    expect(UNGROUNDED).toBe("Ich konnte keine Antwort mit wörtlichen Zitaten aus den Quellen belegen.");
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

describe("runTurn: question normalization", () => {
  const DIRTY = "\u0000Wo sitzt\u0007 die Firma?\r\n";
  const CLEAN = "Wo sitzt die Firma?";

  it("zero-chunk path saves the normalized question", async () => {
    const h = harness({ retrieval: { ok: true, chunks: [], usageId: "u-r" } });
    await runTurn(h.deps, { notebookId: NOTEBOOK_ID, question: DIRTY });
    expect(h.saveTurn).toHaveBeenCalledWith(expect.objectContaining({ question: CLEAN }));
  });

  it("model path sends the normalized question to the model and saves it", async () => {
    const h = harness();
    await runTurn(h.deps, { notebookId: NOTEBOOK_ID, question: DIRTY });
    const content = h.requests[0]?.input.messages[0]?.content ?? "";
    expect(content).toContain(`<frage-0123456789abcdef>\n${CLEAN}\n</frage-0123456789abcdef>`);
    expect(content).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
    expect(h.saveTurn).toHaveBeenCalledWith(expect.objectContaining({ question: CLEAN }));
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
      // Extended for the fold fix: five drop-reason and folded counters were added.
      // Extended again for the echo fix (ADR 0018): echoStripped (a count) was added.
      // Extended for the ungrounded answer (ADR 0026): abstention (a fixed enum, no text) was added.
      expect(Object.keys(h.logs[0] ?? {}).sort()).toEqual(
        [
          "abstained",
          "abstention",
          "chunks",
          "citations",
          "citationsFolded",
          "dropped",
          "droppedMalformed",
          "droppedNotInChunk",
          "droppedOverLimit",
          "droppedUnknownChunk",
          "echoStripped",
          "event",
          "ms",
          "outcome",
          "reason",
        ].sort(),
      );
    }
  });

  it("the abstention log value is one of the fixed enum values, never text", async () => {
    const allowed = [null, "no_sources", "model", "no_marker", "dropped"];
    const scenarios: Harness[] = [
      harness(),
      harness({ retrieval: { ok: true, chunks: [], usageId: "u" } }),
      harness({ chat: { kind: "ok", deltas: ["Freie Antwort"] } }),
      harness({ chat: { kind: "ok", deltas: ['X [7: "y"]'] } }),
      harness({ chat: { kind: "ok", deltas: [ABSTENTION] } }),
      harness({ chat: { kind: "refused", category: "provider_error" } }),
      harness({ retrieval: { ok: false, reason: "not_found" } }),
    ];
    for (const h of scenarios) {
      await runTurn(h.deps, { notebookId: NOTEBOOK_ID, question: "Wo?" });
      expect(allowed).toContain(h.logs[0]?.abstention);
    }
  });

  it("abstention is null on failure paths", async () => {
    const failing: Harness[] = [
      harness({ retrieval: { ok: false, reason: "not_found" } }),
      harness({ chat: { kind: "refused", category: "budget_exceeded" } }),
      harness({ saveThrows: true }),
    ];
    for (const h of failing) {
      await runTurn(h.deps, { notebookId: NOTEBOOK_ID, question: "Wo?" });
      expect(h.logs[0]).toMatchObject({ outcome: "failed", abstention: null });
    }
  });

  it("the new counters are null on failure paths", async () => {
    const failing: Harness[] = [
      harness({ retrieval: { ok: false, reason: "not_found" } }),
      harness({ chat: { kind: "refused", category: "budget_exceeded" } }),
      harness({ saveThrows: true }),
    ];
    for (const h of failing) {
      await runTurn(h.deps, { notebookId: NOTEBOOK_ID, question: "Wo?" });
      expect(h.logs[0]).toMatchObject({
        outcome: "failed",
        droppedUnknownChunk: null,
        droppedNotInChunk: null,
        droppedMalformed: null,
        droppedOverLimit: null,
        citationsFolded: null,
      });
    }
  });

  it("the new counters are 0 on the no-chunks abstention path", async () => {
    const h = harness({ retrieval: { ok: true, chunks: [], usageId: "u-r" } });
    await runTurn(h.deps, { notebookId: NOTEBOOK_ID, question: "Wo?" });
    expect(h.logs[0]).toMatchObject({
      droppedUnknownChunk: 0,
      droppedNotInChunk: 0,
      droppedMalformed: 0,
      droppedOverLimit: 0,
      citationsFolded: 0,
    });
  });

  it("the new counters are 0 for an answer with one exact citation", async () => {
    const h = harness();
    await runTurn(h.deps, { notebookId: NOTEBOOK_ID, question: "Wo?" });
    expect(h.logs[0]).toMatchObject({
      droppedUnknownChunk: 0,
      droppedNotInChunk: 0,
      droppedMalformed: 0,
      droppedOverLimit: 0,
      citationsFolded: 0,
    });
  });

  it("the new counters carry the counts from the citation check", async () => {
    const answer = `${ANSWER_SENTINEL} [1: "sitzt in Bonn"] [9: "x"] [1: "gibt es nicht"] [2: "gibt es auch nicht"] [123: "Bonn"]`;
    const h = harness({ chat: { kind: "ok", deltas: [answer] } });
    await runTurn(h.deps, { notebookId: NOTEBOOK_ID, question: "Wo?" });
    expect(h.logs[0]).toMatchObject({
      citations: 1,
      dropped: 4,
      droppedUnknownChunk: 1,
      droppedNotInChunk: 2,
      droppedMalformed: 1,
      droppedOverLimit: 0,
      citationsFolded: 0,
    });
    expect(JSON.stringify(h.logs)).not.toContain(ANSWER_SENTINEL);
  });
});

describe("runTurn: echoed source blocks (ADR 0018)", () => {
  const ECHO_NONCE = "87619878ffa78538";
  const ECHO_CHUNKS = [
    chunk(1, "Entscheidend ist Konsistenz in deiner eigenen Methode, nicht Perfektion."),
    chunk(2, "Behandle jeden Level als Zone."),
  ];
  const ECHO_OUTPUT =
    `<quelle-${ECHO_NONCE} nr="1"> Entscheidend ist Konsistenz in deiner eigenen Methode, nicht Perfektion. </quelle-${ECHO_NONCE}> ` +
    `<quelle-${ECHO_NONCE} nr="2"> Behandle jeden Level als Zone. </quelle-${ECHO_NONCE}> ` +
    `Die Price Action funktioniert durch eine Top-Down-Methode [1: "Konsistenz in deiner eigenen Methode"].`;

  function echoHarness(text: string, chars = false): Harness & { nonceCalls: () => number } {
    const h = harness({
      retrieval: { ok: true, chunks: ECHO_CHUNKS, usageId: "u-r" },
      chat: { kind: "ok", deltas: chars ? text.split("") : [text] },
    });
    const nonce = vi.fn(() => ECHO_NONCE);
    h.deps.nonce = nonce;
    return Object.assign(h, { nonceCalls: () => nonce.mock.calls.length });
  }

  it("saves the answer without nonce or tags, with the valid citation renumbered", async () => {
    const h = echoHarness(ECHO_OUTPUT);
    const r = await runTurn(h.deps, { notebookId: NOTEBOOK_ID, question: "Wie?" });
    const answer = "Die Price Action funktioniert durch eine Top-Down-Methode [1].";
    const citations = [{ ordinal: 1, chunkId: "chunk-1", quote: "Konsistenz in deiner eigenen Methode" }];
    expect(h.saveTurn).toHaveBeenCalledWith(expect.objectContaining({ answer, citations }));
    expect(r).toEqual({ ok: true, message: { id: ANSWER_ID, content: answer, citations, abstained: false, abstention: null } });
    const saved = JSON.stringify(h.saveTurn.mock.calls);
    expect(saved).not.toContain(ECHO_NONCE);
    expect(saved).not.toContain("<quelle");
    expect(saved).not.toContain("nicht Perfektion");
  });

  it("asks for the nonce once per turn", async () => {
    const h = echoHarness(ECHO_OUTPUT);
    await runTurn(h.deps, { notebookId: NOTEBOOK_ID, question: "Wie?" });
    expect(h.nonceCalls()).toBe(1);
  });

  it("markers inside echoed blocks never count: only the marker after them is a citation", async () => {
    const text =
      `<quelle-${ECHO_NONCE} nr="1"> Text [1: "Konsistenz in deiner eigenen Methode"] </quelle-${ECHO_NONCE}> ` +
      `Antwort [2: "Behandle jeden Level"].`;
    const h = echoHarness(text);
    const r = await runTurn(h.deps, { notebookId: NOTEBOOK_ID, question: "Wie?" });
    expect(r).toMatchObject({
      ok: true,
      message: {
        content: "Antwort [1].",
        citations: [{ ordinal: 1, chunkId: "chunk-2", quote: "Behandle jeden Level" }],
        abstained: false,
      },
    });
  });

  it("only echoed blocks abstain with zero citations, even with valid markers inside the blocks", async () => {
    const text =
      `<quelle-${ECHO_NONCE} nr="1"> Entscheidend ist Konsistenz in deiner eigenen Methode, nicht Perfektion. ` +
      `[1: "Konsistenz in deiner eigenen Methode"] </quelle-${ECHO_NONCE}> ` +
      `<quelle-${ECHO_NONCE} nr="2"> Behandle jeden Level als Zone. [2: "Behandle jeden Level"] </quelle-${ECHO_NONCE}>`;
    const h = echoHarness(text);
    const r = await runTurn(h.deps, { notebookId: NOTEBOOK_ID, question: "Wie?" });
    expect(h.saveTurn).toHaveBeenCalledWith(expect.objectContaining({ answer: ABSTENTION, citations: [] }));
    expect(r).toEqual({
      ok: true,
      message: { id: ANSWER_ID, content: ABSTENTION, citations: [], abstained: true, abstention: "model" },
    });
    expect(h.logs[0]).toMatchObject({ outcome: "ok", citations: 0, abstained: true, abstention: "model" });
    expect(h.logs[0]?.echoStripped).toBeGreaterThanOrEqual(1);
  });

  it("an unclosed echoed block drops the rest, so a citation after it does not count", async () => {
    const text = `<quelle-${ECHO_NONCE} nr="1"> Text und Antwort [1: "Konsistenz in deiner eigenen Methode"].`;
    const h = echoHarness(text);
    const r = await runTurn(h.deps, { notebookId: NOTEBOOK_ID, question: "Wie?" });
    expect(r).toMatchObject({ ok: true, message: { content: ABSTENTION, citations: [], abstained: true, abstention: "model" } });
  });

  for (const chars of [false, true]) {
    it(`no streamed chunk contains the nonce, a tag or source text (${chars ? "one character" : "one"} delta)`, async () => {
      const h = echoHarness(ECHO_OUTPUT, chars);
      const seen: string[] = [];
      await runTurn(h.deps, { notebookId: NOTEBOOK_ID, question: "Wie?", onDelta: (t) => seen.push(t) });
      const streamed = seen.join("");
      expect(streamed).toContain("Die Price Action funktioniert durch eine Top-Down-Methode");
      expect(streamed).not.toContain("[1");
      expect(streamed).not.toContain("nicht Perfektion");
      expect(streamed).not.toContain("Zone");
      for (const s of [streamed, ...seen]) {
        expect(s.toLowerCase()).not.toContain(ECHO_NONCE);
        expect(s.toLowerCase()).not.toContain("<quelle");
      }
    });
  }

  it("nothing is streamed for an echo-only output", async () => {
    const h = echoHarness(`<quelle-${ECHO_NONCE} nr="1"> Entscheidend ist Konsistenz </quelle-${ECHO_NONCE}>`, true);
    const seen: string[] = [];
    await runTurn(h.deps, { notebookId: NOTEBOOK_ID, question: "Wie?", onDelta: (t) => seen.push(t) });
    expect(seen.join("").trim()).toBe("");
  });

  it("the log counts what was stripped and holds no nonce or text", async () => {
    const h = echoHarness(ECHO_OUTPUT);
    await runTurn(h.deps, { notebookId: NOTEBOOK_ID, question: QUESTION_SENTINEL });
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]?.echoStripped).toBeGreaterThanOrEqual(1);
    expect(typeof h.logs[0]?.echoStripped).toBe("number");
    const text = JSON.stringify(h.logs);
    expect(text).not.toContain(ECHO_NONCE);
    expect(text).not.toContain("Perfektion");
    expect(text).not.toContain("Price Action");
  });

  it("echoStripped is 0 for a clean answer, 0 on the no-chunks path, null on failure paths", async () => {
    const clean = harness();
    await runTurn(clean.deps, { notebookId: NOTEBOOK_ID, question: "Wo?" });
    expect(clean.logs[0]?.echoStripped).toBe(0);

    const none = harness({ retrieval: { ok: true, chunks: [], usageId: "u-r" } });
    await runTurn(none.deps, { notebookId: NOTEBOOK_ID, question: "Wo?" });
    expect(none.logs[0]?.echoStripped).toBe(0);

    const failing: Harness[] = [
      harness({ retrieval: { ok: false, reason: "not_found" } }),
      harness({ chat: { kind: "refused", category: "budget_exceeded" } }),
      harness({ saveThrows: true }),
    ];
    for (const h of failing) {
      await runTurn(h.deps, { notebookId: NOTEBOOK_ID, question: "Wo?" });
      expect(h.logs[0]).toMatchObject({ outcome: "failed", echoStripped: null });
    }
  });
});

describe("runTurn: <antwort> wrapper", () => {
  const WRAPPED = '<antwort>Text in Bonn [1: "sitzt in Bonn"].</antwort>';

  for (const chars of [false, true]) {
    it(`stores no tag, the citation validates, no streamed delta has the tag (${chars ? "one character" : "one"} delta)`, async () => {
      const h = harness({ chat: { kind: "ok", deltas: chars ? WRAPPED.split("") : [WRAPPED] } });
      const seen: string[] = [];
      const r = await runTurn(h.deps, { notebookId: NOTEBOOK_ID, question: "Wo?", onDelta: (t) => seen.push(t) });
      const citations = [{ ordinal: 1, chunkId: "chunk-1", quote: "sitzt in Bonn" }];
      expect(h.saveTurn).toHaveBeenCalledWith(
        expect.objectContaining({ answer: "Text in Bonn [1].", citations }),
      );
      expect(r).toEqual({
        ok: true,
        message: { id: ANSWER_ID, content: "Text in Bonn [1].", citations, abstained: false, abstention: null },
      });
      expect(JSON.stringify(h.saveTurn.mock.calls).toLowerCase()).not.toContain("antwort>");
      const streamed = seen.join("");
      expect(streamed.toLowerCase()).not.toContain("<antwort");
      expect(streamed.toLowerCase()).not.toContain("</antwort");
      expect(streamed).toContain("Text in Bonn");
      for (const s of seen) expect(s.toLowerCase()).not.toContain("<antw");
      expect(h.logs[0]).toMatchObject({ outcome: "ok", citations: 1, abstained: false });
    });
  }
});

describe("runTurn: folded citations", () => {
  const SS = String.fromCodePoint(0xdf);
  const FOLD_CHUNKS = [chunk(1, `${CHUNK_SENTINEL} Er sagte, da${SS} er morgen kommt.`)];

  it("a folded match does not abstain and is saved with the original chunk span", async () => {
    const h = harness({
      retrieval: { ok: true, chunks: FOLD_CHUNKS, usageId: "u-r" },
      chat: { kind: "ok", deltas: [`${ANSWER_SENTINEL} Er kommt [1: "dass er morgen"].`] },
    });
    const r = await runTurn(h.deps, { notebookId: NOTEBOOK_ID, question: QUESTION_SENTINEL });
    const quote = `da${SS} er morgen`;
    expect(h.saveTurn).toHaveBeenCalledWith({
      notebookId: NOTEBOOK_ID,
      question: QUESTION_SENTINEL,
      answerId: ANSWER_ID,
      answer: `${ANSWER_SENTINEL} Er kommt [1].`,
      citations: [{ ordinal: 1, chunkId: "chunk-1", quote }],
    });
    expect(r).toMatchObject({ ok: true, message: { abstained: false, citations: [{ quote }] } });
    expect(h.logs[0]).toMatchObject({ outcome: "ok", citations: 1, dropped: 0, abstained: false, citationsFolded: 1 });
    const text = JSON.stringify(h.logs);
    expect(text).not.toContain(ANSWER_SENTINEL);
    expect(text).not.toContain(CHUNK_SENTINEL);
    expect(text).not.toContain(QUESTION_SENTINEL);
  });
});
