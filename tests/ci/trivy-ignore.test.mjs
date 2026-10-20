// Static test for .trivyignore.yaml: the file exists and every exception is
// specific and expiring. Entries are `- id:` items; each needs a concrete id
// (no wildcard), non-empty paths, a non-empty statement (the reason) and an
// expired_at date at most 90 days from today.
//
// Run with: node --test tests/ci/trivy-ignore.test.mjs
//
// Line based (no YAML parser in the repo). An empty file with no entries passes
// the entry checks; the file itself must exist.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const FILE = fileURLToPath(new URL("../../.trivyignore.yaml", import.meta.url));
const DAY = 24 * 60 * 60 * 1000;

function entries() {
  const raw = readFileSync(FILE, "utf8").replace(/\r/g, "").split("\n");
  const lines = raw.filter((l) => l.trim() !== "" && !l.trim().startsWith("#"));
  const out = [];
  let cur = null;
  let inPaths = false;
  for (const l of lines) {
    const start = l.match(/^(\s*)- id:\s*(.*?)\s*(#.*)?$/);
    if (start) {
      cur = { id: start[2].replace(/^["']|["']$/g, ""), paths: [], statement: "", expired_at: "" };
      out.push(cur);
      inPaths = false;
      continue;
    }
    if (!cur) continue;
    if (/^\S/.test(l)) {
      cur = null; // next top-level section
      continue;
    }
    let m;
    if ((m = l.match(/^\s+paths:\s*(.*)$/))) {
      inPaths = true;
      const inline = m[1].match(/^\[(.*)\]/);
      if (inline) {
        cur.paths.push(...inline[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean));
        inPaths = false;
      }
    } else if (inPaths && (m = l.match(/^\s+-\s*(.+?)\s*$/))) {
      cur.paths.push(m[1].replace(/^["']|["']$/g, ""));
    } else if ((m = l.match(/^\s+statement:\s*(.*?)\s*$/))) {
      inPaths = false;
      cur.statement = m[1].replace(/^["'>|-]+|["']$/g, "").trim();
    } else if ((m = l.match(/^\s+expired_at:\s*["']?([^"'\s#]*)/))) {
      inPaths = false;
      cur.expired_at = m[1];
    } else if (/^\s+[a-z_]+:/.test(l)) {
      inPaths = false;
    }
  }
  return out;
}

describe(".trivyignore.yaml", () => {
  it("exists at the repository root", () => {
    assert.ok(existsSync(FILE), ".trivyignore.yaml is missing");
  });

  it("every entry has a concrete id without wildcard", () => {
    for (const e of entries()) {
      assert.ok(e.id, "entry without id");
      assert.doesNotMatch(e.id, /[*?]/, `${e.id}: wildcard id`);
    }
  });

  it("every entry has non-empty paths without a catch-all", () => {
    for (const e of entries()) {
      assert.ok(e.paths.length > 0, `${e.id}: paths is empty`);
      for (const p of e.paths) {
        assert.notEqual(p, "", `${e.id}: empty path`);
        assert.doesNotMatch(p, /^\*+(\/\*+)?$/, `${e.id}: catch-all path ${p}`);
      }
    }
  });

  it("every entry has a statement (the reason)", () => {
    for (const e of entries()) {
      assert.ok(e.statement.length > 0, `${e.id}: statement is empty`);
    }
  });

  it("every entry expires within 90 days from today", () => {
    const limit = Date.now() + 90 * DAY;
    for (const e of entries()) {
      assert.match(e.expired_at, /^\d{4}-\d{2}-\d{2}$/, `${e.id}: expired_at missing or not YYYY-MM-DD`);
      const t = Date.parse(`${e.expired_at}T23:59:59Z`);
      assert.ok(!Number.isNaN(t), `${e.id}: invalid date`);
      assert.ok(t <= limit + DAY, `${e.id}: expired_at ${e.expired_at} is more than 90 days away`);
    }
  });

  it("no id appears twice for the same path", () => {
    const seen = new Set();
    for (const e of entries()) {
      for (const p of e.paths) {
        const key = `${e.id}@${p}`;
        assert.ok(!seen.has(key), `duplicate exception ${key}`);
        seen.add(key);
      }
    }
  });
});
