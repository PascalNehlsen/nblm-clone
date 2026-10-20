// parseOpsSummary validates what public.ops_summary returned (via lib/server/admin/ops.ts), and
// categoryLabel turns a stored category into the German label for the ops page.
//
// Pinned contract (lib/server/ops/summary.ts):
//   parseOpsSummary(json: unknown, now: Date = new Date()) -> the same keys as the RPC result
//     (days, ingest_errors, cost_per_day, latency_p95, status_counts, global_today, settings, eval).
//     It throws on any shape violation: an extra or missing key at any level, a wrong type, days
//     other than 7 or 30, a day that is not YYYY-MM-DD, a kind other than embedding or chat, a
//     status other than reserved, settled or failed, a negative or non-finite number, a category
//     that does not match ^[a-z_]{1,40}$.
//   cost_per_day in the result has one entry per day of the window (ending on today in
//     Europe/Berlin, `days` entries) and per kind (embedding, then chat), ascending by day, 0 for
//     what the RPC did not report.
//   categoryLabel(category: string): the German label of any category in lib/ops/categories.ts,
//     "Unbekannter Fehler" for anything else.
import { describe, expect, it } from "vitest";
import { categoryLabel, parseOpsSummary } from "@/lib/server/ops/summary";

const NOW = new Date("2026-10-20T10:00:00Z"); // 12:00 in Berlin

function valid(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    days: 7,
    ingest_errors: [
      { category: "no_text", count: 3 },
      { category: "url_blocked", count: 1 },
    ],
    cost_per_day: [
      { day: "2026-10-19", kind: "chat", cost_usd: 0.0123 },
      { day: "2026-10-20", kind: "embedding", cost_usd: 0.004 },
    ],
    latency_p95: [
      { kind: "chat", p95_ms: 1905.5 },
      { kind: "embedding", p95_ms: 50 },
    ],
    status_counts: [
      { kind: "chat", status: "settled", count: 20 },
      { kind: "chat", status: "failed", count: 1 },
    ],
    global_today: { spent_usd: 0.25, limit_usd: 5 },
    settings: {
      model_features_enabled: true,
      daily_limit_usd: 0.5,
      daily_limit_anonymous_usd: 0.2,
      global_daily_limit_usd: 5,
    },
    eval: {
      ran_at: "2026-10-20T08:00:00+00:00",
      commit_sha: "abc1234",
      security_passed: 5,
      security_total: 5,
      quality_passed: 9,
      quality_total: 12,
      errored: 0,
      ok: true,
    },
    ...over,
  };
}

function parse(json: unknown, now: Date = NOW) {
  return parseOpsSummary(json, now) as unknown as Record<string, unknown> & {
    cost_per_day: Array<{ day: string; kind: string; cost_usd: number }>;
  };
}

describe("parseOpsSummary: accepts a well-formed result", () => {
  it("keeps the RPC keys and values", () => {
    const out = parse(valid());
    expect(Object.keys(out).sort()).toEqual(
      ["cost_per_day", "days", "eval", "global_today", "ingest_errors", "latency_p95", "settings", "status_counts"].sort(),
    );
    expect(out.days).toBe(7);
    expect(out.ingest_errors).toEqual([
      { category: "no_text", count: 3 },
      { category: "url_blocked", count: 1 },
    ]);
    expect(out.latency_p95).toEqual([
      { kind: "chat", p95_ms: 1905.5 },
      { kind: "embedding", p95_ms: 50 },
    ]);
    expect(out.status_counts).toEqual([
      { kind: "chat", status: "settled", count: 20 },
      { kind: "chat", status: "failed", count: 1 },
    ]);
    expect(out.global_today).toEqual({ spent_usd: 0.25, limit_usd: 5 });
    expect(out.settings).toEqual(valid().settings);
    expect(out.eval).toEqual(valid().eval);
  });

  it("accepts 30 days, a null eval and empty series", () => {
    const out = parse(valid({ days: 30, eval: null, ingest_errors: [], latency_p95: [], status_counts: [], cost_per_day: [] }));
    expect(out.days).toBe(30);
    expect(out.eval).toBeNull();
    expect(out.ingest_errors).toEqual([]);
  });

  it("accepts a null commit_sha in the eval run", () => {
    const run = { ...(valid().eval as object), commit_sha: null };
    expect(() => parse(valid({ eval: run }))).not.toThrow();
  });

  it("does not mutate its input", () => {
    const input = valid();
    const copy = structuredClone(input);
    parse(input);
    expect(input).toEqual(copy);
  });
});

describe("parseOpsSummary: fills missing days with 0", () => {
  it("returns one entry per day and kind for the 7-day window ending today in Berlin", () => {
    const out = parse(valid({ cost_per_day: [] }));
    const days = [...new Set(out.cost_per_day.map((e) => e.day))];
    expect(days).toEqual(["2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18", "2026-10-19", "2026-10-20"]);
    expect(out.cost_per_day).toHaveLength(14);
    for (const entry of out.cost_per_day) expect(entry.cost_usd).toBe(0);
    expect(out.cost_per_day.slice(0, 2).map((e) => e.kind)).toEqual(["embedding", "chat"]);
  });

  it("keeps the reported costs and zero-fills only the rest", () => {
    const out = parse(valid());
    const by = (day: string, kind: string) => out.cost_per_day.find((e) => e.day === day && e.kind === kind)?.cost_usd;
    expect(by("2026-10-19", "chat")).toBe(0.0123);
    expect(by("2026-10-20", "embedding")).toBe(0.004);
    expect(by("2026-10-19", "embedding")).toBe(0);
    expect(by("2026-10-20", "chat")).toBe(0);
    expect(out.cost_per_day).toHaveLength(14);
  });

  it("returns 60 entries for the 30-day window, from 2026-09-21 to 2026-10-20", () => {
    const out = parse(valid({ days: 30, cost_per_day: [] }));
    expect(out.cost_per_day).toHaveLength(60);
    expect(out.cost_per_day[0]?.day).toBe("2026-09-21");
    expect(out.cost_per_day[59]?.day).toBe("2026-10-20");
  });

  it("is sorted ascending by day", () => {
    const out = parse(valid());
    const days = out.cost_per_day.map((e) => e.day);
    expect(days).toEqual([...days].sort());
  });

  it("takes today from Europe/Berlin, not UTC", () => {
    // 21:59 UTC on 19 Oct is 23:59 in Berlin (CEST): still the 19th.
    expect(parse(valid({ cost_per_day: [] }), new Date("2026-10-19T21:59:00Z")).cost_per_day.at(-1)?.day).toBe("2026-10-19");
    // 22:30 UTC on 19 Oct is 00:30 on the 20th in Berlin.
    expect(parse(valid({ cost_per_day: [] }), new Date("2026-10-19T22:30:00Z")).cost_per_day.at(-1)?.day).toBe("2026-10-20");
  });
});

describe("parseOpsSummary: rejects anything that is not exactly the contract", () => {
  const cases: Array<[string, unknown]> = [
    ["null", null],
    ["a string", "summary"],
    ["an array", []],
    ["an empty object", {}],
    ["an extra top-level key", valid({ user_id: "11111111-1111-4111-8111-111111111111" })],
    ["a missing top-level key", (() => { const v = valid(); delete v.settings; return v; })()],
    ["days 14", valid({ days: 14 })],
    ["days as a string", valid({ days: "7" })],
    ["ingest_errors that is not an array", valid({ ingest_errors: {} })],
    ["an ingest error with an extra field", valid({ ingest_errors: [{ category: "no_text", count: 1, title: "x" }] })],
    ["an ingest error without a count", valid({ ingest_errors: [{ category: "no_text" }] })],
    ["an ingest error with a negative count", valid({ ingest_errors: [{ category: "no_text", count: -1 }] })],
    ["an ingest error with a fractional count", valid({ ingest_errors: [{ category: "no_text", count: 1.5 }] })],
    ["an ingest error with a count as a string", valid({ ingest_errors: [{ category: "no_text", count: "1" }] })],
    ["an ingest category with upper case", valid({ ingest_errors: [{ category: "No_Text", count: 1 }] })],
    ["an ingest category with a space", valid({ ingest_errors: [{ category: "no text", count: 1 }] })],
    ["an empty ingest category", valid({ ingest_errors: [{ category: "", count: 1 }] })],
    ["an ingest category over 40 characters", valid({ ingest_errors: [{ category: "a".repeat(41), count: 1 }] })],
    ["a null ingest category", valid({ ingest_errors: [{ category: null, count: 1 }] })],
    ["a cost entry with an extra field", valid({ cost_per_day: [{ day: "2026-10-19", kind: "chat", cost_usd: 1, user_id: "u" }] })],
    ["a cost entry with a malformed day", valid({ cost_per_day: [{ day: "19.10.2026", kind: "chat", cost_usd: 1 }] })],
    ["a cost entry with a timestamp instead of a day", valid({ cost_per_day: [{ day: "2026-10-19T00:00:00Z", kind: "chat", cost_usd: 1 }] })],
    ["a cost entry with an unknown kind", valid({ cost_per_day: [{ day: "2026-10-19", kind: "image", cost_usd: 1 }] })],
    ["a negative cost", valid({ cost_per_day: [{ day: "2026-10-19", kind: "chat", cost_usd: -0.01 }] })],
    ["a cost of NaN", valid({ cost_per_day: [{ day: "2026-10-19", kind: "chat", cost_usd: Number.NaN }] })],
    ["a cost of Infinity", valid({ cost_per_day: [{ day: "2026-10-19", kind: "chat", cost_usd: Number.POSITIVE_INFINITY }] })],
    ["a cost as a string", valid({ cost_per_day: [{ day: "2026-10-19", kind: "chat", cost_usd: "0.01" }] })],
    ["a latency entry with an extra field", valid({ latency_p95: [{ kind: "chat", p95_ms: 1, model_id: "m" }] })],
    ["a latency entry with an unknown kind", valid({ latency_p95: [{ kind: "x", p95_ms: 1 }] })],
    ["a negative latency", valid({ latency_p95: [{ kind: "chat", p95_ms: -1 }] })],
    ["a null latency", valid({ latency_p95: [{ kind: "chat", p95_ms: null }] })],
    ["a status entry with an unknown status", valid({ status_counts: [{ kind: "chat", status: "pending", count: 1 }] })],
    ["a status entry with an extra field", valid({ status_counts: [{ kind: "chat", status: "settled", count: 1, x: 1 }] })],
    ["a status entry with a negative count", valid({ status_counts: [{ kind: "chat", status: "settled", count: -2 }] })],
    ["global_today with an extra field", valid({ global_today: { spent_usd: 1, limit_usd: 5, x: 1 } })],
    ["global_today without limit_usd", valid({ global_today: { spent_usd: 1 } })],
    ["global_today with a negative spend", valid({ global_today: { spent_usd: -1, limit_usd: 5 } })],
    ["global_today as null", valid({ global_today: null })],
    ["settings with an extra field", valid({ settings: { ...(valid().settings as object), updated_by: "x" } })],
    ["settings with a missing limit", valid({ settings: { model_features_enabled: true, daily_limit_usd: 1 } })],
    ["settings with the switch as a string", valid({ settings: { ...(valid().settings as object), model_features_enabled: "true" } })],
    ["eval with an extra id", valid({ eval: { ...(valid().eval as object), id: 4 } })],
    ["eval with a missing field", valid({ eval: { ran_at: "2026-10-20T08:00:00Z", ok: true } })],
    ["eval with ok as a string", valid({ eval: { ...(valid().eval as object), ok: "true" } })],
    ["eval with a negative count", valid({ eval: { ...(valid().eval as object), errored: -1 } })],
    ["eval with passed above total", valid({ eval: { ...(valid().eval as object), quality_passed: 13 } })],
    ["eval as undefined", valid({ eval: undefined })],
  ];

  it.each(cases)("throws for %s", (_label, input) => {
    expect(() => parseOpsSummary(input, NOW)).toThrow();
  });

  it("does not put the rejected value into the error message", () => {
    try {
      parseOpsSummary(valid({ ingest_errors: [{ category: "SECRET_PAYLOAD_9", count: 1 }] }), NOW);
      expect.unreachable("parseOpsSummary should have thrown");
    } catch (error) {
      expect(error instanceof Error ? error.message : String(error)).not.toContain("SECRET_PAYLOAD_9");
    }
  });
});

describe("categoryLabel", () => {
  it("returns the German label of an ingest, URL and model category", () => {
    expect(categoryLabel("no_text")).toBe("Kein Text gefunden");
    expect(categoryLabel("url_blocked")).toBe("Adresse nicht erlaubt");
    expect(categoryLabel("provider_timeout")).toBe("Zeitüberschreitung beim Modellanbieter");
    expect(categoryLabel("budget_exceeded")).toBe("Tagesbudget des Nutzers erreicht");
  });

  it('returns "Unbekannter Fehler" for an unknown or malformed category', () => {
    for (const category of ["unknown", "whatever_else", "", "No_Text", "constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(categoryLabel(category), category).toBe("Unbekannter Fehler");
    }
  });
});
