// The two importers of lib/server/admin/ops.ts, with the admin module mocked:
//
//   lib/server/ops/read.ts      loadOpsSummary(days: 7 | 30, now?: Date): Promise<ParsedOpsSummary>
//                               reads through readOpsSummary and validates with parseOpsSummary;
//                               a malformed result is an error (fail closed), never partial data.
//   lib/server/eval/record.ts   recordEvalResult(result: EvalResult): Promise<void>
//                               turns the scored eval result into the score recordEvalRun stores:
//                               security = EVAL_CASES.security, quality = facts + abstention,
//                               ok = every security case passed and at least 5 quality cases passed
//                               (QUALITY_MIN in scripts/eval.mjs), errored as reported, commitSha
//                               from VERCEL_GIT_COMMIT_SHA or null. It does not catch: the route does.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EVAL_CASES } from "@/lib/server/eval/corpus";
import type { EvalResult } from "@/lib/server/eval/run";

const readOpsSummary = vi.fn();
const recordEvalRun = vi.fn();
vi.mock("@/lib/server/admin/ops", () => ({
  readOpsSummary: (...args: unknown[]) => readOpsSummary(...args),
  recordEvalRun: (...args: unknown[]) => recordEvalRun(...args),
}));

const NOW = new Date("2026-10-20T10:00:00Z");

const RAW = {
  days: 7,
  ingest_errors: [{ category: "no_text", count: 2 }],
  cost_per_day: [{ day: "2026-10-20", kind: "chat", cost_usd: 0.5 }],
  latency_p95: [{ kind: "chat", p95_ms: 900 }],
  status_counts: [{ kind: "chat", status: "settled", count: 4 }],
  global_today: { spent_usd: 0.5, limit_usd: 5 },
  settings: { model_features_enabled: true, daily_limit_usd: 0.5, daily_limit_anonymous_usd: 0.2, global_daily_limit_usd: 5 },
  eval: null,
};

beforeEach(() => {
  readOpsSummary.mockReset();
  recordEvalRun.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// SIGNATURE CHANGE (approved fix after the reviewer FAIL, PR #63): loadOpsSummary now takes the
// verified user first, loadOpsSummary(user, days, now?), and checks isOperator(user) itself. The
// layout alone is not enough: client-side navigation does not re-run it (ADR 0005). The calls
// below were loadOpsSummary(days, NOW) before; only the signature changed, not what is asserted.
type OpsUser = Parameters<typeof import("@/lib/server/ops/access").isOperator>[0];
const asUser = (over: Record<string, unknown>): OpsUser =>
  ({ id: "11111111-1111-4111-8111-111111111111", ...over }) as unknown as OpsUser;
const OPERATOR = asUser({ app_metadata: { ops: true } });

describe("loadOpsSummary", () => {
  it.each([7, 30] as const)("reads %s days through the admin module and returns the parsed summary", async (days) => {
    readOpsSummary.mockResolvedValue({ ...RAW, days });
    const { loadOpsSummary } = await import("@/lib/server/ops/read");

    const out = await loadOpsSummary(OPERATOR, days, NOW);

    expect(readOpsSummary).toHaveBeenCalledTimes(1);
    expect(readOpsSummary).toHaveBeenCalledWith(days);
    expect(out.days).toBe(days);
    expect(out.cost_per_day).toHaveLength(days * 2); // zero-filled by parseOpsSummary
  });

  it("throws when the result does not match the contract", async () => {
    readOpsSummary.mockResolvedValue({ ...RAW, user_id: "11111111-1111-4111-8111-111111111111" });
    const { loadOpsSummary } = await import("@/lib/server/ops/read");
    await expect(loadOpsSummary(OPERATOR, 7, NOW)).rejects.toThrow();
  });

  it("throws when the admin module throws, with the error passed on unchanged", async () => {
    readOpsSummary.mockRejectedValue(new Error("ops store unavailable: not configured"));
    const { loadOpsSummary } = await import("@/lib/server/ops/read");
    await expect(loadOpsSummary(OPERATOR, 7, NOW)).rejects.toThrow("ops store unavailable: not configured");
  });

  it.each([
    ["a signed-in user without the flag", asUser({ app_metadata: {} })],
    ["a user with no app_metadata", asUser({})],
    ["ops only in user_metadata", asUser({ app_metadata: {}, user_metadata: { ops: true } })],
    ["ops as the string \"true\"", asUser({ app_metadata: { ops: "true" } })],
    ["an anonymous user with the flag", asUser({ app_metadata: { ops: true }, is_anonymous: true })],
    ["no user (null)", null],
  ])("rejects %s and never calls the admin module", async (_label, who) => {
    readOpsSummary.mockResolvedValue({ ...RAW });
    const { loadOpsSummary } = await import("@/lib/server/ops/read");

    await expect(loadOpsSummary(who as OpsUser, 7, NOW)).rejects.toThrow();
    await expect(loadOpsSummary(who as OpsUser, 30)).rejects.toThrow();

    expect(readOpsSummary).not.toHaveBeenCalled();
  });

  it("the refusal carries a fixed message with no user data", async () => {
    const { loadOpsSummary } = await import("@/lib/server/ops/read");
    const who = asUser({ app_metadata: {}, email: "someone@example.test" });
    const err = await loadOpsSummary(who, 7, NOW).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg.length).toBeGreaterThan(0);
    expect(msg).not.toContain("someone@example.test");
    expect(msg).not.toContain("11111111-1111-4111-8111-111111111111");
  });

  it("calls the admin module exactly once, with days, for an operator", async () => {
    readOpsSummary.mockResolvedValue({ ...RAW, days: 30 });
    const { loadOpsSummary } = await import("@/lib/server/ops/read");
    await loadOpsSummary(OPERATOR, 30, NOW);
    expect(readOpsSummary).toHaveBeenCalledTimes(1);
    expect(readOpsSummary).toHaveBeenCalledWith(30);
  });
});

const security = EVAL_CASES.security.map((c) => c.id);
const quality = [...EVAL_CASES.facts, ...EVAL_CASES.abstention].map((c) => c.id);

function result(over: { failSecurity?: string[]; failQuality?: string[]; errored?: number } = {}): EvalResult {
  const cases: Record<string, boolean> = {};
  for (const id of security) cases[id] = !over.failSecurity?.includes(id);
  for (const id of quality) cases[id] = !over.failQuality?.includes(id);
  return {
    cases,
    errored: over.errored ?? 0,
    reasons: Object.fromEntries([...security, ...quality].map((id) => [id, null])),
  };
}

describe("recordEvalResult", () => {
  it("records a full pass with the case counts, the commit sha and ok = true", async () => {
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "abc1234def");
    recordEvalRun.mockResolvedValue(undefined);
    const { recordEvalResult } = await import("@/lib/server/eval/record");

    await recordEvalResult(result());

    expect(recordEvalRun).toHaveBeenCalledTimes(1);
    expect(recordEvalRun).toHaveBeenCalledWith({
      commitSha: "abc1234def",
      securityPassed: security.length,
      securityTotal: security.length,
      qualityPassed: quality.length,
      qualityTotal: quality.length,
      errored: 0,
      ok: true,
    });
  });

  it("sends a null commit sha when VERCEL_GIT_COMMIT_SHA is unset or empty", async () => {
    recordEvalRun.mockResolvedValue(undefined);
    const { recordEvalResult } = await import("@/lib/server/eval/record");
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "");
    await recordEvalResult(result());
    expect(recordEvalRun.mock.calls[0]?.[0]).toMatchObject({ commitSha: null });
    vi.unstubAllEnvs();
    delete process.env.VERCEL_GIT_COMMIT_SHA;
    await recordEvalResult(result());
    expect(recordEvalRun.mock.calls[1]?.[0]).toMatchObject({ commitSha: null });
  });

  it("one failed security case makes ok false and lowers securityPassed by one", async () => {
    recordEvalRun.mockResolvedValue(undefined);
    const { recordEvalResult } = await import("@/lib/server/eval/record");
    await recordEvalResult(result({ failSecurity: [security[0] as string] }));
    expect(recordEvalRun.mock.calls[0]?.[0]).toMatchObject({
      securityPassed: security.length - 1,
      securityTotal: security.length,
      qualityPassed: quality.length,
      ok: false,
    });
  });

  it("quality passes with exactly 5 of the fact and abstention cases and fails with 4", async () => {
    recordEvalRun.mockResolvedValue(undefined);
    const { recordEvalResult } = await import("@/lib/server/eval/record");

    await recordEvalResult(result({ failQuality: quality.slice(5) }));
    expect(recordEvalRun.mock.calls[0]?.[0]).toMatchObject({ qualityPassed: 5, qualityTotal: quality.length, ok: true });

    await recordEvalResult(result({ failQuality: quality.slice(4) }));
    expect(recordEvalRun.mock.calls[1]?.[0]).toMatchObject({ qualityPassed: 4, qualityTotal: quality.length, ok: false });
  });

  it("passes the errored count through", async () => {
    recordEvalRun.mockResolvedValue(undefined);
    const { recordEvalResult } = await import("@/lib/server/eval/record");
    await recordEvalResult(result({ errored: 3 }));
    expect(recordEvalRun.mock.calls[0]?.[0]).toMatchObject({ errored: 3 });
  });

  it("counts only a literal true as a pass, and ignores ids that are not cases", async () => {
    recordEvalRun.mockResolvedValue(undefined);
    const { recordEvalResult } = await import("@/lib/server/eval/record");
    const r = result();
    (r.cases as Record<string, unknown>)[security[0] as string] = "true";
    (r.cases as Record<string, unknown>)["not-a-case"] = true;
    await recordEvalResult(r);
    expect(recordEvalRun.mock.calls[0]?.[0]).toMatchObject({
      securityPassed: security.length - 1,
      securityTotal: security.length,
      ok: false,
    });
  });

  it("hands only the score to the admin module: no reasons, no case ids", async () => {
    recordEvalRun.mockResolvedValue(undefined);
    const { recordEvalResult } = await import("@/lib/server/eval/record");
    await recordEvalResult(result());
    const arg = recordEvalRun.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Object.keys(arg).sort()).toEqual(
      ["commitSha", "errored", "ok", "qualityPassed", "qualityTotal", "securityPassed", "securityTotal"].sort(),
    );
  });

  it("lets a failure of the admin module reach the caller (the route is fail-soft, not this function)", async () => {
    recordEvalRun.mockRejectedValue(new Error("ops store unavailable: record failed"));
    const { recordEvalResult } = await import("@/lib/server/eval/record");
    await expect(recordEvalResult(result())).rejects.toThrow("ops store unavailable");
  });
});
