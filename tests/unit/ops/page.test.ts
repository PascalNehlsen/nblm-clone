// The /ops page checks the operator itself. The layout also does, but client-side navigation and
// partial rendering do not re-run a layout (ADR 0005), and the page reads service_role aggregates.
//
//   page.tsx   const { user } = await getVerifiedUser(); if (!isOperator(user)) notFound();
//              then loadOpsSummary(user, days); ?tage=30 -> 30, anything else -> 7.
//              On a failed load: console.error("ops store: summary failed") with no other argument,
//              and the German alert.
//
// The admin module is mocked at its boundary, so the check in page.tsx and in loadOpsSummary is
// what is under test: for a non-operator readOpsSummary must never be called.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getVerifiedUser = vi.fn();
const readOpsSummary = vi.fn();
vi.mock("@/lib/supabase/server", () => ({ getVerifiedUser: () => getVerifiedUser() }));
vi.mock("@/lib/server/admin/ops", () => ({
  readOpsSummary: (...args: unknown[]) => readOpsSummary(...args),
  recordEvalRun: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  redirect: () => {
    throw new Error("NEXT_REDIRECT");
  },
}));

const RAW = {
  days: 7,
  ingest_errors: [],
  cost_per_day: [],
  latency_p95: [],
  status_counts: [],
  global_today: { spent_usd: 0, limit_usd: 5 },
  settings: { model_features_enabled: true, daily_limit_usd: 0.5, daily_limit_anonymous_usd: 0.2, global_daily_limit_usd: 5 },
  eval: null,
};

const user = (over: Record<string, unknown>) => ({ id: "11111111-1111-4111-8111-111111111111", ...over });
const OPERATOR = user({ app_metadata: { ops: true } });

async function renderPage(searchParams: Record<string, string | string[] | undefined> = {}) {
  const { default: OpsPage } = await import("@/app/(app)/ops/page");
  return OpsPage({ searchParams: Promise.resolve(searchParams) });
}

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  getVerifiedUser.mockReset();
  readOpsSummary.mockReset();
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
});

describe("ops page: operator check on the page itself", () => {
  it.each([
    ["a signed-in user without the flag", user({ app_metadata: {} })],
    ["ops only in user_metadata", user({ app_metadata: {}, user_metadata: { ops: true } })],
    ["ops as the string \"true\"", user({ app_metadata: { ops: "true" } })],
    ["an anonymous demo user with the flag", user({ app_metadata: { ops: true }, is_anonymous: true })],
    ["no user", null],
  ])("calls notFound() for %s and never reads the summary", async (_label, who) => {
    getVerifiedUser.mockResolvedValue({ supabase: {}, user: who });
    readOpsSummary.mockResolvedValue({ ...RAW });

    await expect(renderPage()).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(renderPage({ tage: "30" })).rejects.toThrow("NEXT_NOT_FOUND");

    expect(readOpsSummary).not.toHaveBeenCalled();
  });

  it("does not read the summary when verifying the user throws", async () => {
    getVerifiedUser.mockRejectedValue(new Error("auth down"));
    await expect(renderPage()).rejects.toThrow();
    expect(readOpsSummary).not.toHaveBeenCalled();
  });
});

describe("ops page: operator", () => {
  it("reads 7 days by default", async () => {
    getVerifiedUser.mockResolvedValue({ supabase: {}, user: OPERATOR });
    readOpsSummary.mockResolvedValue({ ...RAW, days: 7 });
    await renderPage();
    expect(readOpsSummary).toHaveBeenCalledTimes(1);
    expect(readOpsSummary).toHaveBeenCalledWith(7);
  });

  it("reads 30 days with ?tage=30", async () => {
    getVerifiedUser.mockResolvedValue({ supabase: {}, user: OPERATOR });
    readOpsSummary.mockResolvedValue({ ...RAW, days: 30 });
    await renderPage({ tage: "30" });
    expect(readOpsSummary).toHaveBeenCalledTimes(1);
    expect(readOpsSummary).toHaveBeenCalledWith(30);
  });

  it.each([["days=30 (wrong name)", { days: "30" }], ["tage=14", { tage: "14" }], ["tage as a list", { tage: ["30", "7"] }]])(
    "reads 7 days for %s",
    async (_label, sp) => {
      getVerifiedUser.mockResolvedValue({ supabase: {}, user: OPERATOR });
      readOpsSummary.mockResolvedValue({ ...RAW, days: 7 });
      await renderPage(sp);
      expect(readOpsSummary).toHaveBeenCalledWith(7);
    },
  );

  it("shows the German alert and logs only the fixed line when loading fails", async () => {
    getVerifiedUser.mockResolvedValue({ supabase: {}, user: OPERATOR });
    readOpsSummary.mockRejectedValue(new Error("ops store unavailable: secret detail 4711"));

    const out = await renderPage();

    expect(JSON.stringify(out)).toContain("Die Betriebsdaten konnten nicht geladen werden.");
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]).toEqual(["ops store: summary failed"]);
  });

  it("does not log when loading works", async () => {
    getVerifiedUser.mockResolvedValue({ supabase: {}, user: OPERATOR });
    readOpsSummary.mockResolvedValue({ ...RAW });
    await renderPage();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
