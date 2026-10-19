// Tests for the Supabase migration guard used by `develop.yml` before
// `supabase db push` runs against the hosted develop database.
//
// Run with: node --test 'tests/ci/*.test.mjs'
// (a bare directory does not work with node --test; it must be a glob or file list)
//
// Pure functions only: no child processes, no network, no env. Reading
// supabase/migrations/*.sql with fs is allowed and used below.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseApplied,
  stripSqlComments,
  checkMigrations,
  summary,
} from "../../scripts/migration-guard.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

function file(name, sql) {
  return { name, sql };
}

/** Finds the (first) error with the given rule id, or undefined. */
function findError(errors, rule) {
  return errors.find((e) => e.rule === rule);
}

describe("parseApplied", () => {
  it("empty input gives an empty array", () => {
    assert.deepEqual(parseApplied(""), []);
  });

  it("ignores blank lines and whitespace-only lines", () => {
    const text = "\n   \n20260101000000\n\n   \n20260102000000\n\n";
    assert.deepEqual(parseApplied(text), [
      "20260101000000",
      "20260102000000",
    ]);
  });

  it("trims surrounding whitespace on each line", () => {
    assert.deepEqual(parseApplied("  20260101000000  \n"), [
      "20260101000000",
    ]);
  });

  it("returns versions sorted ascending regardless of input order", () => {
    assert.deepEqual(
      parseApplied("20260103000000\n20260101000000\n20260102000000\n"),
      ["20260101000000", "20260102000000", "20260103000000"],
    );
  });

  it("throws on a non-blank line that is not exactly 14 digits", () => {
    assert.throws(() => parseApplied("not-a-version-zzz\n"), Error);
  });

  it("the thrown error message does not contain the offending line content", () => {
    const marker = "not-a-version-zzz";
    try {
      parseApplied(`20260101000000\n${marker}\n`);
      assert.fail("expected parseApplied to throw");
    } catch (err) {
      assert.ok(!err.message.includes(marker));
    }
  });

  it("throws on a line with the wrong digit count (13 digits)", () => {
    assert.throws(() => parseApplied("2026010100000\n"), Error);
  });

  it("throws on a line with non-digit characters mixed with digits", () => {
    assert.throws(() => parseApplied("2026010100000x\n"), Error);
  });
});

describe("stripSqlComments", () => {
  it("removes a line comment to end of line", () => {
    const out = stripSqlComments("select 1; -- drop table secret_table\n");
    assert.ok(!out.includes("drop table secret_table"));
    assert.ok(out.includes("select 1;"));
  });

  it("removes a block comment, including multi-line", () => {
    const out = stripSqlComments(
      "select 1;\n/* drop table secret_table\n   more text */\nselect 2;",
    );
    assert.ok(!out.includes("drop table secret_table"));
    assert.ok(out.includes("select 1;"));
    assert.ok(out.includes("select 2;"));
  });

  it("removes multiple comments of both kinds in one input", () => {
    const out = stripSqlComments(
      "-- a\nselect 1; /* b */ select 2; -- c\n",
    );
    assert.ok(!out.includes("-- a"));
    assert.ok(!out.includes("/* b */"));
    assert.ok(!out.includes("-- c"));
  });
});

describe("checkMigrations: pending / drift / out-of-order / bad filename", () => {
  it("local [a,b,c] with applied [a,b] gives pending [c]", () => {
    const files = [
      file("20260101000000_a.sql", "select 1;"),
      file("20260102000000_b.sql", "select 1;"),
      file("20260103000000_c.sql", "select 1;"),
    ];
    const result = checkMigrations({
      files,
      applied: ["20260101000000", "20260102000000"],
    });
    assert.deepEqual(result.pending, ["20260103000000_c.sql"]);
    assert.equal(result.ok, true);
  });

  it("an empty applied list gives all files pending, sorted ascending", () => {
    const files = [
      file("20260103000000_c.sql", "select 1;"),
      file("20260101000000_a.sql", "select 1;"),
      file("20260102000000_b.sql", "select 1;"),
    ];
    const result = checkMigrations({ files, applied: [] });
    assert.deepEqual(result.pending, [
      "20260101000000_a.sql",
      "20260102000000_b.sql",
      "20260103000000_c.sql",
    ]);
    assert.equal(result.ok, true);
  });

  it("an applied version with no local file gives a drift error naming only the version", () => {
    const files = [file("20260101000000_a.sql", "select 1;")];
    const result = checkMigrations({
      files,
      applied: ["20260101000000", "20260102000000"],
    });
    assert.equal(result.ok, false);
    const err = findError(result.errors, "drift");
    assert.ok(err, "expected a drift error");
    assert.equal(err.version, "20260102000000");
    assert.equal(err.file, undefined);
  });

  it("a pending version lower than the newest applied version gives an out-of-order error", () => {
    const files = [
      file("20260101000000_a.sql", "select 1;"),
      file("20260102000000_b.sql", "select 1;"), // pending, older than 20260103000000
    ];
    const result = checkMigrations({
      files,
      applied: ["20260101000000", "20260103000000"],
    });
    assert.equal(result.ok, false);
    const err = findError(result.errors, "out-of-order");
    assert.ok(err, "expected an out-of-order error");
    assert.equal(err.file, "20260102000000_b.sql");
  });

  it("a file name that does not match the required pattern gives a bad-filename error", () => {
    const files = [file("not-a-valid-name.sql", "select 1;")];
    const result = checkMigrations({ files, applied: [] });
    assert.equal(result.ok, false);
    const err = findError(result.errors, "bad-filename");
    assert.ok(err, "expected a bad-filename error");
    assert.equal(err.file, "not-a-valid-name.sql");
  });

  it("a file name with uppercase letters is also a bad-filename", () => {
    const files = [file("20260101000000_Bad_Name.sql", "select 1;")];
    const result = checkMigrations({ files, applied: [] });
    assert.equal(result.ok, false);
    assert.ok(findError(result.errors, "bad-filename"));
  });

  it("destructive SQL in an already-applied file is not checked", () => {
    const files = [
      file("20260101000000_a.sql", "DROP TABLE old_table;"), // applied, not checked
      file("20260102000000_b.sql", "select 1;"), // pending, clean
    ];
    const result = checkMigrations({
      files,
      applied: ["20260101000000"],
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.pending, ["20260102000000_b.sql"]);
  });
});

describe("checkMigrations: destructive statement rules (one per rule id)", () => {
  const cases = [
    ["drop-table", "DROP TABLE foo;"],
    ["drop-table", "DROP TABLE IF EXISTS foo;"],
    ["drop-schema", "DROP SCHEMA foo;"],
    ["drop-view", "DROP VIEW foo;"],
    ["drop-materialized-view", "DROP MATERIALIZED VIEW foo;"],
    ["drop-function", "DROP FUNCTION foo();"],
    ["drop-type", "DROP TYPE foo;"],
    ["drop-extension", "DROP EXTENSION foo;"],
    ["drop-column", "ALTER TABLE t DROP COLUMN c;"],
    ["rename", "ALTER TABLE t RENAME COLUMN a TO b;"],
    ["alter-column-type", "ALTER TABLE t ALTER COLUMN x TYPE text;"],
    ["set-schema", "ALTER TABLE t SET SCHEMA other;"],
    ["truncate", "TRUNCATE t;"],
    ["delete-without-where", "DELETE FROM t;"],
  ];

  for (const [rule, sql] of cases) {
    it(`flags ${JSON.stringify(sql)} with rule ${rule}`, () => {
      const files = [file("20260101000000_x.sql", sql)];
      const result = checkMigrations({ files, applied: [] });
      assert.equal(result.ok, false);
      const err = findError(result.errors, rule);
      assert.ok(err, `expected rule ${rule} for ${sql}`);
      assert.equal(err.file, "20260101000000_x.sql");
    });
  }
});

describe("checkMigrations: destructive statement variants (whitespace, casing, phrasing)", () => {
  it("DROP\\n  TABLE IF EXISTS x is flagged as drop-table", () => {
    const files = [file("20260101000000_x.sql", "DROP\n  TABLE IF EXISTS x;")];
    const result = checkMigrations({ files, applied: [] });
    assert.equal(result.ok, false);
    assert.ok(findError(result.errors, "drop-table"));
  });

  it("alter table t drop c (no COLUMN keyword) is flagged as drop-column", () => {
    const files = [file("20260101000000_x.sql", "alter table t drop c;")];
    const result = checkMigrations({ files, applied: [] });
    assert.equal(result.ok, false);
    assert.ok(findError(result.errors, "drop-column"));
  });

  it("ALTER TABLE t ALTER COLUMN x SET DATA TYPE text is flagged as alter-column-type", () => {
    const files = [
      file(
        "20260101000000_x.sql",
        "ALTER TABLE t ALTER COLUMN x SET DATA TYPE text;",
      ),
    ];
    const result = checkMigrations({ files, applied: [] });
    assert.equal(result.ok, false);
    assert.ok(findError(result.errors, "alter-column-type"));
  });

  it("alter table t rename to u is flagged as rename", () => {
    const files = [
      file("20260101000000_x.sql", "alter table t rename to u;"),
    ];
    const result = checkMigrations({ files, applied: [] });
    assert.equal(result.ok, false);
    assert.ok(findError(result.errors, "rename"));
  });

  it("TRUNCATE t is flagged as truncate", () => {
    const files = [file("20260101000000_x.sql", "TRUNCATE t;")];
    const result = checkMigrations({ files, applied: [] });
    assert.equal(result.ok, false);
    assert.ok(findError(result.errors, "truncate"));
  });

  it("delete from t; (no WHERE) is flagged as delete-without-where", () => {
    const files = [file("20260101000000_x.sql", "delete from t;")];
    const result = checkMigrations({ files, applied: [] });
    assert.equal(result.ok, false);
    assert.ok(findError(result.errors, "delete-without-where"));
  });

  it("lower-case drop table is still flagged (case-insensitive)", () => {
    const files = [file("20260101000000_x.sql", "drop table foo;")];
    const result = checkMigrations({ files, applied: [] });
    assert.equal(result.ok, false);
    assert.ok(findError(result.errors, "drop-table"));
  });
});

describe("checkMigrations: destructive statements inside comments are not flagged", () => {
  const commentedCases = [
    ["-- line comment", "-- DROP TABLE foo;\nselect 1;"],
    ["block comment", "/* DROP TABLE foo; */\nselect 1;"],
    [
      "line comment, drop column variant",
      "-- alter table t drop c;\nselect 1;",
    ],
    [
      "block comment, truncate variant",
      "/* TRUNCATE t; */\nselect 1;",
    ],
    [
      "block comment, delete-without-where variant",
      "/* delete from t; */\nselect 1;",
    ],
    [
      "line comment, rename variant",
      "-- alter table t rename to u;\nselect 1;",
    ],
  ];

  for (const [label, sql] of commentedCases) {
    it(`${label} produces no destructive-statement errors`, () => {
      const files = [file("20260101000000_x.sql", sql)];
      const result = checkMigrations({ files, applied: [] });
      assert.equal(result.ok, true);
      assert.deepEqual(result.errors, []);
    });
  }
});

describe("checkMigrations: allowed statements pass", () => {
  it("drop policy, drop trigger, drop index, drop constraint, create or replace function, revoke, grant, add column, enable RLS, and a WHERE-qualified delete all pass together", () => {
    const sql = `
      DROP POLICY foo ON bar;
      DROP TRIGGER foo ON bar;
      DROP INDEX foo;
      alter table t drop constraint foo_check;
      CREATE OR REPLACE FUNCTION f() RETURNS void AS $$ BEGIN END; $$ LANGUAGE plpgsql;
      REVOKE ALL ON bar FROM anon;
      GRANT SELECT ON bar TO authenticated;
      ALTER TABLE t ADD COLUMN c text;
      ALTER TABLE t ENABLE ROW LEVEL SECURITY;
      DELETE FROM t WHERE id = 1;
    `;
    const files = [file("20260101000000_x.sql", sql)];
    const result = checkMigrations({ files, applied: [] });
    assert.equal(result.ok, true);
    assert.deepEqual(result.errors, []);
  });

  it("alter table t drop constraint foo (alone) does not trigger drop-column", () => {
    const files = [
      file("20260101000000_x.sql", "alter table t drop constraint foo;"),
    ];
    const result = checkMigrations({ files, applied: [] });
    assert.equal(result.ok, true);
    assert.deepEqual(result.errors, []);
  });
});

describe("checkMigrations: gaps found in review (more destructive forms)", () => {
  const blocked = [
    ["alter-column-type", "alter table t alter c type bigint;"],
    ["alter-column-type", "ALTER TABLE t ALTER COLUMN c TYPE bigint;"],
    ["alter-column-type", "alter table t alter column c type text;"],
    [null, "drop owned by r;"],
    [null, "drop domain d cascade;"],
    [null, "drop sequence s;"],
    [null, "drop procedure p;"],
    [null, "drop role r;"],
  ];

  for (const [rule, sql] of blocked) {
    it(`flags ${JSON.stringify(sql)}`, () => {
      const files = [file("20260101000000_x.sql", sql)];
      const result = checkMigrations({ files, applied: [] });
      assert.equal(result.ok, false);
      assert.ok(result.errors.length > 0);
      assert.equal(result.errors[0].file, "20260101000000_x.sql");
      if (rule) assert.ok(findError(result.errors, rule), `expected rule ${rule}`);
    });
  }

  const allowed = [
    "alter table t add column c int;",
    "create sequence s;",
    "alter table t alter column c set default 1;",
  ];

  for (const sql of allowed) {
    it(`still allows ${JSON.stringify(sql)}`, () => {
      const files = [file("20260101000000_x.sql", sql)];
      const result = checkMigrations({ files, applied: [] });
      assert.equal(result.ok, true);
      assert.deepEqual(result.errors, []);
    });
  }

  it("a statement after a '--' inside a string literal is still flagged", () => {
    const files = [
      file("20260101000000_x.sql", "select '--'; drop table x;"),
    ];
    const result = checkMigrations({ files, applied: [] });
    assert.equal(result.ok, false);
    assert.ok(findError(result.errors, "drop-table"));
  });
});

describe("checkMigrations: ok reflects errors", () => {
  it("ok is true iff errors is empty", () => {
    const clean = checkMigrations({
      files: [file("20260101000000_x.sql", "select 1;")],
      applied: [],
    });
    assert.equal(clean.ok, true);
    assert.deepEqual(clean.errors, []);

    const dirty = checkMigrations({
      files: [file("20260101000000_x.sql", "DROP TABLE foo;")],
      applied: [],
    });
    assert.equal(dirty.ok, false);
    assert.ok(dirty.errors.length > 0);
  });
});

describe("checkMigrations: the real migrations in supabase/migrations/ pass today", () => {
  it("with applied = [], ok is true and pending is every file, sorted", () => {
    const dir = path.join(repoRoot, "supabase/migrations");
    const names = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".sql"))
      .sort();
    assert.ok(names.length > 0, "expected at least one migration file");

    const files = names.map((name) =>
      file(name, fs.readFileSync(path.join(dir, name), "utf8")),
    );
    const result = checkMigrations({ files, applied: [] });

    assert.equal(
      result.ok,
      true,
      `expected ok, got errors: ${JSON.stringify(result.errors)}`,
    );
    assert.deepEqual(result.pending, names);
  });
});

describe("summary", () => {
  it("lists pending file names and error rule ids, and never leaks SQL text", () => {
    const marker = "secret_marker_xyz";
    const files = [
      file("20260101000000_clean.sql", "select 1;"),
      file(
        "20260102000000_destructive.sql",
        `TRUNCATE ${marker}_table;`,
      ),
    ];
    const result = checkMigrations({ files, applied: [] });
    assert.equal(result.ok, false);

    const md = summary(result);
    assert.equal(typeof md, "string");
    assert.ok(md.includes("20260101000000_clean.sql"));
    assert.ok(md.includes("20260102000000_destructive.sql"));
    assert.ok(md.includes("truncate"));
    assert.ok(!md.includes(marker));
    assert.ok(!JSON.stringify(result).includes(marker));
  });

  it("includes a drift version and a bad-filename file without SQL text", () => {
    const files = [file("bad name.sql", "select 1;")];
    const result = checkMigrations({
      files,
      applied: ["20260199000000"],
    });
    const md = summary(result);
    assert.ok(md.includes("bad-filename"));
    assert.ok(md.includes("drift"));
    assert.ok(md.includes("20260199000000"));
  });
});
