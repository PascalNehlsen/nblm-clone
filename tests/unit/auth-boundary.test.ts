// Static guards for PR B1 (auth/session), mirroring the style of
// tests/unit/web-shell.test.tsx and tests/rls/harness.test.ts's source scans:
// no admin-credential-shaped substrings anywhere under apps/web, no
// NEXT_PUBLIC_ variable name that looks like it carries a secret, the two
// server-only Supabase modules are actually marked server-only, and no
// "use client" file imports them (or lib/server/).
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const webDir = path.join(repoRoot, "apps/web");
const skippedDirNames = new Set(["node_modules", ".next"]);
const sourceExtensions = new Set([".ts", ".tsx", ".js", ".mjs"]);

function collectSourceFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (skippedDirNames.has(entry.name)) continue;
      files.push(...collectSourceFiles(path.join(dir, entry.name)));
      continue;
    }
    if (sourceExtensions.has(path.extname(entry.name))) {
      files.push(path.join(dir, entry.name));
    }
  }

  return files;
}

describe("boundary scan: no admin-credential-shaped substrings under apps/web", () => {
  const forbiddenSubstrings = ["service_role", "SERVICE_ROLE", "sb_secret_", "SECRET_KEY", "JWT_SECRET"];

  it("apps/web exists and contains at least one source file", () => {
    expect(fs.existsSync(webDir)).toBe(true);
    expect(collectSourceFiles(webDir).length).toBeGreaterThan(0);
  });

  it("contains none of the forbidden substrings", () => {
    const offenders: string[] = [];
    for (const file of collectSourceFiles(webDir)) {
      const content = fs.readFileSync(file, "utf8");
      for (const needle of forbiddenSubstrings) {
        if (content.includes(needle)) {
          offenders.push(`${path.relative(webDir, file)}: contains "${needle}"`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("no NEXT_PUBLIC_ variable name contains SECRET or SERVICE", () => {
    const pattern = /NEXT_PUBLIC_[A-Z0-9_]*(?:SECRET|SERVICE)[A-Z0-9_]*/g;
    const offenders: string[] = [];
    for (const file of collectSourceFiles(webDir)) {
      const content = fs.readFileSync(file, "utf8");
      const matches = content.match(pattern);
      if (matches) {
        offenders.push(`${path.relative(webDir, file)}: ${matches.join(", ")}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("lib/supabase/server.ts and lib/supabase/proxy.ts are marked server-only", () => {
  const serverFile = path.join(webDir, "lib/supabase/server.ts");
  const proxyLibFile = path.join(webDir, "lib/supabase/proxy.ts");

  it("both files exist", () => {
    expect(fs.existsSync(serverFile), "lib/supabase/server.ts is missing").toBe(true);
    expect(fs.existsSync(proxyLibFile), "lib/supabase/proxy.ts is missing").toBe(true);
  });

  it("both begin with `import \"server-only\"` as their first line", () => {
    for (const file of [serverFile, proxyLibFile]) {
      const firstLine = fs.readFileSync(file, "utf8").split("\n")[0]?.trim();
      expect(firstLine, `${path.relative(webDir, file)} must start with import "server-only"`).toBe(
        'import "server-only";',
      );
    }
  });
});

describe("no \"use client\" file imports a server-only module", () => {
  const forbiddenImportTargets = ["lib/supabase/server", "lib/supabase/proxy", "lib/server/"];

  function isClientComponent(content: string): boolean {
    const firstMeaningfulLine = content
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    return firstMeaningfulLine === '"use client";' || firstMeaningfulLine === "'use client';";
  }

  it("has no offenders", () => {
    const offenders: string[] = [];
    for (const file of collectSourceFiles(webDir).filter((f) => path.extname(f) !== ".mjs")) {
      const content = fs.readFileSync(file, "utf8");
      if (!isClientComponent(content)) continue;

      for (const target of forbiddenImportTargets) {
        if (content.includes(target)) {
          offenders.push(`${path.relative(webDir, file)}: "use client" file imports "${target}"`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
