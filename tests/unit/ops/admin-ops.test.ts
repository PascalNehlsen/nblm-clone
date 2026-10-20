// lib/server/admin/ops.ts: the third module that holds the service_role key (after admin/usage.ts
// and admin/accounts.ts). Same rules as admin/usage.ts: it refuses anything that is not a secret
// key or a service_role JWT, fails closed when the key is missing, and never leaks the key or a
// response body in an error message.
//
// Pinned contract:
//   export surface: exactly readOpsSummary and recordEvalRun
//   readOpsSummary(days: 7 | 30): Promise<unknown>
//     POST {NEXT_PUBLIC_SUPABASE_URL}/rest/v1/rpc/ops_summary with { p_days: days }; resolves the
//     jsonb object the function returned (validation is parseOpsSummary's job, not this module's)
//   recordEvalRun(score): Promise<void>, score = { commitSha: string | null, securityPassed,
//     securityTotal, qualityPassed, qualityTotal, errored: number, ok: boolean }
//     POST .../rpc/record_eval_run with { p_commit_sha, p_security_passed, p_security_total,
//     p_quality_passed, p_quality_total, p_errored, p_ok }
//
// vi.resetModules() + a dynamic import per test, as in tests/unit/admin/usage.test.ts: the admin
// client is created lazily and cached, and @supabase/supabase-js resolves fetch when first loaded.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Built at runtime, not a literal next to a key-like name, so a scanner like gitleaks does not
// flag a fake fixture as a real secret. None of these are real credentials.
const SECRET_KEY = ["sb", "secret", "ops", "fixture"].join("_");
const ANOTHER_SECRET_KEY_FIXTURE = ["sb", "secret", "ops", "another"].join("_");
const PUBLISHABLE_KEY_FIXTURE = ["sb", "publishable", "ops", "fixture"].join("_");
const SUPABASE_URL = "http://127.0.0.1:54321";

function base64url(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function fakeJwt(role: string): string {
  return `${base64url({ alg: "HS256", typ: "JWT" })}.${base64url({ role })}.sig`;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function loadOps() {
  vi.resetModules();
  return import("@/lib/server/admin/ops");
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

const SUMMARY = { days: 7, ingest_errors: [], cost_per_day: [], eval: null };

const score = {
  commitSha: "abc1234",
  securityPassed: 5,
  securityTotal: 5,
  qualityPassed: 9,
  qualityTotal: 12,
  errored: 1,
  ok: true,
};

function lastCall(): { url: string; init: RequestInit | undefined } {
  const [url, init] = vi.mocked(fetch).mock.calls[0] ?? [];
  return { url: String(url), init: init as RequestInit | undefined };
}

describe("module surface", () => {
  it("exports exactly readOpsSummary and recordEvalRun", async () => {
    const mod = await loadOps();
    expect(Object.keys(mod).sort()).toEqual(["readOpsSummary", "recordEvalRun"]);
  });
});

describe("readOpsSummary", () => {
  it.each([7, 30] as const)("POSTs once to /rest/v1/rpc/ops_summary with { p_days: %s }", async (days) => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(SUMMARY));
    const { readOpsSummary } = await loadOps();

    await readOpsSummary(days);

    expect(fetch).toHaveBeenCalledTimes(1);
    const { url, init } = lastCall();
    expect(url).toBe(`${SUPABASE_URL}/rest/v1/rpc/ops_summary`);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ p_days: days });
  });

  it("carries the secret key in the apikey and Authorization headers", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(SUMMARY));
    const { readOpsSummary } = await loadOps();

    await readOpsSummary(7);

    const headers = new Headers(lastCall().init?.headers);
    expect(headers.get("apikey")).toBe(SECRET_KEY);
    expect(headers.get("authorization")).toBe(`Bearer ${SECRET_KEY}`);
  });

  it("resolves the object the RPC returned, unchanged", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(SUMMARY));
    const { readOpsSummary } = await loadOps();
    await expect(readOpsSummary(7)).resolves.toEqual(SUMMARY);
  });

  it.each([0, 1, 8, 14, 31, -7, 7.5, Number.NaN, null, undefined, "7"])("refuses days = %s before any fetch", async (days) => {
    const { readOpsSummary } = await loadOps();
    await expect(readOpsSummary(days as unknown as 7)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["null", null],
    ["a string", "summary"],
    ["a number", 7],
    ["an array", [SUMMARY]],
  ])("throws when the RPC returns %s", async (_label, body) => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(body));
    const { readOpsSummary } = await loadOps();
    await expect(readOpsSummary(7)).rejects.toThrow();
  });

  it("an HTTP error throws, with neither the key nor the response body in the message", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("upstream exploded: sensitive-db-detail-ops-1", { status: 500 }));
    const { readOpsSummary } = await loadOps();

    await expect(readOpsSummary(7)).rejects.toThrow();
    try {
      await readOpsSummary(7);
      expect.unreachable("readOpsSummary should have thrown");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(SECRET_KEY);
      expect(message).not.toContain("sensitive-db-detail-ops-1");
    }
  });

  it("a permission error from the database throws with a fixed message, not its text", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ code: "42501", message: "permission denied for function ops_summary SENTINEL_PG", details: null, hint: null }, 403),
    );
    const { readOpsSummary } = await loadOps();
    try {
      await readOpsSummary(7);
      expect.unreachable("readOpsSummary should have thrown");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain("SENTINEL_PG");
      expect(message).not.toContain(SECRET_KEY);
    }
  });

  it("a network error throws, with the key never in the message", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error(`fetch failed while using key ${SECRET_KEY}`));
    const { readOpsSummary } = await loadOps();
    try {
      await readOpsSummary(7);
      expect.unreachable("readOpsSummary should have thrown");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(SECRET_KEY);
    }
  });
});

describe("recordEvalRun", () => {
  it("POSTs once to /rest/v1/rpc/record_eval_run with the migration's p_-named args", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 204 }));
    const { recordEvalRun } = await loadOps();

    await expect(recordEvalRun(score)).resolves.toBeUndefined();

    expect(fetch).toHaveBeenCalledTimes(1);
    const { url, init } = lastCall();
    expect(url).toBe(`${SUPABASE_URL}/rest/v1/rpc/record_eval_run`);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      p_commit_sha: "abc1234",
      p_security_passed: 5,
      p_security_total: 5,
      p_quality_passed: 9,
      p_quality_total: 12,
      p_errored: 1,
      p_ok: true,
    });
  });

  it("sends a null commit sha as null", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 204 }));
    const { recordEvalRun } = await loadOps();
    await recordEvalRun({ ...score, commitSha: null });
    expect(JSON.parse(String(lastCall().init?.body))).toMatchObject({ p_commit_sha: null });
  });

  it("also resolves when the RPC answers 200 with a null body (a void function)", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(null));
    const { recordEvalRun } = await loadOps();
    await expect(recordEvalRun(score)).resolves.toBeUndefined();
  });

  it("sends only the seven documented arguments, even if the caller passes more", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 204 }));
    const { recordEvalRun } = await loadOps();
    await recordEvalRun({ ...score, answer: "ANSWER_DO_NOT_LEAK", userId: "u-1" } as unknown as typeof score);
    const body = String(lastCall().init?.body);
    expect(body).not.toContain("ANSWER_DO_NOT_LEAK");
    expect(Object.keys(JSON.parse(body) as object).sort()).toEqual(
      ["p_commit_sha", "p_errored", "p_ok", "p_quality_passed", "p_quality_total", "p_security_passed", "p_security_total"].sort(),
    );
  });

  it("an HTTP error throws, with neither the key nor the response body in the message", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("upstream exploded: sensitive-db-detail-ops-2", { status: 500 }));
    const { recordEvalRun } = await loadOps();
    try {
      await recordEvalRun(score);
      expect.unreachable("recordEvalRun should have thrown");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(SECRET_KEY);
      expect(message).not.toContain("sensitive-db-detail-ops-2");
    }
  });

  it("a validation error (22023) throws with a fixed message", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ code: "22023", message: "record_eval_run: SENTINEL_PG_2" }, 400));
    const { recordEvalRun } = await loadOps();
    await expect(recordEvalRun(score)).rejects.toThrow();
    try {
      await recordEvalRun(score);
    } catch (error) {
      expect(error instanceof Error ? error.message : String(error)).not.toContain("SENTINEL_PG_2");
    }
  });

  it("a network error throws, with the key never in the message", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error(`fetch failed while using key ${SECRET_KEY}`));
    const { recordEvalRun } = await loadOps();
    try {
      await recordEvalRun(score);
      expect.unreachable("recordEvalRun should have thrown");
    } catch (error) {
      expect(error instanceof Error ? error.message : String(error)).not.toContain(SECRET_KEY);
    }
  });
});

describe("fails closed without a usable service_role credential", () => {
  it("a missing SUPABASE_SECRET_KEY throws before any fetch, from both functions", async () => {
    delete process.env.SUPABASE_SECRET_KEY;
    const { readOpsSummary, recordEvalRun } = await loadOps();

    await expect(readOpsSummary(7)).rejects.toThrow();
    await expect(recordEvalRun(score)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("a missing NEXT_PUBLIC_SUPABASE_URL throws before any fetch", async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    const { readOpsSummary } = await loadOps();
    await expect(readOpsSummary(7)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("an empty SUPABASE_SECRET_KEY throws before any fetch", async () => {
    vi.stubEnv("SUPABASE_SECRET_KEY", "");
    const { readOpsSummary } = await loadOps();
    await expect(readOpsSummary(7)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("a publishable key throws before any fetch", async () => {
    vi.stubEnv("SUPABASE_SECRET_KEY", PUBLISHABLE_KEY_FIXTURE);
    const { readOpsSummary } = await loadOps();
    await expect(readOpsSummary(7)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["anon", "authenticated"])("a %s-role JWT throws before any fetch", async (role) => {
    vi.stubEnv("SUPABASE_SECRET_KEY", fakeJwt(role));
    const { readOpsSummary, recordEvalRun } = await loadOps();
    await expect(readOpsSummary(7)).rejects.toThrow();
    await expect(recordEvalRun(score)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("the error for a rejected key never contains the key", async () => {
    vi.stubEnv("SUPABASE_SECRET_KEY", PUBLISHABLE_KEY_FIXTURE);
    const { readOpsSummary } = await loadOps();
    try {
      await readOpsSummary(7);
      expect.unreachable("readOpsSummary should have thrown");
    } catch (error) {
      expect(error instanceof Error ? error.message : String(error)).not.toContain(PUBLISHABLE_KEY_FIXTURE);
    }
  });

  it("a service_role JWT is accepted and reaches fetch", async () => {
    vi.stubEnv("SUPABASE_SECRET_KEY", fakeJwt("service_role"));
    vi.mocked(fetch).mockResolvedValue(jsonResponse(SUMMARY));
    const { readOpsSummary } = await loadOps();
    await readOpsSummary(7);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("an sb_secret_ key is accepted and reaches fetch", async () => {
    vi.stubEnv("SUPABASE_SECRET_KEY", ANOTHER_SECRET_KEY_FIXTURE);
    vi.mocked(fetch).mockResolvedValue(jsonResponse(SUMMARY));
    const { readOpsSummary } = await loadOps();
    await readOpsSummary(7);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
