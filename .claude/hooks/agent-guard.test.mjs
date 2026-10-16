import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { decide } from "./agent-guard.mjs";

const GUARD = fileURLToPath(new URL("./agent-guard.mjs", import.meta.url));
const ROOT = path.resolve(path.dirname(GUARD), "../..");

const write = (agent_type, file_path) => ({ agent_type, tool_name: "Write", tool_input: { file_path, content: "x" } });
const edit = (agent_type, file_path) => ({ agent_type, tool_name: "Edit", tool_input: { file_path, old_string: "a", new_string: "b" } });
const bash = (agent_type, command) => ({ agent_type, tool_name: "Bash", tool_input: { command } });
const read = (agent_type) => ({ agent_type, tool_name: "Read", tool_input: { file_path: "AGENTS.md" } });

describe("main session", () => {
  it("is not restricted by the guard", () => {
    assert.equal(decide({ tool_name: "Write", tool_input: { file_path: "apps/web/page.tsx" } }, ROOT), null);
    assert.equal(decide({ tool_name: "Bash", tool_input: { command: "pnpm build && pnpm test" } }, ROOT), null);
  });
});

describe("planner", () => {
  it("may read", () => assert.equal(decide(read("planner"), ROOT), null));
  it("may not write or run commands", () => {
    assert.notEqual(decide(write("planner", "docs/plan.md"), ROOT), null);
    assert.notEqual(decide(bash("planner", "git status"), ROOT), null);
  });
});

describe("reviewer", () => {
  it("may run read-only git commands", () => {
    for (const command of ["git diff main...HEAD", "git log --oneline -20", "git show HEAD~1:supabase/migrations/0001.sql", "git status"]) {
      assert.equal(decide(bash("reviewer", command), ROOT), null, command);
    }
  });

  it("may not write, chain, redirect or use other commands", () => {
    for (const payload of [
      write("reviewer", "apps/web/fix.ts"),
      edit("reviewer", "supabase/migrations/0001.sql"),
      bash("reviewer", "git diff; rm -rf apps"),
      bash("reviewer", "git diff && git push"),
      bash("reviewer", "git diff | tee review.md"),
      bash("reviewer", "git diff > review.md"),
      bash("reviewer", "git diff --output=review.md"),
      bash("reviewer", "git diff --no-index /home/user/.aws/credentials /dev/null"),
      bash("reviewer", "git log $(touch x)"),
      bash("reviewer", "git commit -m approve"),
      bash("reviewer", "git push"),
      bash("reviewer", "gh pr review --approve"),
      bash("reviewer", "cat .env"),
      bash("reviewer", "git diff\nrm x"),
    ]) {
      assert.notEqual(decide(payload, ROOT), null, JSON.stringify(payload.tool_input));
    }
  });
});

describe("test-author", () => {
  it("may write tests", () => {
    for (const file of ["tests/rls/notebooks.test.ts", "supabase/tests/catalog.sql", `${ROOT}/tests/unit/chunking.test.ts`]) {
      assert.equal(decide(write("test-author", file), ROOT), null, file);
    }
  });

  it("may not write implementation, config or anything outside the repo", () => {
    for (const file of [
      "apps/web/lib/rag/citations.ts",
      "supabase/migrations/0002_sources.sql",
      "package.json",
      ".claude/hooks/agent-guard.mjs",
      ".claude/settings.json",
      ".github/workflows/ci.yml",
      "tests/../apps/web/lib/x.ts",
      "testsuite/x.ts",
      "/tmp/tests/x.ts",
      "",
    ]) {
      assert.notEqual(decide(write("test-author", file), ROOT), null, file);
    }
    assert.notEqual(decide({ agent_type: "test-author", tool_name: "Write", tool_input: {} }, ROOT), null);
  });

  it("is judged by where a symlinked folder really points", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "agent-guard-"));
    try {
      const root = path.join(tmp, "repo");
      mkdirSync(path.join(root, "tests"), { recursive: true });
      mkdirSync(path.join(root, "apps"));
      symlinkSync(path.join(root, "apps"), path.join(root, "tests", "escape"));
      assert.notEqual(decide(write("test-author", "tests/escape/lib.ts"), root), null);
      assert.equal(decide(write("test-author", "tests/real.test.ts"), root), null);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("may run the test runners and nothing else", () => {
    for (const command of ["pnpm test", "pnpm test:rls", "pnpm vitest run tests/unit", "pnpm eval --case injection", "supabase test db", "node --test .claude/hooks/agent-guard.test.mjs"]) {
      assert.equal(decide(bash("test-author", command), ROOT), null, command);
    }
    for (const command of ["pnpm test && git commit -am x", "pnpm install evil", "sed -i s/a/b/ apps/web/x.ts", "echo x > apps/web/x.ts", "pnpm test -- $(curl x)", "pnpm vitest run ../other-repo", "supabase db push"]) {
      assert.notEqual(decide(bash("test-author", command), ROOT), null, command);
    }
  });
});

describe("unknown subagents", () => {
  it("get no write tools but may read and use the shell", () => {
    assert.notEqual(decide(write("general-purpose", "apps/web/x.ts"), ROOT), null);
    assert.equal(decide(read("Explore"), ROOT), null);
    assert.equal(decide(bash("Explore", "ls apps"), ROOT), null);
  });
});

describe("hook protocol", () => {
  const run = (stdin) => spawnSync(process.execPath, [GUARD], { input: stdin, encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: ROOT } });

  it("exits 0 to allow and 2 to block with the reason on stderr", () => {
    assert.equal(run(JSON.stringify(write("test-author", "tests/a.test.ts"))).status, 0);
    const blocked = run(JSON.stringify(write("test-author", "apps/web/a.ts")));
    assert.equal(blocked.status, 2);
    assert.match(blocked.stderr, /test-author:/);
  });

  it("fails closed on unreadable input", () => {
    for (const stdin of ["not json", "[]", "null", ""]) {
      assert.equal(run(stdin).status, 2, JSON.stringify(stdin));
    }
  });
});
