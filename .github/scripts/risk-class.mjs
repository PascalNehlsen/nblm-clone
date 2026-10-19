#!/usr/bin/env node
// Risk class of a change, computed from the paths it touches (AGENTS.md "Roles and flow").
// The guardrails workflow pipes `git diff --name-only --no-renames -z` into this script on
// every pull request, using the copy of this script on the base branch, so a PR cannot
// change its own class. It reports the class and does not block: exit 0 for both classes,
// non-zero only when the script itself fails.
//
// Paths are untrusted (anyone who opens a PR picks the file names), so they never reach a
// workflow command or a markdown line raw: stdout gets only the class and counts, and the
// step summary lists paths escaped to printable ASCII inside a fence they cannot close.
// An empty path list is an error, not "normal": in CI it means git diff failed or saw
// nothing, and reporting that as normal would hide a high-risk change.

import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// A rule ending in "/" matches every path below that directory; any other rule matches
// exactly one file. Keep AGENTS.md's "- **high:**" line in sync (tests/ci/ checks it).
export const HIGH_RULES = Object.freeze([
  // Database, infrastructure, CI and agent configuration
  "supabase/",
  "infra/",
  ".github/",
  ".claude/",
  "scripts/",
  // Tests that guard the gates: the RLS matrix and the classifier's own tests
  "tests/rls/",
  "tests/ci/",
  // Prompts, retrieval and the server-only model and budget code
  "apps/web/lib/rag/",
  "prompts/",
  "apps/web/prompts/",
  "apps/web/lib/server/",
  // Auth
  "apps/web/proxy.ts",
  "apps/web/lib/supabase/",
  "apps/web/lib/auth/",
  "apps/web/app/auth/",
  "apps/web/app/(public)/login/",
  // Rule files
  "AGENTS.md",
  "CLAUDE.md",
  "SECURITY.md",
  "docs/ai-workflow.md",
  "docs/privacy.md",
  "docs/adr/",
  // Security configuration
  ".gitleaks.toml",
  ".pre-commit-config.yaml",
  "pnpm-workspace.yaml",
  "eslint.config.mjs",
  "apps/web/next.config.ts",
  "apps/web/vercel.json",
]);

const SUMMARY_LIMIT = 100;

function normalise(raw) {
  let p = String(raw);
  while (p.startsWith("./")) p = p.slice(2);
  return p;
}

function matchingRule(p) {
  return HIGH_RULES.find((rule) => (rule.endsWith("/") ? p.startsWith(rule) : p === rule)) ?? null;
}

export function classify(paths) {
  const reasons = [];
  for (const raw of paths) {
    const p = normalise(raw);
    if (p === "") continue;
    const rule = matchingRule(p);
    if (rule !== null) reasons.push({ path: p, rule });
  }
  return { riskClass: reasons.length > 0 ? "high" : "normal", reasons };
}

// JSON string with every character outside printable ASCII as \uXXXX, so bidi overrides,
// zero-width and line-separator characters cannot reorder or hide text in the summary.
function escapePath(value) {
  return JSON.stringify(value).replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function summary(result, total) {
  const lines = [`## Risk class: ${result.riskClass}`, ""];
  if (result.reasons.length === 0) {
    lines.push(`None of the ${total} changed paths matches a high-risk rule.`, "");
    return lines.join("\n");
  }
  lines.push(`${result.reasons.length} of ${total} changed paths match a high-risk rule:`, "", "```text");
  // JSON.stringify escapes newlines and quotes, so every entry stays on one line that
  // starts with a quote and can never be read as the closing fence.
  for (const { path: p, rule } of result.reasons.slice(0, SUMMARY_LIMIT)) {
    lines.push(`${escapePath(p)} (rule ${escapePath(rule)})`);
  }
  if (result.reasons.length > SUMMARY_LIMIT) {
    lines.push(`... and ${result.reasons.length - SUMMARY_LIMIT} more`);
  }
  lines.push("```", "");
  return lines.join("\n");
}

function main() {
  const paths = readFileSync(0).toString("utf8").split("\0").filter((p) => p !== "");
  if (paths.length === 0) {
    const error = new Error("no changed paths on stdin");
    error.name = "NoChangedPaths";
    throw error;
  }
  const result = classify(paths);

  process.stdout.write(`risk class: ${result.riskClass}\n`);
  process.stdout.write(
    `::notice title=Risk class::${result.riskClass} (${result.reasons.length} of ${paths.length} changed paths match a high-risk rule)\n`,
  );

  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) appendFileSync(summaryFile, summary(result, paths.length));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`risk-class: ${error?.name ?? "Error"}\n`);
    process.exit(1);
  }
}
