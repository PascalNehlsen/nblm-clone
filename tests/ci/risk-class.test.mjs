// Tests for the CI risk-class classifier.
//
// Run with: node --test 'tests/ci/*.test.mjs'
// (a bare directory does not work with node --test; it must be a glob or file list)
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { classify, HIGH_RULES } from "../../.github/scripts/risk-class.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const cliPath = path.join(repoRoot, ".github/scripts/risk-class.mjs");

const EXPECTED_HIGH_RULES = [
  "supabase/",
  "infra/",
  ".github/",
  ".claude/",
  "scripts/",
  "apps/web/lib/rag/",
  "prompts/",
  "apps/web/prompts/",
  "apps/web/lib/server/",
  "apps/web/proxy.ts",
  "apps/web/lib/supabase/",
  "apps/web/lib/auth/",
  "apps/web/app/auth/",
  "apps/web/app/(public)/login/",
  "AGENTS.md",
  "CLAUDE.md",
  "SECURITY.md",
  "docs/ai-workflow.md",
  "docs/privacy.md",
  "docs/adr/",
  "eslint.config.mjs",
  "apps/web/next.config.ts",
  "apps/web/vercel.json",
  ".gitleaks.toml",
  ".pre-commit-config.yaml",
  "pnpm-workspace.yaml",
  "tests/rls/",
  "tests/ci/",
];

// One representative path per rule, used by case 3.
const RULE_EXAMPLES = [
  ["supabase/", "supabase/migrations/x.sql"],
  ["infra/", "infra/aws/main.tf"],
  [".github/", ".github/workflows/ci.yml"],
  [".claude/", ".claude/agents/planner.md"],
  ["scripts/", "scripts/gitleaks.sh"],
  ["apps/web/lib/rag/", "apps/web/lib/rag/retrieve.ts"],
  ["prompts/", "prompts/system.md"],
  ["apps/web/prompts/", "apps/web/prompts/system.md"],
  ["apps/web/lib/server/", "apps/web/lib/server/admin/usage.ts"],
  ["apps/web/proxy.ts", "apps/web/proxy.ts"],
  ["apps/web/lib/supabase/", "apps/web/lib/supabase/server.ts"],
  ["apps/web/lib/auth/", "apps/web/lib/auth/errors.ts"],
  ["apps/web/app/auth/", "apps/web/app/auth/actions.ts"],
  ["apps/web/app/(public)/login/", "apps/web/app/(public)/login/page.tsx"],
  ["AGENTS.md", "AGENTS.md"],
  ["CLAUDE.md", "CLAUDE.md"],
  ["SECURITY.md", "SECURITY.md"],
  ["docs/ai-workflow.md", "docs/ai-workflow.md"],
  ["docs/privacy.md", "docs/privacy.md"],
  ["docs/adr/", "docs/adr/0001-security-definer-membership-helper.md"],
  ["eslint.config.mjs", "eslint.config.mjs"],
  ["apps/web/next.config.ts", "apps/web/next.config.ts"],
  ["apps/web/vercel.json", "apps/web/vercel.json"],
  [".gitleaks.toml", ".gitleaks.toml"],
  [".pre-commit-config.yaml", ".pre-commit-config.yaml"],
  ["pnpm-workspace.yaml", "pnpm-workspace.yaml"],
  ["tests/rls/", "tests/rls/notebooks.test.ts"],
  ["tests/ci/", "tests/ci/risk-class.test.mjs"],
];

describe("HIGH_RULES", () => {
  it("equals the approved rule set, order independent", () => {
    assert.deepEqual([...HIGH_RULES].sort(), [...EXPECTED_HIGH_RULES].sort());
  });
});

describe("classify", () => {
  it("case 1: empty list is normal with no reasons", () => {
    const result = classify([]);
    assert.deepEqual(result, { riskClass: "normal", reasons: [] });
  });

  it("case 2: unrelated app and docs paths are normal", () => {
    const result = classify([
      "apps/web/app/(protected)/notebooks/page.tsx",
      "docs/roadmap.md",
    ]);
    assert.equal(result.riskClass, "normal");
    assert.deepEqual(result.reasons, []);
  });

  describe("case 3: each high rule matches its representative path", () => {
    for (const [rule, examplePath] of RULE_EXAMPLES) {
      it(`rule ${JSON.stringify(rule)} matches ${JSON.stringify(examplePath)}`, () => {
        const result = classify([examplePath]);
        assert.equal(result.riskClass, "high");
        assert.equal(result.reasons.length, 1);
        assert.equal(result.reasons[0].rule, rule);
        assert.equal(result.reasons[0].path, examplePath);
      });
    }
  });

  describe("case 4: lookalike paths are normal", () => {
    const lookalikes = [
      "docs/infrastructure.md",
      "supabase-notes.md",
      "infra-notes/x.md",
      "scripts-old/a.sh",
      "apps/web/lib/server-utils.ts",
      "apps/web/lib/authz.ts",
      "docs/adrs.md",
      "tests/unit/x.test.ts",
      "tests/e2e/login.spec.ts",
      "tests/rls-notes.md",
      "docs/gitleaks.md",
      "apps/web/pnpm-workspace.yaml.bak",
    ];
    for (const lookalike of lookalikes) {
      it(`${JSON.stringify(lookalike)} is normal`, () => {
        const result = classify([lookalike]);
        assert.equal(result.riskClass, "normal");
        assert.deepEqual(result.reasons, []);
      });
    }
  });

  it("case 5: apps/web/proxy.ts is high, apps/web/lib/proxy-helpers.ts is normal", () => {
    const high = classify(["apps/web/proxy.ts"]);
    assert.equal(high.riskClass, "high");
    assert.equal(high.reasons.length, 1);
    assert.equal(high.reasons[0].rule, "apps/web/proxy.ts");

    const normal = classify(["apps/web/lib/proxy-helpers.ts"]);
    assert.equal(normal.riskClass, "normal");
    assert.deepEqual(normal.reasons, []);
  });

  it("case 6: a leading './' is stripped before matching and in the reason path", () => {
    const result = classify(["./supabase/x.sql"]);
    assert.equal(result.riskClass, "high");
    assert.equal(result.reasons.length, 1);
    assert.equal(result.reasons[0].path, "supabase/x.sql");
    assert.equal(result.reasons[0].rule, "supabase/");
  });

  it("case 7: a mixed list is high, reasons contain only the matching path", () => {
    const result = classify([
      "apps/web/app/page.tsx",
      "infra/aws/main.tf",
      "README.md",
    ]);
    assert.equal(result.riskClass, "high");
    assert.equal(result.reasons.length, 1);
    assert.equal(result.reasons[0].path, "infra/aws/main.tf");
    assert.equal(result.reasons[0].rule, "infra/");
  });

  it("case 8: a rename out of supabase/ (diff run with --no-renames) is still high", () => {
    const result = classify(["supabase/tests/a.sql", "docs/archive/a.sql"]);
    assert.equal(result.riskClass, "high");
    assert.equal(result.reasons.length, 1);
    assert.equal(result.reasons[0].path, "supabase/tests/a.sql");
    assert.equal(result.reasons[0].rule, "supabase/");
  });

  it("case 9: a workflow-only diff is high", () => {
    const result = classify([".github/workflows/ci.yml"]);
    assert.equal(result.riskClass, "high");
  });

  it("case 10: the classifier script itself is high", () => {
    const result = classify([".github/scripts/risk-class.mjs"]);
    assert.equal(result.riskClass, "high");
  });

  describe("case 11: lockfiles and manifests are normal", () => {
    for (const manifestPath of [
      "package.json",
      "pnpm-lock.yaml",
      "apps/web/package.json",
    ]) {
      it(`${JSON.stringify(manifestPath)} is normal`, () => {
        const result = classify([manifestPath]);
        assert.equal(result.riskClass, "normal");
        assert.deepEqual(result.reasons, []);
      });
    }
  });
});

describe("case 12: CLI", () => {
  function runCli({ input, env = {} }) {
    return spawnSync(process.execPath, [cliPath], {
      cwd: repoRoot,
      input,
      env: { ...process.env, ...env },
    });
  }

  function withTempSummaryFile(run) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "risk-class-"));
    const summaryPath = path.join(dir, "step-summary.md");
    try {
      return run(summaryPath);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it("12a: a mixed high/normal diff prints the class, one notice, and only the high path in the summary", () => {
    withTempSummaryFile((summaryPath) => {
      const input = "docs/my notes.md\0supabase/my file.sql\0";
      const result = runCli({
        input,
        env: { GITHUB_STEP_SUMMARY: summaryPath },
      });

      assert.equal(result.status, 0);

      const stdout = result.stdout.toString("utf8");
      const stdoutLines = stdout.split("\n");
      assert.equal(stdoutLines[0], "risk class: high");

      const noticeLines = stdoutLines.filter((line) =>
        line.startsWith("::notice"),
      );
      assert.equal(noticeLines.length, 1);
      assert.ok(noticeLines[0].startsWith("::notice title=Risk class::"));

      const summary = fs.readFileSync(summaryPath, "utf8");
      assert.ok(summary.includes(JSON.stringify("supabase/my file.sql")));
      assert.ok(!summary.includes("my notes.md"));
    });
  });

  it("12b: an all-normal diff prints 'risk class: normal' and exits 0", () => {
    const input = "README.md\0package.json\0";
    const result = runCli({ input });

    assert.equal(result.status, 0);
    const stdoutLines = result.stdout.toString("utf8").split("\n");
    assert.equal(stdoutLines[0], "risk class: normal");
  });

  it("12c: an evil filename cannot break out of the summary fence or emit a forged workflow command", () => {
    withTempSummaryFile((summaryPath) => {
      const evilPath = "supabase/x```\n## pwned\n::error::boom`.sql";
      const input = evilPath + "\0";
      const result = runCli({
        input,
        env: { GITHUB_STEP_SUMMARY: summaryPath },
      });

      assert.equal(result.status, 0);

      const stdoutLines = result.stdout.toString("utf8").split("\n");
      const colonLines = stdoutLines.filter((line) => line.startsWith("::"));
      assert.equal(colonLines.length, 1);
      assert.ok(!stdoutLines.some((line) => line.startsWith("::error")));

      const summaryLines = fs.readFileSync(summaryPath, "utf8").split("\n");
      const fenceLines = summaryLines.filter((line) => line.startsWith("```"));
      assert.equal(fenceLines.length, 2);
      assert.equal(fenceLines[0], "```text");
      assert.equal(fenceLines[1], "```");
      assert.ok(!summaryLines.includes("## pwned"));
    });
  });

  it("12d: more than 100 high paths are truncated in the summary with a '... and N more' line", () => {
    withTempSummaryFile((summaryPath) => {
      const paths = [];
      for (let i = 0; i < 150; i += 1) {
        paths.push(`supabase/f${i}.sql`);
      }
      const input = paths.join("\0") + "\0";
      const result = runCli({
        input,
        env: { GITHUB_STEP_SUMMARY: summaryPath },
      });

      assert.equal(result.status, 0);

      const summaryLines = fs.readFileSync(summaryPath, "utf8").split("\n");
      const openIndex = summaryLines.indexOf("```text");
      const closeIndex = summaryLines.indexOf("```", openIndex + 1);
      assert.ok(openIndex >= 0 && closeIndex > openIndex);

      const contentLines = summaryLines
        .slice(openIndex + 1, closeIndex)
        .filter((line) => line.length > 0);

      const moreLines = contentLines.filter((line) => /and \d+ more/.test(line));
      assert.equal(moreLines.length, 1);
      assert.ok(/and 50 more/.test(moreLines[0]));

      const pathLines = contentLines.filter((line) => line !== moreLines[0]);
      assert.ok(pathLines.length <= 100);
    });
  });

  describe("12e: empty or all-NUL stdin fails closed instead of reporting normal", () => {
    // In CI the diff is piped in; an empty or NUL-only payload means `git diff`
    // failed or produced no output, which must not be reported as "normal".
    for (const [label, input] of [
      ["empty stdin", ""],
      ["stdin with only NULs", "\0\0"],
    ]) {
      it(`${label} exits non-zero and writes nothing`, () => {
        withTempSummaryFile((summaryPath) => {
          const result = runCli({
            input,
            env: { GITHUB_STEP_SUMMARY: summaryPath },
          });

          assert.notEqual(result.status, 0);

          const stdoutLines = result.stdout.toString("utf8").split("\n");
          assert.ok(!stdoutLines.includes("risk class: normal"));
          assert.ok(!stdoutLines.some((line) => line.startsWith("::notice")));

          const summaryExists = fs.existsSync(summaryPath);
          if (summaryExists) {
            assert.equal(fs.readFileSync(summaryPath, "utf8"), "");
          }
        });
      });
    }
  });

  it("12f: invisible and HTML characters in high paths are escaped in the summary", () => {
    withTempSummaryFile((summaryPath) => {
      // Built from character codes, not literal characters, so this source
      // file contains no raw invisible or bidi-affecting characters itself.
      const BIDI_OVERRIDE = String.fromCharCode(0x202e); // U+202E
      const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b); // U+200B
      const LINE_SEPARATOR = String.fromCharCode(0x2028); // U+2028
      const bidiPath =
        "supabase/a" +
        BIDI_OVERRIDE +
        "b" +
        ZERO_WIDTH_SPACE +
        "c" +
        LINE_SEPARATOR +
        "d.sql";
      const htmlPath = "supabase/<img src=x onerror=alert(1)></details>.sql";
      const input = bidiPath + "\0" + htmlPath + "\0";
      const result = runCli({
        input,
        env: { GITHUB_STEP_SUMMARY: summaryPath },
      });

      assert.equal(result.status, 0);

      const summary = fs.readFileSync(summaryPath, "utf8");

      assert.ok(!summary.includes(BIDI_OVERRIDE));
      assert.ok(!summary.includes(ZERO_WIDTH_SPACE));
      assert.ok(!summary.includes(LINE_SEPARATOR));

      // The builder escapes every character outside printable ASCII
      // (0x20-0x7E) as a literal lowercase-hex "\uXXXX" sequence.
      const escaped202e = String.fromCharCode(0x5c) + "u202e";
      const escaped200b = String.fromCharCode(0x5c) + "u200b";
      const escaped2028 = String.fromCharCode(0x5c) + "u2028";
      assert.ok(summary.includes(escaped202e));
      assert.ok(summary.includes(escaped200b));
      assert.ok(summary.includes(escaped2028));

      const summaryLines = summary.split("\n");
      const fenceLines = summaryLines.filter((line) => line.startsWith("```"));
      assert.equal(fenceLines.length, 2);

      const openIndex = summaryLines.indexOf("```text");
      const closeIndex = summaryLines.indexOf("```", openIndex + 1);
      assert.ok(openIndex >= 0 && closeIndex > openIndex);

      const imgLines = summaryLines.filter((line) => line.includes("<img"));
      assert.equal(imgLines.length, 1);
      const imgIndex = summaryLines.indexOf(imgLines[0]);
      assert.ok(imgIndex > openIndex && imgIndex < closeIndex);
    });
  });
});

describe("case 13: existence guard for HIGH_RULES paths", () => {
  // These rule paths exist in the repo today. If one of them is renamed or
  // removed without updating HIGH_RULES, this guard fails.
  const EXISTING_RULE_PATHS = [
    "supabase/",
    "infra/",
    ".github/",
    ".claude/",
    "scripts/",
    "apps/web/lib/server/",
    "apps/web/proxy.ts",
    "apps/web/lib/supabase/",
    "apps/web/lib/auth/",
    "apps/web/app/auth/",
    "apps/web/app/(public)/login/",
    "AGENTS.md",
    "CLAUDE.md",
    "SECURITY.md",
    "docs/ai-workflow.md",
    "docs/privacy.md",
    "docs/adr/",
    "eslint.config.mjs",
    "apps/web/next.config.ts",
    "apps/web/vercel.json",
    ".gitleaks.toml",
    ".pre-commit-config.yaml",
    "pnpm-workspace.yaml",
    "tests/rls/",
    "tests/ci/",
  ];

  // These rule paths are planned but not yet present in the repo, so their
  // existence is deliberately not asserted here.
  const PLANNED_RULE_PATHS = ["apps/web/lib/rag/", "prompts/", "apps/web/prompts/"];

  for (const rulePath of EXISTING_RULE_PATHS) {
    it(`${JSON.stringify(rulePath)} exists in the repo today`, () => {
      assert.ok(
        fs.existsSync(path.join(repoRoot, rulePath)),
        `expected ${rulePath} to exist at the repo root`,
      );
    });
  }

  it("every HIGH_RULES entry is either an existing path or a documented planned path", () => {
    const union = new Set([...EXISTING_RULE_PATHS, ...PLANNED_RULE_PATHS]);
    for (const rule of HIGH_RULES) {
      assert.ok(
        union.has(rule),
        `rule ${JSON.stringify(rule)} is neither in the existing nor the planned path list; a new rule must be classified in this test file`,
      );
    }
  });
});

describe("case 14: AGENTS.md drift guard", () => {
  it("the backticked tokens on the '- **high:**' line of AGENTS.md are exactly HIGH_RULES, as a set", () => {
    const agentsContent = fs.readFileSync(
      path.join(repoRoot, "AGENTS.md"),
      "utf8",
    );
    const highLine = agentsContent
      .split("\n")
      .find((line) => line.startsWith("- **high:**"));
    assert.ok(
      highLine,
      "AGENTS.md must contain a line starting with '- **high:**'",
    );

    const tokens = [...highLine.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    assert.ok(
      tokens.length > 0,
      "the '- **high:**' line must contain at least one backticked token",
    );

    // Set equality, not just "every token is a known rule": a path dropped
    // from the docs (present in HIGH_RULES but missing from the line) must
    // also fail this guard.
    assert.deepEqual(
      new Set(tokens),
      new Set(HIGH_RULES),
      "the backticked tokens on AGENTS.md's '- **high:**' line must be exactly the HIGH_RULES set",
    );
  });
});
