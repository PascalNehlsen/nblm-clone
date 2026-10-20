// Structural test for .github/workflows/drift.yml: nightly drift detection for
// the aws and cloudflare stacks. It plans with the read-only PLAN role in the
// GitHub environment `drift`, never applies, never saves a plan, and fails the
// run (exit code 2 from -detailed-exitcode) with an ::error:: drift message.
//
// Run with: node --test tests/ci/drift-workflow.test.mjs
//
// Line based and indentation aware (no YAML parser in the repo). Only reads the
// workflow file.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const FILE = fileURLToPath(new URL("../../.github/workflows/drift.yml", import.meta.url));
const lines = readFileSync(FILE, "utf8").replace(/\r/g, "").split("\n");

const indentOf = (l) => l.match(/^ */)[0].length;
const isBlank = (l) => l.trim() === "";
const isComment = (l) => l.trim().startsWith("#");
const code = lines.filter((l) => !isComment(l));
const codeText = code.join("\n");

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

const stepCode = (s) => s.filter((l) => !isComment(l)).join("\n");

function theJob() {
  const all = Object.values(jobs(lines));
  assert.equal(all.length, 1, "expected exactly one job (the stack matrix)");
  return all[0];
}

function permissionsOf(body) {
  const at = body.findIndex((l) => /^ {4}permissions:\s*$/.test(l));
  assert.notEqual(at, -1, "job has no permissions: block");
  const out = {};
  for (let i = at + 1; i < body.length; i++) {
    const l = body[i];
    if (isBlank(l) || isComment(l)) continue;
    if (indentOf(l) <= 4) break;
    const m = l.match(/^\s+([a-z-]+):\s*([a-z]+)\s*(#.*)?$/);
    assert.ok(m, `unparsable permission line: ${l}`);
    out[m[1]] = m[2];
  }
  return out;
}

/** Steps that run the plan command (`tofu.sh ... plan`). */
const isPlanStep = (s) => /scripts\/tofu\.sh[^\n]*\bplan\b/.test(stepCode(s));
const isInitStep = (s) => /scripts\/tofu\.sh[^\n]*\binit\b/.test(stepCode(s));

describe("drift.yml: triggers and top level", () => {
  it("triggers only on a nightly schedule and workflow_dispatch", () => {
    const start = code.findIndex((l) => /^on:/.test(l));
    assert.notEqual(start, -1);
    const rest = code.slice(start + 1);
    const end = rest.findIndex((l) => !isBlank(l) && indentOf(l) === 0);
    const block = rest.slice(0, end === -1 ? undefined : end);
    const triggers = block.filter((l) => /^ {2}[a-z_]+:/.test(l)).map((l) => l.trim().replace(/:.*$/, "")).sort();
    assert.deepEqual(triggers, ["schedule", "workflow_dispatch"]);
    const cron = block.find((l) => /- cron:/.test(l));
    assert.ok(cron, "no cron entry");
    const fields = cron.match(/cron:\s*["']([^"']+)["']/)?.[1].trim().split(/\s+/);
    assert.equal(fields?.length, 5);
    assert.deepEqual(fields.slice(2), ["*", "*", "*"], "nightly means every day of every month");
    assert.match(fields[0], /^\d+$/);
    assert.match(fields[1], /^\d+$/);
  });

  it("has top-level permissions: {} and never uses pull_request_target", () => {
    assert.ok(code.some((l) => /^permissions:\s*\{\s*\}\s*$/.test(l)), "missing top-level permissions: {}");
    assert.doesNotMatch(codeText, /pull_request_target/);
  });

  it("pins every action to a 40-hex SHA with a version comment", () => {
    const uses = code.filter((l) => /\buses:\s/.test(l));
    assert.ok(uses.length >= 2);
    for (const l of uses) {
      assert.match(l, /uses:\s*[\w.-]+\/[\w./-]+@[0-9a-f]{40}\s+#\s*v\d[\w.\-]*\s*$/, l.trim());
    }
  });
});

describe("drift.yml: the job", () => {
  it("runs in the drift environment, with only contents: read and id-token: write", () => {
    const body = theJob();
    assert.ok(body.some((l) => /^ {4}environment:\s*drift\s*$/.test(l)), "job must use environment: drift");
    assert.deepEqual(permissionsOf(body), { contents: "read", "id-token": "write" });
  });

  it("matrix is exactly the aws and cloudflare stacks", () => {
    const body = theJob();
    const at = body.findIndex((l) => /^\s+stack:/.test(l));
    assert.notEqual(at, -1, "no matrix stack");
    let stacks = [];
    const inline = body[at].match(/stack:\s*\[(.*)\]/);
    if (inline) {
      stacks = inline[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, ""));
    } else {
      for (let i = at + 1; i < body.length; i++) {
        const m = body[i].match(/^\s+-\s*["']?([\w-]+)["']?\s*(#.*)?$/);
        if (!m) break;
        stacks.push(m[1]);
      }
    }
    assert.deepEqual(stacks.sort(), ["aws", "cloudflare"]);
  });

  it("checks out without persisting credentials", () => {
    const body = theJob();
    const at = body.findIndex((l) => /uses:\s*actions\/checkout@/.test(l));
    assert.notEqual(at, -1, "no checkout");
    assert.match(body.slice(at + 1, at + 6).join("\n"), /persist-credentials:\s*false/);
  });

  it("assumes the plan role, never the apply role", () => {
    const body = theJob().filter((l) => !isComment(l)).join("\n");
    assert.match(body, /role-to-assume:\s*\$\{\{\s*env\.PLAN_ROLE_ARN\s*\}\}|role-to-assume:\s*arn:aws:iam::278311879197:role\/nblm-tofu-plan\b/);
    if (/env\.PLAN_ROLE_ARN/.test(body)) {
      assert.match(codeText, /^\s{2}PLAN_ROLE_ARN:\s*arn:aws:iam::278311879197:role\/nblm-tofu-plan\s*$/m);
    }
    assert.doesNotMatch(codeText, /nblm-tofu-apply/);
    assert.doesNotMatch(codeText, /APPLY_ROLE_ARN/);
  });
});

describe("drift.yml: plan only", () => {
  const planSteps = () => steps(theJob()).filter(isPlanStep);

  it("has exactly one plan step with -lock=false -detailed-exitcode -no-color on the matrix stack, without -out", () => {
    const plans = planSteps();
    assert.equal(plans.length, 1);
    const t = stepCode(plans[0]);
    assert.match(t, /^\s*STACK:\s*\$\{\{\s*matrix\.stack\s*\}\}\s*$/m, "step env needs STACK: ${{ matrix.stack }}");
    assert.match(t, /-chdir="infra\/\$STACK"/);
    assert.match(t, /\bplan\b[^\n]*-lock=false/);
    assert.match(t, /-detailed-exitcode/);
    assert.match(t, /-no-color/);
    assert.doesNotMatch(t, /-out[= ]/);
  });

  it("no run: block contains a ${{ expression (template injection, zizmor)", () => {
    for (let i = 0; i < code.length; i++) {
      const m = code[i].match(/^(\s*)(?:- )?run:\s*(.*)$/);
      if (!m) continue;
      const base = m[1].length;
      const body = [m[2]];
      if (/^[|>][+-]?\s*$/.test(m[2])) {
        body.length = 0;
        for (let j = i + 1; j < code.length; j++) {
          if (!isBlank(code[j]) && indentOf(code[j]) <= base) break;
          body.push(code[j]);
        }
      }
      assert.doesNotMatch(body.join("\n"), /\$\{\{/, `run block at code line ${i + 1} uses \${{ }}`);
    }
  });

  it("never applies, saves a plan or uploads anything", () => {
    assert.doesNotMatch(codeText, /\btofu\.sh[^\n]*\bapply\b/);
    assert.doesNotMatch(codeText, /\btofu\s+apply\b/);
    assert.doesNotMatch(codeText, /upload-artifact/);
    assert.doesNotMatch(codeText, /-out[= ]/);
    assert.doesNotMatch(codeText, /\.tfplan/);
  });

  it("exit code 2 fails the job with an ::error:: drift message and writes the plan to the step summary", () => {
    const t = stepCode(planSteps()[0]);
    assert.match(t, /shell:\s*bash/, "needs shell: bash for pipefail and rc handling");
    assert.match(t, /\b2\)/, "no handling of exit code 2");
    assert.match(t, /::error::[^\n]*drift/i);
    assert.match(t, /GITHUB_STEP_SUMMARY/);
    // The plan output is what lands in the summary, and rc 2 and other codes exit non-zero.
    assert.match(t, /exit\s+("\$rc"|1)/);
    assert.match(t, /tee\b|>>\s*"\$GITHUB_STEP_SUMMARY"/);
  });

  it("the init step is -lockfile=readonly -input=false", () => {
    const inits = steps(theJob()).filter(isInitStep);
    assert.equal(inits.length, 1);
    const t = stepCode(inits[0]);
    assert.match(t, /^\s*STACK:\s*\$\{\{\s*matrix\.stack\s*\}\}\s*$/m, "step env needs STACK: ${{ matrix.stack }}");
    assert.match(t, /-chdir="infra\/\$STACK"/);
    assert.match(t, /-lockfile=readonly/);
    assert.match(t, /-input=false/);
  });
});

describe("drift.yml: variables and secrets only where needed", () => {
  const all = () => steps(theJob());

  it("TF_VAR_budget_alert_email comes from vars.BUDGET_ALERT_EMAIL, on the plan step only", () => {
    const hits = all().filter((s) => /budget_alert_email/i.test(stepCode(s)));
    assert.equal(hits.length, 1, "exactly one step may mention the email");
    assert.ok(isPlanStep(hits[0]));
    assert.match(stepCode(hits[0]), /^\s*TF_VAR_budget_alert_email:\s*\$\{\{\s*vars\.BUDGET_ALERT_EMAIL\s*\}\}\s*$/m);
    assert.equal(code.filter((l) => /budget_alert_email/i.test(l)).length, 1, "also appears outside a step");
    assert.doesNotMatch(codeText, /secrets\.[A-Za-z0-9_]*(BUDGET|EMAIL)/i);
  });

  it("CLOUDFLARE_API_TOKEN comes from secrets and sits only on the init and plan steps", () => {
    const hits = all().filter((s) => /CLOUDFLARE_API_TOKEN/.test(stepCode(s)));
    assert.equal(hits.length, 2, "expected the init and the plan step");
    for (const s of hits) {
      assert.ok(isInitStep(s) || isPlanStep(s));
      assert.match(stepCode(s), /^\s*CLOUDFLARE_API_TOKEN:\s*\$\{\{\s*secrets\.CLOUDFLARE_API_TOKEN\s*\}\}\s*$/m);
    }
    assert.equal(code.filter((l) => /CLOUDFLARE_API_TOKEN/.test(l)).length, 2, "also appears outside those steps");
  });

  it("no other secret is referenced and nothing is set at workflow or job level env", () => {
    const secrets = [...codeText.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(secrets)], ["CLOUDFLARE_API_TOKEN"]);
    assert.doesNotMatch(codeText, /secrets:\s*inherit/);
    assert.doesNotMatch(codeText, /-var[ =]/);
  });
});
