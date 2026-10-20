// Source scans: pending buttons on the login page, one cached auth check per
// request, parallel data loads on the notebook page.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const web = (rel: string) => path.join(repoRoot, "apps/web", rel);

function read(file: string): string {
  expect(fs.existsSync(file), `${path.relative(repoRoot, file)} must exist`).toBe(true);
  return fs.readFileSync(file, "utf8");
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("login pending buttons", () => {
  it("the login page uses a client component for the GitHub submit button", () => {
    const page = stripComments(read(web("app/(public)/login/page.tsx")));
    const imports = [...page.matchAll(/import\s+\{([^}]*)\}\s+from\s+["'](\.\/[^"']+)["']/g)];
    const nonDemo = imports.filter((m) => !m[2]!.endsWith("demo-button"));
    expect(nonDemo.length, "page.tsx must import a local submit button component").toBeGreaterThan(0);

    const files = nonDemo
      .map((m) => path.join(web("app/(public)/login"), `${m[2]}.tsx`))
      .filter((file) => fs.existsSync(file));
    expect(files.length).toBeGreaterThan(0);
    const button = files.map((file) => stripComments(fs.readFileSync(file, "utf8"))).find((s) =>
      s.includes("useFormStatus"),
    );
    expect(button, "a local component must use useFormStatus").toBeDefined();
    expect(button!.trimStart().startsWith('"use client"')).toBe(true);
    expect(button).toMatch(/from\s+["']react-dom["']/);
    expect(button).toContain("Anmeldung läuft …");
    expect(button).toContain("Mit GitHub anmelden");
    expect(button).toMatch(/type="submit"/);

    // The idle label no longer lives inline in the server page.
    const usedInPage = nonDemo.some((m) =>
      m[1]!
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .some((name) => new RegExp(`<${name}[\\s/>]`).test(page)),
    );
    expect(usedInPage).toBe(true);
  });

  it("the demo button shows Demo wird vorbereitet … while busy and keeps its idle name", () => {
    const source = stripComments(read(web("app/(public)/login/demo-button.tsx")));
    expect(source).toContain("Demo wird vorbereitet …");
    expect(source).toContain("Demo starten (ohne Anmeldung)");
  });
});

describe("one auth check per request", () => {
  it("lib/supabase/server.ts exports getVerifiedUser wrapped in React cache", () => {
    const source = stripComments(read(web("lib/supabase/server.ts")));
    expect(source).toMatch(/import\s+\{[^}]*\bcache\b[^}]*\}\s+from\s+["']react["']/);
    expect(source).toContain("export const getVerifiedUser = cache(");
  });

  it.each([
    "app/(app)/layout.tsx",
    "app/(app)/page.tsx",
    "app/(app)/notebooks/[id]/page.tsx",
  ])("%s uses getVerifiedUser and no direct auth.getUser", (rel) => {
    const source = stripComments(read(web(rel)));
    expect(source).toContain("getVerifiedUser(");
    expect(source).not.toContain("supabase.auth.getUser(");
    expect(source).not.toMatch(/\.auth\.getUser\(/);
  });
});

describe("notebook access check runs before the loading boundary", () => {
  it("access.ts exports getNotebookForUser wrapped in React cache", () => {
    const source = stripComments(read(web("app/(app)/notebooks/[id]/access.ts")));
    expect(source).toMatch(/import\s+\{[^}]*\bcache\b[^}]*\}\s+from\s+["']react["']/);
    expect(source).toContain("export const getNotebookForUser = cache(");
  });

  it("the notebook layout calls getNotebookForUser from ./access", () => {
    const source = stripComments(read(web("app/(app)/notebooks/[id]/layout.tsx")));
    expect(source).toContain("getNotebookForUser(");
    expect(source).toMatch(/from\s+["']\.\/access["']/);
  });

  it("NavProgress is a client component rendered in the root layout", () => {
    const component = read(web("components/nav-progress.tsx"));
    expect(component.trimStart().startsWith('"use client"')).toBe(true);
    const layout = stripComments(read(web("app/layout.tsx")));
    expect(layout).toContain("<NavProgress />");
  });
});

describe("notebook page loads in parallel", () => {
  it("uses Promise.all for getNotebookForUser, listMembers, listSources and listHistory", () => {
    const source = stripComments(read(web("app/(app)/notebooks/[id]/page.tsx")));
    expect(source).not.toMatch(/\bgetNotebook\(/);
    const all = source.match(/Promise\.all(?:Settled)?\s*\(/);
    expect(all, "Promise.all must be used").not.toBeNull();
    expect(source).toMatch(/Promise\.all\s*\(/);
    const start = source.search(/Promise\.all\s*\(/);
    const block = source.slice(start, start + 800);
    for (const call of ["getNotebookForUser(", "listMembers(", "listSources(", "listHistory("]) {
      expect(block, `${call} must be inside the Promise.all block`).toContain(call);
    }
  });
});
