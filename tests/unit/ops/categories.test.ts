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
} from "@/lib/ops/categories";

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
