// The ops page adds lib/server/admin/ops.ts (third holder of the secret key, read-only aggregates
// plus recording an eval score). The real eslint.config.mjs, run through ESLint's Node API on
// virtual files (same technique as tests/unit/account/eslint-imports.test.ts), must say:
//   - lib/server/ops/read.ts and lib/server/eval/record.ts alone may import lib/server/admin/ops
//   - nothing else may: not the page, the layout, access.ts, summary.ts, the eval route or
//     http.ts, call.ts, delete-account.ts, lib/supabase, lib/notebooks
//   - the two importers may not import any other admin module, the bare admin directory or the
//     Supabase SDK (values)
//   - the admin modules stay separate: ops.ts imports neither usage nor accounts, and neither of
//     those imports ops
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

const READ = "apps/web/lib/server/ops/read.ts";
const RECORD = "apps/web/lib/server/eval/record.ts";
const SNIPPET = (specifier: string) => `import { readOpsSummary } from "${specifier}";\nexport const x = readOpsSummary;\n`;

describe("only lib/server/ops/read.ts and lib/server/eval/record.ts may import lib/server/admin/ops", () => {
  it.each([
    [READ, "../admin/ops"],
    [READ, "@/lib/server/admin/ops"],
    [RECORD, "../admin/ops"],
    [RECORD, "@/lib/server/admin/ops"],
  ] as const)("does not flag %s importing %s", async (file, specifier) => {
    expect(flagged(await lint(file, SNIPPET(specifier)))).toBe(false);
  });

  it.each([
    ["apps/web/app/x.ts", "@/lib/server/admin/ops"],
    ["apps/web/app/(app)/ops/page.tsx", "@/lib/server/admin/ops"],
    ["apps/web/app/(app)/ops/page.tsx", "../../../lib/server/admin/ops"],
    ["apps/web/app/(app)/ops/layout.tsx", "@/lib/server/admin/ops"],
    ["apps/web/app/api/eval/route.ts", "@/lib/server/admin/ops"],
    ["apps/web/lib/server/ops/access.ts", "../admin/ops"],
    ["apps/web/lib/server/ops/summary.ts", "../admin/ops"],
    ["apps/web/lib/server/ops/summary.ts", "@/lib/server/admin/ops"],
    ["apps/web/lib/server/eval/http.ts", "../admin/ops"],
    ["apps/web/lib/server/eval/run.ts", "../admin/ops"],
    ["apps/web/lib/server/model/call.ts", "../admin/ops"],
    ["apps/web/lib/server/model/call.ts", "@/lib/server/admin/ops"],
    ["apps/web/lib/server/account/delete-account.ts", "../admin/ops"],
    ["apps/web/lib/server/account/delete-account.ts", "@/lib/server/admin/ops"],
    ["apps/web/lib/notebooks/x.ts", "@/lib/server/admin/ops"],
    // lib/supabase/** is exempted from the SDK ban, but that exemption must not extend here.
    ["apps/web/lib/supabase/x.ts", "../server/admin/ops"],
    ["apps/web/app/x/page.jsx", "@/lib/server/admin/ops"],
    ["apps/web/lib/x.cjs", "@/lib/server/admin/ops"],
    ["apps/web/lib/x.mts", "@/lib/server/admin/ops"],
  ] as const)("flags %s importing %s", async (file, specifier) => {
    expect(flagged(await lint(file, SNIPPET(specifier)))).toBe(true);
  });

  it("flags a re-export of admin/ops from another file", async () => {
    expect(flagged(await lint("apps/web/app/x.ts", 'export { readOpsSummary } from "@/lib/server/admin/ops";\n'))).toBe(true);
  });
});

describe("the read.ts and record.ts exceptions are narrow", () => {
  it.each([
    [READ, "../admin/usage", "reserve"],
    [READ, "@/lib/server/admin/usage", "reserve"],
    [READ, "../admin/accounts", "deleteAuthUser"],
    [READ, "@/lib/server/admin/accounts", "deleteAuthUser"],
    [READ, "../admin/other", "x"],
    [READ, "../admin", "x"],
    [RECORD, "../admin/usage", "reserve"],
    [RECORD, "@/lib/server/admin/usage", "reserve"],
    [RECORD, "../admin/accounts", "deleteAuthUser"],
    [RECORD, "../admin/other", "x"],
    [RECORD, "../admin", "x"],
  ] as const)("still flags %s importing %s", async (file, specifier, name) => {
    expect(flagged(await lint(file, `import { ${name} } from "${specifier}";\nexport const y = ${name};\n`))).toBe(true);
  });

  it.each([READ, RECORD])("still flags %s importing a value from @supabase/supabase-js", async (file) => {
    expect(flagged(await lint(file, 'import { createClient } from "@supabase/supabase-js";\nexport const x = createClient;\n'))).toBe(true);
  });

  it.each([READ, RECORD])("still flags %s importing the model call engine or the Bedrock provider", async (file) => {
    expect(flagged(await lint(file, 'import { buildModelCaller } from "../model/call-core";\nexport const x = buildModelCaller;\n'))).toBe(true);
    expect(flagged(await lint(file, 'import { bedrockChat } from "../model/bedrock";\nexport const x = bedrockChat;\n'))).toBe(true);
  });

  it("does not flag the page importing the read module or the pure helpers (they hold no key)", async () => {
    const messages = await lint(
      "apps/web/app/(app)/ops/page.tsx",
      'import { loadOpsSummary } from "@/lib/server/ops/read";\nimport { categoryLabel } from "@/lib/server/ops/summary";\nimport { isOperator } from "@/lib/server/ops/access";\nexport const x = [loadOpsSummary, categoryLabel, isOperator];\n',
    );
    expect(flagged(messages)).toBe(false);
  });
});

describe("the admin modules stay separate", () => {
  it.each([
    ["apps/web/lib/server/admin/ops.ts", "./usage"],
    ["apps/web/lib/server/admin/ops.ts", "./accounts"],
    ["apps/web/lib/server/admin/usage.ts", "./ops"],
    ["apps/web/lib/server/admin/accounts.ts", "./ops"],
  ] as const)("flags %s importing the sibling %s", async (file, specifier) => {
    expect(flagged(await lint(file, `import { x } from "${specifier}";\nexport const y = x;\n`))).toBe(true);
  });

  it("flags admin/ops.ts importing the Bedrock SDK or the model engine", async () => {
    const file = "apps/web/lib/server/admin/ops.ts";
    expect(flagged(await lint(file, 'import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";\nexport const x = BedrockRuntimeClient;\n'))).toBe(true);
    expect(flagged(await lint(file, 'import { buildModelCaller } from "../model/call-core";\nexport const x = buildModelCaller;\n'))).toBe(true);
  });
});
