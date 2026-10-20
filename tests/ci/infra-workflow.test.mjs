// Structural test for TF_VAR_budget_alert_email in .github/workflows/infra.yml
// (the AWS pipeline, ops page PR): the budget alert address comes from the
// GitHub variable BUDGET_ALERT_EMAIL, never from secrets, and only the two
// plan steps ("Plan" in plan-pr and plan-main) get it. Apply uses the saved
// plan and never sees it.
//
// Run with: node --test tests/ci/infra-workflow.test.mjs
//
// Line based and indentation aware, like infra-cloudflare-workflow.test.mjs
// (no YAML parser in the repo). Only reads the workflow file.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const FILE = fileURLToPath(new URL("../../.github/workflows/infra.yml", import.meta.url));
const lines = readFileSync(FILE, "utf8").replace(/\r/g, "").split("\n");

const indentOf = (l) => l.match(/^ */)[0].length;
const isBlank = (l) => l.trim() === "";
const isComment = (l) => l.trim().startsWith("#");

function jobs(ls) {
  const start = ls.findIndex((l) => /^jobs:/.test(l));
  assert.notEqual(start, -1, "no top-level jobs: block");
  const result = {};
  let name = null;
  for (let i = start + 1; i < ls.length; i++) {
    const l = ls[i];
    if (!isBlank(l) && !isComment(l) && indentOf(l) === 0) break;
    const m = l.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (m) {
      name = m[1];
      result[name] = [];
    } else if (name) {
      result[name].push(l);
    }
  }
  return result;
}

/** Steps of a job as arrays of raw lines (steps are `- ` items at indent 6). */
function steps(jobLines) {
  const out = [];
  let cur = null;
  for (const l of jobLines) {
    if (/^ {6}- /.test(l)) {
      cur = [l];
      out.push(cur);
    } else if (cur && (isBlank(l) || indentOf(l) > 6)) {
      cur.push(l);
    } else if (!isBlank(l) && indentOf(l) <= 4) {
      cur = null;
    }
  }
  return out;
}

const stepName = (s) => (s.join("\n").match(/^\s*(?:- )?name:\s*["']?(.*?)["']?\s*$/m) ?? [])[1];
const VAR_LINE = /^\s*TF_VAR_budget_alert_email:\s*\$\{\{\s*vars\.BUDGET_ALERT_EMAIL\s*\}\}\s*(#.*)?$/;
const mentions = (l) => !isComment(l) && /budget_alert_email/i.test(l);

describe("infra.yml: TF_VAR_budget_alert_email", () => {
  it("is set in step-level env of the Plan step in plan-pr and plan-main, from vars.BUDGET_ALERT_EMAIL", () => {
    const all = jobs(lines);
    for (const name of ["plan-pr", "plan-main"]) {
      const plan = steps(all[name] ?? []).filter((s) => stepName(s) === "Plan");
      assert.equal(plan.length, 1, `${name} needs exactly one step named Plan`);
      const text = plan[0];
      const envAt = text.findIndex((l) => /^\s+env:\s*$/.test(l));
      assert.notEqual(envAt, -1, `${name}: Plan step has no env: block`);
      const envLines = text.filter((l) => VAR_LINE.test(l));
      assert.equal(envLines.length, 1, `${name}: Plan step needs exactly one TF_VAR_budget_alert_email from vars.BUDGET_ALERT_EMAIL`);
      assert.ok(text.indexOf(envLines[0]) > envAt, `${name}: the variable must sit inside the step's env: block`);
    }
  });

  it("appears on no other step, in no other job, and not at job or workflow level", () => {
    const all = jobs(lines);
    const total = lines.filter(mentions).length;
    let onPlanSteps = 0;
    for (const [name, body] of Object.entries(all)) {
      for (const s of steps(body)) {
        const hits = s.filter(mentions).length;
        if (hits === 0) continue;
        assert.ok(
          (name === "plan-pr" || name === "plan-main") && stepName(s) === "Plan",
          `${name}: step "${stepName(s)}" must not get TF_VAR_budget_alert_email`,
        );
        onPlanSteps += hits;
      }
    }
    assert.equal(onPlanSteps, 2, "expected exactly two occurrences, on the two Plan steps");
    assert.equal(total, onPlanSteps, "the variable also appears outside job steps (job or workflow level)");
  });

  it("is never present in the apply job", () => {
    const apply = jobs(lines).apply ?? [];
    assert.ok(apply.length > 0, "apply job missing");
    assert.equal(apply.filter(mentions).length, 0);
    assert.equal(apply.filter((l) => !isComment(l) && /BUDGET_ALERT_EMAIL/.test(l)).length, 0);
  });

  it("is never sourced from secrets, and BUDGET_ALERT_EMAIL is only read through vars.", () => {
    for (const l of lines) {
      if (isComment(l)) continue;
      if (/BUDGET_ALERT_EMAIL/.test(l)) {
        assert.match(l, /\bvars\.BUDGET_ALERT_EMAIL\b/, l.trim());
        assert.doesNotMatch(l, /secrets\./, l.trim());
      }
    }
    assert.ok(lines.some((l) => /vars\.BUDGET_ALERT_EMAIL/.test(l)), "vars.BUDGET_ALERT_EMAIL is never referenced");
    assert.ok(
      !lines.some((l) => !isComment(l) && /secrets\.[A-Za-z0-9_]*(BUDGET|EMAIL)/i.test(l)),
      "no budget or email secret may be referenced",
    );
  });

  it("is not passed through -var on any command line and referenced only as TF_VAR_", () => {
    const text = lines.filter((l) => !isComment(l)).join("\n");
    assert.doesNotMatch(text, /-var[ =]/);
    for (const [i, l] of lines.entries()) {
      if (isComment(l) || !/\bbudget_alert_email\b/.test(l) || /TF_VAR_/.test(l)) continue;
      assert.fail(`unexpected reference at line ${i + 1}: ${l.trim()}`);
    }
  });
});
