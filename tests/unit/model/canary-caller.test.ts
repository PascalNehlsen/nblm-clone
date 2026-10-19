// R2: createCanaryCaller (spec .git/R2-SPEC.md, ADR 0014). Same wiring proof as
// call-production.test.ts: the real modules are mocked, never the network or Supabase. The
// budget subject comes only from CANARY_USER_ID.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelConfig } from "@/lib/server/model/config";
import type { PriceTable } from "@/lib/server/model/prices";
import type { ProviderCall } from "@/lib/server/model/types";

const { reserveMock, settleMock, getVerifiedUserMock, modelConfigMock, TEST_PRICE_TABLE } = vi.hoisted(() => ({
  reserveMock: vi.fn(),
  settleMock: vi.fn(),
  getVerifiedUserMock: vi.fn(),
  modelConfigMock: vi.fn(),
  TEST_PRICE_TABLE: { "test-chat-model": { inputUsdPerMTok: 3, outputUsdPerMTok: 15 } } satisfies PriceTable,
}));

vi.mock("@/lib/server/admin/usage", () => ({ reserve: reserveMock, settle: settleMock }));
vi.mock("@/lib/server/model/caller", () => ({ getVerifiedUser: getVerifiedUserMock }));
vi.mock("@/lib/server/model/config", () => ({ modelConfig: modelConfigMock }));
vi.mock("@/lib/server/model/prices", async () => {
  const actual = await vi.importActual<typeof import("@/lib/server/model/prices")>("@/lib/server/model/prices");
  return { ...actual, PRICES: TEST_PRICE_TABLE };
});

import { createCanaryCaller } from "@/lib/server/model/call";

const CANARY_ID = "33333333-3333-4333-8333-333333333333";
const TEST_CONFIG: ModelConfig = { modelId: "test-chat-model", maxOutputTokens: 100, timeoutMs: 1000, temperature: 0.2 };

function fakeProvider(): ProviderCall<"chat"> {
  return vi.fn(async () => ({ output: { text: "hi" }, usage: { inputTokens: 1, outputTokens: 1 } }));
}

const REQUEST = { kind: "chat" as const, notebookId: null, input: { system: "s", messages: [{ role: "user" as const, content: "hi" }] } };

beforeEach(() => {
  reserveMock.mockReset();
  settleMock.mockReset();
  getVerifiedUserMock.mockReset();
  modelConfigMock.mockReset();
  modelConfigMock.mockReturnValue(TEST_CONFIG);
  reserveMock.mockResolvedValue({ outcome: "ok", usageId: "usage-1" });
  settleMock.mockResolvedValue(true);
  // A session user must never be consulted by the canary.
  getVerifiedUserMock.mockResolvedValue({ id: "session-user", isAnonymous: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("createCanaryCaller: configuration", () => {
  it("is null when CANARY_USER_ID is unset", () => {
    delete process.env.CANARY_USER_ID;
    expect(createCanaryCaller({ provider: fakeProvider() })).toBeNull();
  });

  for (const bad of ["", "   ", "not-a-uuid", "33333333-3333-4333-8333-33333333333", `${CANARY_ID}0`, "../../etc/passwd"]) {
    it(`is null for the non-UUID value ${JSON.stringify(bad)}`, () => {
      vi.stubEnv("CANARY_USER_ID", bad);
      expect(createCanaryCaller({ provider: fakeProvider() })).toBeNull();
    });
  }

  it("returns a caller for a UUID", () => {
    vi.stubEnv("CANARY_USER_ID", CANARY_ID);
    expect(typeof createCanaryCaller({ provider: fakeProvider() })).toBe("function");
  });
});

describe("createCanaryCaller: budget subject", () => {
  it("reserves for CANARY_USER_ID with isAnonymous false, without asking for a session user", async () => {
    vi.stubEnv("CANARY_USER_ID", CANARY_ID);
    const provider = fakeProvider();
    const caller = createCanaryCaller({ provider });
    expect(caller).not.toBeNull();
    const result = await caller?.(REQUEST);
    expect(result?.ok).toBe(true);
    expect(getVerifiedUserMock).not.toHaveBeenCalled();
    expect(reserveMock).toHaveBeenCalledTimes(1);
    expect(reserveMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: CANARY_ID, isAnonymous: false, modelId: "test-chat-model" }),
    );
    expect(settleMock).toHaveBeenCalledWith(expect.objectContaining({ usageId: "usage-1" }));
  });

  it("a refused reservation (kill switch) stops before the provider", async () => {
    vi.stubEnv("CANARY_USER_ID", CANARY_ID);
    reserveMock.mockResolvedValue({ outcome: "kill_switch_on" });
    const provider = fakeProvider();
    const result = await createCanaryCaller({ provider })?.(REQUEST);
    expect(result?.ok).toBe(false);
    expect(provider).not.toHaveBeenCalled();
  });

  it("no parameter can choose the user: extra fields on deps are ignored", async () => {
    vi.stubEnv("CANARY_USER_ID", CANARY_ID);
    const polluted = {
      provider: fakeProvider(),
      userId: "attacker",
      getVerifiedUser: async () => ({ id: "injected-user", isAnonymous: true }),
    } as unknown as { provider: ProviderCall<"chat"> };
    await createCanaryCaller(polluted)?.(REQUEST);
    expect(reserveMock).toHaveBeenCalledWith(expect.objectContaining({ userId: CANARY_ID, isAnonymous: false }));
  });

  it("reads the env at call time of createCanaryCaller, not at import", async () => {
    vi.stubEnv("CANARY_USER_ID", CANARY_ID);
    const first = createCanaryCaller({ provider: fakeProvider() });
    vi.stubEnv("CANARY_USER_ID", "not-a-uuid");
    expect(createCanaryCaller({ provider: fakeProvider() })).toBeNull();
    expect(first).not.toBeNull();
  });
});
