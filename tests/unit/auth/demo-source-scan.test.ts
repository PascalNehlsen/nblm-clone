// Source scans for the F2 demo login (spec .git/F2-SPEC.md):
// - lib/supabase/client.ts (browser) reads only the two public env names, as
//   `process.env.NEXT_PUBLIC_*` literals so Next inlines them.
// - login/demo-button.tsx never puts a <script> tag in its JSX and builds the
//   Cloudflare script URL only inside an indented handler, never at module top level,
//   never in an effect, so nothing reaches Cloudflare before the click.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const CLIENT = path.join(repoRoot, "apps/web/lib/supabase/client.ts");
const BUTTON = path.join(repoRoot, "apps/web/app/(public)/login/demo-button.tsx");
const LOGIN_PAGE = path.join(repoRoot, "apps/web/app/(public)/login/page.tsx");

function read(file: string): string {
  expect(fs.existsSync(file), `${path.relative(repoRoot, file)} must exist`).toBe(true);
  return fs.readFileSync(file, "utf8");
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("lib/supabase/client.ts", () => {
  it("is a browser client built with createBrowserClient", () => {
    const source = stripComments(read(CLIENT));
    expect(source).toContain("createBrowserClient");
    expect(source).toContain("@supabase/ssr");
    expect(source).toMatch(/export function createBrowserSupabase\s*\(/);
  });

  it("reads exactly the two public env names, as process.env literals", () => {
    const source = stripComments(read(CLIENT));
    const names = [...source.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((m) => m[1]);
    expect(new Set(names)).toEqual(new Set(["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"]));
  });

  it("uses no dynamic env access and no other env source", () => {
    const source = stripComments(read(CLIENT));
    expect(source).not.toMatch(/process\.env\s*\[/);
    expect(source).not.toMatch(/process\.env\s*[,;)}]/);
    expect(source).not.toMatch(/import\.meta\.env/);
    expect(source).not.toMatch(/SERVICE_ROLE|SECRET|server-only/i);
  });
});

describe("login/demo-button.tsx", () => {
  it("is a client component", () => {
    const source = read(BUTTON);
    expect(source.trimStart().startsWith('"use client"')).toBe(true);
    expect(source).toMatch(/export function DemoButton\s*\(/);
  });

  it("has no <script tag and no next/script import", () => {
    const source = stripComments(read(BUTTON));
    expect(source).not.toContain("<script");
    expect(source).not.toContain("<Script");
    expect(source).not.toMatch(/from\s+["']next\/script["']/);
  });

  it("builds the Turnstile URL only in an indented handler, not at module level or in an effect", () => {
    const source = stripComments(read(BUTTON));
    const lines = source.split("\n");
    const hits = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => line.includes("challenges.cloudflare.com"));
    expect(hits.length).toBeGreaterThan(0);
    for (const { line } of hits) {
      expect(line).toMatch(/^\s{4,}\S/); // inside a function body, not top level
    }
    expect(source).not.toMatch(/useEffect|useLayoutEffect/);
    // the explicit render mode is part of the URL
    expect(source).toContain("render=explicit");
    // the script is created from code, and only after the first hit of the URL's own handler
    expect(source).toMatch(/createElement\(\s*["']script["']\s*\)/);
  });

  it("shows the button text, the 24 hour line and the sicherheitspruefung alert", () => {
    const source = read(BUTTON);
    expect(source).toContain("Demo starten (ohne Anmeldung)");
    expect(source).toContain("Die Demo-Daten werden nach 24 Stunden gelöscht.");
    expect(source).toContain('role="alert"');
    expect(source).toMatch(/sicherheitspruefung/);
    expect(source).toMatch(/signInAnonymously/);
    expect(source).toMatch(/captchaToken/);
  });
});

describe("login/page.tsx", () => {
  it("renders DemoButton with the public site key or null", () => {
    const source = stripComments(read(LOGIN_PAGE));
    expect(source).toMatch(/<DemoButton\s+siteKey=\{process\.env\.NEXT_PUBLIC_TURNSTILE_SITE_KEY \?\? null\}\s*\/>/);
  });
});
