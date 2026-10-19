// PR E2: the model call wrapper's engine, exercised through the test-only
// createModelCallerForTests (testing.ts), never through production call.ts --
// that distinction, and that createModelCallerForTests must never reach
// production code, is covered in eslint-imports.test.ts and auth-boundary.test.ts.
// createModelCallerForTests enforces auth, config, pricing and budget (via fake
// deps here, never the real network) before calling a fake provider, then
// settles. See AGENTS.md: "every model call passes the per-user budget check
// first" and "logs never contain prompt, source or answer text". The wiring of
// the real deps in production call.ts is covered separately in
// call-production.test.ts.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createModelCallerForTests } from "@/lib/server/model/testing";
import type { ModelCallLogEvent, ModelCallRequest, ModelCallResult } from "@/lib/server/model/call-core";
import { ProviderError } from "@/lib/server/model/types";
import type { ModelKind, ProviderCall, ProviderRequest, ProviderUsage } from "@/lib/server/model/types";
import type { ModelConfig } from "@/lib/server/model/config";
import { costUsd, estimateCostUsd, inputTokenUpperBound } from "@/lib/server/model/prices";
import type { ModelPrice, PriceTable } from "@/lib/server/model/prices";
import type { VerifiedUser } from "@/lib/server/model/caller";

// ---------------------------------------------------------------------------
// Fixed test fixtures: a price table passed explicitly (deps.prices), since the
// real PRICES ships empty (approved decision 4a) and would make every call
// price_unknown if we relied on the default.
// ---------------------------------------------------------------------------

const CHAT_PRICE: ModelPrice = { inputUsdPerMTok: 3, outputUsdPerMTok: 15 };
const EMBED_PRICE: ModelPrice = { inputUsdPerMTok: 1, outputUsdPerMTok: 0 };

const PRICE_TABLE: PriceTable = {
  "test-chat-model": CHAT_PRICE,
  "test-embed-model": EMBED_PRICE,
};

const CHAT_CONFIG: ModelConfig = { modelId: "test-chat-model", maxOutputTokens: 512, timeoutMs: 5_000 };
const EMBED_CONFIG: ModelConfig = { modelId: "test-embed-model", maxOutputTokens: 0, timeoutMs: 5_000 };

function configFor(kind: ModelKind): ModelConfig | null {
  return kind === "chat" ? CHAT_CONFIG : EMBED_CONFIG;
}

const CHAT_REQUEST: ModelCallRequest<"chat"> = {
  kind: "chat",
  notebookId: "nb-1",
  input: { system: "System prompt.", messages: [{ role: "user", content: "Hello there" }] },
};

function makeClock(values: number[]): () => number {
  let i = 0;
  return () => {
    const value = values[Math.min(i, values.length - 1)] ?? 0;
    i += 1;
    return value;
  };
}

// Minimal shapes matching the approved reserve/settle signatures (ADR 0006 /
// supabase/migrations/20261018214400_model_usage_budget.sql), duplicated here so
// this file does not depend on lib/server/admin/usage existing or being imported
// as a value (call.ts is meant to be its only importer).
interface ReserveArgs {
  userId: string;
  isAnonymous: boolean;
  notebookId: string | null;
  kind: ModelKind;
  modelId: string;
  estimatedCostUsd: number;
  callCount: number;
}
type ReserveOutcome =
  | { outcome: "ok"; usageId: string }
  | { outcome: "kill_switch_on" | "budget_exceeded" | "global_budget_exceeded" };
interface SettleArgs {
  usageId: string;
  status: "settled" | "failed";
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
  messageId: string | null;
  errorCategory: string | null;
}

interface HarnessOptions<K extends ModelKind> {
  provider: ProviderCall<K>;
  getVerifiedUser?: () => Promise<VerifiedUser | null>;
  reserve?: (a: ReserveArgs) => Promise<ReserveOutcome>;
  settle?: (a: SettleArgs) => Promise<boolean>;
  config?: (kind: ModelKind) => ModelConfig | null;
  prices?: PriceTable;
  nowValues?: number[];
  log?: (e: ModelCallLogEvent) => void;
}

function buildHarness<K extends ModelKind>(opts: HarnessOptions<K>) {
  const provider = vi.fn(opts.provider);
  const getVerifiedUser = vi.fn(opts.getVerifiedUser ?? (async () => ({ id: "user-1", isAnonymous: false })));
  const reserve = vi.fn(opts.reserve ?? (async () => ({ outcome: "ok" as const, usageId: "usage-1" })));
  const settle = vi.fn(opts.settle ?? (async () => true));
  const log = vi.fn(opts.log ?? (() => {}));
  const now = makeClock(opts.nowValues ?? [1000, 1500]);

  const callModel = createModelCallerForTests<K>({
    provider,
    getVerifiedUser,
    usage: { reserve, settle },
    config: opts.config ?? configFor,
    prices: opts.prices ?? PRICE_TABLE,
    now,
    log,
  });

  return { provider, getVerifiedUser, reserve, settle, log, now, callModel };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Type contract: ModelCallRequest carries no per-request override for anything
// that must come from the verified session or the server config. Checked by
// `pnpm typecheck` (tests/**/*.ts is included in the root tsconfig), not by
// vitest at runtime -- these object literals never get used.
// ---------------------------------------------------------------------------
// @ts-expect-error ModelCallRequest must not accept a userId override
const _typeTestUserId: ModelCallRequest<"chat"> = { ...CHAT_REQUEST, userId: "injected" };
// @ts-expect-error ModelCallRequest must not accept an isAnonymous override
const _typeTestIsAnonymous: ModelCallRequest<"chat"> = { ...CHAT_REQUEST, isAnonymous: true };
// @ts-expect-error ModelCallRequest must not accept a modelId override
const _typeTestModelId: ModelCallRequest<"chat"> = { ...CHAT_REQUEST, modelId: "injected-model" };
// @ts-expect-error ModelCallRequest must not accept a maxOutputTokens override
const _typeTestMaxOutputTokens: ModelCallRequest<"chat"> = { ...CHAT_REQUEST, maxOutputTokens: 10 };
void _typeTestUserId;
void _typeTestIsAnonymous;
void _typeTestModelId;
void _typeTestMaxOutputTokens;

describe("createModelCaller: happy paths", () => {
  it("chat: reserves the hand-computed estimate, calls the provider, settles with the real cost", async () => {
    const usage: ProviderUsage = { inputTokens: 42, outputTokens: 17 };
    const harness = buildHarness<"chat">({
      provider: async () => ({ output: { text: "answer" }, usage }),
      nowValues: [1000, 1500],
    });

    const expectedTokens = inputTokenUpperBound("chat", CHAT_REQUEST.input);
    const expectedEstimate = estimateCostUsd(CHAT_PRICE, expectedTokens, CHAT_CONFIG.maxOutputTokens);
    const expectedRealCost = costUsd(CHAT_PRICE, usage);

    const result = await harness.callModel(CHAT_REQUEST);

    expect(harness.reserve).toHaveBeenCalledTimes(1);
    expect(harness.reserve).toHaveBeenCalledWith({
      userId: "user-1",
      isAnonymous: false,
      notebookId: "nb-1",
      kind: "chat",
      modelId: "test-chat-model",
      estimatedCostUsd: expectedEstimate,
      callCount: 1,
    });

    expect(harness.provider).toHaveBeenCalledTimes(1);
    const providerArg = harness.provider.mock.calls[0]?.[0] as ProviderRequest<"chat">;
    expect(providerArg.modelId).toBe("test-chat-model");
    expect(providerArg.maxOutputTokens).toBe(512);
    expect(providerArg.input).toEqual(CHAT_REQUEST.input);
    expect(providerArg.signal).toBeInstanceOf(AbortSignal);

    expect(harness.settle).toHaveBeenCalledTimes(1);
    expect(harness.settle).toHaveBeenCalledWith({
      usageId: "usage-1",
      status: "settled",
      inputTokens: 42,
      outputTokens: 17,
      costUsd: expectedRealCost,
      latencyMs: 500,
      messageId: null,
      errorCategory: null,
    });

    expect(result).toEqual({
      ok: true,
      output: { text: "answer" },
      usageId: "usage-1",
      inputTokens: 42,
      outputTokens: 17,
      costUsd: expectedRealCost,
      latencyMs: 500,
      settled: true,
    });
  });

  it("embedding: maxOutputTokens 0 reaches the provider, estimate has no output part, settles", async () => {
    const usage: ProviderUsage = { inputTokens: 9, outputTokens: 0 };
    const request: ModelCallRequest<"embedding"> = { kind: "embedding", notebookId: null, input: { texts: ["a", "b"] } };
    const harness = buildHarness<"embedding">({
      provider: async () => ({ output: { vectors: [[0.1, 0.2]] }, usage }),
      config: () => EMBED_CONFIG,
      nowValues: [2000, 2100],
    });

    const expectedTokens = inputTokenUpperBound("embedding", request.input);
    const expectedEstimate = estimateCostUsd(EMBED_PRICE, expectedTokens, 0);
    const expectedRealCost = costUsd(EMBED_PRICE, usage);

    const result = await harness.callModel(request);

    const providerArg = harness.provider.mock.calls[0]?.[0] as ProviderRequest<"embedding">;
    expect(providerArg.maxOutputTokens).toBe(0);
    expect(harness.reserve).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "embedding", estimatedCostUsd: expectedEstimate }),
    );
    expect(harness.settle).toHaveBeenCalledWith(expect.objectContaining({ status: "settled", costUsd: expectedRealCost }));
    expect(result).toEqual({
      ok: true,
      output: { vectors: [[0.1, 0.2]] },
      usageId: "usage-1",
      inputTokens: 9,
      outputTokens: 0,
      costUsd: expectedRealCost,
      latencyMs: 100,
      settled: true,
    });
  });

  it("uses isAnonymous/userId from getVerifiedUser and modelId from config, ignoring any injected request fields", async () => {
    const harness = buildHarness({
      provider: async () => ({ output: { text: "x" }, usage: { inputTokens: 1, outputTokens: 1 } }),
      getVerifiedUser: async () => ({ id: "real-user", isAnonymous: true }),
    });

    const polluted = {
      ...CHAT_REQUEST,
      userId: "injected-user",
      isAnonymous: false,
      modelId: "injected-model",
    } as ModelCallRequest<"chat">;

    await harness.callModel(polluted);

    expect(harness.reserve).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "real-user", isAnonymous: true, modelId: "test-chat-model" }),
    );
  });
});

describe("createModelCaller: refusals before any provider call", () => {
  const unauthenticatedCases: Array<[string, () => Promise<VerifiedUser | null>]> = [
    ["returns null", async () => null],
    ["throws", async () => { throw new Error("auth down"); }],
  ];

  it.each(unauthenticatedCases)(
    "getVerifiedUser %s -> unauthenticated; reserve and provider are not called",
    async (_label, impl) => {
      const harness = buildHarness({
        provider: async () => ({ output: { text: "x" }, usage: { inputTokens: 1, outputTokens: 1 } }),
        getVerifiedUser: impl,
      });
      const result = await harness.callModel(CHAT_REQUEST);
      expect(result).toEqual({ ok: false, category: "unauthenticated", usageId: null });
      expect(harness.reserve).not.toHaveBeenCalled();
      expect(harness.provider).not.toHaveBeenCalled();
    },
  );

  it("config(kind) null -> model_not_configured; reserve is not called", async () => {
    const harness = buildHarness({
      provider: async () => ({ output: { text: "x" }, usage: { inputTokens: 1, outputTokens: 1 } }),
      config: () => null,
    });
    const result = await harness.callModel(CHAT_REQUEST);
    expect(result).toEqual({ ok: false, category: "model_not_configured", usageId: null });
    expect(harness.reserve).not.toHaveBeenCalled();
  });

  it("no price entry for the configured model -> price_unknown; reserve is not called", async () => {
    const harness = buildHarness({
      provider: async () => ({ output: { text: "x" }, usage: { inputTokens: 1, outputTokens: 1 } }),
      config: () => ({ modelId: "unpriced-model", maxOutputTokens: 100, timeoutMs: 1000 }),
    });
    const result = await harness.callModel(CHAT_REQUEST);
    expect(result).toEqual({ ok: false, category: "price_unknown", usageId: null });
    expect(harness.reserve).not.toHaveBeenCalled();
  });

  it.each(["__proto__", "constructor"])("model id %s never resolves a price -> price_unknown", async (modelId) => {
    const harness = buildHarness({
      provider: async () => ({ output: { text: "x" }, usage: { inputTokens: 1, outputTokens: 1 } }),
      config: () => ({ modelId, maxOutputTokens: 100, timeoutMs: 1000 }),
    });
    const result = await harness.callModel(CHAT_REQUEST);
    expect(result).toEqual({ ok: false, category: "price_unknown", usageId: null });
    expect(harness.reserve).not.toHaveBeenCalled();
  });

  it("a non-finite estimate (e.g. a NaN price) -> price_unknown", async () => {
    const harness = buildHarness({
      provider: async () => ({ output: { text: "x" }, usage: { inputTokens: 1, outputTokens: 1 } }),
      config: () => ({ modelId: "weird-model", maxOutputTokens: 10, timeoutMs: 1000 }),
      prices: { "weird-model": { inputUsdPerMTok: Number.NaN, outputUsdPerMTok: 0 } },
    });
    const result = await harness.callModel(CHAT_REQUEST);
    expect(result).toEqual({ ok: false, category: "price_unknown", usageId: null });
  });

  it("a zero estimate (e.g. a free price) -> price_unknown", async () => {
    const harness = buildHarness({
      provider: async () => ({ output: { text: "x" }, usage: { inputTokens: 1, outputTokens: 1 } }),
      config: () => ({ modelId: "free-model", maxOutputTokens: 0, timeoutMs: 1000 }),
      prices: { "free-model": { inputUsdPerMTok: 0, outputUsdPerMTok: 0 } },
    });
    const result = await harness.callModel(CHAT_REQUEST);
    expect(result).toEqual({ ok: false, category: "price_unknown", usageId: null });
  });

  it("omitting deps.prices falls back to the real (empty) PRICES, so every call is price_unknown", async () => {
    const provider = vi.fn(async () => ({ output: { text: "x" }, usage: { inputTokens: 1, outputTokens: 1 } }));
    const reserve = vi.fn(async () => ({ outcome: "ok" as const, usageId: "usage-1" }));
    const callModel = createModelCallerForTests<"chat">({
      provider,
      getVerifiedUser: async () => ({ id: "user-1", isAnonymous: false }),
      usage: { reserve, settle: vi.fn(async () => true) },
      config: configFor,
      now: makeClock([0, 1]),
      log: vi.fn(),
    });
    const result = await callModel(CHAT_REQUEST);
    expect(result).toEqual({ ok: false, category: "price_unknown", usageId: null });
    expect(reserve).not.toHaveBeenCalled();
  });

  it.each(["kill_switch_on", "budget_exceeded", "global_budget_exceeded"] as const)(
    "reserve outcome %s becomes that category; provider and settle are not called, and it is logged as refused",
    async (outcome) => {
      const log = vi.fn();
      const harness = buildHarness({
        provider: async () => ({ output: { text: "x" }, usage: { inputTokens: 1, outputTokens: 1 } }),
        reserve: async () => ({ outcome }),
        log,
      });
      const result = await harness.callModel(CHAT_REQUEST);
      expect(result).toEqual({ ok: false, category: outcome, usageId: null });
      expect(harness.provider).not.toHaveBeenCalled();
      expect(harness.settle).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0]?.[0]).toMatchObject({ outcome: "refused", category: outcome });
    },
  );

  const budgetUnavailableCases: Array<[string, () => Promise<ReserveOutcome>]> = [
    ["reserve throws", async () => { throw new Error("db down"); }],
    ["reserve resolves ok without a usageId", async () => ({ outcome: "ok" }) as unknown as ReserveOutcome],
    ["reserve resolves an unknown outcome", async () => ({ outcome: "mystery" }) as unknown as ReserveOutcome],
  ];

  it.each(budgetUnavailableCases)("%s -> budget_unavailable; provider is not called", async (_label, reserveImpl) => {
    const harness = buildHarness({
      provider: async () => ({ output: { text: "x" }, usage: { inputTokens: 1, outputTokens: 1 } }),
      reserve: reserveImpl,
    });
    const result = await harness.callModel(CHAT_REQUEST);
    expect(result).toEqual({ ok: false, category: "budget_unavailable", usageId: null });
    expect(harness.provider).not.toHaveBeenCalled();
  });
});

describe("createModelCaller: provider failures", () => {
  it("ProviderError('throttled', usage) settles failed with the reported tokens/cost, returns provider_throttled", async () => {
    const usage: ProviderUsage = { inputTokens: 7, outputTokens: 3 };
    const harness = buildHarness({
      provider: async () => {
        throw new ProviderError("throttled", usage);
      },
    });
    const result = await harness.callModel(CHAT_REQUEST);
    expect(result).toEqual({ ok: false, category: "provider_throttled", usageId: "usage-1" });
    const expectedCost = costUsd(CHAT_PRICE, usage);
    expect(harness.settle).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        inputTokens: 7,
        outputTokens: 3,
        costUsd: expectedCost,
        errorCategory: "provider_throttled",
      }),
    );
  });

  it("ProviderError('timeout') maps to provider_timeout even without a real timeout", async () => {
    const harness = buildHarness({
      provider: async () => {
        throw new ProviderError("timeout");
      },
    });
    const result = await harness.callModel(CHAT_REQUEST);
    expect(result).toEqual({ ok: false, category: "provider_timeout", usageId: "usage-1" });
  });

  it("a plain Error (and any non-ProviderError) -> provider_error, settles failed at 0/0 tokens and the estimate cost", async () => {
    const harness = buildHarness({
      provider: async () => {
        throw new Error("network blip");
      },
    });
    const expectedTokens = inputTokenUpperBound("chat", CHAT_REQUEST.input);
    const expectedEstimate = estimateCostUsd(CHAT_PRICE, expectedTokens, CHAT_CONFIG.maxOutputTokens);

    const result = await harness.callModel(CHAT_REQUEST);

    expect(result).toEqual({ ok: false, category: "provider_error", usageId: "usage-1" });
    expect(harness.settle).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        inputTokens: 0,
        outputTokens: 0,
        costUsd: expectedEstimate,
        errorCategory: "provider_error",
      }),
    );
  });

  it("settle throwing after a provider error: ok:false with the provider category, settleFailed logged", async () => {
    const log = vi.fn();
    const harness = buildHarness({
      provider: async () => {
        throw new Error("boom");
      },
      settle: async () => {
        throw new Error("db down");
      },
      log,
    });
    const result = await harness.callModel(CHAT_REQUEST);
    expect(result).toEqual({ ok: false, category: "provider_error", usageId: "usage-1" });
    expect(log.mock.calls[0]?.[0]).toMatchObject({ category: "provider_error", settleFailed: true });
  });

  it("provider timeout: aborts the signal, settles failed once, and ignores a late provider resolution", async () => {
    vi.useFakeTimers();
    let capturedSignal: AbortSignal | undefined;
    let resolveLate: ((v: { output: { text: string }; usage: ProviderUsage }) => void) | undefined;

    const harness = buildHarness({
      provider: async (req: ProviderRequest<"chat">) => {
        capturedSignal = req.signal;
        return new Promise<{ output: { text: string }; usage: ProviderUsage }>((resolve) => {
          resolveLate = resolve;
        });
      },
      nowValues: [1000, 6000],
    });

    const expectedTokens = inputTokenUpperBound("chat", CHAT_REQUEST.input);
    const expectedEstimate = estimateCostUsd(CHAT_PRICE, expectedTokens, CHAT_CONFIG.maxOutputTokens);

    const resultPromise = harness.callModel(CHAT_REQUEST);
    await vi.advanceTimersByTimeAsync(CHAT_CONFIG.timeoutMs);
    const result = await resultPromise;

    expect(result).toEqual({ ok: false, category: "provider_timeout", usageId: "usage-1" });
    expect(capturedSignal?.aborted).toBe(true);
    expect(harness.settle).toHaveBeenCalledTimes(1);
    expect(harness.settle).toHaveBeenCalledWith(
      expect.objectContaining({
        usageId: "usage-1",
        status: "failed",
        errorCategory: "provider_timeout",
        inputTokens: 0,
        outputTokens: 0,
        costUsd: expectedEstimate,
      }),
    );

    resolveLate?.({ output: { text: "too late" }, usage: { inputTokens: 1, outputTokens: 1 } });
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.settle).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["negative inputTokens", { inputTokens: -1, outputTokens: 1 }],
    ["NaN outputTokens", { inputTokens: 1, outputTokens: Number.NaN }],
    ["a float inputTokens", { inputTokens: 1.5, outputTokens: 1 }],
  ] as const)(
    "provider usage with %s -> provider_invalid_response, settles failed at the estimate, no output returned",
    async (_label, usage) => {
      const harness = buildHarness({
        provider: async () => ({ output: { text: "hi" }, usage }),
      });
      const expectedTokens = inputTokenUpperBound("chat", CHAT_REQUEST.input);
      const expectedEstimate = estimateCostUsd(CHAT_PRICE, expectedTokens, CHAT_CONFIG.maxOutputTokens);

      const result = await harness.callModel(CHAT_REQUEST);

      expect(result).toEqual({ ok: false, category: "provider_invalid_response", usageId: "usage-1" });
      expect("output" in result).toBe(false);
      expect(harness.settle).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "failed",
          inputTokens: 0,
          outputTokens: 0,
          costUsd: expectedEstimate,
          errorCategory: "provider_invalid_response",
        }),
      );
    },
  );
});

describe("createModelCaller: settle failures after a provider success", () => {
  it("settle returning false: ok:true settled:false, one log event with category settle_failed", async () => {
    const log = vi.fn();
    const harness = buildHarness({
      provider: async () => ({ output: { text: "hi" }, usage: { inputTokens: 1, outputTokens: 1 } }),
      settle: async () => false,
      log,
    });
    const result = await harness.callModel(CHAT_REQUEST);
    expect(result).toMatchObject({ ok: true, settled: false });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toMatchObject({ category: "settle_failed", settleFailed: true });
  });

  it("settle throwing: ok:true settled:false, one log event with category settle_failed", async () => {
    const log = vi.fn();
    const harness = buildHarness({
      provider: async () => ({ output: { text: "hi" }, usage: { inputTokens: 1, outputTokens: 1 } }),
      settle: async () => {
        throw new Error("db down");
      },
      log,
    });
    const result = await harness.callModel(CHAT_REQUEST);
    expect(result).toMatchObject({ ok: true, settled: false });
    expect(log.mock.calls[0]?.[0]).toMatchObject({ category: "settle_failed", settleFailed: true });
  });
});

describe("createModelCaller: linkMessage", () => {
  it("passes the resolved message id to settle", async () => {
    const harness = buildHarness({
      provider: async () => ({ output: { text: "hi" }, usage: { inputTokens: 1, outputTokens: 1 } }),
    });
    const linkMessage = vi.fn(async () => "message-123");

    const result = await harness.callModel({ ...CHAT_REQUEST, linkMessage });

    expect(linkMessage).toHaveBeenCalledWith({ text: "hi" });
    expect(harness.settle).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "message-123", status: "settled", errorCategory: null }),
    );
    expect(result).toMatchObject({ ok: true, settled: true });
  });

  it("linkMessage throwing: settles with messageId null and message_link_failed, returns ok:false", async () => {
    const harness = buildHarness({
      provider: async () => ({ output: { text: "hi" }, usage: { inputTokens: 1, outputTokens: 1 } }),
    });
    const linkMessage = vi.fn(async () => {
      throw new Error("link failed");
    });

    const result = await harness.callModel({ ...CHAT_REQUEST, linkMessage });

    expect(harness.settle).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: null, status: "settled", errorCategory: "message_link_failed" }),
    );
    expect(result).toEqual({ ok: false, category: "message_link_failed", usageId: "usage-1" });
  });
});

describe("createModelCaller: no sentinel text leaks anywhere besides the returned output", () => {
  const SECRET_SYSTEM = "sentinel-system-9f3a";
  const SECRET_MESSAGE = "sentinel-message-7b2c";
  const SECRET_TEXT = "sentinel-embedding-1d4e";
  const SECRET_OUTPUT = "sentinel-output-5a6f";
  const SECRET_ERROR = "sentinel-error-8c1d";
  const ALL_SENTINELS = [SECRET_SYSTEM, SECRET_MESSAGE, SECRET_TEXT, SECRET_OUTPUT, SECRET_ERROR];

  function assertNoSentinel(haystack: unknown): void {
    const text = JSON.stringify(haystack, (_key, value: unknown) =>
      value instanceof Error ? { message: value.message, stack: value.stack, cause: value.cause } : value,
    );
    for (const sentinel of ALL_SENTINELS) {
      expect(text ?? "").not.toContain(sentinel);
    }
  }

  it("happy path: sentinels stay out of logs and console output (the returned output legitimately carries one)", async () => {
    const consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    );
    const log = vi.fn();
    const harness = buildHarness<"chat">({
      provider: async () => ({ output: { text: SECRET_OUTPUT }, usage: { inputTokens: 1, outputTokens: 1 } }),
      log,
    });

    const result = await harness.callModel({
      kind: "chat",
      notebookId: null,
      input: { system: SECRET_SYSTEM, messages: [{ role: "user", content: SECRET_MESSAGE }] },
    });

    assertNoSentinel(log.mock.calls);
    for (const spy of consoleSpies) assertNoSentinel(spy.mock.calls);
    expect(result.ok && result.output.text).toBe(SECRET_OUTPUT);
  });

  it("a thrown provider error's message never reaches logs, console output, the returned result or settle", async () => {
    const consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    );
    const log = vi.fn();
    const harness = buildHarness({
      provider: async () => {
        throw new Error(`boom ${SECRET_ERROR}`);
      },
      log,
    });

    const result = await harness.callModel({
      kind: "chat",
      notebookId: null,
      input: { system: SECRET_SYSTEM, messages: [{ role: "user", content: SECRET_MESSAGE }] },
    });

    assertNoSentinel(log.mock.calls);
    for (const spy of consoleSpies) assertNoSentinel(spy.mock.calls);
    assertNoSentinel(result);
    assertNoSentinel(harness.settle.mock.calls);
  });

  it("a provider that throws with a sentinel message, fed sentinel input, leaks nothing through the default logger", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const consoleSpies = [logSpy, infoSpy, warnSpy, errorSpy, debugSpy];
    const provider = vi.fn(async () => {
      throw new Error(`boom ${SECRET_ERROR}`);
    });
    const reserve = vi.fn(async () => ({ outcome: "ok" as const, usageId: "usage-1" }));
    const settle = vi.fn(async () => true);

    // deps.log omitted on purpose: this exercises the default (console.info) logger.
    const callModel = createModelCallerForTests<"chat">({
      provider,
      getVerifiedUser: async () => ({ id: "user-1", isAnonymous: false }),
      usage: { reserve, settle },
      config: configFor,
      prices: PRICE_TABLE,
      now: makeClock([0, 1]),
    });

    await callModel({
      kind: "chat",
      notebookId: null,
      input: { system: SECRET_SYSTEM, messages: [{ role: "user", content: SECRET_MESSAGE }] },
    });

    expect(infoSpy).toHaveBeenCalledTimes(1);
    for (const spy of consoleSpies) assertNoSentinel(spy.mock.calls);
  });

  it("embedding input texts never reach the logs", async () => {
    const log = vi.fn();
    const harness = buildHarness({
      provider: async () => ({ output: { vectors: [[0.1]] }, usage: { inputTokens: 1, outputTokens: 0 } }),
      config: () => EMBED_CONFIG,
      log,
    });

    await harness.callModel({ kind: "embedding", notebookId: null, input: { texts: [SECRET_TEXT] } });

    assertNoSentinel(log.mock.calls);
  });

  it("every logged event's keys are a subset of the documented ModelCallLogEvent keys", async () => {
    const ALLOWED_KEYS = [
      "event",
      "outcome",
      "category",
      "kind",
      "modelId",
      "usageId",
      "inputTokens",
      "outputTokens",
      "costUsd",
      "latencyMs",
      "settleFailed",
    ];
    const log = vi.fn();
    const harness = buildHarness({
      provider: async () => ({ output: { text: "x" }, usage: { inputTokens: 1, outputTokens: 1 } }),
      log,
    });

    await harness.callModel(CHAT_REQUEST);

    expect(log).toHaveBeenCalledTimes(1);
    const event = log.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Object.keys(event).every((key) => ALLOWED_KEYS.includes(key))).toBe(true);
  });
});

describe("createModelCaller: reserve runs at most once, settle at most once, on every path", () => {
  const scenarios: Array<[string, HarnessOptions<"chat">]> = [
    [
      "happy path",
      { provider: async () => ({ output: { text: "x" }, usage: { inputTokens: 1, outputTokens: 1 } }) },
    ],
    ["provider throws a plain Error", { provider: async () => { throw new Error("x"); } }],
    [
      "provider throws ProviderError('throttled')",
      {
        provider: async () => {
          throw new ProviderError("throttled", { inputTokens: 1, outputTokens: 1 });
        },
      },
    ],
    [
      "provider reports invalid usage",
      { provider: async () => ({ output: { text: "x" }, usage: { inputTokens: -1, outputTokens: 1 } }) },
    ],
  ];

  it.each(scenarios)("%s: reserve once, settle at most once", async (_label, opts) => {
    const harness = buildHarness(opts);
    await harness.callModel(CHAT_REQUEST);
    expect(harness.reserve).toHaveBeenCalledTimes(1);
    expect(harness.settle.mock.calls.length).toBeLessThanOrEqual(1);
    expect(harness.settle).toHaveBeenCalledTimes(1); // every scenario above does reach settle
  });

  it("a refusal before reserve never calls reserve or settle", async () => {
    const harness = buildHarness({
      provider: async () => ({ output: { text: "x" }, usage: { inputTokens: 1, outputTokens: 1 } }),
      getVerifiedUser: async () => null,
    });
    await harness.callModel(CHAT_REQUEST);
    expect(harness.reserve).not.toHaveBeenCalled();
    expect(harness.settle).not.toHaveBeenCalled();
  });
});

describe("createModelCaller: default logging", () => {
  it("omitting deps.log writes exactly one console.info call with parseable JSON", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const provider = vi.fn(async () => ({ output: { text: "x" }, usage: { inputTokens: 1, outputTokens: 1 } }));
    const reserve = vi.fn(async () => ({ outcome: "ok" as const, usageId: "usage-1" }));
    const settle = vi.fn(async () => true);

    const callModel = createModelCallerForTests<"chat">({
      provider,
      getVerifiedUser: async () => ({ id: "user-1", isAnonymous: false }),
      usage: { reserve, settle },
      config: configFor,
      prices: PRICE_TABLE,
      now: makeClock([0, 1]),
    });

    await callModel(CHAT_REQUEST);

    expect(infoSpy).toHaveBeenCalledTimes(1);
    const [line] = infoSpy.mock.calls[0] as [string];
    expect(typeof line).toBe("string");
    expect(() => JSON.parse(line)).not.toThrow();
  });
});

// Keeps the imported type used (ModelCallResult only appears in annotations above,
// which some lint configurations still flag as "unused" for type-only imports).
type _KeepModelCallResultImportUsed = ModelCallResult<"chat">;
void (null as unknown as _KeepModelCallResultImportUsed);
