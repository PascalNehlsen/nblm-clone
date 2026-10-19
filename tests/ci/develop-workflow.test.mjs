// Structural tests for .github/workflows/develop.yml (ci/develop-deploy,
// ADR 0010): deploy `main` to the develop environment from CI.
//
// Run with: node --test 'tests/ci/*.test.mjs'
//
// The repo has no YAML parser among its dependencies and this PR adds none, so
// the checks are line based and indentation aware. They assume the plain block
// style used in ci.yml (two-space indent, `- ` steps at indent 6 inside a job).
// Only reads the workflow file; no process, no network, no environment.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const FILE = fileURLToPath(new URL("../../.github/workflows/develop.yml", import.meta.url));

function load() {
  if (!existsSync(FILE)) return null;
  return readFileSync(FILE, "utf8").replace(/\r/g, "").split("\n");
}

const lines = load();

function need() {
  assert.ok(lines, ".github/workflows/develop.yml does not exist");
  return lines;
}

const indentOf = (l) => l.match(/^ */)[0].length;
const isBlank = (l) => l.trim() === "";
const isComment = (l) => l.trim().startsWith("#");
const code = (ls) => ls.filter((l) => !isBlank(l) && !isComment(l));

/** Lines of a top-level key's block (without the key line). */
function topBlock(ls, key) {
  const re = new RegExp(`^["']?${key}["']?:`);
  const start = ls.findIndex((l) => re.test(l));
  if (start === -1) return null;
  const out = [];
  for (let i = start + 1; i < ls.length; i++) {
    if (!isBlank(ls[i]) && !isComment(ls[i]) && indentOf(ls[i]) === 0) break;
    out.push(ls[i]);
  }
  return { head: ls[start], body: out };
}

/** Map of job name to its lines (without the job name line). */
function jobs(ls) {
  const block = topBlock(ls, "jobs");
  assert.ok(block, "no top-level jobs: block");
  const result = {};
  let name = null;
  for (const l of block.body) {
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

/** All `run:` bodies as arrays of raw lines. */
function runBlocks(ls) {
  const blocks = [];
  for (let i = 0; i < ls.length; i++) {
    const m = ls[i].match(/^(\s*)(- )?run:\s*(.*)$/);
    if (!m) continue;
    const keyIndent = m[1].length + (m[2] ? 2 : 0);
    const rest = m[3];
    if (/^[|>][+-]?\s*(#.*)?$/.test(rest)) {
      const body = [];
      for (let j = i + 1; j < ls.length; j++) {
        if (!isBlank(ls[j]) && indentOf(ls[j]) <= keyIndent) break;
        body.push(ls[j]);
      }
      blocks.push(body);
    } else {
      blocks.push([rest]);
    }
  }
  return blocks;
}

/** Logical shell command lines of a job (continuations joined, comments dropped). */
function commands(ls) {
  return runBlocks(ls)
    .map((b) => b.join("\n"))
    .join("\n")
    .replace(/\\\n\s*/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

/** For every line, the key indent of the enclosing `env:` block, or null. */
function envContext(ls) {
  const ctx = [];
  let current = null;
  for (const l of ls) {
    if (isBlank(l)) {
      ctx.push(current);
      continue;
    }
    if (current !== null && indentOf(l) <= current) current = null;
    const m = l.match(/^(\s*)(- )?env:\s*(.*)$/);
    if (m) {
      const keyIndent = m[1].length + (m[2] ? 2 : 0);
      if (m[3].startsWith("{")) {
        ctx.push(keyIndent); // inline map on the same line
      } else {
        ctx.push(null);
        current = keyIndent;
      }
      continue;
    }
    ctx.push(current);
  }
  return ctx;
}

/** First index of a logical command matching re, or -1. */
const firstIdx = (cmds, re) => cmds.findIndex((c) => re.test(c));

describe("develop.yml: file", () => {
  it("exists", () => {
    need();
  });
});

describe("develop.yml: triggers", () => {
  it("runs on push to main only, plus workflow_dispatch", () => {
    const ls = need();
    const on = topBlock(ls, "on");
    assert.ok(on, "no top-level on: block");
    const children = code(on.body)
      .filter((l) => indentOf(l) === 2)
      .map((l) => l.trim().replace(/:.*$/, ""))
      .sort();
    assert.deepEqual(children, ["push", "workflow_dispatch"]);

    const pushStart = on.body.findIndex((l) => /^ {2}push:/.test(l));
    const push = [];
    for (let i = pushStart + 1; i < on.body.length; i++) {
      if (!isBlank(on.body[i]) && indentOf(on.body[i]) <= 2) break;
      push.push(on.body[i]);
    }
    const text = code(push).join("\n");
    const inline = text.match(/branches:\s*\[([^\]]*)\]/);
    let branches;
    if (inline) {
      branches = inline[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, ""));
    } else {
      branches = code(push)
        .filter((l) => /^\s*-\s+/.test(l))
        .map((l) => l.replace(/^\s*-\s+/, "").trim().replace(/^["']|["']$/g, ""));
    }
    assert.deepEqual(branches, ["main"]);
    assert.doesNotMatch(text, /branches-ignore|tags|paths/, "no tags or paths filters on push");
  });

  it("never uses pull_request, pull_request_target or workflow_run", () => {
    const text = code(need()).join("\n");
    assert.doesNotMatch(text, /pull_request/);
    assert.doesNotMatch(text, /workflow_run/);
  });
});

describe("develop.yml: permissions", () => {
  it("has top-level permissions: {}", () => {
    const ls = need();
    assert.ok(
      ls.some((l) => /^permissions:\s*\{\s*\}\s*(#.*)?$/.test(l)),
      "top-level permissions: {} missing",
    );
  });

  it("grants every job exactly contents: read", () => {
    const all = jobs(need());
    for (const [name, body] of Object.entries(all)) {
      const start = body.findIndex((l) => /^ {4}permissions:/.test(l));
      assert.notEqual(start, -1, `job ${name} has no permissions block`);
      assert.doesNotMatch(body[start], /\{\s*\}/, `job ${name}: use contents: read`);
      const grants = [];
      for (let i = start + 1; i < body.length; i++) {
        if (!isBlank(body[i]) && indentOf(body[i]) <= 4) break;
        if (!isBlank(body[i]) && !isComment(body[i])) grants.push(body[i].trim().replace(/\s*#.*$/, ""));
      }
      assert.deepEqual(grants, ["contents: read"], `job ${name} grants`);
    }
  });

  it("never mentions id-token", () => {
    assert.doesNotMatch(code(need()).join("\n"), /id-token/);
  });
});

describe("develop.yml: concurrency", () => {
  it("has exactly one concurrency group that never cancels a running deploy", () => {
    const ls = code(need());
    const heads = ls.filter((l) => /^\s*concurrency:/.test(l));
    assert.equal(heads.length, 1, "exactly one concurrency: key");
    const text = ls.join("\n");
    assert.equal((text.match(/\bgroup:/g) ?? []).length, 1);
    assert.match(text, /cancel-in-progress:\s*false\b/);
    assert.doesNotMatch(text, /cancel-in-progress:\s*(true|\$\{\{)/);
  });
});

describe("develop.yml: jobs", () => {
  it("has the jobs migrate, deploy and eval", () => {
    assert.deepEqual(Object.keys(jobs(need())).sort(), ["deploy", "eval", "migrate"]);
  });

  it("deploy needs migrate", () => {
    const body = jobs(need()).deploy ?? [];
    const needs = code(body).find((l) => /^ {4}needs:/.test(l));
    assert.ok(needs, "deploy has no needs:");
    if (/needs:\s*\S/.test(needs)) {
      assert.match(needs, /needs:\s*(migrate|\[\s*migrate\s*\])\s*(#.*)?$/);
    } else {
      const items = code(body)
        .slice(code(body).indexOf(needs) + 1)
        .filter((l) => indentOf(l) > 4)
        .map((l) => l.trim());
      assert.deepEqual(items, ["- migrate"]);
    }
  });

  it("runs both jobs in environment develop", () => {
    const all = jobs(need());
    for (const name of ["migrate", "deploy"]) {
      const env = code(all[name] ?? []).find((l) => /^ {4}environment:/.test(l));
      assert.ok(env, `job ${name} has no environment`);
      assert.match(env, /environment:\s*develop\s*(#.*)?$/, `job ${name} environment`);
    }
  });
});

describe("develop.yml: pinned actions", () => {
  it("pins every uses: to a 40-hex SHA with a version comment", () => {
    const uses = need().filter((l) => /^\s*(- )?uses:/.test(l));
    assert.ok(uses.length > 0, "no uses: lines at all");
    for (const l of uses) {
      assert.match(l, /uses:\s*[\w.-]+\/[\w./-]+@[0-9a-f]{40}\s+#\s*v\d[\w.+-]*\s*$/, l.trim());
    }
  });

  it("sets persist-credentials: false on every checkout", () => {
    const ls = need();
    const checkouts = ls
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => /^\s*(- )?uses:\s*actions\/checkout@/.test(l));
    assert.ok(checkouts.length > 0, "no checkout step");
    for (const { l, i } of checkouts) {
      const m = l.match(/^(\s*)(- )?/);
      const keyIndent = m[1].length + (m[2] ? 2 : 0);
      const dash = keyIndent - 2;
      let start = i;
      while (start > 0 && !(indentOf(ls[start]) === dash && /^\s*- /.test(ls[start]))) start--;
      let end = i + 1;
      while (end < ls.length && (isBlank(ls[end]) || indentOf(ls[end]) > dash)) end++;
      const step = ls.slice(start, end).join("\n");
      assert.match(step, /persist-credentials:\s*false\b/, `checkout at line ${i + 1}`);
    }
  });
});

describe("develop.yml: secrets and template injection", () => {
  it("uses secrets only in step-level env", () => {
    const ls = need();
    const ctx = envContext(ls);
    let seen = 0;
    ls.forEach((l, i) => {
      if (isComment(l) || !/\$\{\{\s*secrets\./.test(l)) return;
      seen++;
      assert.ok(
        ctx[i] !== null && ctx[i] >= 8,
        `line ${i + 1} uses a secret outside a step-level env: ${l.trim()}`,
      );
    });
    assert.ok(seen > 0, "no secret is referenced at all");
  });

  it("never puts a secret inside a run: block", () => {
    for (const body of runBlocks(need())) {
      assert.doesNotMatch(body.join("\n"), /\$\{\{\s*secrets\./);
    }
  });

  it("has no ${{ expression of any kind inside a run: block", () => {
    for (const body of runBlocks(need())) {
      assert.doesNotMatch(body.join("\n"), /\$\{\{/, body.join("\n"));
    }
  });
});

describe("develop.yml: migrate job", () => {
  const cmds = () => commands(jobs(need()).migrate ?? []);

  it("runs the migration guard before any db push", () => {
    const c = cmds();
    const guard = firstIdx(c, /scripts\/migration-guard\.mjs/);
    const push = firstIdx(c, /supabase\b.*\bdb push\b/);
    assert.notEqual(guard, -1, "migration guard is not run");
    assert.notEqual(push, -1, "no supabase db push");
    assert.ok(guard < push, "guard must run before db push");
  });

  it("dry-runs db push before the real push", () => {
    const c = cmds();
    const pushes = c.map((x, i) => ({ x, i })).filter(({ x }) => /\bdb push\b/.test(x));
    const dry = pushes.filter(({ x }) => /--dry-run\b/.test(x));
    const real = pushes.filter(({ x }) => !/--dry-run\b/.test(x));
    assert.ok(dry.length >= 1, "no db push --dry-run");
    assert.ok(real.length >= 1, "no real db push");
    assert.ok(dry[0].i < real[0].i, "dry run must come first");
  });

  it("never resets, seeds or includes all migrations", () => {
    const text = cmds().join("\n");
    assert.doesNotMatch(text, /\bdb reset\b/);
    assert.doesNotMatch(text, /\bseed\b/i);
    assert.doesNotMatch(text, /--include-all|--include-roles|--include-seed/);
    assert.doesNotMatch(code(need()).join("\n"), /--include-all|--include-roles|--include-seed/);
  });
});

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
const usesDbUrlEnv = (s) => /^\s+SUPABASE_DB_URL:/m.test(s.join("\n"));

describe("develop.yml: database URL check (incident: psql echoed a malformed URL with the password)", () => {
  const POOLER_RE =
    "^postgresql://[^:/@]+:[^@]+@[a-z0-9.-]+\\.pooler\\.supabase\\.com:5432/postgres\\?sslmode=require$"
      .replace("[^@]+", "[A-Za-z0-9]+");

  const checkStep = () => {
    const all = steps(jobs(need()).migrate ?? []);
    const first = all.find(usesDbUrlEnv);
    assert.ok(first, "no migrate step has SUPABASE_DB_URL in its env");
    return first;
  };
  const checkCmds = () => commands(checkStep());
  const checkText = () => runBlocks(checkStep()).map((b) => b.join("\n")).join("\n");
  const isMask = (c) => c.includes("::add-mask::");
  const isAssignment = (c) => /^(export\s+|local\s+|readonly\s+)?[A-Za-z_]\w*=/.test(c);

  it("the first migrate step with SUPABASE_DB_URL in its env is named Check database URL", () => {
    assert.equal(stepName(checkStep()), "Check database URL");
  });

  it("no step before it references SUPABASE_DB_URL at all", () => {
    const all = steps(jobs(need()).migrate ?? []);
    const idx = all.findIndex(usesDbUrlEnv);
    assert.notEqual(idx, -1);
    for (const s of all.slice(0, idx)) {
      assert.doesNotMatch(s.join("\n"), /SUPABASE_DB_URL/);
    }
  });

  it("registers at least two masks (password and URL)", () => {
    const masks = checkCmds().filter(isMask);
    assert.ok(masks.length >= 2, `expected >= 2 ::add-mask:: commands, got ${masks.length}`);
  });

  it("registers the masks before any other command that uses the URL", () => {
    const c = checkCmds();
    const maskIdx = c.map((x, i) => (isMask(x) ? i : -1)).filter((i) => i !== -1);
    assert.ok(maskIdx.length >= 2, "fewer than two masks");
    const second = maskIdx[1];
    c.forEach((cmd, i) => {
      if (i < second && /SUPABASE_DB_URL/.test(cmd)) {
        assert.ok(
          isMask(cmd) || isAssignment(cmd),
          `command uses SUPABASE_DB_URL before both masks are set: ${cmd}`,
        );
      }
    });
    const test = firstIdx(c, /=~/);
    assert.notEqual(test, -1, "no =~ test");
    assert.ok(second < test, "the regex test must come after both masks");
  });

  it("checks the URL with =~ against the literal session-pooler pattern", () => {
    const text = checkText();
    assert.match(text, /\[\[[^\n]*=~/, "no [[ ... =~ ... ]] test");
    assert.ok(text.includes(POOLER_RE), `pattern missing: ${POOLER_RE}`);
  });

  it("exits 1 on mismatch with a fixed message", () => {
    assert.match(checkText(), /exit\s+1/);
  });

  it("never prints the URL except inside an ::add-mask:: line", () => {
    for (const c of checkCmds()) {
      if (isMask(c)) continue;
      if (/\b(echo|printf|cat|tee)\b/.test(c)) {
        assert.doesNotMatch(c, /\$\{?SUPABASE_DB_URL\b/, `prints the URL: ${c}`);
      }
      assert.doesNotMatch(
        c,
        /^\s*(?:[A-Za-z_]\w*=)?(?:"?\$\(\s*)?(?:psql|supabase|pnpm\s+exec\s+supabase|npx\s+supabase)\b/,
        `check step must not call a client: ${c}`,
      );
    }
  });

  it("every later step that uses SUPABASE_DB_URL comes after the check step", () => {
    const all = steps(jobs(need()).migrate ?? []);
    const idx = all.findIndex(usesDbUrlEnv);
    const refs = all
      .map((s, i) => ({ s, i }))
      .filter(({ s }) => /SUPABASE_DB_URL/.test(s.join("\n")));
    assert.ok(refs.length > 1, "no later step uses SUPABASE_DB_URL");
    assert.equal(refs[0].i, idx, "check step must be the first step that references the URL");
    for (const { s, i } of refs.slice(1)) {
      assert.ok(i > idx, `step ${stepName(s)} references SUPABASE_DB_URL before the check`);
    }
    assert.doesNotMatch(
      (jobs(need()).deploy ?? []).join("\n"),
      /SUPABASE_DB_URL/,
      "the deploy job must not reference SUPABASE_DB_URL",
    );
  });
});

describe("develop.yml: shell and pipefail", () => {
  it("has top-level defaults: run: shell: bash", () => {
    const d = topBlock(need(), "defaults");
    assert.ok(d, "no top-level defaults: block");
    const body = code(d.body);
    const run = body.findIndex((l) => indentOf(l) === 2 && /^\s*run:\s*$/.test(l));
    assert.notEqual(run, -1, "defaults has no run: key");
    assert.ok(
      body.slice(run + 1).some((l) => indentOf(l) === 4 && /^\s*shell:\s*bash\s*(#.*)?$/.test(l)),
      "defaults.run.shell must be bash",
    );
  });

  it("no step or job overrides shell: with anything but bash", () => {
    for (const l of code(need())) {
      const m = l.match(/^\s*(- )?shell:\s*(.*?)\s*(#.*)?$/);
      if (m) assert.equal(m[2], "bash", `shell override: ${l.trim()}`);
    }
  });

  it("any run: with a pipe needs the bash default or set -o pipefail", () => {
    const d = topBlock(need(), "defaults");
    const hasDefault = !!d && /^\s*shell:\s*bash\s*(#.*)?$/m.test(d.body.join("\n"));
    for (const body of runBlocks(need())) {
      const text = body
        .join("\n")
        .replace(/"(?:\\.|[^"\\])*"/g, '""')
        .replace(/'[^']*'/g, "''");
      if (/(^|[^|])\|(?!\|)/.test(text)) {
        assert.ok(
          hasDefault || /set\s+-[a-z]*o\s+pipefail/.test(text),
          `piped run without pipefail: ${text}`,
        );
      }
    }
  });
});

describe("develop.yml: deploy URL check", () => {
  it("matches the deploy URL with a strict bash regex and exits non-zero otherwise", () => {
    const block = runBlocks(need())
      .map((b) => b.join("\n"))
      .find((t) => /\bvercel\b.*\bdeploy\b/.test(t));
    assert.ok(block, "no deploy run block");
    assert.match(
      block,
      /\[\[[^\n]*=~[^\n]*\^https:\/\/\[a-z0-9-\]\+\\\.vercel\\\.app\$/,
      "deploy URL must be checked with [[ ... =~ ^https://[a-z0-9-]+\\.vercel\\.app$ ]]",
    );
    assert.match(block, /exit\s+1/);
    assert.doesNotMatch(block, /\bcase\b/, "a case glob also matches / and newlines");
  });
});

describe("develop.yml: deploy job", () => {
  it("deploys staged, smokes, promotes, smokes live, in that order", () => {
    const c = commands(jobs(need()).deploy ?? []);
    const deploy = firstIdx(c, /\bvercel\b.*\bdeploy\b/);
    assert.notEqual(deploy, -1, "no vercel deploy");
    assert.match(c[deploy], /--prod\b/);
    assert.match(c[deploy], /--skip-domain\b/);

    const staged = firstIdx(c, /scripts\/smoke\.mjs\s+staged\b/);
    const promote = firstIdx(c, /\bvercel\b.*\bpromote\b/);
    const live = firstIdx(c, /scripts\/smoke\.mjs\s+live\b/);
    assert.notEqual(staged, -1, "no smoke.mjs staged");
    assert.notEqual(promote, -1, "no vercel promote");
    assert.notEqual(live, -1, "no smoke.mjs live");
    assert.ok(deploy < staged && staged < promote && promote < live, "wrong order");
  });
});

describe("develop.yml: deploy outputs the URL for the eval job", () => {
  it("declares outputs: url: ${{ steps.deploy.outputs.url }} at job level", () => {
    const body = jobs(need()).deploy ?? [];
    const start = body.findIndex((l) => /^ {4}outputs:\s*(#.*)?$/.test(l));
    assert.notEqual(start, -1, "deploy has no outputs: block");
    const entries = [];
    for (let i = start + 1; i < body.length; i++) {
      if (!isBlank(body[i]) && indentOf(body[i]) <= 4) break;
      if (!isBlank(body[i]) && !isComment(body[i])) entries.push(body[i].trim().replace(/\s*#.*$/, ""));
    }
    assert.deepEqual(entries, ["url: ${{ steps.deploy.outputs.url }}"]);
  });
});

describe("develop.yml: eval job", () => {
  const evalJob = () => {
    const body = jobs(need()).eval;
    assert.ok(body, "no eval job");
    return body;
  };
  const jobKey = (key) => code(evalJob()).find((l) => new RegExp(`^ {4}${key}:`).test(l));
  const evalStep = () => {
    const found = steps(evalJob()).find((s) => stepName(s) === "Eval");
    assert.ok(found, "no step named Eval");
    return found;
  };

  it("is named eval (develop)", () => {
    assert.match(jobKey("name") ?? "", /name:\s*["']?eval \(develop\)["']?\s*(#.*)?$/);
  });

  it("needs exactly deploy", () => {
    const needs = jobKey("needs");
    assert.ok(needs, "eval has no needs:");
    assert.match(needs, /needs:\s*(deploy|\[\s*deploy\s*\])\s*(#.*)?$/);
  });

  // 12 minutes: a timed-out first attempt (310 s) plus the retry needs up to 625 s.
  it("runs on ubuntu-24.04 in environment develop with a 12 minute timeout", () => {
    assert.match(jobKey("runs-on") ?? "", /runs-on:\s*ubuntu-24\.04\s*(#.*)?$/);
    assert.match(jobKey("environment") ?? "", /environment:\s*develop\s*(#.*)?$/);
    assert.match(jobKey("timeout-minutes") ?? "", /timeout-minutes:\s*12\s*(#.*)?$/);
  });

  it("has no job-level env, so no secret can reach other steps", () => {
    assert.equal(jobKey("env"), undefined, "eval must set env per step only");
  });

  it("checks out with persist-credentials: false and sets up node, without installing packages", () => {
    const text = evalJob().join("\n");
    assert.match(text, /uses:\s*actions\/checkout@[0-9a-f]{40}/);
    assert.match(text, /uses:\s*actions\/setup-node@[0-9a-f]{40}/);
    assert.match(text, /node-version:\s*24\b/);
    assert.doesNotMatch(commands(evalJob()).join("\n"), /\b(pnpm|npm|yarn)\s+(install|i|ci)\b/);
    assert.doesNotMatch(text, /pnpm\/action-setup/);
  });

  it("the Eval step runs node scripts/eval.mjs piped into tee -a $GITHUB_STEP_SUMMARY", () => {
    const c = commands(evalStep());
    assert.deepEqual(c, ['node scripts/eval.mjs | tee -a "$GITHUB_STEP_SUMMARY"']);
  });

  it("the Eval step env has the URL from the deploy output and both secrets", () => {
    const text = evalStep().join("\n");
    assert.match(text, /^\s+EVAL_BASE_URL:\s*\$\{\{\s*needs\.deploy\.outputs\.url\s*\}\}\s*$/m);
    assert.match(text, /^\s+EVAL_SECRET:\s*\$\{\{\s*secrets\.EVAL_SECRET\s*\}\}\s*$/m);
    assert.match(
      text,
      /^\s+VERCEL_AUTOMATION_BYPASS_SECRET:\s*\$\{\{\s*secrets\.VERCEL_AUTOMATION_BYPASS_SECRET\s*\}\}\s*$/m,
    );
  });

  it("secrets appear only inside the Eval step", () => {
    const body = evalJob();
    const evalText = evalStep().join("\n");
    const secretLines = body.filter((l) => !isComment(l) && /\$\{\{\s*secrets\./.test(l));
    assert.ok(secretLines.length >= 2, "expected the two secrets");
    for (const l of secretLines) assert.ok(evalText.includes(l), `secret outside the Eval step: ${l.trim()}`);
  });

  it("does not run when the deploy failed or was skipped, and has no if: that bypasses needs", () => {
    assert.doesNotMatch(code(evalJob()).join("\n"), /^\s*if:\s*.*(always\(\)|failure\(\)|cancelled\(\))/m);
  });
});
