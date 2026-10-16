#!/usr/bin/env node
// PreToolUse hook that enforces subagent roles.
//
// A subagent's tool list only knows whole tools: `Bash` means every command,
// `Write` means every file. What a role may do with a tool lives here, not in
// the prompt. Claude Code puts `agent_type` into the hook input when the call
// comes from a subagent; the main session (the builder) has none and is
// governed by the permission rules in .claude/settings.json instead.
//
//   planner      no writes, no shell
//   reviewer     no writes; shell only for read-only git commands
//   test-author  writes only under tests/ and supabase/tests/;
//                shell only for the test runners
//   other        unknown subagents (including built-ins) get no write tools
//
// Exit 0 allows, exit 2 blocks (stderr goes back to the model). Anything that
// is not clearly allowed is blocked, including unreadable input.
//
// This is a guard against mistakes, not a security boundary: a test file is
// code and can do anything when it runs. The hard limits are outside the
// agent: no credentials in the sandbox, branch rulesets, environment approval.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

// Chaining, substitution, redirection, escapes and globs. Any of them turns an
// allowed command into an arbitrary one.
const SHELL_META = /[;&|`$<>(){}\\*?\n\r]/;
const ARGS = String.raw`(?: [\w./:=@~^+-]+)*`;

// `--output` writes a file; `--no-index` lets git diff read files outside the
// repository (for example ~/.aws/credentials). Ranges like main...HEAD stay legal.
const REVIEWER_COMMAND = new RegExp(String.raw`^git (?:diff|log|show|status|blame)${ARGS}$`);
const REVIEWER_FORBIDDEN = /--output|--no-index/;
const TEST_AUTHOR_COMMAND = new RegExp(
  String.raw`^(?:pnpm (?:test|test:[a-z0-9-]+|vitest|eval)|supabase test db|node --test)${ARGS}$`,
);
const TEST_AUTHOR_FORBIDDEN = /\.\./;
const TEST_AUTHOR_PATH = /^(?:tests|supabase\/tests)\//;

// Resolve symlinks on the longest existing prefix, so a not-yet-existing file
// inside a symlinked folder is still judged by where it really lands.
function realTarget(absolute) {
  let existing = absolute;
  const rest = [];
  while (!existsSync(existing)) {
    rest.unshift(path.basename(existing));
    const parent = path.dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  return path.join(realpathSync(existing), ...rest);
}

function repoRelative(raw, root) {
  if (typeof raw !== "string" || raw === "") return null;
  const absolute = path.isAbsolute(raw) ? raw : path.resolve(root, raw);
  const relative = path.relative(realpathSync(root), realTarget(absolute));
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join("/");
}

function shellAllowed(command, pattern, forbidden) {
  if (typeof command !== "string") return false;
  const trimmed = command.trim();
  return !SHELL_META.test(trimmed) && !forbidden.test(trimmed) && pattern.test(trimmed);
}

/** Returns null when the call is allowed, otherwise the reason it is blocked. */
export function decide(payload, root) {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return "agent-guard: hook input is not an object";
  }
  const role = payload.agent_type;
  if (role === undefined || role === null || role === "") return null; // main session

  const tool = payload.tool_name;
  const input = payload.tool_input ?? {};

  if (role === "planner") {
    return WRITE_TOOLS.has(tool) || tool === "Bash" ? `planner: ${tool} is not allowed, the planner only reads` : null;
  }

  if (role === "reviewer") {
    if (WRITE_TOOLS.has(tool)) return `reviewer: ${tool} is not allowed, the reviewer reports and does not fix`;
    if (tool === "Bash" && !shellAllowed(input.command, REVIEWER_COMMAND, REVIEWER_FORBIDDEN)) {
      return "reviewer: only read-only git commands (diff, log, show, status, blame) without shell operators";
    }
    return null;
  }

  if (role === "test-author") {
    if (WRITE_TOOLS.has(tool)) {
      const relative = repoRelative(input.file_path ?? input.notebook_path, root);
      if (relative === null) return "test-author: path is missing or outside the repository";
      if (!TEST_AUTHOR_PATH.test(relative)) {
        return `test-author: writes only under tests/ or supabase/tests/, not ${relative}. List needed helpers for the builder instead`;
      }
      return null;
    }
    if (tool === "Bash" && !shellAllowed(input.command, TEST_AUTHOR_COMMAND, TEST_AUTHOR_FORBIDDEN)) {
      return "test-author: shell only for `pnpm test*`, `pnpm vitest`, `pnpm eval`, `supabase test db`, `node --test`";
    }
    return null;
  }

  return WRITE_TOOLS.has(tool) ? `agent-guard: subagent ${JSON.stringify(role)} has no write access; implementation happens in the main session` : null;
}

function main() {
  const root = process.env.CLAUDE_PROJECT_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  let reason;
  try {
    reason = decide(JSON.parse(readFileSync(0, "utf8")), root);
  } catch (error) {
    reason = `agent-guard: hook input not readable (${error?.name ?? "Error"})`; // fail closed
  }
  if (reason) {
    process.stderr.write(`${reason}\n`);
    process.exit(2);
  }
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
