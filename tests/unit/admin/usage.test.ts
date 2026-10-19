// PR E2: the one module holding the service_role key (ADR 0006). It must refuse
// anything that is not a secret key / service_role JWT, fail closed when the key is
// missing (approved decision 1: SUPABASE_SECRET_KEY is not set yet anywhere), and
// never leak the key or a raw response body in an error message.
//
// vi.resetModules() + a dynamic import per test, because the module is supposed to
// create its admin client lazily and cache it -- and because @supabase/supabase-js
// resolves `fetch` when it is first loaded, so re-stubbing global fetch only takes
// effect for a freshly imported client (same reasoning as the module being lazy).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Built at runtime, not a literal next to a key-like name, so a scanner like
// gitleaks (generic-api-key, entropy) does not flag a fake test fixture as a
// real secret. None of these are real credentials.
const SECRET_KEY = ["sb", "secret", "unit", "fixture"].join("_");
const ANOTHER_SECRET_KEY_FIXTURE = ["sb", "secret", "another", "fixture"].join("_");
const PUBLISHABLE_KEY_FIXTURE = ["sb", "publishable", "unit", "fixture"].join("_");
const SUPABASE_URL = "http://127.0.0.1:54321";

function base64url(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

// A JWT shaped exactly like the ones lib/supabase/env.ts already decodes (header,
// payload, signature), with a given `role` claim. The signature is never verified
// here -- the module under test is expected to read the claim, not to verify it,
// same as the existing publishable-key check it mirrors.
function fakeJwt(role: string): string {
  return `${base64url({ alg: "HS256", typ: "JWT" })}.${base64url({ role })}.sig`;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function loadUsage() {
  vi.resetModules();
  return import("@/lib/server/admin/usage");
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", SUPABASE_URL);
  vi.stubEnv("SUPABASE_SECRET_KEY", SECRET_KEY);
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.SUPABASE_SECRET_KEY;
});

const reserveArgs = {
  userId: "11111111-1111-4111-8111-111111111111",
  isAnonymous: false,
  notebookId: "22222222-2222-4222-8222-222222222222",
  kind: "chat" as const,
  modelId: "test-model",
  estimatedCostUsd: 0.001,
  callCount: 1,
};

const settleArgs = {
  usageId: "usage-1",
  status: "settled" as const,
  inputTokens: 10,
  outputTokens: 5,
  costUsd: 0.0001,
  latencyMs: 250,
  messageId: null,
  errorCategory: null,
};

describe("module surface", () => {
  it("exports exactly reserve and settle", async () => {
    const mod = await loadUsage();
    expect(Object.keys(mod).sort()).toEqual(["reserve", "settle"]);
  });
});

describe("reserve", () => {
  it("POSTs exactly once to /rest/v1/rpc/reserve_model_call with the migration's p_-named args", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse([{ outcome: "ok", usage_id: "usage-1" }]));
    const { reserve } = await loadUsage();

    await reserve(reserveArgs);

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(fetch).mock.calls[0] ?? [];
    expect(String(url)).toBe(`${SUPABASE_URL}/rest/v1/rpc/reserve_model_call`);
    expect((init as RequestInit | undefined)?.method).toBe("POST");
    const body: unknown = JSON.parse(String((init as RequestInit | undefined)?.body));
    expect(body).toEqual({
      p_user_id: reserveArgs.userId,
      p_is_anonymous: reserveArgs.isAnonymous,
      p_notebook_id: reserveArgs.notebookId,
      p_kind: reserveArgs.kind,
      p_model_id: reserveArgs.modelId,
      p_estimated_cost_usd: reserveArgs.estimatedCostUsd,
      p_call_count: reserveArgs.callCount,
    });
  });

  it("carries the secret key in the apikey and Authorization headers", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse([{ outcome: "ok", usage_id: "usage-1" }]));
    const { reserve } = await loadUsage();

    await reserve(reserveArgs);

    const [, init] = vi.mocked(fetch).mock.calls[0] ?? [];
    const headers = new Headers((init as RequestInit | undefined)?.headers);
    expect(headers.get("apikey")).toBe(SECRET_KEY);
    expect(headers.get("authorization")).toBe(`Bearer ${SECRET_KEY}`);
  });

  it.each([
    ["ok", [{ outcome: "ok", usage_id: "usage-42" }], { outcome: "ok", usageId: "usage-42" }],
    ["kill_switch_on", [{ outcome: "kill_switch_on", usage_id: null }], { outcome: "kill_switch_on" }],
    ["budget_exceeded", [{ outcome: "budget_exceeded", usage_id: null }], { outcome: "budget_exceeded" }],
    [
      "global_budget_exceeded",
      [{ outcome: "global_budget_exceeded", usage_id: null }],
      { outcome: "global_budget_exceeded" },
    ],
  ] as const)("maps the %s outcome from the table-returning RPC response", async (_label, responseBody, expected) => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(responseBody));
    const { reserve } = await loadUsage();
    await expect(reserve(reserveArgs)).resolves.toEqual(expected);
  });

  it("an unknown outcome throws, with neither the key nor the response body in the message", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse([{ outcome: "mystery-outcome-xyz", usage_id: null }]));
    const { reserve } = await loadUsage();

    await expect(reserve(reserveArgs)).rejects.toThrow();
    try {
      await reserve(reserveArgs);
      expect.unreachable("reserve should have thrown");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(SECRET_KEY);
      expect(message).not.toContain("mystery-outcome-xyz");
    }
  });

  it("an HTTP error throws, with neither the key nor the response body in the message", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("upstream exploded: sensitive-db-detail-77", { status: 500 }));
    const { reserve } = await loadUsage();

    try {
      await reserve(reserveArgs);
      expect.unreachable("reserve should have thrown");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(SECRET_KEY);
      expect(message).not.toContain("sensitive-db-detail-77");
    }
  });

  it("a network error throws, with the key never in the message", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error(`fetch failed while using key ${SECRET_KEY}`));
    const { reserve } = await loadUsage();

    try {
      await reserve(reserveArgs);
      expect.unreachable("reserve should have thrown");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(SECRET_KEY);
    }
  });
});

describe("settle", () => {
  it("POSTs to /rest/v1/rpc/settle_model_call with the migration's p_-named args and returns the boolean", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(true));
    const { settle } = await loadUsage();

    await expect(settle(settleArgs)).resolves.toBe(true);

    const [url, init] = vi.mocked(fetch).mock.calls[0] ?? [];
    expect(String(url)).toBe(`${SUPABASE_URL}/rest/v1/rpc/settle_model_call`);
    const body: unknown = JSON.parse(String((init as RequestInit | undefined)?.body));
    expect(body).toEqual({
      p_usage_id: settleArgs.usageId,
      p_status: settleArgs.status,
      p_input_tokens: settleArgs.inputTokens,
      p_output_tokens: settleArgs.outputTokens,
      p_cost_usd: settleArgs.costUsd,
      p_latency_ms: settleArgs.latencyMs,
      p_message_id: settleArgs.messageId,
      p_error_category: settleArgs.errorCategory,
    });
  });

  it("returns false when the RPC reports no row changed (second settle of the same row)", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(false));
    const { settle } = await loadUsage();
    await expect(settle(settleArgs)).resolves.toBe(false);
  });

  it("an HTTP error throws, with neither the key nor the response body in the message", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("upstream exploded: sensitive-db-detail-88", { status: 500 }));
    const { settle } = await loadUsage();

    try {
      await settle(settleArgs);
      expect.unreachable("settle should have thrown");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(SECRET_KEY);
      expect(message).not.toContain("sensitive-db-detail-88");
    }
  });
});

describe("fails closed without a usable service_role credential (approved decision 1)", () => {
  it("a missing SUPABASE_SECRET_KEY throws before any fetch", async () => {
    delete process.env.SUPABASE_SECRET_KEY;
    const { reserve } = await loadUsage();

    await expect(reserve(reserveArgs)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("a publishable key throws before any fetch", async () => {
    vi.stubEnv("SUPABASE_SECRET_KEY", PUBLISHABLE_KEY_FIXTURE);
    const { reserve } = await loadUsage();

    await expect(reserve(reserveArgs)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("an anon-role JWT throws before any fetch", async () => {
    vi.stubEnv("SUPABASE_SECRET_KEY", fakeJwt("anon"));
    const { reserve } = await loadUsage();

    await expect(reserve(reserveArgs)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("an authenticated-role JWT throws before any fetch", async () => {
    vi.stubEnv("SUPABASE_SECRET_KEY", fakeJwt("authenticated"));
    const { reserve } = await loadUsage();

    await expect(reserve(reserveArgs)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("a service_role JWT is accepted and reaches fetch", async () => {
    vi.stubEnv("SUPABASE_SECRET_KEY", fakeJwt("service_role"));
    vi.mocked(fetch).mockResolvedValue(jsonResponse([{ outcome: "ok", usage_id: "usage-1" }]));
    const { reserve } = await loadUsage();

    await reserve(reserveArgs);

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("an sb_secret_ key is accepted and reaches fetch", async () => {
    vi.stubEnv("SUPABASE_SECRET_KEY", ANOTHER_SECRET_KEY_FIXTURE);
    vi.mocked(fetch).mockResolvedValue(jsonResponse([{ outcome: "ok", usage_id: "usage-1" }]));
    const { reserve } = await loadUsage();

    await reserve(reserveArgs);

    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
