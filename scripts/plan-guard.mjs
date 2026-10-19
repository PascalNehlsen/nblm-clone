#!/usr/bin/env node
// Plan guard for CI (ADR 0009): reads `tofu show -json <planfile>` on stdin and
// fails unless every resource change is create, update, read or no-op. Delete,
// replace (delete+create in either order), forget and anything unknown fail, and
// so does input it cannot parse. No override in v1.
//
// Prints a Markdown table of addresses and actions to stdout (for the run
// summary), never attribute values: the plan JSON holds every planned value.
//
// Usage: scripts/tofu.sh -chdir=infra/aws show -json aws.tfplan | node scripts/plan-guard.mjs
// Exit 0 allows, exit 1 blocks.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const ALLOWED = new Set(["no-op", "create", "read", "update"]);

function fail(error, changes = []) {
  return { ok: false, error, changes, violations: [] };
}

/** Checks one `tofu show -json` document. Errors name positions, never values. */
export function guardPlan(text) {
  let plan;
  try {
    plan = JSON.parse(text);
  } catch {
    return fail("plan is not valid JSON");
  }
  if (plan === null || typeof plan !== "object" || Array.isArray(plan)) {
    return fail("plan is not a JSON object");
  }
  if (plan.errored === true) return fail("plan errored");
  if (plan.resource_changes === undefined) return { ok: true, error: null, changes: [], violations: [] };
  if (!Array.isArray(plan.resource_changes)) return fail("resource_changes is not an array");

  const changes = [];
  const violations = [];
  for (const [index, entry] of plan.resource_changes.entries()) {
    const address = entry?.address;
    const actions = entry?.change?.actions;
    if (typeof address !== "string" || address === "") {
      return fail(`resource_changes[${index}] has no address`, changes);
    }
    if (!Array.isArray(actions) || !actions.every((action) => typeof action === "string")) {
      return fail(`resource_changes[${index}] has no list of actions`, changes);
    }
    const item = { address, actions: [...actions] };
    changes.push(item);
    if (actions.length !== 1 || !ALLOWED.has(actions[0])) violations.push(item);
  }
  return { ok: violations.length === 0, error: null, changes, violations };
}

// Addresses come from the configuration (resource names, for_each keys), so
// escape what would break a table cell.
function cell(value) {
  return value.replace(/[|\\`<>]/g, (c) => `\\${c}`).replace(/[\r\n]/g, " ");
}

export function summary(result) {
  const lines = ["### Plan guard", ""];
  if (result.error) {
    lines.push(`**Blocked:** ${cell(result.error)}.`);
    return lines.join("\n") + "\n";
  }
  lines.push(
    result.ok
      ? `**Passed:** ${result.changes.length} resource change(s), none deletes or replaces.`
      : `**Blocked:** ${result.violations.length} change(s) delete, replace or forget a resource. No override in v1 (ADR 0009).`,
  );
  if (result.changes.length > 0) {
    lines.push("", "| Address | Actions | Allowed |", "|---|---|---|");
    const blocked = new Set(result.violations);
    for (const item of result.changes) {
      lines.push(`| ${cell(item.address)} | ${cell(item.actions.join(", "))} | ${blocked.has(item) ? "no" : "yes"} |`);
    }
  }
  return lines.join("\n") + "\n";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = guardPlan(readFileSync(0, "utf8"));
  process.stdout.write(summary(result));
  if (!result.ok) {
    process.stderr.write(`plan-guard: blocked (${result.error ?? `${result.violations.length} disallowed change(s)`})\n`);
    process.exitCode = 1;
  }
}
