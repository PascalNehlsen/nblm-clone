import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import * as fs from "node:fs";
import * as path from "node:path";
import RootLayout, { metadata } from "../../apps/web/app/layout";
import Page from "../../apps/web/app/(app)/page";

// apps/web/app/(app)/page.tsx is now an async server component that reads
// the signed-in user (createClient().auth.getUser()) and that user's
// notebooks (listNotebooks()) -- both mocked here so this file stays a pure
// render/markup test, independent of a real Supabase session or database.
// vi.mock calls are hoisted above these imports by vitest, so Page's own
// internal `import { createClient } from "@/lib/supabase/server"` and
// `import { listNotebooks } from "@/lib/notebooks/notebooks"` resolve to
// these mocks (same technique as tests/unit/auth/callback.test.ts).
vi.mock("@/lib/supabase/server", () => {
  const fakeClient = {
    auth: {
      async getUser() {
        return {
          data: { user: { id: "11111111-1111-4111-8111-111111111111", is_anonymous: false } },
          error: null,
        };
      },
    },
  };
  return {
    createClient: vi.fn(async () => fakeClient),
    getVerifiedUser: vi.fn(async () => ({
      supabase: fakeClient,
      user: { id: "11111111-1111-4111-8111-111111111111", is_anonymous: false },
    })),
  };
});

vi.mock("@/lib/notebooks/notebooks", () => ({
  listNotebooks: vi.fn(async () => []),
}));

// Resolve relative to this test file so it is independent of the cwd vitest is
// invoked from.
const repoRoot = path.resolve(import.meta.dirname, "../..");
const webDir = path.join(repoRoot, "apps/web");

describe("apps/web/app/layout.tsx", () => {
  it("renders <html lang=\"de\"> with children inside <body>", () => {
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

  it("exports metadata with title \"nblm-clone\" and a non-empty description", () => {
    expect(metadata).toBeDefined();
    expect(metadata.title).toBe("nblm-clone");
    expect(typeof metadata.description).toBe("string");
    expect((metadata.description as string).trim().length).toBeGreaterThan(0);
  });
});

describe("apps/web/app/page.tsx", () => {
  it("renders exactly one <h1> with text 'Deine Notizbücher'", async () => {
    const markup = renderToStaticMarkup(await Page({}));

    const h1Matches = markup.match(/<h1[^>]*>.*?<\/h1>/gs) ?? [];
    expect(h1Matches).toHaveLength(1);

    const h1Text = h1Matches[0]?.replace(/<[^>]+>/g, "") ?? "";
    expect(h1Text).toBe("Deine Notizbücher");
  });
});

describe("rendered shell loads no remote content", () => {
  it("has no http://, https:// or protocol-relative URLs in src/href attributes", async () => {
    const pageElement = await Page({});
    const markup = renderToStaticMarkup(
      RootLayout({ children: <>{pageElement}</> }),
    );

    const remoteAttrMatches =
      markup.match(/(?:src|href)=["'](?:https?:|\/\/)[^"']*["']/gi) ?? [];
    expect(remoteAttrMatches).toEqual([]);
  });
});

describe("static source guard: no remote fonts or assets", () => {
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

  // Matches a CSS `url(...)` or `@import ...` whose target is remote: an
  // absolute http(s) URL or a protocol-relative `//host/...` URL, with or
  // without quotes. Local absolute paths (`/foo.woff2`) and `data:` URIs must
  // not match.
  function hasRemoteCssReference(content: string): boolean {
    const remoteCssPattern = /(?:@import\s+|url\(\s*)["']?(?:https?:|\/\/)/i;
    return remoteCssPattern.test(content);
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

  it("hasRemoteCssReference flags remote url()/@import targets and ignores local/data ones", () => {
    const mustFlag = [
      '@import url("https://fonts.googleapis.com/css2")',
      '@import "//x.example/a.css"',
      "src: url(https://x/y.woff2)",
    ];
    const mustNotFlag = [
      'url("/local.woff2")',
      "url(data:font/woff2;base64,AAA)",
    ];

    for (const css of mustFlag) {
      expect(hasRemoteCssReference(css)).toBe(true);
    }
    for (const css of mustNotFlag) {
      expect(hasRemoteCssReference(css)).toBe(false);
    }
  });

  it("no .css file under apps/web contains a remote url() or @import target", () => {
    const cssFiles = collectSourceFiles(webDir).filter(
      (file) => path.extname(file) === ".css",
    );
    const offenders = cssFiles.filter((file) => {
      const content = fs.readFileSync(file, "utf8");
      return hasRemoteCssReference(content);
    });

    expect(offenders).toEqual([]);
  });
});
