import "server-only";

import { INGEST_ERROR_CATEGORIES, MODEL_ERROR_CATEGORIES, URL_ERROR_CATEGORIES, sourceErrorLabel } from "@/lib/ops/categories";

// What public.ops_summary returns (ADR 0023), checked field by field: a shape the page does not
// expect is an error, never rendered. Error messages name the field, never the value.

export type Kind = "embedding" | "chat";
export type CallStatus = "reserved" | "settled" | "failed";

export interface OpsSummary {
  days: 7 | 30;
  ingest_errors: { category: string; count: number }[];
  cost_per_day: { day: string; kind: Kind; cost_usd: number }[];
  latency_p95: { kind: Kind; p95_ms: number }[];
  status_counts: { kind: Kind; status: CallStatus; count: number }[];
  global_today: { spent_usd: number; limit_usd: number };
  settings: {
    model_features_enabled: boolean;
    daily_limit_usd: number;
    daily_limit_anonymous_usd: number;
    global_daily_limit_usd: number;
  };
  eval: {
    ran_at: string;
    commit_sha: string | null;
    security_passed: number;
    security_total: number;
    quality_passed: number;
    quality_total: number;
    errored: number;
    ok: boolean;
  } | null;
}

type Json = Record<string, unknown>;
const KINDS: readonly Kind[] = ["embedding", "chat"];
const STATUSES: readonly CallStatus[] = ["reserved", "settled", "failed"];

function fail(field: string): never {
  throw new Error(`ops summary: invalid ${field}`);
}

function object(value: unknown, keys: readonly string[], field: string): Json {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(field);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((k, i) => k !== expected[i])) fail(field);
  return value as Json;
}

function array(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) fail(field);
  return value;
}

function amount(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) fail(field);
  return value;
}

function count(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) fail(field);
  return value as number;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) fail(field);
  return value as T;
}

// YYYY-MM-DD of a date in Europe/Berlin.
function berlinDay(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function windowDays(days: number, now: Date): string[] {
  const [y, m, d] = berlinDay(now).split("-").map(Number) as [number, number, number];
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i--) out.push(new Date(Date.UTC(y, m - 1, d - i)).toISOString().slice(0, 10));
  return out;
}

export function parseOpsSummary(json: unknown, now: Date = new Date()): OpsSummary {
  const top = object(
    json,
    ["days", "ingest_errors", "cost_per_day", "latency_p95", "status_counts", "global_today", "settings", "eval"],
    "summary",
  );
  if (top.days !== 7 && top.days !== 30) fail("days");
  const days = top.days;

  const ingest_errors = array(top.ingest_errors, "ingest_errors").map((e) => {
    const o = object(e, ["category", "count"], "ingest_errors");
    if (typeof o.category !== "string" || !/^[a-z_]{1,40}$/.test(o.category)) fail("ingest_errors.category");
    return { category: o.category, count: count(o.count, "ingest_errors.count") };
  });

  const reported = new Map<string, number>();
  for (const e of array(top.cost_per_day, "cost_per_day")) {
    const o = object(e, ["day", "kind", "cost_usd"], "cost_per_day");
    if (typeof o.day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(o.day)) fail("cost_per_day.day");
    const kind = oneOf(o.kind, KINDS, "cost_per_day.kind");
    reported.set(`${o.day}|${kind}`, amount(o.cost_usd, "cost_per_day.cost_usd"));
  }
  const cost_per_day = windowDays(days, now).flatMap((day) =>
    KINDS.map((kind) => ({ day, kind, cost_usd: reported.get(`${day}|${kind}`) ?? 0 })),
  );

  const latency_p95 = array(top.latency_p95, "latency_p95").map((e) => {
    const o = object(e, ["kind", "p95_ms"], "latency_p95");
    return { kind: oneOf(o.kind, KINDS, "latency_p95.kind"), p95_ms: amount(o.p95_ms, "latency_p95.p95_ms") };
  });

  const status_counts = array(top.status_counts, "status_counts").map((e) => {
    const o = object(e, ["kind", "status", "count"], "status_counts");
    return {
      kind: oneOf(o.kind, KINDS, "status_counts.kind"),
      status: oneOf(o.status, STATUSES, "status_counts.status"),
      count: count(o.count, "status_counts.count"),
    };
  });

  const g = object(top.global_today, ["spent_usd", "limit_usd"], "global_today");
  const global_today = { spent_usd: amount(g.spent_usd, "global_today"), limit_usd: amount(g.limit_usd, "global_today") };

  const s = object(
    top.settings,
    ["model_features_enabled", "daily_limit_usd", "daily_limit_anonymous_usd", "global_daily_limit_usd"],
    "settings",
  );
  if (typeof s.model_features_enabled !== "boolean") fail("settings");
  const settings = {
    model_features_enabled: s.model_features_enabled,
    daily_limit_usd: amount(s.daily_limit_usd, "settings"),
    daily_limit_anonymous_usd: amount(s.daily_limit_anonymous_usd, "settings"),
    global_daily_limit_usd: amount(s.global_daily_limit_usd, "settings"),
  };

  let evalRun: OpsSummary["eval"] = null;
  if (top.eval !== null) {
    const r = object(
      top.eval,
      ["ran_at", "commit_sha", "security_passed", "security_total", "quality_passed", "quality_total", "errored", "ok"],
      "eval",
    );
    if (typeof r.ran_at !== "string" || Number.isNaN(Date.parse(r.ran_at))) fail("eval.ran_at");
    if (r.commit_sha !== null && typeof r.commit_sha !== "string") fail("eval.commit_sha");
    if (typeof r.ok !== "boolean") fail("eval.ok");
    const run = {
      ran_at: r.ran_at,
      commit_sha: r.commit_sha,
      security_passed: count(r.security_passed, "eval"),
      security_total: count(r.security_total, "eval"),
      quality_passed: count(r.quality_passed, "eval"),
      quality_total: count(r.quality_total, "eval"),
      errored: count(r.errored, "eval"),
      ok: r.ok,
    };
    if (run.security_passed > run.security_total || run.quality_passed > run.quality_total) fail("eval");
    evalRun = run;
  }

  return { days, ingest_errors, cost_per_day, latency_p95, status_counts, global_today, settings, eval: evalRun };
}

const KNOWN = new Set<string>([...MODEL_ERROR_CATEGORIES, ...INGEST_ERROR_CATEGORIES, ...URL_ERROR_CATEGORIES]);

// The German label of a stored category, the same one the sources list shows.
export function categoryLabel(category: string): string {
  return KNOWN.has(category) ? sourceErrorLabel(category) : "Unbekannter Fehler";
}
