// PR E2: fixed error categories for model calls (AGENTS.md: "fixed categories in
// lib/ops/categories.ts"). Every category needs a German label for the ops page.
//
// C1 ingestion (plan approved by Pascal, 2026-10-19) extends this file with the
// ingest categories (.git/C1-API-SPEC.md, "categories.ts"): no overlap with the
// model categories, and sourceErrorLabel() covering both families plus unknown input.
import { describe, expect, it } from "vitest";
import {
  CATEGORY_LABELS,
  INGEST_CATEGORY_LABELS,
  INGEST_ERROR_CATEGORIES,
  MODEL_ERROR_CATEGORIES,
  sourceErrorLabel,
  URL_CATEGORY_LABELS,
  URL_ERROR_CATEGORIES,
} from "@/lib/ops/categories";

// Built from code points so the German labels cannot be normalized silently.
const UE = String.fromCharCode(0x00fc);
const SS = String.fromCharCode(0x00df);
const EXPECTED_URL_LABELS: Record<string, string> = {
  url_invalid: `Ung${UE}ltige Adresse`,
  url_blocked: "Adresse nicht erlaubt",
  url_dns_failed: "Adresse nicht gefunden",
  url_unreachable: "Seite nicht erreichbar",
  url_timeout: `Zeit${UE}berschreitung beim Abruf`,
  url_http_error: "Seite antwortet mit Fehler",
  url_too_many_redirects: "Zu viele Weiterleitungen",
  url_too_large: `Seite zu gro${SS}`,
  url_unsupported_type: `Seitentyp nicht unterst${UE}tzt`,
};

describe("MODEL_ERROR_CATEGORIES", () => {
  it("has no duplicates", () => {
    expect(new Set(MODEL_ERROR_CATEGORIES).size).toBe(MODEL_ERROR_CATEGORIES.length);
  });

  it("every category matches ^[a-z_]{1,40}$ (matches the DB check constraint)", () => {
    for (const category of MODEL_ERROR_CATEGORIES) {
      expect(category).toMatch(/^[a-z_]{1,40}$/);
    }
  });

  it("includes the budget and kill-switch outcomes verbatim (ADR 0006 outcome names)", () => {
    expect(MODEL_ERROR_CATEGORIES).toContain("kill_switch_on");
    expect(MODEL_ERROR_CATEGORIES).toContain("budget_exceeded");
    expect(MODEL_ERROR_CATEGORIES).toContain("global_budget_exceeded");
  });
});

describe("CATEGORY_LABELS", () => {
  it("has exactly one label per category, keys matching the category list", () => {
    const keys = Object.keys(CATEGORY_LABELS).sort();
    expect(keys).toEqual([...MODEL_ERROR_CATEGORIES].sort());
  });

  it("every label is a non-empty German string without an em dash", () => {
    for (const category of MODEL_ERROR_CATEGORIES) {
      const label = CATEGORY_LABELS[category];
      expect(typeof label).toBe("string");
      expect(label.trim().length).toBeGreaterThan(0);
      expect(label).not.toContain("—"); // em dash, forbidden by AGENTS.md conventions
    }
  });
});

describe("INGEST_ERROR_CATEGORIES", () => {
  it("has no duplicates", () => {
    expect(new Set(INGEST_ERROR_CATEGORIES).size).toBe(INGEST_ERROR_CATEGORIES.length);
  });

  it("every category matches ^[a-z_]{1,40}$ (matches the DB check constraint)", () => {
    for (const category of INGEST_ERROR_CATEGORIES) {
      expect(category).toMatch(/^[a-z_]{1,40}$/);
    }
  });

  it("has no overlap with MODEL_ERROR_CATEGORIES", () => {
    const modelSet = new Set<string>(MODEL_ERROR_CATEGORIES);
    const overlap = INGEST_ERROR_CATEGORIES.filter((category) => modelSet.has(category));
    expect(overlap).toEqual([]);
  });

  it("every category has a non-empty label without an em dash", () => {
    for (const category of INGEST_ERROR_CATEGORIES) {
      const label = INGEST_CATEGORY_LABELS[category];
      expect(typeof label).toBe("string");
      expect(label.trim().length).toBeGreaterThan(0);
      expect(label).not.toContain("—");
    }
  });
});

// C2 URL import (plan approved by Pascal, 2026-10-19): nine fetch categories.
describe("URL_ERROR_CATEGORIES", () => {
  it("is exactly the nine planned categories, without duplicates", () => {
    expect([...URL_ERROR_CATEGORIES].sort()).toEqual(Object.keys(EXPECTED_URL_LABELS).sort());
    expect(new Set(URL_ERROR_CATEGORIES).size).toBe(URL_ERROR_CATEGORIES.length);
  });

  it("every category matches ^[a-z_]{1,40}$ (matches the DB check constraint)", () => {
    for (const category of URL_ERROR_CATEGORIES) {
      expect(category).toMatch(/^[a-z_]{1,40}$/);
    }
  });

  it("has no overlap with the ingest and model lists", () => {
    const others = new Set<string>([...INGEST_ERROR_CATEGORIES, ...MODEL_ERROR_CATEGORIES]);
    expect(URL_ERROR_CATEGORIES.filter((category) => others.has(category))).toEqual([]);
  });

  it("has one German label per category, exactly as planned, without an em dash", () => {
    expect(Object.keys(URL_CATEGORY_LABELS).sort()).toEqual([...URL_ERROR_CATEGORIES].sort());
    for (const category of URL_ERROR_CATEGORIES) {
      expect(URL_CATEGORY_LABELS[category]).toBe(EXPECTED_URL_LABELS[category]);
      expect(URL_CATEGORY_LABELS[category]).not.toContain(String.fromCharCode(0x2014));
    }
  });
});

describe("sourceErrorLabel for URL categories", () => {
  it('returns "Adresse nicht erlaubt" for url_blocked', () => {
    expect(sourceErrorLabel("url_blocked")).toBe("Adresse nicht erlaubt");
  });

  it("returns the planned label for every URL category", () => {
    for (const category of URL_ERROR_CATEGORIES) {
      expect(sourceErrorLabel(category)).toBe(EXPECTED_URL_LABELS[category]);
    }
  });
});

describe("sourceErrorLabel", () => {
  it('returns "Modell nicht konfiguriert" for model_not_configured', () => {
    expect(sourceErrorLabel("model_not_configured")).toBe("Modell nicht konfiguriert");
  });

  it("returns the ingest label for an ingest category (no_text)", () => {
    expect(sourceErrorLabel("no_text")).toBe(INGEST_CATEGORY_LABELS.no_text);
  });

  it('returns "Unbekannter Fehler" for null', () => {
    expect(sourceErrorLabel(null)).toBe("Unbekannter Fehler");
  });

  it('returns "Unbekannter Fehler" for an unrecognized category string', () => {
    expect(sourceErrorLabel("whatever_else")).toBe("Unbekannter Fehler");
  });
});
