// AGENTS.md: "No em dashes in docs or UI text." This scans the app and lib
// code added for auth/session (and everything else under these two
// directories going forward) for the U+2014 em dash character.
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const targets = [path.join(repoRoot, "apps/web/app"), path.join(repoRoot, "apps/web/lib")];
const skippedDirNames = new Set(["node_modules", ".next"]);
const EM_DASH = "—";

function collectFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (skippedDirNames.has(entry.name)) continue;
      files.push(...collectFiles(path.join(dir, entry.name)));
      continue;
    }
    if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      files.push(path.join(dir, entry.name));
    }
  }

  return files;
}

describe("no em dash under apps/web/app and apps/web/lib", () => {
  it("apps/web/app and apps/web/lib exist", () => {
    for (const dir of targets) {
      expect(fs.existsSync(dir), `expected ${path.relative(repoRoot, dir)} to exist`).toBe(true);
    }
  });

  it("contains no U+2014 em dash in any .ts/.tsx file", () => {
    const offenders: string[] = [];
    for (const dir of targets) {
      for (const file of collectFiles(dir)) {
        const content = fs.readFileSync(file, "utf8");
        if (content.includes(EM_DASH)) {
          offenders.push(path.relative(repoRoot, file));
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
