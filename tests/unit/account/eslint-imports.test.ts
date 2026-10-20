// Account deletion adds lib/server/admin/accounts.ts (second holder of the secret key). The real
// eslint.config.mjs, run through ESLint's Node API on virtual files (same technique as
// tests/unit/eslint-imports.test.ts), must say:
//   - lib/server/account/delete-account.ts alone may import lib/server/admin/accounts
//   - lib/server/admin/usage.ts alone may import values from @supabase/supabase-js there
//     (accounts.ts uses fetch: full SUPABASE_IMPORTS ban, type imports allowed)
//   - nothing else may import it: not the profil server action, not call.ts, not any other file
//     in lib/server/account/, lib/notebooks, lib/supabase or app/
//   - the exceptions are narrow: delete-account.ts still may not import admin/usage, other
//     admin files, the bare admin directory or the Supabase SDK
import * as path from "node:path";
import { ESLint, type Linter } from "eslint";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const eslint = new ESLint({ cwd: repoRoot, overrideConfigFile: path.join(repoRoot, "eslint.config.mjs") });

async function lint(relativeFilePath: string, code: string): Promise<Linter.LintMessage[]> {
  const results = await eslint.lintText(code, { filePath: path.join(repoRoot, relativeFilePath) });
  return results[0]?.messages ?? [];
}

const RESTRICTED = new Set(["no-restricted-imports", "@typescript-eslint/no-restricted-imports"]);

function flagged(messages: Linter.LintMessage[]): boolean {
  return messages.some((message) => message.ruleId !== null && RESTRICTED.has(message.ruleId));
}

const DELETE_ACCOUNT = "apps/web/lib/server/account/delete-account.ts";

describe("only lib/server/account/delete-account.ts may import lib/server/admin/accounts", () => {
  it.each(["../admin/accounts", "@/lib/server/admin/accounts"])("does not flag delete-account.ts importing %s", async (specifier) => {
    const messages = await lint(
      DELETE_ACCOUNT,
      `import { deleteAuthUser } from "${specifier}";\nexport const x = deleteAuthUser;\n`,
    );
    expect(flagged(messages)).toBe(false);
  });

  it.each([
    ["apps/web/app/x.ts", "@/lib/server/admin/accounts"],
    ["apps/web/app/(app)/profil/actions.ts", "@/lib/server/admin/accounts"],
    ["apps/web/app/(app)/profil/actions.ts", "../../../lib/server/admin/accounts"],
    ["apps/web/lib/server/model/call.ts", "../admin/accounts"],
    ["apps/web/lib/server/model/call.ts", "@/lib/server/admin/accounts"],
    ["apps/web/lib/server/admin/usage.ts", "./accounts"],
    ["apps/web/lib/server/account/other.ts", "../admin/accounts"],
    ["apps/web/lib/server/account/other.ts", "@/lib/server/admin/accounts"],
    ["apps/web/lib/notebooks/x.ts", "@/lib/server/admin/accounts"],
    // lib/supabase/** is exempted from the SDK ban, but that exemption must not extend here.
    ["apps/web/lib/supabase/x.ts", "../server/admin/accounts"],
    ["apps/web/app/x/page.jsx", "@/lib/server/admin/accounts"],
    ["apps/web/lib/x.cjs", "@/lib/server/admin/accounts"],
    ["apps/web/lib/x.mts", "@/lib/server/admin/accounts"],
  ] as const)("flags %s importing %s", async (file, specifier) => {
    const messages = await lint(file, `import { deleteAuthUser } from "${specifier}";\nexport const x = deleteAuthUser;\n`);
    expect(flagged(messages)).toBe(true);
  });

  it("flags a re-export of admin/accounts from another file", async () => {
    const messages = await lint("apps/web/app/x.ts", 'export { deleteAuthUser } from "@/lib/server/admin/accounts";\n');
    expect(flagged(messages)).toBe(true);
  });
});

describe("the delete-account.ts exception is narrow", () => {
  it.each([
    ["../admin/usage", "reserve"],
    ["@/lib/server/admin/usage", "reserve"],
    ["../admin/other", "x"],
    ["@/lib/server/admin/other", "x"],
    ["../admin", "x"],
  ])("still flags delete-account.ts importing %s", async (specifier, name) => {
    const messages = await lint(DELETE_ACCOUNT, `import { ${name} } from "${specifier}";\nexport const y = ${name};\n`);
    expect(flagged(messages)).toBe(true);
  });

  it("still flags delete-account.ts importing @supabase/supabase-js (the client is injected, never built here)", async () => {
    const messages = await lint(
      DELETE_ACCOUNT,
      'import { createClient } from "@supabase/supabase-js";\nexport const x = createClient;\n',
    );
    expect(flagged(messages)).toBe(true);
  });

  it("allows delete-account.ts a type-only SupabaseClient import and the notebooks library", async () => {
    const messages = await lint(
      DELETE_ACCOUNT,
      'import type { SupabaseClient } from "@supabase/supabase-js";\nimport { deleteNotebook } from "../../notebooks/notebooks";\nexport type C = SupabaseClient;\nexport const x = deleteNotebook;\n',
    );
    expect(flagged(messages)).toBe(false);
  });
});

describe("lib/server/admin/accounts.ts may import the Supabase SDK, nothing else may via the admin directory", () => {
  // This expectation flipped by an approved change: accounts.ts talks to the admin API through
  // fetch, so it gets the full SUPABASE_IMPORTS ban (type imports allowed). usage.ts keeps its
  // exception for @supabase/supabase-js.
  it("flags accounts.ts importing a value (createClient) from @supabase/supabase-js", async () => {
    const messages = await lint(
      "apps/web/lib/server/admin/accounts.ts",
      'import { createClient } from "@supabase/supabase-js";\nexport const x = createClient;\n',
    );
    expect(flagged(messages)).toBe(true);
  });

  it("does not flag accounts.ts importing a type from @supabase/supabase-js", async () => {
    const messages = await lint(
      "apps/web/lib/server/admin/accounts.ts",
      'import type { SupabaseClient } from "@supabase/supabase-js";\nexport type C = SupabaseClient;\n',
    );
    expect(flagged(messages)).toBe(false);
  });

  it("still does not flag usage.ts importing createClient from @supabase/supabase-js", async () => {
    const messages = await lint(
      "apps/web/lib/server/admin/usage.ts",
      'import { createClient } from "@supabase/supabase-js";\nexport const x = createClient;\n',
    );
    expect(flagged(messages)).toBe(false);
  });

  it("still flags accounts.ts importing the sibling admin/usage module", async () => {
    const messages = await lint("apps/web/lib/server/admin/accounts.ts", 'import { reserve } from "./usage";\nexport const x = reserve;\n');
    expect(flagged(messages)).toBe(true);
  });

  it("still flags usage.ts-style access: delete-account.ts importing @supabase/auth-js or postgrest-js", async () => {
    for (const pkg of ["@supabase/auth-js", "@supabase/postgrest-js"]) {
      const messages = await lint(DELETE_ACCOUNT, `import * as sdk from "${pkg}";\nexport const x = sdk;\n`);
      expect(flagged(messages), pkg).toBe(true);
    }
  });
});
