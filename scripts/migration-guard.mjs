#!/usr/bin/env node
// Migration guard for develop.yml (ADR 0010): before `supabase db push`, checks the
// migrations that are pending on the remote (local files whose version is not applied).
// Fails on drift (applied version without a local file), on a pending version older than
// the newest applied one, on bad file names, and on destructive statements in pending
// files: migrations must be expand-only (AGENTS.md). A heuristic speed bump; the reviewed
// migration diff is the real check. No override in v1.
//
// Prints a Markdown summary with file names and rule ids, never SQL text.
//
// Usage: <applied versions, one per line> | node scripts/migration-guard.mjs [migrations dir]
// Exit 0 allows, exit 1 blocks.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const FILE_NAME = /^(\d{14})_[a-z0-9_]+\.sql$/;
const VERSION = /^\d{14}$/;

// Keyword gaps allow any whitespace, so a statement split over lines still matches.
const RULES = [
  ["drop-table", /\bdrop\s+table\b/i],
  ["drop-schema", /\bdrop\s+schema\b/i],
  ["drop-materialized-view", /\bdrop\s+materialized\s+view\b/i],
  ["drop-view", /\bdrop\s+view\b/i],
  ["drop-function", /\bdrop\s+function\b/i],
  ["drop-type", /\bdrop\s+type\b/i],
  ["drop-extension", /\bdrop\s+extension\b/i],
  ["drop-sequence", /\bdrop\s+sequence\b/i],
  ["drop-procedure", /\bdrop\s+procedure\b/i],
  ["drop-domain", /\bdrop\s+domain\b/i],
  ["drop-owned", /\bdrop\s+owned\b/i],
  ["drop-role", /\bdrop\s+role\b/i],
  // ALTER TABLE ... DROP [COLUMN] x, but not DROP CONSTRAINT (a replace pattern) and not
  // ALTER COLUMN ... DROP DEFAULT / NOT NULL / IDENTITY / EXPRESSION (they relax, not remove).
  ["drop-column", /\balter\s+table\b[^;]*?\bdrop\s+(?!constraint\b|default\b|not\s+null\b|identity\b|expression\b)(?:column\s+)?(?:if\s+exists\s+)?[a-z_"]/i],
  ["rename", /\brename\b/i],
  // COLUMN is optional in Postgres: ALTER TABLE t ALTER c TYPE ...
  ["alter-column-type", /\balter\s+(?:column\s+)?\S+\s+(?:set\s+data\s+)?type\b/i],
  ["set-schema", /\bset\s+schema\b/i],
  ["truncate", /\btruncate\b/i],
];

export function parseApplied(text) {
  const versions = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (line === "") return;
    if (!VERSION.test(line)) throw new Error(`applied versions: line ${index + 1} is not a 14-digit version`);
    versions.push(line);
  });
  return versions.sort();
}

// Removes -- and /* */ comments, but only outside string literals ('...'), quoted
// identifiers ("...") and dollar-quoted bodies ($tag$...$tag$), which are kept as they are
// (so "select '--'; drop table x" still shows the drop). One pass, linear.
export function stripSqlComments(sql) {
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    if (c === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? n : end;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      out += " ";
      continue;
    }
    if (c === "'" || c === '"') {
      // A doubled quote inside is an escaped quote; the scan simply continues past it.
      let j = i + 1;
      while (j < n && sql[j] !== c) j++;
      out += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === "$") {
      const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i, i + 64));
      if (tag) {
        const end = sql.indexOf(tag[0], i + tag[0].length);
        const stop = end === -1 ? n : end + tag[0].length;
        out += sql.slice(i, stop);
        i = stop;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

function destructiveRules(sql) {
  const code = stripSqlComments(sql);
  const found = RULES.filter(([, pattern]) => pattern.test(code)).map(([rule]) => rule);
  const deleteWithoutWhere = code
    .split(";")
    .some((statement) => /\bdelete\s+from\b/i.test(statement) && !/\bwhere\b/i.test(statement));
  if (deleteWithoutWhere) found.push("delete-without-where");
  return found;
}

export function checkMigrations({ files, applied }) {
  const errors = [];
  const byVersion = new Map();
  for (const { name } of files) {
    const match = FILE_NAME.exec(name);
    if (!match) errors.push({ rule: "bad-filename", file: name });
    else byVersion.set(match[1], name);
  }

  const appliedSet = new Set(applied);
  for (const version of [...appliedSet].sort()) {
    if (!byVersion.has(version)) errors.push({ rule: "drift", version });
  }

  const newestApplied = [...appliedSet].sort().at(-1) ?? null;
  const pendingFiles = files
    .filter(({ name }) => {
      const match = FILE_NAME.exec(name);
      return match && !appliedSet.has(match[1]);
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  for (const { name, sql } of pendingFiles) {
    if (newestApplied !== null && name.slice(0, 14) < newestApplied) errors.push({ rule: "out-of-order", file: name });
    for (const rule of destructiveRules(sql)) errors.push({ rule, file: name });
  }

  return { ok: errors.length === 0, pending: pendingFiles.map(({ name }) => name), errors };
}

// A bad file name can contain anything; escape what would break a table cell.
function cell(value) {
  return String(value).replace(/[|\\`<>]/g, (c) => `\\${c}`).replace(/[\r\n]/g, " ");
}

export function summary(result) {
  const lines = ["### Migration guard", ""];
  lines.push(
    result.ok
      ? `**Passed:** ${result.pending.length} pending migration(s), none destructive.`
      : `**Blocked:** ${result.errors.length} finding(s). Migrations must be expand-only (AGENTS.md, ADR 0010); no override in v1.`,
  );
  lines.push("", "Pending:", "");
  if (result.pending.length === 0) lines.push("- none");
  for (const name of result.pending) lines.push(`- ${cell(name)}`);
  if (result.errors.length > 0) {
    lines.push("", "| Rule | File or version |", "|---|---|");
    for (const error of result.errors) lines.push(`| ${cell(error.rule)} | ${cell(error.file ?? error.version ?? "")} |`);
  }
  return lines.join("\n") + "\n";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = process.argv[2] ?? "supabase/migrations";
  let result;
  try {
    const applied = parseApplied(readFileSync(0, "utf8"));
    const files = readdirSync(dir)
      .filter((name) => name.endsWith(".sql"))
      .map((name) => ({ name, sql: readFileSync(path.join(dir, name), "utf8") }));
    result = checkMigrations({ files, applied });
  } catch (error) {
    process.stderr.write(`migration-guard: ${error instanceof Error ? error.message : "unreadable input"}\n`);
    process.exit(1);
  }
  process.stdout.write(summary(result));
  if (!result.ok) {
    process.stderr.write(`migration-guard: blocked (${result.errors.length} finding(s))\n`);
    process.exitCode = 1;
  }
}
