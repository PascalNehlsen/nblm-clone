// Boundary: the game day module is a pure server-only decision, with no session,
// database or request-scoped dependencies.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const FILE = new URL("../../../apps/web/lib/server/game-day.ts", import.meta.url);

describe("lib/server/game-day.ts boundary", () => {
  const source = readFileSync(FILE, "utf8");

  it('begins with `import "server-only";`', () => {
    expect(source.split("\n")[0]?.trim()).toBe('import "server-only";');
  });

  it("imports nothing from lib/supabase, admin or next/headers", () => {
    const specifiers = [...source.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1]);
    for (const spec of specifiers) {
      expect(spec, spec).not.toMatch(/supabase/);
      expect(spec, spec).not.toMatch(/admin/);
      expect(spec, spec).not.toBe("next/headers");
    }
  });
});
