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

// PR E2 (model call wrapper): call.ts is the one documented importer of
// lib/server/admin/usage (ADR 0006: "the secret key lives in one server module
// ... PR E2", AGENTS.md: "service_role only in server code under
// lib/server/admin/"). The broad ADMIN_IMPORTS ban must get a narrow exception
// for exactly that file, not for the whole lib/server/model directory, and not
// for app code or other lib/ callers.
describe("eslint no-restricted-imports: apps/web/lib/server/model/call.ts alone may import lib/server/admin/usage", () => {
  const callFile = "apps/web/lib/server/model/call.ts";

  it("does not flag a relative import of ../admin/usage from call.ts", async () => {
    const messages = await lint(callFile, 'import { reserve } from "../admin/usage";\nexport const x = reserve;\n');
    expect(flaggedByNoRestrictedImports(messages)).toBe(false);
  });

  it("does not flag the alias import of @/lib/server/admin/usage from call.ts", async () => {
    const messages = await lint(
      callFile,
      'import { reserve } from "@/lib/server/admin/usage";\nexport const x = reserve;\n',
    );
    expect(flaggedByNoRestrictedImports(messages)).toBe(false);
  });

  it("still flags apps/web/app/x.ts importing lib/server/admin/usage", async () => {
    const messages = await lint(
      "apps/web/app/x.ts",
      'import { reserve } from "@/lib/server/admin/usage";\nexport const x = reserve;\n',
    );
    expect(flaggedByNoRestrictedImports(messages)).toBe(true);
  });

  it("still flags another file under lib/server/model importing lib/server/admin/usage", async () => {
    const messages = await lint(
      "apps/web/lib/server/model/other.ts",
      'import { reserve } from "../admin/usage";\nexport const x = reserve;\n',
    );
    expect(flaggedByNoRestrictedImports(messages)).toBe(true);
  });

  it("still flags apps/web/lib/notebooks/x.ts importing lib/server/admin/usage", async () => {
    const messages = await lint(
      "apps/web/lib/notebooks/x.ts",
      'import { reserve } from "@/lib/server/admin/usage";\nexport const x = reserve;\n',
    );
    expect(flaggedByNoRestrictedImports(messages)).toBe(true);
  });

  // B1 fix: the eslint `files` glob now covers .jsx/.cjs/.mts/.cts too, since
  // Next serves .jsx (page.jsx, route.jsx) and the codebase can contain the
  // others. The ban must still catch the admin import in each of them.
  it.each(["apps/web/app/x/page.jsx", "apps/web/lib/x.cjs", "apps/web/lib/x.mts"] as const)(
    "still flags %s importing lib/server/admin/usage",
    async (file) => {
      const messages = await lint(file, 'import { reserve } from "@/lib/server/admin/usage";\nexport const x = reserve;\n');
      expect(flaggedByNoRestrictedImports(messages)).toBe(true);
    },
  );

  // The exception is for the usage.ts module only, not the whole admin directory:
  // call.ts importing any other file (or the bare directory) under lib/server/admin
  // must still be flagged.
  it("still flags call.ts importing a relative sibling other than usage", async () => {
    const messages = await lint(
      callFile,
      'import { x } from "../admin/other";\nexport const y = x;\n',
    );
    expect(flaggedByNoRestrictedImports(messages)).toBe(true);
  });

  it("still flags call.ts importing the alias form of a sibling other than usage", async () => {
    const messages = await lint(
      callFile,
      'import { x } from "@/lib/server/admin/other";\nexport const y = x;\n',
    );
    expect(flaggedByNoRestrictedImports(messages)).toBe(true);
  });

  it("still flags call.ts importing the bare admin directory", async () => {
    const messages = await lint(callFile, 'import { x } from "../admin";\nexport const y = x;\n');
    expect(flaggedByNoRestrictedImports(messages)).toBe(true);
  });

  // Review gap: a re-export is still an import of the banned specifier, and
  // no-restricted-imports treats it the same, but it is cheap to pin down.
  it("flags apps/web/app/x.ts re-exporting from lib/server/admin/usage", async () => {
    const messages = await lint("apps/web/app/x.ts", 'export { reserve } from "@/lib/server/admin/usage";\n');
    expect(flaggedByNoRestrictedImports(messages)).toBe(true);
  });
});

// ADR 0006: the admin usage module is the one place allowed to construct a
// service_role client with @supabase/supabase-js; everywhere else under
// apps/web the @supabase/* ban (further up in this file) still applies,
// including other files under lib/server/admin and lib/server/model/call.ts
// itself (which may import the *functions* from usage.ts, not the SDK).
describe("eslint no-restricted-imports: apps/web/lib/server/admin/usage.ts alone may import @supabase/supabase-js", () => {
  const usageFile = "apps/web/lib/server/admin/usage.ts";

  it("does not flag a value import of createClient from @supabase/supabase-js", async () => {
    const messages = await lint(
      usageFile,
      'import { createClient } from "@supabase/supabase-js";\nexport const x = createClient;\n',
    );
    expect(flaggedByNoRestrictedImports(messages)).toBe(false);
  });

  it("still flags another file under lib/server/admin importing @supabase/supabase-js", async () => {
    const messages = await lint(
      "apps/web/lib/server/admin/other.ts",
      'import { createClient } from "@supabase/supabase-js";\nexport const x = createClient;\n',
    );
    expect(flaggedByNoRestrictedImports(messages)).toBe(true);
  });

  it("still flags lib/server/model/call.ts importing @supabase/supabase-js directly", async () => {
    const messages = await lint(
      "apps/web/lib/server/model/call.ts",
      'import { createClient } from "@supabase/supabase-js";\nexport const x = createClient;\n',
    );
    expect(flaggedByNoRestrictedImports(messages)).toBe(true);
  });
});

// Reviewer finding on E2 (2026-10-19, approved): createModelCallerForTests
// accepts injectable deps (including usage.reserve/settle), so it could bypass
// the budget check if production code ever imported it. Nothing under apps/web
// may import lib/server/model/testing, in any form, including from call.ts
// itself.
describe("eslint no-restricted-imports: nothing under apps/web may import lib/server/model/testing", () => {
  it.each([
    ["apps/web/app/x.ts", "@/lib/server/model/testing"],
    ["apps/web/lib/server/model/other.ts", "./testing"],
    ["apps/web/lib/server/model/call.ts", "@/lib/server/model/testing"],
    // Review gap: lib/supabase/** is exempted from the @supabase/* ban further
    // up in this file, but that exemption must not extend to this rule.
    ["apps/web/lib/supabase/x.ts", "@/lib/server/model/testing"],
  ] as const)("flags %s importing %s", async (file, specifier) => {
    const messages = await lint(
      file,
      `import { createModelCallerForTests } from "${specifier}";\nexport const x = createModelCallerForTests;\n`,
    );
    expect(flaggedByNoRestrictedImports(messages)).toBe(true);
  });
});

// call-core.ts holds the engine (buildModelCaller, with all deps required).
// Only the two production-shaped wrappers may reach it: call.ts (which binds
// the real deps) and testing.ts (which binds real deps for whatever the test
// omits). Everything else, including other app code, must go through one of
// those two, never the engine directly.
describe("eslint no-restricted-imports: only call.ts and testing.ts may import lib/server/model/call-core", () => {
  it.each([
    ["apps/web/app/x.ts", "@/lib/server/model/call-core"],
    ["apps/web/lib/server/model/other.ts", "./call-core"],
    // Review gap: lib/supabase/** is exempted from the @supabase/* ban further
    // up in this file, but that exemption must not extend to this rule either.
    ["apps/web/lib/supabase/x.ts", "@/lib/server/model/call-core"],
  ] as const)("flags %s importing %s", async (file, specifier) => {
    const messages = await lint(
      file,
      `import { buildModelCaller } from "${specifier}";\nexport const x = buildModelCaller;\n`,
    );
    expect(flaggedByNoRestrictedImports(messages)).toBe(true);
  });

  // Review gap: a re-export is still an import of the banned specifier.
  it("flags apps/web/lib/server/model/other.ts re-exporting everything from ./call-core", async () => {
    const messages = await lint("apps/web/lib/server/model/other.ts", 'export * from "./call-core";\n');
    expect(flaggedByNoRestrictedImports(messages)).toBe(true);
  });

  it.each([
    ["apps/web/lib/server/model/call.ts", "./call-core"],
    ["apps/web/lib/server/model/testing.ts", "./call-core"],
  ] as const)("does not flag %s importing %s", async (file, specifier) => {
    const messages = await lint(
      file,
      `import { buildModelCaller } from "${specifier}";\nexport const x = buildModelCaller;\n`,
    );
    expect(flaggedByNoRestrictedImports(messages)).toBe(false);
  });
});
