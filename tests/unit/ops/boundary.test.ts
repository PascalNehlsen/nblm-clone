// Source-text guards for the ops page (the service_role key, the operator check and the route).
// ESLint (tests/unit/ops/eslint-imports.test.ts) only sees static import specifiers; this scan also
// sees import(), require() and plain .js/.mjs/.cjs files.
//
//   - lib/server/admin/ops.ts holds the key (third module next to admin/usage.ts, admin/accounts.ts)
//   - lib/server/ops/read.ts and lib/server/eval/record.ts are its ONLY importers, and reach it by a
//     RELATIVE "../admin/ops" (the needles of tests/unit/auth-boundary.test.ts do not match it)
//   - access.ts and summary.ts are pure: no admin module, no Supabase client
//   - nothing in the ops code reads user_metadata (the user can edit it)
//   - /ops is not a public path, the layout 404s through notFound(), the page is a server component
//   - the eval route wires record.ts in, and http.ts stays free of admin code (tests/unit/eval)
//   - the migration adds no security definer function and nothing for anon or authenticated
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { isPublicPath } from "@/lib/auth/paths";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const webDir = path.join(repoRoot, "apps/web");
const sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);

function collectSourceFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      files.push(...collectSourceFiles(path.join(dir, entry.name)));
    } else if (sourceExtensions.has(path.extname(entry.name))) {
      files.push(path.join(dir, entry.name));
    }
  }
  return files;
}

function relative(file: string): string {
  return path.relative(webDir, file).split(path.sep).join("/");
}

function read(file: string): string {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}

function firstLine(file: string): string | undefined {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n")[0]?.trim() : undefined;
}

// Code without comments, so a comment that says "never reads user_metadata" is not a violation.
function code(file: string): string {
  return read(file)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const ADMIN_OPS = path.join(webDir, "lib/server/admin/ops.ts");
const OPS_DIR = path.join(webDir, "lib/server/ops");
const READ = path.join(OPS_DIR, "read.ts");
const ACCESS = path.join(OPS_DIR, "access.ts");
const SUMMARY = path.join(OPS_DIR, "summary.ts");
const RECORD = path.join(webDir, "lib/server/eval/record.ts");
const PAGE_DIR = path.join(webDir, "app/(app)/ops");
const LAYOUT = path.join(PAGE_DIR, "layout.tsx");
const PAGE = path.join(PAGE_DIR, "page.tsx");
const EVAL_ROUTE = path.join(webDir, "app/api/eval/route.ts");

const OPS_REFERENCE = ["admin/ops"];
const ALLOWED_OPS_REFERENCE_FILES = ["lib/server/admin/ops.ts", "lib/server/ops/read.ts", "lib/server/eval/record.ts"];

function offenders(files: Array<{ relativePath: string; content: string }>): string[] {
  return files
    .filter((file) => !ALLOWED_OPS_REFERENCE_FILES.includes(file.relativePath))
    .filter((file) => OPS_REFERENCE.some((needle) => file.content.includes(needle)))
    .map((file) => file.relativePath);
}

describe("boundary scan: only read.ts and record.ts may reference admin/ops", () => {
  it("catches static, dynamic and require references elsewhere, and in other file types", () => {
    const samples: Array<[string, string]> = [
      ["app/(app)/ops/page.tsx", 'import { readOpsSummary } from "@/lib/server/admin/ops";'],
      ["app/api/eval/route.ts", 'const m = await import("../../../lib/server/admin/ops");'],
      ["lib/x.cjs", 'const { recordEvalRun } = require("./server/admin/ops");'],
      ["lib/server/ops/summary.ts", 'import { readOpsSummary } from "../admin/ops";'],
      ["lib/server/eval/http.ts", 'import { recordEvalRun } from "../admin/ops";'],
      ["app/x/page.jsx", 'import { readOpsSummary } from "@/lib/server/admin/ops";'],
    ];
    for (const [relativePath, content] of samples) {
      expect(offenders([{ relativePath, content }]), relativePath).toEqual([relativePath]);
    }
  });

  it("does not flag the three allowed files", () => {
    expect(
      offenders([
        { relativePath: "lib/server/ops/read.ts", content: 'import { readOpsSummary } from "../admin/ops";' },
        { relativePath: "lib/server/eval/record.ts", content: 'import { recordEvalRun } from "../admin/ops";' },
        { relativePath: "lib/server/admin/ops.ts", content: "// lib/server/admin/ops.ts" },
      ]),
    ).toEqual([]);
  });

  it("the real tree references admin/ops nowhere else", () => {
    const files = collectSourceFiles(webDir).map((file) => ({ relativePath: relative(file), content: fs.readFileSync(file, "utf8") }));
    expect(offenders(files)).toEqual([]);
  });

  it("read.ts and record.ts really import it, by a relative path", () => {
    for (const file of [READ, RECORD]) {
      expect(fs.existsSync(file), `${relative(file)} is missing`).toBe(true);
      expect(read(file), relative(file)).toMatch(/from\s+["']\.\.\/admin\/ops["']/);
      expect(read(file), relative(file)).not.toMatch(/\bfrom\s*["']@\/lib\/server\/admin/);
    }
  });

  it("neither of the other two admin modules mentions ops", () => {
    for (const file of ["usage.ts", "accounts.ts"]) {
      expect(read(path.join(webDir, "lib/server/admin", file)), file).not.toMatch(/admin\/ops|from\s+["']\.\/ops["']/);
    }
  });
});

describe("the ops modules exist and are marked server-only", () => {
  it.each([ADMIN_OPS, READ, ACCESS, SUMMARY, RECORD])("%s exists and begins with `import \"server-only\"`", (file) => {
    expect(fs.existsSync(file), `${relative(file)} is missing`).toBe(true);
    expect(firstLine(file), `${relative(file)} must start with import "server-only"`).toBe('import "server-only";');
  });

  it("every file in lib/server/ops/ begins with `import \"server-only\"`", () => {
    const files = collectSourceFiles(OPS_DIR);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(firstLine(file), `${relative(file)} must start with import "server-only"`).toBe('import "server-only";');
    }
  });

  it("admin/ops.ts exports exactly readOpsSummary and recordEvalRun in its source", () => {
    const exported = [...read(ADMIN_OPS).matchAll(/^export\s+(?:async\s+)?(?:function|const|class|let|var)\s+(\w+)/gm)].map((m) => m[1]);
    expect(exported.sort()).toEqual(["readOpsSummary", "recordEvalRun"]);
    expect(read(ADMIN_OPS)).not.toMatch(/^export\s+(?:default|\*|\{)/m);
  });
});

describe("access.ts and summary.ts are pure", () => {
  it.each([ACCESS, SUMMARY])("%s imports no admin module, no Supabase client and nothing request-bound", (file) => {
    expect(fs.existsSync(file), `${relative(file)} is missing`).toBe(true);
    const content = code(file);
    expect(content).not.toMatch(/admin\//);
    expect(content).not.toMatch(/@supabase\/|lib\/supabase\//);
    expect(content).not.toMatch(/next\/headers|next\/navigation/);
    expect(content).not.toMatch(/SECRET_KEY|service_role/);
  });
});

describe("the operator check never trusts user_metadata", () => {
  it("no code under lib/server/ops or app/(app)/ops reads user_metadata", () => {
    const files = [...collectSourceFiles(OPS_DIR), ...collectSourceFiles(PAGE_DIR)];
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) expect(code(file), relative(file)).not.toMatch(/user_metadata|userMetadata/);
  });

  it("access.ts reads app_metadata and is_anonymous", () => {
    const content = code(ACCESS);
    expect(content).toMatch(/app_metadata/);
    expect(content).toMatch(/is_anonymous/);
  });
});

describe("the /ops route", () => {
  it("is not a public path (the proxy redirects a visitor without a session to /login)", () => {
    for (const p of ["/ops", "/ops/", "/ops/x"]) expect(isPublicPath(p), p).toBe(false);
  });

  it("the layout exists, decides on getVerifiedUser and isOperator, and answers with notFound()", () => {
    expect(fs.existsSync(LAYOUT), "app/(app)/ops/layout.tsx is missing").toBe(true);
    const content = code(LAYOUT);
    expect(content).toMatch(/getVerifiedUser/);
    expect(content).toMatch(/isOperator/);
    expect(content).toMatch(/notFound\s*\(/);
    expect(content).not.toMatch(/\bredirect\s*\(/);
    expect(content).not.toContain("getClaims");
    expect(content.split("\n")[0]?.trim()).not.toMatch(/use client/);
  });

  it("the page exists, is a server component and reads through lib/server/ops/read only", () => {
    expect(fs.existsSync(PAGE), "app/(app)/ops/page.tsx is missing").toBe(true);
    const content = code(PAGE);
    expect(content).not.toMatch(/["']use client["']/);
    expect(content).toMatch(/server\/ops\/read/);
    expect(content).not.toMatch(/admin\/|SECRET_KEY|service_role/);
  });

  it('no file under app/(app)/ops is a "use client" file (the view renders on the server)', () => {
    const files = collectSourceFiles(PAGE_DIR);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) expect(code(file), relative(file)).not.toMatch(/^\s*["']use client["']/);
  });
});

describe("the eval route records the score through record.ts", () => {
  it("route.ts imports record.ts and hands it to handleEvalRequest", () => {
    const content = read(EVAL_ROUTE);
    expect(content).toMatch(/from\s+["']@\/lib\/server\/eval\/record["']/);
    expect(content).toMatch(/\brecord\s*[:,]/);
    expect(content).not.toMatch(/admin\//);
  });

  it("route.ts still exports POST only and keeps maxDuration = 300", () => {
    const content = read(EVAL_ROUTE);
    expect(content).toContain("export const maxDuration = 300");
    expect(content).toMatch(/export\s+(?:async\s+)?function\s+POST/);
    expect(content).not.toMatch(/export\s+(?:async\s+)?function\s+(?:GET|PUT|DELETE|PATCH)\b/);
  });

  it("eval/http.ts has no admin import: recording is injected", () => {
    expect(read(path.join(webDir, "lib/server/eval/http.ts"))).not.toMatch(/admin\/|lib\/supabase|SECRET_KEY/);
  });
});

describe("the ops migration", () => {
  const dir = path.join(repoRoot, "supabase/migrations");
  const file = path.join(dir, "20261024090000_ops.sql");
  const sql = () =>
    read(file)
      .split("\n")
      .map((line) => line.replace(/--.*$/, ""))
      .join("\n")
      .toLowerCase();

  it("exists", () => {
    expect(fs.existsSync(file), "supabase/migrations/20261024090000_ops.sql is missing").toBe(true);
  });

  it("adds no security definer function and grants nothing to anon, authenticated or public", () => {
    const content = sql();
    expect(content).not.toMatch(/security\s+definer/);
    expect(content).not.toMatch(/grant\s+[^;]*\bto\s+[^;]*\b(anon|authenticated|public)\b/);
  });

  it("is expand-only: no drop, no rename, no truncate, no delete, no alter of an existing object", () => {
    const content = sql();
    expect(content).not.toMatch(/\bdrop\s+(table|column|function|policy|schema|trigger)\b/);
    expect(content).not.toMatch(/\brename\b/);
    expect(content).not.toMatch(/\btruncate\b/);
    expect(content).not.toMatch(/\bdelete\s+from\b/);
    expect(content).not.toMatch(/alter\s+table\s+(?!private\.eval_runs)/);
  });

  it("reads no user_metadata and no text column of sources, messages or chunks", () => {
    const content = sql();
    expect(content).not.toMatch(/user_metadata/);
    expect(content).not.toMatch(/\b(content|title|quote|storage_path|source_url)\b/);
  });
});
