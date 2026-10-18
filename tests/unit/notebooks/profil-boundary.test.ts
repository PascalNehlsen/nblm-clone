// Mirrors tests/unit/auth-boundary.test.ts's "no 'use client' file imports a
// server-only module" scan, but pins down the one component the B2 plan
// names explicitly: the profil page's copy-id button must be a client
// component (it needs an onClick/clipboard access) yet must import nothing
// from lib/supabase or lib/server -- the id it copies is passed in as a
// prop from the server-rendered profil page, never fetched by the client
// component itself.
//
// Expected path (communicated to the builder): apps/web/app/(app)/profil/copy-id-button.tsx
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const copyButtonFile = path.join(repoRoot, "apps/web/app/(app)/profil/copy-id-button.tsx");

describe("profil copy-id-button: client component, no server-only imports", () => {
  it("exists at apps/web/app/(app)/profil/copy-id-button.tsx", () => {
    expect(
      fs.existsSync(copyButtonFile),
      "expected apps/web/app/(app)/profil/copy-id-button.tsx to exist",
    ).toBe(true);
  });

  it('starts with "use client" as its first meaningful line', () => {
    const content = fs.readFileSync(copyButtonFile, "utf8");
    const firstMeaningfulLine = content
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    expect(firstMeaningfulLine).toBe('"use client";');
  });

  it("imports nothing from lib/supabase or lib/server", () => {
    const content = fs.readFileSync(copyButtonFile, "utf8");
    expect(content).not.toMatch(/lib\/supabase/);
    expect(content).not.toMatch(/lib\/server/);
  });
});
