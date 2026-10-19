// Structural tests for .github/workflows/release.yml (ci/release-workflow, R3):
// release to production from a `v*` tag, with a staged deploy, a canary,
// promote, a live smoke test and an automatic rollback.
//
// Run with: node --test 'tests/ci/*.test.mjs'
//
// Same approach as develop-workflow.test.mjs: no YAML parser, line based and
// indentation aware, plain block style (two-space indent, `- ` steps at indent
// 6 inside a job, step keys at indent 8, env keys at indent 10).
// Only reads the workflow file; no process, no network, no environment.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const FILE = fileURLToPath(new URL("../../.github/workflows/release.yml", import.meta.url));

function load() {
  if (!existsSync(FILE)) return null;
  return readFileSync(FILE, "utf8").replace(/\r/g, "").split("\n");
}

const lines = load();

function need() {
  assert.ok(lines, ".github/workflows/release.yml does not exist");
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

const release = () => {
  const all = jobs(need());
  assert.deepEqual(Object.keys(all), ["release"], "exactly one job named release");
  return all.release;
};

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

/** Logical shell command lines (continuations joined, comments dropped). */
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
        ctx.push(keyIndent);
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
const stepId = (s) => (s.join("\n").match(/^\s*(?:- )?id:\s*["']?([\w-]+)["']?\s*$/m) ?? [])[1];
const stepIf = (s) => (s.join("\n").match(/^\s+if:\s*(.*)$/m) ?? [])[1];
const stepText = (s) => runBlocks(s).map((b) => b.join("\n")).join("\n");
const stepCmds = (s) => commands(s);
const stepEnvText = (s) => s.filter((l) => !isComment(l)).join("\n");
const refsDbUrl = (s) => /SUPABASE_DB_URL/.test(s.join("\n"));

const ROLLBACK_RE = /roll\s*back/i;
const isRollback = (s) => ROLLBACK_RE.test(stepName(s) ?? "");

/** Index of the first step whose logical commands match re (rollback excluded unless asked). */
function stepIdx(re, { includeRollback = false } = {}) {
  const all = steps(release());
  return all.findIndex(
    (s) => (includeRollback || !isRollback(s)) && stepCmds(s).some((c) => re.test(c)),
  );
}

const ALLOWED_SECRETS = [
  "SUPABASE_DB_URL",
  "VERCEL_TOKEN",
  "VERCEL_AUTOMATION_BYPASS_SECRET",
  "CANARY_SECRET",
];

describe("release.yml: file", () => {
  it("exists", () => {
    need();
  });
});

describe("release.yml: triggers", () => {
  it("runs on push of tags v* only", () => {
    const ls = need();
    const on = topBlock(ls, "on");
    assert.ok(on, "no top-level on: block");
    const children = code(on.body)
      .filter((l) => indentOf(l) === 2)
      .map((l) => l.trim().replace(/:.*$/, ""));
    assert.deepEqual(children, ["push"]);

    const push = [];
    const pushStart = on.body.findIndex((l) => /^ {2}push:/.test(l));
    for (let i = pushStart + 1; i < on.body.length; i++) {
      if (!isBlank(on.body[i]) && indentOf(on.body[i]) <= 2) break;
      push.push(on.body[i]);
    }
    const text = code(push).join("\n");
    const inline = text.match(/tags:\s*\[([^\]]*)\]/);
    let tags;
    if (inline) {
      tags = inline[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, ""));
    } else {
      const start = code(push).findIndex((l) => /^\s*tags:\s*$/.test(l));
      assert.notEqual(start, -1, "no tags: filter on push");
      tags = code(push)
        .slice(start + 1)
        .filter((l) => /^\s*-\s+/.test(l))
        .map((l) => l.replace(/^\s*-\s+/, "").trim().replace(/\s*#.*$/, "").replace(/^["']|["']$/g, ""));
    }
    assert.deepEqual(tags, ["v*"]);
    assert.doesNotMatch(text, /branches|paths|tags-ignore/, "only a tags filter on push");
  });

  it("never uses pull_request, pull_request_target, workflow_run or workflow_dispatch", () => {
    const text = code(need()).join("\n");
    assert.doesNotMatch(text, /pull_request/);
    assert.doesNotMatch(text, /workflow_run/);
    assert.doesNotMatch(text, /workflow_dispatch/);
  });
});

describe("release.yml: permissions", () => {
  it("has top-level permissions: {}", () => {
    assert.ok(
      need().some((l) => /^permissions:\s*\{\s*\}\s*(#.*)?$/.test(l)),
      "top-level permissions: {} missing",
    );
  });

  it("grants the release job exactly contents: read and actions: read", () => {
    const body = release();
    const start = body.findIndex((l) => /^ {4}permissions:/.test(l));
    assert.notEqual(start, -1, "release job has no permissions block");
    assert.doesNotMatch(body[start], /\{\s*\}/);
    const grants = [];
    for (let i = start + 1; i < body.length; i++) {
      if (!isBlank(body[i]) && indentOf(body[i]) <= 4) break;
      if (!isBlank(body[i]) && !isComment(body[i])) grants.push(body[i].trim().replace(/\s*#.*$/, ""));
    }
    assert.deepEqual(grants.sort(), ["actions: read", "contents: read"]);
  });

  it("never mentions id-token", () => {
    assert.doesNotMatch(code(need()).join("\n"), /id-token/);
  });
});

describe("release.yml: job, environment, concurrency", () => {
  it("runs on ubuntu-24.04 in environment production", () => {
    const body = code(release());
    const runsOn = body.find((l) => /^ {4}runs-on:/.test(l));
    assert.ok(runsOn, "no runs-on");
    assert.match(runsOn, /runs-on:\s*ubuntu-24\.04\s*(#.*)?$/);
    const env = body.find((l) => /^ {4}environment:/.test(l));
    assert.ok(env, "no environment");
    assert.match(env, /environment:\s*production\s*(#.*)?$/);
  });

  it("has exactly one concurrency group production that never cancels", () => {
    const ls = code(need());
    assert.equal(ls.filter((l) => /^\s*concurrency:/.test(l)).length, 1, "exactly one concurrency: key");
    const text = ls.join("\n");
    assert.equal((text.match(/\bgroup:/g) ?? []).length, 1);
    assert.match(text, /\bgroup:\s*["']?production["']?\s*(#.*)?$/m);
    assert.match(text, /cancel-in-progress:\s*false\b/);
    assert.doesNotMatch(text, /cancel-in-progress:\s*(true|\$\{\{)/);
  });
});

describe("release.yml: pinned actions and checkout", () => {
  it("pins every uses: to a 40-hex SHA with a version comment", () => {
    const uses = need().filter((l) => /^\s*(- )?uses:/.test(l));
    assert.ok(uses.length > 0, "no uses: lines at all");
    for (const l of uses) {
      assert.match(l, /uses:\s*[\w.-]+\/[\w./-]+@[0-9a-f]{40}\s+#\s*v\d[\w.+-]*\s*$/, l.trim());
    }
  });

  it("checks out with fetch-depth 0 and persist-credentials false", () => {
    const co = steps(release()).filter((s) => /^\s*(- )?uses:\s*actions\/checkout@/m.test(s.join("\n")));
    assert.ok(co.length > 0, "no checkout step");
    for (const s of co) {
      const t = s.join("\n");
      assert.match(t, /persist-credentials:\s*false\b/);
      assert.match(t, /fetch-depth:\s*0\b/);
    }
  });
});

describe("release.yml: shell and pipefail", () => {
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

  it("every step that writes to GITHUB_STEP_SUMMARY does so through tee -a", () => {
    let seen = 0;
    for (const c of commands(need())) {
      if (!/GITHUB_STEP_SUMMARY/.test(c)) continue;
      seen++;
      assert.match(c, /\|\s*tee\s+-a\s+"\$GITHUB_STEP_SUMMARY"/, `summary write without tee -a: ${c}`);
      assert.doesNotMatch(c, />>?\s*"?\$GITHUB_STEP_SUMMARY/, `plain redirect to the summary: ${c}`);
    }
    assert.ok(seen > 0, "nothing is written to the step summary");
  });
});

describe("release.yml: secrets and template injection", () => {
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

  it("references only the four allowed secrets, each mapped to its own name", () => {
    const names = [];
    for (const l of code(need())) {
      const m = l.match(/\$\{\{\s*secrets\.([A-Za-z0-9_]+)\s*\}\}/g);
      if (!m) continue;
      for (const x of m) names.push(x.match(/secrets\.([A-Za-z0-9_]+)/)[1]);
      const key = l.trim().match(/^([A-Za-z0-9_]+):/);
      assert.ok(key, `secret not assigned to a plain env key: ${l.trim()}`);
      assert.equal(key[1], names[names.length - 1], `env key differs from secret name: ${l.trim()}`);
    }
    for (const n of names) assert.ok(ALLOWED_SECRETS.includes(n), `unexpected secret ${n}`);
    for (const n of ALLOWED_SECRETS) assert.ok(names.includes(n), `secret ${n} is never used`);
  });

  it("puts a secret only in steps whose script uses it", () => {
    for (const s of steps(release())) {
      for (const name of ALLOWED_SECRETS) {
        if (!new RegExp(`^\\s+${name}:\\s*\\$\\{\\{\\s*secrets\\.${name}\\s*\\}\\}`, "m").test(s.join("\n"))) continue;
        // scripts/smoke.mjs and scripts/canary.mjs read their secrets from the
        // environment, so the run text never names them.
        const cmds = stepCmds(s);
        const runsSmoke = cmds.some((c) => /scripts\/smoke\.mjs/.test(c));
        const runsCanary = cmds.some((c) => /scripts\/canary\.mjs/.test(c));
        const readByScript =
          (name === "VERCEL_AUTOMATION_BYPASS_SECRET" && (runsSmoke || runsCanary)) ||
          (name === "CANARY_SECRET" && runsCanary);
        assert.ok(
          readByScript || new RegExp(`\\$\\{?${name}\\b`).test(stepText(s)),
          `step "${stepName(s)}" has ${name} in env but its script never uses it`,
        );
      }
    }
  });

  it("scopes each secret to the steps that need it", () => {
    for (const s of steps(release())) {
      const text = stepEnvText(s);
      const cmds = stepCmds(s).join("\n");
      const label = `step "${stepName(s)}"`;
      if (/secrets\.CANARY_SECRET/.test(text)) {
        assert.match(cmds, /scripts\/canary\.mjs/, `${label} must not have CANARY_SECRET`);
      }
      if (/secrets\.SUPABASE_DB_URL/.test(text)) {
        assert.doesNotMatch(cmds, /\bvercel\b|canary\.mjs|smoke\.mjs/, `${label} must not have SUPABASE_DB_URL`);
      }
      if (/secrets\.VERCEL_TOKEN/.test(text)) {
        assert.doesNotMatch(cmds, /\bpsql\b|\bsupabase\b|canary\.mjs/, `${label} must not have VERCEL_TOKEN`);
      }
      if (/secrets\.VERCEL_AUTOMATION_BYPASS_SECRET/.test(text)) {
        assert.doesNotMatch(cmds, /\bpsql\b|\bsupabase\b/, `${label} must not have the bypass secret`);
      }
    }
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

  it("takes the production variables from vars.* only", () => {
    const text = code(need()).join("\n");
    for (const v of [
      "VERCEL_ORG_ID",
      "VERCEL_PROJECT_ID",
      "PRODUCTION_SITE_URL",
      "PRODUCTION_SUPABASE_URL",
      "PRODUCTION_SUPABASE_PUBLISHABLE_KEY",
    ]) {
      assert.match(text, new RegExp(`\\$\\{\\{\\s*vars\\.${v}\\s*\\}\\}`), `vars.${v} is not used`);
    }
    assert.doesNotMatch(text, /\bDEVELOP_[A-Z_]+/, "no develop variables in the production release");
  });
});

describe("release.yml: tag and develop gates", () => {
  it("checks that the tagged commit is an ancestor of origin/main", () => {
    const i = stepIdx(/git merge-base --is-ancestor\s+"?\$GITHUB_SHA"?\s+origin\/main\b/);
    assert.notEqual(i, -1, "no merge-base --is-ancestor $GITHUB_SHA origin/main step");
    const s = steps(release())[i];
    assert.match(stepText(s), /exit\s+1|\|\|/, "the ancestor check must fail the release");
  });

  it("checks that develop.yml succeeded for this SHA through gh api", () => {
    const i = stepIdx(/\bgh api\b/);
    assert.notEqual(i, -1, "no gh api step");
    const s = steps(release())[i];
    const env = s.join("\n");
    assert.match(env, /GH_TOKEN:\s*\$\{\{\s*github\.token\s*\}\}/);
    assert.match(env, /^\s+REPO:/m);
    assert.match(env, /^\s+SHA:/m);
    const text = stepText(s);
    assert.match(text, /develop\.yml/);
    assert.match(text, /success/);
    assert.match(text, /exit\s+1/, "must fail when no successful develop run exists");
    assert.doesNotMatch(text, /\$\{\{/);
  });

  it("runs both gates before pnpm install and before anything touches production", () => {
    const anc = stepIdx(/--is-ancestor/);
    const dev = stepIdx(/\bgh api\b/);
    const install = stepIdx(/pnpm install --frozen-lockfile/);
    assert.notEqual(install, -1, "no pnpm install --frozen-lockfile");
    const dbUse = steps(release()).findIndex(refsDbUrl);
    assert.ok(anc !== -1 && anc < dev, "ancestor check must come first, then the develop check");
    assert.ok(dev < install, "develop check before install");
    assert.ok(install < dbUse, "install before any step with the database URL");
  });
});

describe("release.yml: database URL check", () => {
  const POOLER_RE =
    "^postgresql://[^:/@]+:[A-Za-z0-9]+@[a-z0-9.-]+\\.pooler\\.supabase\\.com:5432/postgres\\?sslmode=require$";

  const checkStep = () => {
    const first = steps(release()).find(refsDbUrl);
    assert.ok(first, "no step has SUPABASE_DB_URL in its env");
    return first;
  };
  const checkCmds = () => commands(checkStep());
  const isMask = (c) => c.includes("::add-mask::");
  const isAssignment = (c) => /^(export\s+|local\s+|readonly\s+)?[A-Za-z_]\w*=/.test(c);
  const firstIdx = (cmds, re) => cmds.findIndex((c) => re.test(c));

  it("the first step with SUPABASE_DB_URL is named Check database URL", () => {
    assert.equal(stepName(checkStep()), "Check database URL");
  });

  it("no step before it references SUPABASE_DB_URL", () => {
    const all = steps(release());
    const idx = all.findIndex(refsDbUrl);
    for (const s of all.slice(0, idx)) assert.doesNotMatch(s.join("\n"), /SUPABASE_DB_URL/);
  });

  it("registers at least two masks before any other use and before the regex test", () => {
    const c = checkCmds();
    const maskIdx = c.map((x, i) => (isMask(x) ? i : -1)).filter((i) => i !== -1);
    assert.ok(maskIdx.length >= 2, `expected >= 2 ::add-mask:: commands, got ${maskIdx.length}`);
    const second = maskIdx[1];
    c.forEach((cmd, i) => {
      if (i < second && /SUPABASE_DB_URL/.test(cmd)) {
        assert.ok(isMask(cmd) || isAssignment(cmd), `uses the URL before both masks: ${cmd}`);
      }
    });
    const test = firstIdx(c, /=~/);
    assert.notEqual(test, -1, "no =~ test");
    assert.ok(second < test, "the regex test must come after both masks");
  });

  it("checks the URL against the literal session-pooler pattern and exits 1", () => {
    const text = runBlocks(checkStep()).map((b) => b.join("\n")).join("\n");
    assert.match(text, /\[\[[^\n]*=~/);
    assert.ok(text.includes(POOLER_RE), `pattern missing: ${POOLER_RE}`);
    assert.match(text, /exit\s+1/);
  });

  it("never prints the URL and calls no client in the check step", () => {
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

  it("every database client call comes after the check step", () => {
    const all = steps(release());
    const idx = all.findIndex(refsDbUrl);
    all.forEach((s, i) => {
      if (stepCmds(s).some((c) => /\bpsql\b|\bsupabase\b.*\bdb\b/.test(c))) {
        assert.ok(i > idx, `step "${stepName(s)}" uses the database before the URL check`);
      }
    });
    const clients = all.filter((s) => stepCmds(s).some((c) => /\bpsql\b|\bdb push\b/.test(c)));
    assert.ok(clients.length >= 2, "expected psql and db push steps");
  });
});

describe("release.yml: database steps", () => {
  const cmds = () => commands(release());

  it("never resets, seeds or includes all migrations", () => {
    const text = cmds().join("\n");
    assert.doesNotMatch(text, /\bdb reset\b/);
    assert.doesNotMatch(text, /\bseed\b/i);
    assert.doesNotMatch(text, /--include-all|--include-roles|--include-seed/);
    assert.doesNotMatch(code(need()).join("\n"), /--include-all|--include-roles|--include-seed/);
  });

  it("dry-runs db push before the real push", () => {
    const all = steps(release());
    const pushes = all
      .map((s, i) => ({ s, i, c: stepCmds(s).filter((x) => /\bdb push\b/.test(x)) }))
      .filter((x) => x.c.length > 0);
    const dry = pushes.filter((x) => x.c.some((c) => /--dry-run\b/.test(c)));
    const real = pushes.filter((x) => x.c.some((c) => !/--dry-run\b/.test(c)));
    assert.ok(dry.length >= 1, "no db push --dry-run step");
    assert.ok(real.length >= 1, "no real db push step");
    assert.ok(dry[0].i < real[0].i, "dry run must come first");
  });
});

describe("release.yml: step order", () => {
  it("runs the whole release in the specified order", () => {
    const order = [
      ["ancestor check", stepIdx(/--is-ancestor/)],
      ["develop check", stepIdx(/\bgh api\b/)],
      ["install", stepIdx(/pnpm install --frozen-lockfile/)],
      ["database URL check", steps(release()).findIndex(refsDbUrl)],
      ["read applied migrations", stepIdx(/\bpsql\b/)],
      ["migration guard", stepIdx(/scripts\/migration-guard\.mjs/)],
      ["dry run", stepIdx(/\bdb push\b.*--dry-run\b/)],
      ["push", stepIdx(/\bdb push\b(?!.*--dry-run)/)],
      ["record previous", stepIdx(/api\.vercel\.com\/v13\/deployments/)],
      ["deploy", stepIdx(/\bvercel\b.*\bdeploy\b/)],
      ["staged smoke", stepIdx(/scripts\/smoke\.mjs\s+staged\b/)],
      ["canary", stepIdx(/scripts\/canary\.mjs/)],
      ["promote", stepIdx(/\bvercel\b.*\bpromote\b/)],
      ["live smoke", stepIdx(/scripts\/smoke\.mjs\s+live\b/)],
    ];
    for (const [name, i] of order) assert.notEqual(i, -1, `missing step: ${name}`);
    for (let k = 1; k < order.length; k++) {
      assert.ok(order[k - 1][1] < order[k][1], `${order[k - 1][0]} must come before ${order[k][0]}`);
    }
  });

  it("records the live deployment as step id previous, with teamId, printing only the id", () => {
    const all = steps(release());
    const s = all.find((x) => stepId(x) === "previous");
    assert.ok(s, "no step with id: previous");
    const text = stepText(s);
    assert.match(text, /https:\/\/api\.vercel\.com\/v13\/deployments\/[^\n]*teamId=/);
    assert.match(s.join("\n"), /VERCEL_TOKEN:\s*\$\{\{\s*secrets\.VERCEL_TOKEN\s*\}\}/);
    assert.match(text, /GITHUB_OUTPUT/);
    assert.match(text, /\bid=/);
    assert.match(text, /404/, "the first release (API answers 404) must not fail");
  });

  it("deploys staged with step id deploy and a strict URL regex", () => {
    const all = steps(release());
    const s = all.find((x) => stepId(x) === "deploy");
    assert.ok(s, "no step with id: deploy");
    const text = stepText(s);
    const deploy = stepCmds(s).find((c) => /\bvercel\b.*\bdeploy\b/.test(c));
    assert.ok(deploy, "no vercel deploy command in the deploy step");
    assert.match(deploy, /--prod\b/);
    assert.match(deploy, /--skip-domain\b/);
    assert.match(deploy, /--yes\b/);
    assert.match(
      text,
      /\[\[[^\n]*=~[^\n]*\^https:\/\/\[a-z0-9-\]\+\\\.vercel\\\.app\$/,
      "deploy URL must be checked with [[ ... =~ ^https://[a-z0-9-]+\\.vercel\\.app$ ]]",
    );
    assert.match(text, /exit\s+1/);
    assert.doesNotMatch(text, /\bcase\b/);
    assert.match(text, /\burl=/, "the deploy step must output url");
    assert.match(text, /GITHUB_OUTPUT/);
  });

  it("runs the staged smoke test with its environment", () => {
    const all = steps(release());
    const s = all.find((x) => stepCmds(x).some((c) => /scripts\/smoke\.mjs\s+staged\b/.test(c)));
    assert.ok(s, "no staged smoke step");
    const t = s.join("\n");
    assert.match(t, /^\s+SMOKE_BASE_URL:\s*\$\{\{\s*steps\.deploy\.outputs\.url\s*\}\}/m);
    assert.match(t, /^\s+SMOKE_SITE_URL:\s*\$\{\{\s*vars\.PRODUCTION_SITE_URL\s*\}\}/m);
    assert.match(t, /^\s+SMOKE_SUPABASE_URL:\s*\$\{\{\s*vars\.PRODUCTION_SUPABASE_URL\s*\}\}/m);
    assert.match(
      t,
      /^\s+SMOKE_SUPABASE_PUBLISHABLE_KEY:\s*\$\{\{\s*vars\.PRODUCTION_SUPABASE_PUBLISHABLE_KEY\s*\}\}/m,
    );
    assert.match(t, /secrets\.VERCEL_AUTOMATION_BYPASS_SECRET/);
  });

  it("runs the canary against the staged URL with its secret", () => {
    const all = steps(release());
    const s = all.find((x) => stepCmds(x).some((c) => /scripts\/canary\.mjs/.test(c)));
    assert.ok(s, "no canary step");
    const t = s.join("\n");
    assert.match(t, /^\s+CANARY_BASE_URL:\s*\$\{\{\s*steps\.deploy\.outputs\.url\s*\}\}/m);
    assert.match(t, /CANARY_SECRET:\s*\$\{\{\s*secrets\.CANARY_SECRET\s*\}\}/);
    assert.match(t, /secrets\.VERCEL_AUTOMATION_BYPASS_SECRET/);
    assert.doesNotMatch(stepText(s), /\$\{?CANARY_SECRET\b[^\n]*\b(echo|printf|tee)\b|\b(echo|printf|tee)\b[^\n]*\$\{?CANARY_SECRET\b/);
  });

  it("promotes the staged deployment by URL and then smokes live with step id live", () => {
    const all = steps(release());
    const promote = all.find(
      (x) => !isRollback(x) && stepCmds(x).some((c) => /\bvercel\b.*\bpromote\b/.test(c)),
    );
    assert.ok(promote, "no promote step");
    const cmd = stepCmds(promote).find((c) => /\bvercel\b.*\bpromote\b/.test(c));
    assert.match(cmd, /\bpromote\s+"?\$\{?DEPLOY_URL\}?"?\s+--yes\b/);
    assert.match(promote.join("\n"), /^\s+DEPLOY_URL:\s*\$\{\{\s*steps\.deploy\.outputs\.url\s*\}\}/m);

    const live = all.find((x) => stepId(x) === "live");
    assert.ok(live, "no step with id: live");
    assert.ok(stepCmds(live).some((c) => /scripts\/smoke\.mjs\s+live\b/.test(c)), "live step must run smoke.mjs live");
    assert.equal(stepIf(live), undefined, "the live smoke step must not be conditional");
  });
});

describe("release.yml: rollback", () => {
  const rollback = () => {
    const all = steps(release());
    const idx = all.findIndex(isRollback);
    assert.notEqual(idx, -1, "no step named Roll back");
    return { all, idx, s: all[idx] };
  };

  it("is the last step and runs only if failure() and the live smoke failed", () => {
    const { all, idx, s } = rollback();
    assert.equal(idx, all.length - 1, "Roll back must be the last step");
    const cond = stepIf(s);
    assert.ok(cond, "rollback has no if:");
    assert.match(cond, /\bfailure\(\)/);
    assert.match(cond, /steps\.live\.outcome\s*==\s*'failure'/);
    assert.doesNotMatch(cond, /always\(\)|\|\||cancelled/);
  });

  it("comes after the live smoke test", () => {
    const { idx } = rollback();
    const live = steps(release()).findIndex((x) => stepId(x) === "live");
    assert.ok(live !== -1 && live < idx, "rollback must follow the live smoke step");
  });

  it("promotes the previous deployment id, smokes live again and always ends with exit 1", () => {
    const { s } = rollback();
    const t = s.join("\n");
    assert.match(t, /^\s+PREVIOUS_ID:\s*\$\{\{\s*steps\.previous\.outputs\.id\s*\}\}/m);
    assert.match(t, /^\s+VERCEL_TOKEN:\s*\$\{\{\s*secrets\.VERCEL_TOKEN\s*\}\}/m);

    const c = stepCmds(s);
    const promote = c.findIndex((x) => /\bvercel\b.*\bpromote\b.*\$\{?PREVIOUS_ID\b/.test(x));
    assert.notEqual(promote, -1, "rollback does not run vercel promote with $PREVIOUS_ID");
    assert.match(c[promote], /--yes\b/);
    const smoke = c.findIndex((x) => /scripts\/smoke\.mjs\s+live\b/.test(x));
    assert.ok(smoke > promote, "rollback must smoke live after promoting the previous deployment");

    assert.match(stepText(s), /\[\[\s+-n\s+"\$\{?PREVIOUS_ID\}?"\s+\]\]|-z\s+"\$\{?PREVIOUS_ID\}?"/, "no check whether a previous id exists");
    assert.equal(c[c.length - 1], "exit 1", "the last command of the rollback step must be exit 1");
    assert.ok(c.filter((x) => x === "exit 1").length >= 1);
  });

  it("says so and still exits 1 without a previous deployment", () => {
    const { s } = rollback();
    const text = stepText(s);
    assert.match(text, /\belse\b/, "no else branch for a missing previous id");
    assert.ok((text.match(/exit\s+1/g) ?? []).length >= 1);
    assert.doesNotMatch(text, /exit\s+0/);
  });
});
