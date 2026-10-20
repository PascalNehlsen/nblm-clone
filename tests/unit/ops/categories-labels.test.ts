// AGENTS.md: "Ingestion and provider errors use the fixed categories in lib/ops/categories.ts. No
// new category without updating the ops page." The ops page labels categories through
// categoryLabel (lib/server/ops/summary.ts). This test walks every exported *_ERROR_CATEGORIES list
// of lib/ops/categories.ts, so a category (or a whole new family) added later without a label
// fails here instead of showing "Unbekannter Fehler" on the page.
import { describe, expect, it } from "vitest";
import * as categories from "@/lib/ops/categories";
import { categoryLabel } from "@/lib/server/ops/summary";

const families = (Object.entries(categories) as [string, unknown][]).filter(
  (entry): entry is [string, readonly string[]] => /_ERROR_CATEGORIES$/.test(entry[0]) && Array.isArray(entry[1]),
);

describe("every category of lib/ops/categories.ts has a German label on the ops page", () => {
  it("finds the three families (model, ingest, url)", () => {
    expect(families.map(([name]) => name).sort()).toEqual(
      ["INGEST_ERROR_CATEGORIES", "MODEL_ERROR_CATEGORIES", "URL_ERROR_CATEGORIES"].sort(),
    );
  });

  for (const [name, list] of families) {
    describe(name, () => {
      it.each(list.map((category) => [category]))("%s has a label", (category) => {
        const label = categoryLabel(category);
        expect(label.trim().length).toBeGreaterThan(0);
        expect(label, `${category} falls back to the unknown label`).not.toBe("Unbekannter Fehler");
        expect(label).not.toContain(String.fromCharCode(0x2014)); // no em dash (AGENTS.md)
        expect(label).not.toBe(category); // a label, not the raw key
      });
    });
  }

  it("agrees with sourceErrorLabel, the label the sources list already uses", () => {
    for (const [, list] of families) {
      for (const category of list) expect(categoryLabel(category)).toBe(categories.sourceErrorLabel(category));
    }
  });
});
