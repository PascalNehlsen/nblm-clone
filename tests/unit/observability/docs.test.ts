// Docs must match the code: the Sentry row belongs to the Processors table, and nobody claims
// tracing is off through `tracesSampleRate: 0` (in Sentry v10 that value enables tracing).
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../../..");
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");

describe("Sentry documentation", () => {
  it("the privacy.md Sentry row is part of the Processors table (no blank line before it)", () => {
    const lines = read("docs/privacy.md").split("\n");
    const i = lines.findIndex((l) => l.startsWith("| Sentry"));
    expect(i, "Sentry row").toBeGreaterThan(0);
    expect(lines[i - 1]!.startsWith("|")).toBe(true);
  });

  for (const rel of ["docs/privacy.md", "docs/adr/0022-error-tracking.md", "apps/web/app/(public)/datenschutz/page.tsx"]) {
    it(`${rel} does not claim tracesSampleRate: 0`, () => {
      expect(read(rel)).not.toMatch(/tracesSampleRate\s*:?\s*`?\s*0\b/);
    });
  }

  it("ADR 0022 says tracing is off by leaving tracesSampleRate unset", () => {
    expect(read("docs/adr/0022-error-tracking.md")).toMatch(/tracesSampleRate[^\n]*(unset|not set|absent|omitted)|(unset|not set|absent|omitted)[^\n]*tracesSampleRate/i);
  });
});
