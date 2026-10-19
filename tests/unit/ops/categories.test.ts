// PR E2: fixed error categories for model calls (AGENTS.md: "fixed categories in
// lib/ops/categories.ts"). Every category needs a German label for the ops page.
import { describe, expect, it } from "vitest";
import { CATEGORY_LABELS, MODEL_ERROR_CATEGORIES } from "@/lib/ops/categories";

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
