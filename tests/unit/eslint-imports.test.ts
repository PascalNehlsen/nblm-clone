// Reviewer finding on B1: the no-restricted-imports rule in eslint.config.mjs
// only matches the exact specifier "@supabase/supabase-js" / "@supabase/ssr",
// so a deep subpath import, or one of the packages supabase-js re-exports
// internally (@supabase/auth-js, @supabase/postgrest-js), slips through. It
// also fully `ignores` apps/web/lib/supabase/** for the whole rule block,
// which means the admin-import ban (AGENTS.md: service_role only in
// lib/server/admin/) does not apply there either -- it should.
//
// This runs the real eslint.config.mjs through ESLint's Node API with
// lintText against virtual files, so it exercises the actual config instead
// of re-describing it.
import * as path from "node:path";
import { ESLint, type Linter } from "eslint";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../..");

function createLinter(): ESLint {
  return new ESLint({
    cwd: repoRoot,
    overrideConfigFile: path.join(repoRoot, "eslint.config.mjs"),
  });
}

async function lint(relativeFilePath: string, code: string): Promise<Linter.LintMessage[]> {
  const eslint = createLinter();
  const results = await eslint.lintText(code, { filePath: path.join(repoRoot, relativeFilePath) });
  return results[0]?.messages ?? [];
}

// Either the core rule or its type-aware @typescript-eslint variant counts:
// both enforce the same import ban, and the config may use either (or, during
// a migration between them, briefly both).
const RESTRICTED_IMPORT_RULE_IDS = new Set(["no-restricted-imports", "@typescript-eslint/no-restricted-imports"]);

function flaggedByNoRestrictedImports(messages: Linter.LintMessage[]): boolean {
  return messages.some((message) => message.ruleId !== null && RESTRICTED_IMPORT_RULE_IDS.has(message.ruleId));
}

describe("eslint no-restricted-imports: apps/web/app may not reach Supabase clients or the admin client directly", () => {
  const appFile = "apps/web/app/example.tsx";

  it("flags a value import of createClient from \"@supabase/supabase-js\"", async () => {
    const messages = await lint(
      appFile,
      'import { createClient } from "@supabase/supabase-js";\nexport const x = createClient;\n',
    );
    expect(flaggedByNoRestrictedImports(messages)).toBe(true);
  });

  it("flags a deep subpath import of @supabase/supabase-js", async () => {
    const messages = await lint(
      appFile,
      'import { createClient } from "@supabase/supabase-js/dist/module/index.js";\nexport const x = createClient;\n',
    );
    expect(flaggedByNoRestrictedImports(messages)).toBe(true);
  });

  it('flags "@supabase/ssr"', async () => {
    const messages = await lint(
      appFile,
      'import { createBrowserClient } from "@supabase/ssr";\nexport const x = createBrowserClient;\n',
    );
    expect(flaggedByNoRestrictedImports(messages)).toBe(true);
  });

  it('flags "@supabase/auth-js"', async () => {
    const messages = await lint(
      appFile,
      'import { GoTrueClient } from "@supabase/auth-js";\nexport const x = GoTrueClient;\n',
    );
    expect(flaggedByNoRestrictedImports(messages)).toBe(true);
  });

  it('flags "@supabase/postgrest-js"', async () => {
    const messages = await lint(
      appFile,
      'import { PostgrestClient } from "@supabase/postgrest-js";\nexport const x = PostgrestClient;\n',
    );
    expect(flaggedByNoRestrictedImports(messages)).toBe(true);
  });

  it('flags an alias import of "@/lib/server/admin/x"', async () => {
    const messages = await lint(
      appFile,
      'import { adminClient } from "@/lib/server/admin/x";\nexport const x = adminClient;\n',
    );
    expect(flaggedByNoRestrictedImports(messages)).toBe(true);
  });

  it('flags a relative import of "../lib/server/admin/x"', async () => {
    const messages = await lint(
      appFile,
      'import { adminClient } from "../lib/server/admin/x";\nexport const x = adminClient;\n',
    );
    expect(flaggedByNoRestrictedImports(messages)).toBe(true);
  });

  it("allows a type-only import of SupabaseClient", async () => {
    const messages = await lint(
      appFile,
      'import type { SupabaseClient } from "@supabase/supabase-js";\nexport type Client = SupabaseClient;\n',
    );
    expect(flaggedByNoRestrictedImports(messages)).toBe(false);
  });
});

describe("eslint no-restricted-imports: apps/web/lib/supabase may use the Supabase SDK but never the admin client", () => {
  const libSupabaseFile = "apps/web/lib/supabase/example.ts";

  it("does not flag @supabase/supabase-js inside lib/supabase (that's where the real clients live)", async () => {
    const messages = await lint(
      libSupabaseFile,
      'import { createClient } from "@supabase/supabase-js";\nexport const x = createClient;\n',
    );
    expect(flaggedByNoRestrictedImports(messages)).toBe(false);
  });

  it("still flags an import of lib/server/admin from inside lib/supabase", async () => {
    const messages = await lint(
      libSupabaseFile,
      'import { adminClient } from "../server/admin/x";\nexport const x = adminClient;\n',
    );
    expect(flaggedByNoRestrictedImports(messages)).toBe(true);
  });
});
