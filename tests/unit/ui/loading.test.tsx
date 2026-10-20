import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import NotebookLoading from "../../../apps/web/app/(app)/notebooks/[id]/loading";

const repoRoot = path.resolve(import.meta.dirname, "../../..");

describe("(app)/notebooks/[id]/loading.tsx", () => {
  it("renders a busy status region that says Wird geladen", () => {
    const markup = renderToStaticMarkup(<NotebookLoading />);
    expect(markup).toMatch(/role="status"/);
    expect(markup).toMatch(/aria-busy="true"/);
    expect(markup).toContain("Wird geladen");
  });

  it("puts role=status and aria-busy on the same element", () => {
    const markup = renderToStaticMarkup(<NotebookLoading />);
    const tags = markup.match(/<[a-z][^>]*>/g) ?? [];
    expect(tags.some((tag) => /role="status"/.test(tag) && /aria-busy="true"/.test(tag))).toBe(true);
  });
});

describe("no group-level loading boundary", () => {
  it("apps/web/app/(app)/loading.tsx does not exist (a missing notebook must stay a 404)", () => {
    for (const ext of ["tsx", "ts", "jsx", "js"]) {
      expect(fs.existsSync(path.join(repoRoot, `apps/web/app/(app)/loading.${ext}`))).toBe(false);
    }
  });
});
