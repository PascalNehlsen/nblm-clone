// Structural test for .github/workflows/security-scans.yml: dependency review,
// CodeQL (javascript-typescript and actions) and the Trivy IaC scan.
//
// Run with: node --test tests/ci/security-scans-workflow.test.mjs
//
// Line based and indentation aware, like infra-workflow.test.mjs (no YAML
// parser in the repo). Only reads the workflow file.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const FILE = fileURLToPath(new URL("../../.github/workflows/security-scans.yml", import.meta.url));
const lines = readFileSync(FILE, "utf8").replace(/\r/g, "").split("\n");

const indentOf = (l) => l.match(/^ */)[0].length;
const isBlank = (l) => l.trim() === "";
const isComment = (l) => l.trim().startsWith("#");
const code = lines.filter((l) => !isComment(l));

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

const jobName = (body) => (body.find((l) => /^ {4}name:/.test(l)) ?? "").replace(/^ {4}name:\s*/, "").replace(/^["']|["']\s*$/g, "").trim();

function jobByName(name) {
  const hit = Object.values(jobs(lines)).filter((b) => jobName(b) === name);
  assert.equal(hit.length, 1, `expected exactly one job named ${name}`);
  return hit[0];
}

/** Key/value pairs of a job-level permissions block (indent 6). */
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

const usesLines = (body) => body.filter((l) => !isComment(l) && /\buses:\s/.test(l));

describe("security-scans.yml: triggers and top level", () => {
  const text = code.join("\n");

  it("has top-level permissions: {}", () => {
    assert.ok(code.some((l) => /^permissions:\s*\{\s*\}\s*$/.test(l)), "missing top-level permissions: {}");
  });

  it("triggers on pull_request, push to main, a weekly schedule and workflow_dispatch", () => {
    const on = code.slice(code.findIndex((l) => /^on:/.test(l)));
    const end = on.findIndex((l, i) => i > 0 && indentOf(l) === 0 && !isBlank(l));
    const block = on.slice(0, end === -1 ? undefined : end).join("\n");
    assert.match(block, /^ {2}pull_request:/m);
    assert.match(block, /^ {2}push:/m);
    assert.match(block, /branches:\s*\[\s*main\s*\]/);
    assert.match(block, /^ {2}schedule:/m);
    assert.match(block, /^ {2}workflow_dispatch:/m);
  });

  it("weekly schedule: a cron with day-of-week set and a fixed day", () => {
    const cron = code.find((l) => /- cron:/.test(l));
    assert.ok(cron, "no cron entry");
    const fields = cron.match(/cron:\s*["']([^"']+)["']/)?.[1].trim().split(/\s+/);
    assert.equal(fields?.length, 5, "cron needs five fields");
    assert.match(fields[4], /^[0-6]$/, "day of week must be a single day (weekly)");
    assert.match(fields[2], /^\*$/);
    assert.match(fields[3], /^\*$/);
  });

  it("has no paths or paths-ignore filter and never uses pull_request_target", () => {
    assert.doesNotMatch(text, /^\s*paths(-ignore)?:/m);
    assert.doesNotMatch(text, /pull_request_target/);
  });

  it("pins every action to a 40-hex SHA with a version comment", () => {
    const uses = lines.filter((l) => !isComment(l) && /\buses:\s/.test(l));
    assert.ok(uses.length >= 3, "expected several uses: lines");
    for (const l of uses) {
      assert.match(l, /uses:\s*[\w.-]+\/[\w./-]+@[0-9a-f]{40}\s+#\s*v\d[\w.\-]*\s*$/, l.trim());
    }
  });

  it("every checkout sets persist-credentials: false", () => {
    for (const [name, body] of Object.entries(jobs(lines))) {
      body.forEach((l, i) => {
        if (!/uses:\s*actions\/checkout@/.test(l) || isComment(l)) return;
        const rest = body.slice(i + 1, i + 6).join("\n");
        assert.match(rest, /persist-credentials:\s*false/, `${name}: checkout without persist-credentials: false`);
      });
    }
  });

  it("has exactly the three jobs", () => {
    const names = Object.values(jobs(lines)).map(jobName).sort();
    assert.deepEqual(names, ["codeql (${{ matrix.language }})", "dependency review", "iac scan (trivy)"].sort());
  });
});

describe("security-scans.yml: dependency review", () => {
  const body = () => jobByName("dependency review");

  it("runs on pull requests only", () => {
    const cond = body().find((l) => /^ {4}if:/.test(l));
    assert.ok(cond, "no job-level if:");
    assert.match(cond, /github\.event_name\s*==\s*'pull_request'/);
  });

  it("has only contents: read", () => {
    assert.deepEqual(permissionsOf(body()), { contents: "read" });
  });

  it("uses actions/dependency-review-action with fail-on-severity high and no PR comment", () => {
    const b = body();
    assert.equal(usesLines(b).filter((l) => /actions\/dependency-review-action@/.test(l)).length, 1);
    const text = b.filter((l) => !isComment(l)).join("\n");
    assert.match(text, /fail-on-severity:\s*high\b/);
    assert.match(text, /comment-summary-in-pr:\s*never\b/);
  });
});

describe("security-scans.yml: codeql", () => {
  const NAME = "codeql (${{ matrix.language }})";
  const body = () => jobByName(NAME);

  it("matrix is exactly javascript-typescript and actions", () => {
    const b = body();
    const at = b.findIndex((l) => /^\s+language:/.test(l));
    assert.notEqual(at, -1, "no matrix language");
    let langs = [];
    const inline = b[at].match(/language:\s*\[(.*)\]/);
    if (inline) {
      langs = inline[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, ""));
    } else {
      for (let i = at + 1; i < b.length; i++) {
        const m = b[i].match(/^\s+-\s*["']?([\w-]+)["']?\s*(#.*)?$/);
        if (!m) break;
        langs.push(m[1]);
      }
    }
    assert.deepEqual(langs.sort(), ["actions", "javascript-typescript"]);
  });

  it("has exactly contents: read, security-events: write, actions: read", () => {
    assert.deepEqual(permissionsOf(body()), { contents: "read", "security-events": "write", actions: "read" });
  });

  it("init and analyze come from github/codeql-action at the same SHA, init with build-mode: none", () => {
    const b = body();
    const init = b.filter((l) => !isComment(l) && /github\/codeql-action\/init@/.test(l));
    const analyze = b.filter((l) => !isComment(l) && /github\/codeql-action\/analyze@/.test(l));
    assert.equal(init.length, 1);
    assert.equal(analyze.length, 1);
    const sha = (l) => l.match(/@([0-9a-f]{40})/)?.[1];
    assert.ok(sha(init[0]), "init not pinned");
    assert.equal(sha(init[0]), sha(analyze[0]));
    const text = b.filter((l) => !isComment(l)).join("\n");
    assert.match(text, /build-mode:\s*none\b/);
    assert.match(text, /languages:\s*\$\{\{\s*matrix\.language\s*\}\}/);
  });
});

describe("security-scans.yml: iac scan (trivy)", () => {
  const body = () => jobByName("iac scan (trivy)");

  it("has only contents: read", () => {
    assert.deepEqual(permissionsOf(body()), { contents: "read" });
  });

  it("runs the pinned wrapper script with the agreed arguments on infra", () => {
    const text = body().filter((l) => !isComment(l)).join("\n");
    assert.match(
      text,
      /scripts\/trivy\.sh config --skip-check-update --severity HIGH,CRITICAL --exit-code 1 --ignorefile \.trivyignore\.yaml infra\s*$/m,
    );
  });

  it("does not install or run trivy any other way", () => {
    const text = body().filter((l) => !isComment(l)).join("\n");
    assert.doesNotMatch(text, /aquasecurity\/trivy-action/);
    assert.doesNotMatch(text, /(^|\s)trivy\s+config/m);
  });
});
