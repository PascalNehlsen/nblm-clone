// Structural tests for .github/workflows/infra-cloudflare.yml (release plan R1):
// plan and apply for infra/cloudflare, mirroring .github/workflows/infra.yml
// (the AWS pipeline) as a separate file.
//
// Run with: node --test tests/ci/infra-cloudflare-workflow.test.mjs
//
// Line based and indentation aware, like develop-workflow.test.mjs: the repo has
// no YAML parser. Assumes plain block style (two-space indent, `- ` steps at
// indent 6 inside a job). Only reads the workflow file; no process, no network.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const FILE = fileURLToPath(new URL("../../.github/workflows/infra-cloudflare.yml", import.meta.url));

function load() {
  if (!existsSync(FILE)) return null;
  return readFileSync(FILE, "utf8").replace(/\r/g, "").split("\n");
}

const lines = load();

function need() {
  assert.ok(lines, ".github/workflows/infra-cloudflare.yml does not exist");
  return lines;
}

const indentOf = (l) => l.match(/^ */)[0].length;
const isBlank = (l) => l.trim() === "";
const isComment = (l) => l.trim().startsWith("#");
const code = (ls) => ls.filter((l) => !isBlank(l) && !isComment(l));

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

function commands(ls) {
  return runBlocks(ls)
    .map((b) => b.join("\n"))
    .join("\n")
    .replace(/\\\n\s*/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

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

/** Header line value of a job-level key (indent 4), comment stripped. */
function jobKey(body, key) {
  const l = code(body).find((x) => new RegExp(`^ {4}${key}:`).test(x));
  return l ? l.replace(new RegExp(`^ {4}${key}:\\s*`), "").replace(/\s+#.*$/, "").trim() : undefined;
}

/** Logical command lines that call tofu (directly or via scripts/tofu.sh). */
const tofuCalls = (cmds) =>
  cmds.filter((c) => /(^|[\s|&;(])(\.\/)?(scripts\/tofu\.sh|tofu)\s/.test(c) && !/^echo\b/.test(c));

const firstIdx = (cmds, re) => cmds.findIndex((c) => re.test(c));

const JOBS = ["apply", "plan-main", "plan-pr"];
const SECRET_STEPS = ["Init", "Plan", "Apply the saved plan"];
const SECRET_LINE = /^\s*CLOUDFLARE_API_TOKEN:\s*\$\{\{\s*secrets\.CLOUDFLARE_API_TOKEN\s*\}\}\s*(#.*)?$/;

describe("infra-cloudflare.yml: file", () => {
  it("exists", () => {
    need();
  });
});

describe("infra-cloudflare.yml: triggers", () => {
  const listAt = (blockLines, key) => {
    const start = blockLines.findIndex((l) => new RegExp(`^ {4}${key}:`).test(l));
    assert.notEqual(start, -1, `no ${key}:`);
    const inline = blockLines[start].match(/\[([^\]]*)\]/);
    if (inline) return inline[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, ""));
    const items = [];
    for (let i = start + 1; i < blockLines.length; i++) {
      if (indentOf(blockLines[i]) <= 4) break;
      items.push(blockLines[i].replace(/^\s*-\s+/, "").trim().replace(/^["']|["']$/g, ""));
    }
    return items;
  };

  it("has exactly pull_request and push", () => {
    const on = topBlock(need(), "on");
    assert.ok(on, "no top-level on: block");
    const children = code(on.body)
      .filter((l) => indentOf(l) === 2)
      .map((l) => l.trim().replace(/:.*$/, ""))
      .sort();
    assert.deepEqual(children, ["pull_request", "push"]);
  });

  it("filters both triggers to exactly infra/cloudflare/**", () => {
    const on = topBlock(need(), "on");
    assert.ok(on, "no top-level on: block");
    const body = code(on.body);
    const section = (name) => {
      const start = body.findIndex((l) => new RegExp(`^ {2}${name}:`).test(l));
      assert.notEqual(start, -1, `no ${name}:`);
      const out = [];
      for (let i = start + 1; i < body.length; i++) {
        if (indentOf(body[i]) <= 2) break;
        out.push(body[i]);
      }
      return out;
    };
    assert.deepEqual(listAt(section("pull_request"), "paths"), ["infra/cloudflare/**"]);
    assert.deepEqual(listAt(section("push"), "paths"), ["infra/cloudflare/**"]);
  });

  it("push runs on branch main only", () => {
    const on = topBlock(need(), "on");
    assert.ok(on, "no top-level on: block");
    const body = code(on.body);
    const start = body.findIndex((l) => /^ {2}push:/.test(l));
    assert.notEqual(start, -1);
    const push = [];
    for (let i = start + 1; i < body.length; i++) {
      if (indentOf(body[i]) <= 2) break;
      push.push(body[i]);
    }
    assert.deepEqual(listAt(push, "branches"), ["main"]);
  });

  it("never uses pull_request_target or workflow_run", () => {
    const text = code(need()).join("\n");
    assert.doesNotMatch(text, /pull_request_target/);
    assert.doesNotMatch(text, /workflow_run/);
  });
});

describe("infra-cloudflare.yml: permissions", () => {
  it("has top-level permissions: {}", () => {
    assert.ok(
      need().some((l) => /^permissions:\s*\{\s*\}\s*(#.*)?$/.test(l)),
      "top-level permissions: {} missing",
    );
  });

  it("grants every job exactly contents: read and id-token: write", () => {
    const all = jobs(need());
    for (const name of JOBS) {
      const body = all[name];
      assert.ok(body, `job ${name} missing`);
      const start = body.findIndex((l) => /^ {4}permissions:/.test(l));
      assert.notEqual(start, -1, `job ${name} has no permissions block`);
      const grants = [];
      for (let i = start + 1; i < body.length; i++) {
        if (!isBlank(body[i]) && indentOf(body[i]) <= 4) break;
        if (!isBlank(body[i]) && !isComment(body[i])) grants.push(body[i].trim().replace(/\s*#.*$/, ""));
      }
      assert.deepEqual(grants.sort(), ["contents: read", "id-token: write"], `job ${name} grants`);
    }
  });
});

describe("infra-cloudflare.yml: concurrency", () => {
  it("has one group named infra-cloudflare, not infra-aws, never cancelling", () => {
    const ls = code(need());
    assert.equal(ls.filter((l) => /^\s*concurrency:/.test(l)).length, 1, "exactly one concurrency: key");
    const text = ls.join("\n");
    const groups = text.match(/\bgroup:.*$/gm) ?? [];
    assert.equal(groups.length, 1, "exactly one group:");
    assert.match(groups[0], /infra-cloudflare/);
    assert.doesNotMatch(groups[0], /infra-aws/);
    assert.match(text, /cancel-in-progress:\s*false\b/);
    assert.doesNotMatch(text, /cancel-in-progress:\s*(true|\$\{\{)/);
  });
});

describe("infra-cloudflare.yml: jobs", () => {
  it("has the jobs plan-pr, plan-main and apply", () => {
    assert.deepEqual(Object.keys(jobs(need())).sort(), JOBS);
  });

  it("plan-pr: environment plan, pull_request from the same repo only", () => {
    const body = jobs(need())["plan-pr"] ?? [];
    assert.equal(jobKey(body, "environment"), "plan");
    const cond = jobKey(body, "if") ?? "";
    assert.match(cond, /github\.event_name == 'pull_request'/);
    assert.match(cond, /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/);
  });

  it("plan-main: environment plan, push to main only", () => {
    const body = jobs(need())["plan-main"] ?? [];
    assert.equal(jobKey(body, "environment"), "plan");
    const cond = jobKey(body, "if") ?? "";
    assert.match(cond, /github\.event_name == 'push'/);
    assert.match(cond, /github\.ref == 'refs\/heads\/main'/);
  });

  it("apply: environment infra, needs plan-main, only when plan-main reports changes", () => {
    const body = jobs(need()).apply ?? [];
    assert.equal(jobKey(body, "environment"), "infra");
    assert.match(jobKey(body, "needs") ?? "", /^(plan-main|\[\s*plan-main\s*\])$/);
    const cond = jobKey(body, "if") ?? "";
    assert.match(cond, /github\.event_name == 'push'/);
    assert.match(cond, /github\.ref == 'refs\/heads\/main'/);
    assert.match(cond, /needs\.plan-main\.outputs\.changes == 'true'/);
  });
});

describe("infra-cloudflare.yml: pinned actions", () => {
  it("pins every uses: to a 40-hex SHA with a version comment", () => {
    const uses = need().filter((l) => /^\s*(- )?uses:/.test(l));
    assert.ok(uses.length > 0, "no uses: lines at all");
    for (const l of uses) {
      assert.match(l, /uses:\s*[\w.-]+\/[\w./-]+@[0-9a-f]{40}\s+#\s*v\d[\w.+-]*\s*$/, l.trim());
    }
  });

  it("sets persist-credentials: false on every checkout, and every job checks out", () => {
    const all = jobs(need());
    for (const name of JOBS) {
      const checkouts = steps(all[name] ?? []).filter((s) => /uses:\s*actions\/checkout@/.test(s.join("\n")));
      assert.equal(checkouts.length, 1, `job ${name} needs exactly one checkout`);
      assert.match(checkouts[0].join("\n"), /persist-credentials:\s*false\b/, `checkout in ${name}`);
    }
  });
});

describe("infra-cloudflare.yml: tofu calls", () => {
  it("every job calls tofu, and every call uses -chdir=infra/cloudflare", () => {
    const all = jobs(need());
    for (const name of JOBS) {
      const calls = tofuCalls(commands(all[name] ?? []));
      assert.ok(calls.length > 0, `job ${name} has no tofu call`);
      for (const c of calls) assert.match(c, /-chdir=infra\/cloudflare\b/, `${name}: ${c}`);
    }
    assert.doesNotMatch(code(need()).join("\n"), /-chdir=infra\/aws/);
  });

  it("every .tfplan reference is cloudflare.tfplan", () => {
    const text = code(need()).join("\n");
    const refs = text.match(/[\w./-]*\.tfplan\b/g) ?? [];
    assert.ok(refs.length > 0, "no plan file referenced");
    for (const r of refs) assert.match(r, /(^|\/)cloudflare\.tfplan$/, r);
  });

  it("init uses -lockfile=readonly in every job", () => {
    const all = jobs(need());
    for (const name of JOBS) {
      const inits = tofuCalls(commands(all[name] ?? [])).filter((c) => /\binit\b/.test(c));
      assert.ok(inits.length > 0, `job ${name} has no init`);
      for (const c of inits) assert.match(c, /-lockfile=readonly\b/, `${name}: ${c}`);
    }
  });

  it("plan in plan-pr and plan-main uses -lock=false and -out=cloudflare.tfplan", () => {
    const all = jobs(need());
    for (const name of ["plan-pr", "plan-main"]) {
      const plans = tofuCalls(commands(all[name] ?? [])).filter((c) => /\bplan\b/.test(c) && !/\bshow\b/.test(c));
      assert.ok(plans.length > 0, `job ${name} has no plan`);
      for (const c of plans) {
        assert.match(c, /-lock=false\b/, `${name}: ${c}`);
        assert.match(c, /-out=cloudflare\.tfplan\b/, `${name}: ${c}`);
      }
    }
  });

  it("plan-main uses -detailed-exitcode and sets the changes output", () => {
    const text = commands(jobs(need())["plan-main"] ?? []).join("\n");
    assert.match(text, /-detailed-exitcode\b/);
    assert.match(text, /changes=true/);
    assert.match(text, /changes=false/);
  });
});

describe("infra-cloudflare.yml: CLOUDFLARE_API_TOKEN", () => {
  it("appears only as the secret, in step-level env of Init, Plan or Apply the saved plan", () => {
    const all = jobs(need());
    let seen = 0;
    for (const name of JOBS) {
      for (const s of steps(all[name] ?? [])) {
        const ctx = envContext(s);
        s.forEach((l, i) => {
          if (isComment(l) || !/CLOUDFLARE_API_TOKEN/.test(l)) return;
          seen++;
          assert.match(l, SECRET_LINE, `${name}: ${l.trim()}`);
          assert.ok(ctx[i] !== null && ctx[i] >= 8, `${name}: not in a step-level env: ${l.trim()}`);
          assert.ok(SECRET_STEPS.includes(stepName(s)), `${name}: step "${stepName(s)}" must not get the token`);
        });
      }
    }
    assert.ok(seen > 0, "the token is never referenced");
    const total = need().filter((l) => !isComment(l) && /CLOUDFLARE_API_TOKEN/.test(l)).length;
    assert.equal(total, seen, "the token also appears outside job steps (job or workflow level)");
  });

  it("every Init, Plan and Apply the saved plan step has the token", () => {
    const all = jobs(need());
    for (const name of JOBS) {
      for (const s of steps(all[name] ?? [])) {
        if (SECRET_STEPS.includes(stepName(s))) {
          assert.match(s.join("\n"), /^\s+CLOUDFLARE_API_TOKEN:/m, `${name}: step ${stepName(s)}`);
        }
      }
    }
    const apply = steps(all.apply ?? []).map(stepName);
    assert.ok(apply.includes("Apply the saved plan"), "apply has no step named Apply the saved plan");
    for (const name of ["plan-pr", "plan-main"]) {
      const n = steps(all[name] ?? []).map(stepName);
      assert.ok(n.includes("Init") && n.includes("Plan"), `${name} needs steps Init and Plan`);
    }
  });

  it("uses no other secret", () => {
    for (const l of code(need())) {
      for (const m of l.matchAll(/secrets\.([A-Za-z0-9_]+)/g)) {
        assert.equal(m[1], "CLOUDFLARE_API_TOKEN", l.trim());
      }
    }
  });

  it("has no ${{ expression of any kind inside a run: block", () => {
    for (const body of runBlocks(need())) {
      assert.doesNotMatch(body.join("\n"), /\$\{\{/, body.join("\n"));
    }
  });
});

describe("infra-cloudflare.yml: plan guard, encryption, artifact, apply", () => {
  const GUARD = /node\s+scripts\/plan-guard\.mjs/;

  it("runs the plan guard in plan-pr, plan-main and apply", () => {
    const all = jobs(need());
    for (const name of JOBS) {
      const c = commands(all[name] ?? []);
      const g = c.find((x) => GUARD.test(x));
      assert.ok(g, `job ${name} does not run the plan guard`);
      assert.match(g, /\bshow\b.*-json\b.*cloudflare\.tfplan/, `${name} guard must read the saved plan`);
    }
  });

  it("plan-main checks that the plan file is encrypted before upload", () => {
    const body = jobs(need())["plan-main"] ?? [];
    const c = commands(body);
    const check = firstIdx(c, /\{"meta":/);
    assert.notEqual(check, -1, 'no check for {"meta":');
    assert.match(c[check], /infra\/cloudflare\/cloudflare\.tfplan/);
    assert.match(c[check], /exit\s+1/);
    const text = body.join("\n");
    assert.ok(text.indexOf('{"meta":') < text.indexOf("actions/upload-artifact@"), "check must precede the upload");
  });

  it("plan-main uploads infra/cloudflare/cloudflare.tfplan as an artifact", () => {
    const upload = steps(jobs(need())["plan-main"] ?? []).find((s) =>
      /uses:\s*actions\/upload-artifact@/.test(s.join("\n")),
    );
    assert.ok(upload, "no upload-artifact step in plan-main");
    const t = upload.join("\n");
    assert.match(t, /^\s+path:\s*infra\/cloudflare\/cloudflare\.tfplan\s*$/m);
    assert.match(t, /if-no-files-found:\s*error\b/);
    assert.match(t, /^\s+(- )?id:\s*upload\s*$/m);
    assert.match(code(jobs(need())["plan-main"]).join("\n"), /artifact-id:\s*\$\{\{\s*steps\.upload\.outputs\.artifact-id\s*\}\}/);
  });

  it("apply downloads the artifact by id into infra/cloudflare", () => {
    const dl = steps(jobs(need()).apply ?? []).find((s) =>
      /uses:\s*actions\/download-artifact@/.test(s.join("\n")),
    );
    assert.ok(dl, "no download-artifact step in apply");
    const t = dl.join("\n");
    assert.match(t, /artifact-ids:\s*\$\{\{\s*needs\.plan-main\.outputs\.artifact-id\s*\}\}/);
    assert.match(t, /^\s+path:\s*infra\/cloudflare\s*$/m);
  });

  it("apply runs the plan guard before applying exactly the saved cloudflare.tfplan", () => {
    const c = commands(jobs(need()).apply ?? []);
    const guard = firstIdx(c, GUARD);
    const apply = c.findIndex((x) => tofuCalls([x]).length > 0 && /\bapply\b/.test(x));
    assert.notEqual(guard, -1, "no plan guard in apply");
    assert.notEqual(apply, -1, "no tofu apply in apply");
    assert.ok(guard < apply, "guard must run before apply");
    assert.match(c[apply], /-chdir=infra\/cloudflare\b/);
    assert.match(c[apply], /\bapply\b[^\n]*\bcloudflare\.tfplan\s*$/);
    assert.doesNotMatch(c[apply], /-auto-approve|-target|-replace|-var/);
  });
});

describe("infra-cloudflare.yml: shell and pipefail", () => {
  it("any run: with a pipe has shell: bash on its step or a top-level default", () => {
    const d = topBlock(need(), "defaults");
    const hasDefault = !!d && /^\s*shell:\s*bash\s*(#.*)?$/m.test(d.body.join("\n"));
    const all = jobs(need());
    let pipes = 0;
    for (const name of JOBS) {
      for (const s of steps(all[name] ?? [])) {
        for (const body of runBlocks(s)) {
          const text = body
            .join("\n")
            .replace(/"(?:\\.|[^"\\])*"/g, '""')
            .replace(/'[^']*'/g, "''");
          if (/(^|[^|])\|(?!\|)/.test(text)) {
            pipes++;
            assert.ok(
              hasDefault || /^\s+shell:\s*bash\s*(#.*)?$/m.test(s.join("\n")),
              `piped run without shell: bash in step ${stepName(s)}`,
            );
          }
        }
      }
    }
    assert.ok(pipes > 0, "expected at least one piped run (the plan guard)");
  });

  it("no step or job overrides shell: with anything but bash", () => {
    for (const l of code(need())) {
      const m = l.match(/^\s*(- )?shell:\s*(.*?)\s*(#.*)?$/);
      if (m) assert.equal(m[2], "bash", `shell override: ${l.trim()}`);
    }
  });
});
