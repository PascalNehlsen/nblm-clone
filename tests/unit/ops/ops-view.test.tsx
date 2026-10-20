// The body of the ops page, rendered from an injected, already parsed summary (no database, no
// network): apps/web/app/(app)/ops/ops-view.tsx exports a synchronous, hook-free
// OpsView({ summary }) for the ParsedOpsSummary that parseOpsSummary returns. The page itself
// (page.tsx) only loads the summary and renders this; the layout has already ruled out everyone
// but operators. Rendered with renderToStaticMarkup, as in tests/unit/notebooks/member-list.test.tsx.
//
// Pinned copy (German, no em dash): the h1 "Betrieb" and the section headings "Fehler beim Import",
// "Kosten pro Tag", "Antwortzeit (p95)", "Anfragen nach Status", "Heutiges Gesamtbudget",
// "Einstellungen" and "Eval"; the window links "7 Tage" and "30 Tage".
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { OpsView } from "@/app/(app)/ops/ops-view";
import { parseOpsSummary } from "@/lib/server/ops/summary";

const NOW = new Date("2026-10-20T10:00:00Z");
const USER_ID = "11111111-1111-4111-8111-111111111111";

function raw(over: Record<string, unknown> = {}) {
  return {
    days: 7,
    ingest_errors: [
      { category: "no_text", count: 3 },
      { category: "url_blocked", count: 1 },
      { category: "unknown", count: 2 },
    ],
    cost_per_day: [{ day: "2026-10-19", kind: "chat", cost_usd: 0.0123 }],
    latency_p95: [
      { kind: "chat", p95_ms: 1905 },
      { kind: "embedding", p95_ms: 50 },
    ],
    status_counts: [
      { kind: "chat", status: "settled", count: 20 },
      { kind: "chat", status: "failed", count: 1 },
    ],
    global_today: { spent_usd: 0.25, limit_usd: 5 },
    settings: { model_features_enabled: true, daily_limit_usd: 0.5, daily_limit_anonymous_usd: 0.2, global_daily_limit_usd: 5 },
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

function render(over: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(OpsView({ summary: parseOpsSummary(raw(over), NOW) }));
}

const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("OpsView: German headings", () => {
  const markup = render();

  it("has the page heading and one heading per section", () => {
    expect(markup).toMatch(/<h1[^>]*>\s*Betrieb\s*<\/h1>/);
    for (const heading of [
      "Fehler beim Import",
      "Kosten pro Tag",
      "Antwortzeit (p95)",
      "Anfragen nach Status",
      "Heutiges Gesamtbudget",
      "Einstellungen",
      "Eval",
    ]) {
      expect(text(markup), heading).toContain(heading);
    }
  });

  it("offers both windows", () => {
    expect(text(markup)).toContain("7 Tage");
    expect(text(markup)).toContain("30 Tage");
  });

  it("uses no em dash", () => {
    expect(markup).not.toContain(String.fromCharCode(0x2014));
  });
});

describe("OpsView: content", () => {
  it("shows ingest errors with the German label and the count, and the unknown label for unknown", () => {
    const t = text(render());
    expect(t).toContain("Kein Text gefunden");
    expect(t).toContain("Adresse nicht erlaubt");
    expect(t).toContain("Unbekannter Fehler");
    expect(t).toMatch(/Kein Text gefunden\s*3/);
  });

  it('says "Keine Fehler" when there are none', () => {
    expect(text(render({ ingest_errors: [] }))).toContain("Keine Fehler");
  });

  it("shows the p95 per kind and the status counts", () => {
    const t = text(render());
    expect(t).toMatch(/1905/);
    expect(t).toMatch(/\b50\b/);
    expect(t).toMatch(/settled|abgeschlossen/i);
    expect(t).toMatch(/\b20\b/);
  });

  it("shows the eval score as passed/total for security and quality", () => {
    const t = text(render());
    expect(t).toContain("5/5");
    expect(t).toContain("9/12");
  });

  it('says "Noch kein Eval-Lauf" when no eval run was recorded', () => {
    expect(text(render({ eval: null }))).toContain("Noch kein Eval-Lauf");
  });

  it("shows the kill switch state: eingeschaltet when on, abgeschaltet when off", () => {
    const settings = (on: boolean) => ({
      model_features_enabled: on,
      daily_limit_usd: 0.5,
      daily_limit_anonymous_usd: 0.2,
      global_daily_limit_usd: 5,
    });
    expect(text(render({ settings: settings(true) }))).toContain("eingeschaltet");
    const off = text(render({ settings: settings(false) }));
    expect(off).toContain("abgeschaltet");
    expect(off).not.toContain("eingeschaltet");
  });

  it("renders zero-filled days without breaking (all costs 0)", () => {
    expect(() => render({ cost_per_day: [] })).not.toThrow();
  });

  it("renders the 30-day window", () => {
    expect(() => render({ days: 30 })).not.toThrow();
  });
});

describe("OpsView: nothing personal and nothing remote", () => {
  it("never renders a user id, even if one is smuggled into the input before parsing", () => {
    // parseOpsSummary rejects it, so the view cannot be built with it at all.
    expect(() => parseOpsSummary(raw({ user_id: USER_ID }), NOW)).toThrow();
    expect(render()).not.toContain(USER_ID);
    expect(render()).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  });

  it("loads nothing remote: no images, scripts, iframes, external links or inline handlers", () => {
    const markup = render();
    expect(markup).not.toMatch(/<(img|script|iframe|object|embed|link|video|audio)\b/i);
    expect(markup).not.toMatch(/https?:\/\//i);
    expect(markup).not.toMatch(/\son[a-z]+\s*=/i);
    expect(markup).not.toMatch(/dangerouslySetInnerHTML/);
  });
});
