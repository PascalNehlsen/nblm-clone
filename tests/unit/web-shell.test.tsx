import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ReactElement, ReactNode } from "react";

// Resolve relative to this test file so it is independent of the cwd vitest is
// invoked from.
const repoRoot = path.resolve(import.meta.dirname, "../..");
const webDir = path.join(repoRoot, "apps/web");

describe("apps/web/app/layout.tsx", () => {
  it("renders <html lang=\"de\"> with children inside <body>", async () => {
    const layoutModule = (await import("../../apps/web/app/layout")) as {
      default: (props: { children: ReactNode }) => ReactElement;
    };
    const RootLayout = layoutModule.default;

    const markup = renderToStaticMarkup(
      RootLayout({ children: <p data-testid="marker">Inhalt</p> }),
    );

    expect(markup).toMatch(/^<html lang="de">/);
    const bodyOpenIndex = markup.indexOf("<body");
    const bodyCloseIndex = markup.indexOf("</body>");
    expect(bodyOpenIndex).toBeGreaterThan(-1);
    expect(bodyCloseIndex).toBeGreaterThan(bodyOpenIndex);

    const bodyContent = markup.slice(bodyOpenIndex, bodyCloseIndex);
    expect(bodyContent).toContain("Inhalt");
  });

  it("exports metadata with the exact German title and a non-empty German description", async () => {
    const layoutModule = (await import("../../apps/web/app/layout")) as {
      metadata: { title?: unknown; description?: unknown };
    };
    const { metadata } = layoutModule;

    expect(metadata).toBeDefined();
    expect(metadata.title).toBe("nblm-clone");
    expect(typeof metadata.description).toBe("string");
    expect((metadata.description as string).trim().length).toBeGreaterThan(0);
  });
});

describe("apps/web/app/page.tsx", () => {
  it("renders exactly one <h1> with text 'Deine Notizbücher'", async () => {
    const pageModule = (await import("../../apps/web/app/page")) as {
      default: () => ReactElement;
    };
    const Page = pageModule.default;

    const markup = renderToStaticMarkup(Page());

    const h1Matches = markup.match(/<h1[^>]*>.*?<\/h1>/gs) ?? [];
    expect(h1Matches).toHaveLength(1);

    const h1Text = h1Matches[0]?.replace(/<[^>]+>/g, "") ?? "";
    expect(h1Text).toBe("Deine Notizbücher");
  });
});

describe("rendered shell loads no remote content", () => {
  it("has no http:// or https:// in src/href attributes and no Google Fonts <link>", async () => {
    const layoutModule = (await import("../../apps/web/app/layout")) as {
      default: (props: { children: ReactNode }) => ReactElement;
    };
    const pageModule = (await import("../../apps/web/app/page")) as {
      default: () => ReactElement;
    };

    const pageMarkup = renderToStaticMarkup(pageModule.default());
    const fullMarkup = renderToStaticMarkup(
      layoutModule.default({ children: <>{pageModule.default()}</> }),
    );
    const combined = `${fullMarkup}\n${pageMarkup}`;

    const remoteAttrMatches =
      combined.match(/(?:src|href)=["'](https?:)[^"']*["']/gi) ?? [];
    expect(remoteAttrMatches).toEqual([]);

    expect(combined).not.toMatch(/<link[^>]*fonts\.googleapis\.com/i);
    expect(combined).not.toMatch(/<link[^>]*fonts\.gstatic\.com/i);
  });
});

describe("static source guard: no next/font/google usage", () => {
  const sourceExtensions = new Set([".ts", ".tsx", ".js", ".mjs", ".css"]);
  const skippedDirNames = new Set(["node_modules", ".next"]);

  function collectSourceFiles(dir: string): string[] {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (skippedDirNames.has(entry.name)) {
          continue;
        }
        files.push(...collectSourceFiles(path.join(dir, entry.name)));
        continue;
      }

      if (sourceExtensions.has(path.extname(entry.name))) {
        files.push(path.join(dir, entry.name));
      }
    }

    return files;
  }

  it("apps/web exists and contains at least one source file", () => {
    expect(fs.existsSync(webDir)).toBe(true);
    expect(fs.statSync(webDir).isDirectory()).toBe(true);

    const sourceFiles = collectSourceFiles(webDir);
    expect(sourceFiles.length).toBeGreaterThan(0);
  });

  it("no source file under apps/web references next/font/google", () => {
    const sourceFiles = collectSourceFiles(webDir);
    const offenders = sourceFiles.filter((file) => {
      const content = fs.readFileSync(file, "utf8");
      return content.includes("next/font/google");
    });

    expect(offenders).toEqual([]);
  });
});
