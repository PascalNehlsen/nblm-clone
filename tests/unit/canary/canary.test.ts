// R2 release canary (spec .git/R2-SPEC.md "canary.ts"). runCanary is pure over injected deps,
// so the cases use plain fakes. The fake chat caller imitates the model wrapper: it streams the
// answer, then runs linkMessage and maps a throw to message_link_failed (same as turn.test.ts).
import { describe, expect, it, vi } from "vitest";
import { runCanary, type CanaryDeps } from "@/lib/server/canary/canary";
import { CANARY_CHUNKS, CANARY_QUESTION } from "@/lib/server/canary/fixture";
import type { ModelCallRequest, ModelCallResult } from "@/lib/server/model/call";

const ANSWER_SENTINEL = "ASENTINEL-antwort-6620";

type CanaryLog = Parameters<CanaryDeps["log"]>[0];

function vector(dim = 1024): number[] {
  return Array.from({ length: dim }, (_, i) => (i % 7) / 10);
}

// A quote that is a real substring of canary chunk 1.
function quoteOfChunk1(): string {
  return (CANARY_CHUNKS[0]?.content ?? "").split(/\s+/).slice(0, 3).join(" ");
}

type EmbedBehaviour =
  | { kind: "ok"; vectors: number[][] }
  | { kind: "refused"; category: "budget_exceeded" | "provider_error" | "kill_switch_on" };

type ChatBehaviour =
  | { kind: "ok"; text: string }
  | { kind: "refused"; category: "budget_exceeded" | "provider_error" | "kill_switch_on" };

function harness(opts: { embed?: EmbedBehaviour; chat?: ChatBehaviour } = {}) {
  const logs: CanaryLog[] = [];
  const embedBehaviour: EmbedBehaviour = opts.embed ?? { kind: "ok", vectors: [vector()] };
  const chatBehaviour: ChatBehaviour = opts.chat ?? {
    kind: "ok",
    text: `${ANSWER_SENTINEL} laut Quelle [1: "${quoteOfChunk1()}"].`,
  };
  const embed = vi.fn<CanaryDeps["embed"]>(async (): Promise<ModelCallResult<"embedding">> => {
    if (embedBehaviour.kind === "refused") return { ok: false, category: embedBehaviour.category, usageId: null };
    return {
      ok: true,
      output: { vectors: embedBehaviour.vectors },
      usageId: "u-e",
      inputTokens: 5,
      outputTokens: 0,
      costUsd: 0,
      latencyMs: 2,
      settled: true,
    };
  });
  const callChat = vi.fn(async (req: ModelCallRequest<"chat">): Promise<ModelCallResult<"chat">> => {
    if (chatBehaviour.kind === "refused") return { ok: false, category: chatBehaviour.category, usageId: null };
    req.onDelta?.(chatBehaviour.text);
    try {
      await req.linkMessage?.({ text: chatBehaviour.text });
    } catch {
      return { ok: false, category: "message_link_failed", usageId: "u-c" };
    }
    return {
      ok: true,
      output: { text: chatBehaviour.text },
      usageId: "u-c",
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.001,
      latencyMs: 3,
      settled: true,
    };
  });
  const deps: CanaryDeps = { embed, callChat, log: (e) => logs.push(e), now: () => 1000 };
  return { deps, embed, callChat, logs };
}

describe("runCanary: happy path", () => {
  it("is ok with all four checks true", async () => {
    const h = harness();
    const r = await runCanary(h.deps);
    expect(r).toEqual({
      ok: true,
      checks: { embedding: true, answered: true, citationValid: true, notAbstained: true },
    });
  });

  it("embeds exactly the fixed question, without a notebook", async () => {
    const h = harness();
    await runCanary(h.deps);
    expect(h.embed).toHaveBeenCalledTimes(1);
    expect(h.embed).toHaveBeenCalledWith({
      kind: "embedding",
      notebookId: null,
      input: { texts: [CANARY_QUESTION] },
    });
  });

  it("asks the model once with the fixed passage as data and no stored notebook", async () => {
    const h = harness();
    await runCanary(h.deps);
    expect(h.callChat).toHaveBeenCalledTimes(1);
    const req = h.callChat.mock.calls[0]?.[0];
    expect(req?.kind).toBe("chat");
    expect(req?.notebookId).toBe("00000000-0000-0000-0000-000000000000");
    const content = req?.input.messages[0]?.content ?? "";
    expect(content).toContain(CANARY_QUESTION);
    expect(content).toContain(CANARY_CHUNKS[0]?.content ?? "missing");
  });
});

describe("runCanary: fixture", () => {
  it("has one or two short German chunks with fixed ids, page null and score 1", () => {
    expect(CANARY_CHUNKS.length).toBeGreaterThanOrEqual(1);
    expect(CANARY_CHUNKS.length).toBeLessThanOrEqual(2);
    CANARY_CHUNKS.forEach((c, i) => {
      expect(c.id).toBe(`canary-${i + 1}`);
      expect(c.page).toBeNull();
      expect(c.score).toBe(1);
      expect(c.content.length).toBeGreaterThan(0);
      expect(c.content.length).toBeLessThan(600);
    });
    expect(CANARY_QUESTION.trim().length).toBeGreaterThan(0);
  });
});

describe("runCanary: embedding", () => {
  it("a refused embedding skips the chat call and fails every check", async () => {
    const h = harness({ embed: { kind: "refused", category: "provider_error" } });
    const r = await runCanary(h.deps);
    expect(h.callChat).not.toHaveBeenCalled();
    expect(r).toEqual({
      ok: false,
      checks: { embedding: false, answered: false, citationValid: false, notAbstained: false },
    });
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).toMatchObject({ event: "canary", ok: false, reason: "provider_error" });
  });

  it("the kill switch on the embedding gives ok false without a chat call", async () => {
    const h = harness({ embed: { kind: "refused", category: "kill_switch_on" } });
    const r = await runCanary(h.deps);
    expect(r.ok).toBe(false);
    expect(h.callChat).not.toHaveBeenCalled();
    expect(h.logs[0]).toMatchObject({ reason: "kill_switch_on" });
  });

  const badVectors: Array<[string, number[][]]> = [
    ["wrong dimension", [vector(1023)]],
    ["no vector", []],
    ["two vectors", [vector(), vector()]],
    ["a NaN entry", [[...vector().slice(0, 1023), Number.NaN]]],
    ["an Infinity entry", [[...vector().slice(0, 1023), Number.POSITIVE_INFINITY]]],
  ];
  for (const [name, vectors] of badVectors) {
    it(`${name} fails the embedding check with reason invalid_vector and skips chat`, async () => {
      const h = harness({ embed: { kind: "ok", vectors } });
      const r = await runCanary(h.deps);
      expect(r.ok).toBe(false);
      expect(r.checks.embedding).toBe(false);
      expect(h.callChat).not.toHaveBeenCalled();
      expect(h.logs[0]).toMatchObject({ reason: "invalid_vector" });
    });
  }
});

describe("runCanary: chat", () => {
  it("the kill switch on the chat call gives ok false, embedding stays true", async () => {
    const h = harness({ chat: { kind: "refused", category: "kill_switch_on" } });
    const r = await runCanary(h.deps);
    expect(r).toEqual({
      ok: false,
      checks: { embedding: true, answered: false, citationValid: false, notAbstained: false },
    });
    expect(h.logs[0]).toMatchObject({ ok: false, reason: "kill_switch_on" });
  });

  it("a refused budget gives answered false with the category as reason", async () => {
    const h = harness({ chat: { kind: "refused", category: "budget_exceeded" } });
    const r = await runCanary(h.deps);
    expect(r.ok).toBe(false);
    expect(r.checks.answered).toBe(false);
    expect(h.logs[0]).toMatchObject({ reason: "budget_exceeded" });
  });

  it("a forged quote is dropped: citationValid and notAbstained are false", async () => {
    const h = harness({ chat: { kind: "ok", text: 'Erfunden [1: "dieser Satz steht nirgends in der Quelle"].' } });
    const r = await runCanary(h.deps);
    expect(r.ok).toBe(false);
    expect(r.checks.embedding).toBe(true);
    expect(r.checks.citationValid).toBe(false);
  });

  it("a citation of an unknown chunk number is dropped", async () => {
    const h = harness({ chat: { kind: "ok", text: `Falsch [9: "${quoteOfChunk1()}"].` } });
    const r = await runCanary(h.deps);
    expect(r.ok).toBe(false);
    expect(r.checks.citationValid).toBe(false);
  });

  it("an answer without any citation abstains: notAbstained false", async () => {
    const h = harness({ chat: { kind: "ok", text: "Freie Antwort ohne Beleg." } });
    const r = await runCanary(h.deps);
    expect(r.ok).toBe(false);
    expect(r.checks.notAbstained).toBe(false);
    expect(r.checks.citationValid).toBe(false);
  });

  it("a message_link_failed from the wrapper is not answered", async () => {
    const h = harness();
    h.callChat.mockImplementationOnce(async () => ({ ok: false, category: "message_link_failed", usageId: "u" }));
    const r = await runCanary(h.deps);
    expect(r.ok).toBe(false);
    expect(r.checks.answered).toBe(false);
  });
});

describe("runCanary: log", () => {
  it("writes exactly one event with fixed keys, the elapsed ms and a null reason on success", async () => {
    const h = harness();
    let t = 1000;
    h.deps.now = () => (t += 50);
    await runCanary(h.deps);
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).toMatchObject({ event: "canary", ok: true, reason: null });
    expect(Object.keys(h.logs[0] ?? {}).sort()).toEqual(["checks", "event", "ms", "ok", "reason"].sort());
    expect(h.logs[0]?.ms).toBeGreaterThanOrEqual(0);
  });

  it("never contains the question, the passage or the answer text, in any scenario", async () => {
    const scenarios = [
      harness(),
      harness({ embed: { kind: "refused", category: "provider_error" } }),
      harness({ embed: { kind: "ok", vectors: [] } }),
      harness({ chat: { kind: "refused", category: "kill_switch_on" } }),
      harness({ chat: { kind: "ok", text: `${ANSWER_SENTINEL} ohne Beleg` } }),
      harness({ chat: { kind: "ok", text: `${ANSWER_SENTINEL} [1: "erfunden"]` } }),
    ];
    for (const h of scenarios) {
      await runCanary(h.deps);
      expect(h.logs).toHaveLength(1);
      const text = JSON.stringify(h.logs);
      expect(text).not.toContain(ANSWER_SENTINEL);
      expect(text).not.toContain(CANARY_QUESTION);
      for (const c of CANARY_CHUNKS) expect(text).not.toContain(c.content);
    }
  });
});
