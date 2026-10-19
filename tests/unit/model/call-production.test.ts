// PR E2: production wiring of lib/server/model/call.ts. Reviewer finding
// (2026-10-19, approved): createModelCallerForTests's injectable deps must never
// reach production, so call.ts exports at runtime only createModelCaller, which
// reads only deps.provider and binds everything else -- getVerifiedUser, reserve
// and settle from the real modules, modelConfig, PRICES, performance.now and the
// JSON console.info logger -- itself. This file proves that wiring with the real
// modules mocked (never the network, never a real Supabase call), as opposed to
// call.test.ts, which exercises the engine's logic through the injectable
// testing.ts harness.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderCall } from "@/lib/server/model/types";
import type { ModelConfig } from "@/lib/server/model/config";
import type { PriceTable } from "@/lib/server/model/prices";
import type { VerifiedUser } from "@/lib/server/model/caller";

// vi.mock factories are hoisted above regular `const` declarations, so the
// mocks (and the fixed price table the prices factory closes over) must be
// created inside vi.hoisted, which is hoisted together with them.
const { reserveMock, settleMock, getVerifiedUserMock, modelConfigMock, TEST_PRICE_TABLE } = vi.hoisted(() => ({
  reserveMock: vi.fn(),
  settleMock: vi.fn(),
  getVerifiedUserMock: vi.fn(),
  modelConfigMock: vi.fn(),
  // Keeps the real pricing math (costUsd, estimateCostUsd, inputTokenUpperBound,
  // priceFor, MESSAGE_OVERHEAD_TOKENS) in the factory below; only PRICES is
  // overridden so the test model id resolves to a price without depending on
  // the real (empty) PRICES.
  TEST_PRICE_TABLE: { "test-chat-model": { inputUsdPerMTok: 3, outputUsdPerMTok: 15 } } satisfies PriceTable,
}));

vi.mock("@/lib/server/admin/usage", () => ({
  reserve: reserveMock,
  settle: settleMock,
}));

vi.mock("@/lib/server/model/caller", () => ({
  getVerifiedUser: getVerifiedUserMock,
}));

vi.mock("@/lib/server/model/config", () => ({
  modelConfig: modelConfigMock,
}));

vi.mock("@/lib/server/model/prices", async () => {
  const actual = await vi.importActual<typeof import("@/lib/server/model/prices")>("@/lib/server/model/prices");
  return { ...actual, PRICES: TEST_PRICE_TABLE };
});

import { createModelCaller } from "@/lib/server/model/call";

const TEST_CONFIG: ModelConfig = { modelId: "test-chat-model", maxOutputTokens: 100, timeoutMs: 1000, temperature: 0.2 };

function fakeProvider(): ProviderCall<"chat"> {
  return vi.fn(async () => ({
    output: { text: "hi" },
    usage: { inputTokens: 1, outputTokens: 1 },
  }));
}

beforeEach(() => {
  reserveMock.mockReset();
  settleMock.mockReset();
  getVerifiedUserMock.mockReset();
  modelConfigMock.mockReset();
  modelConfigMock.mockReturnValue(TEST_CONFIG);
  reserveMock.mockResolvedValue({ outcome: "ok", usageId: "usage-1" });
  settleMock.mockResolvedValue(true);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks(); // also restores console.info after the logger test spies on it
});

describe("createModelCaller (production): runtime surface", () => {
  it("exports exactly createModelCaller", async () => {
    const mod = await import("@/lib/server/model/call");
    expect(Object.keys(mod)).toEqual(["createModelCaller"]);
  });
});

describe("createModelCaller (production): default wiring", () => {
  it("calls the real (mocked) reserve and settle once each, with userId/isAnonymous from the real (mocked) getVerifiedUser, and logs through the real JSON logger", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    getVerifiedUserMock.mockResolvedValue({ id: "real-user-1", isAnonymous: false } satisfies VerifiedUser);
    const provider = fakeProvider();

    const result = await createModelCaller({ provider })({
      kind: "chat",
      notebookId: null,
      input: { system: "s", messages: [{ role: "user", content: "hi" }] },
    });

    expect(getVerifiedUserMock).toHaveBeenCalledTimes(1);
    expect(reserveMock).toHaveBeenCalledTimes(1);
    expect(reserveMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "real-user-1", isAnonymous: false, modelId: "test-chat-model" }),
    );
    expect(settleMock).toHaveBeenCalledTimes(1);
    expect(settleMock).toHaveBeenCalledWith(expect.objectContaining({ usageId: "usage-1" }));
    expect(result.ok).toBe(true);

    // Proves the production logger is the real jsonLog (console.info with a
    // JSON line), not a no-op: call.ts must not pass its own silent default.
    expect(infoSpy).toHaveBeenCalledTimes(1);
    const [line] = infoSpy.mock.calls[0] as [string];
    const event: unknown = JSON.parse(line);
    expect(event).toMatchObject({ event: "model_call" });
  });

  it("the mocked getVerifiedUser returning null is unauthenticated; reserve is never called", async () => {
    getVerifiedUserMock.mockResolvedValue(null);
    const provider = fakeProvider();

    const result = await createModelCaller({ provider })({
      kind: "chat",
      notebookId: null,
      input: { system: "s", messages: [] },
    });

    expect(result).toEqual({ ok: false, category: "unauthenticated", usageId: null });
    expect(reserveMock).not.toHaveBeenCalled();
    expect(provider).not.toHaveBeenCalled();
  });
});

describe("createModelCaller (production): extra fields passed via a cast are ignored", () => {
  it("the injected fakes are never called; the real (mocked) reserve runs with the real (mocked) getVerifiedUser's values", async () => {
    getVerifiedUserMock.mockResolvedValue({ id: "real-user-2", isAnonymous: true } satisfies VerifiedUser);
    const provider = fakeProvider();
    const fakeReserve = vi.fn(async () => ({ outcome: "ok" as const, usageId: "fake-usage" }));
    const fakeSettle = vi.fn(async () => true);

    const polluted = {
      provider,
      usage: { reserve: fakeReserve, settle: fakeSettle },
      getVerifiedUser: async () => ({ id: "injected-user", isAnonymous: false }),
      config: () => ({ modelId: "injected-model", maxOutputTokens: 1, timeoutMs: 1, temperature: 0.2 }),
      prices: { "injected-model": { inputUsdPerMTok: 1, outputUsdPerMTok: 1 } },
    } as unknown as { provider: ProviderCall<"chat"> };

    const result = await createModelCaller(polluted)({
      kind: "chat",
      notebookId: null,
      input: { system: "s", messages: [{ role: "user", content: "hi" }] },
    });

    expect(fakeReserve).not.toHaveBeenCalled();
    expect(fakeSettle).not.toHaveBeenCalled();
    expect(reserveMock).toHaveBeenCalledTimes(1);
    expect(reserveMock).toHaveBeenCalledWith(expect.objectContaining({ isAnonymous: true, modelId: "test-chat-model" }));
    expect(settleMock).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
  });
});

// Type contract: createModelCaller's deps type is { provider: ProviderCall<K> }
// only -- the injectable testing.ts shape must not type-check here. Checked by
// `pnpm typecheck` (tests/**/*.ts is included in the root tsconfig). These
// calls do run at module load (createModelCaller only builds a closure; it
// calls nothing until that closure is invoked with a request, which never
// happens here), so they are harmless regardless of mock state.
function typeOnlyProvider(): ProviderCall<"chat"> {
  return async () => ({ output: { text: "x" }, usage: { inputTokens: 1, outputTokens: 1 } });
}
const _typeTestUsage = createModelCaller({
  provider: typeOnlyProvider(),
  // @ts-expect-error createModelCaller's deps type is { provider } only; usage must be rejected
  usage: { reserve: async () => ({ outcome: "ok" as const, usageId: "x" }), settle: async () => true },
});
// @ts-expect-error createModelCaller's deps type is { provider } only; getVerifiedUser must be rejected
const _typeTestGetVerifiedUser = createModelCaller({ provider: typeOnlyProvider(), getVerifiedUser: async () => null });
void _typeTestUsage;
void _typeTestGetVerifiedUser;
