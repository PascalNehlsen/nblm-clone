// Source-text guards for account deletion (the service_role key and the orchestration around it).
// ESLint (tests/unit/eslint-imports.test.ts) only sees static import specifiers; this scan also
// sees import(), require() and plain .js/.mjs/.cjs files.
//
//   - lib/server/admin/accounts.ts holds the key (second module next to admin/usage.ts)
//   - lib/server/account/delete-account.ts is its ONLY importer
//   - delete-account.ts reaches it, and everything else it imports, by RELATIVE paths: the "rls"
//     vitest project has no "@/" alias, and tests/rls/account_deletion.test.ts imports the module
//   - the server action (app/(app)/profil/actions.ts) never touches the admin module
//   - the profil UI components import nothing server-side
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

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

function firstLine(file: string): string | undefined {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n")[0]?.trim() : undefined;
}

const ACCOUNTS = path.join(webDir, "lib/server/admin/accounts.ts");
const DELETE_ACCOUNT = path.join(webDir, "lib/server/account/delete-account.ts");
const ACTIONS = path.join(webDir, "app/(app)/profil/actions.ts");
const UI = path.join(webDir, "app/(app)/profil/delete-account.tsx");

const ACCOUNTS_REFERENCE = ["admin/accounts"];
const ALLOWED_ACCOUNTS_REFERENCE_FILES = ["lib/server/admin/accounts.ts", "lib/server/account/delete-account.ts"];

function offenders(files: Array<{ relativePath: string; content: string }>): string[] {
  return files
    .filter((file) => !ALLOWED_ACCOUNTS_REFERENCE_FILES.includes(file.relativePath))
    .filter((file) => ACCOUNTS_REFERENCE.some((needle) => file.content.includes(needle)))
    .map((file) => file.relativePath);
}

describe("boundary scan: only delete-account.ts may reference admin/accounts", () => {
  it("catches static, dynamic and require references elsewhere, and in other file types", () => {
    const samples: Array<[string, string]> = [
      ["app/(app)/profil/actions.ts", 'import { deleteAuthUser } from "@/lib/server/admin/accounts";'],
      ["app/x/route.ts", 'const m = await import("../../lib/server/admin/accounts");'],
      ["lib/x.cjs", 'const { deleteAuthUser } = require("./server/admin/accounts");'],
      ["lib/server/model/call.ts", 'import { deleteAuthUser } from "../admin/accounts";'],
      ["app/x/page.jsx", 'import { adminConfigured } from "@/lib/server/admin/accounts";'],
    ];
    for (const [relativePath, content] of samples) {
      expect(offenders([{ relativePath, content }]), relativePath).toEqual([relativePath]);
    }
  });

  it("does not flag the two allowed files", () => {
    expect(
      offenders([
        { relativePath: "lib/server/account/delete-account.ts", content: 'import { deleteAuthUser } from "../admin/accounts";' },
        { relativePath: "lib/server/admin/accounts.ts", content: "// lib/server/admin/accounts.ts" },
      ]),
    ).toEqual([]);
  });

  it("the real tree references admin/accounts nowhere else", () => {
    const files = collectSourceFiles(webDir).map((file) => ({
      relativePath: relative(file),
      content: fs.readFileSync(file, "utf8"),
    }));
    expect(offenders(files)).toEqual([]);
  });

  it("delete-account.ts really does import it (the allowance is not an empty promise)", () => {
    expect(fs.existsSync(DELETE_ACCOUNT), "lib/server/account/delete-account.ts is missing").toBe(true);
    const content = fs.existsSync(DELETE_ACCOUNT) ? fs.readFileSync(DELETE_ACCOUNT, "utf8") : "";
    expect(content).toMatch(/from\s+["']\.\.\/admin\/accounts["']/);
  });
});

describe("the account modules exist and are marked server-only", () => {
  it.each([ACCOUNTS, DELETE_ACCOUNT])("%s exists and begins with `import \"server-only\"`", (file) => {
    expect(fs.existsSync(file), `${relative(file)} is missing`).toBe(true);
    expect(firstLine(file), `${relative(file)} must start with import "server-only"`).toBe('import "server-only";');
  });

  it("every file in lib/server/account/ begins with `import \"server-only\"`", () => {
    const files = collectSourceFiles(path.join(webDir, "lib/server/account"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(firstLine(file), `${relative(file)} must start with import "server-only"`).toBe('import "server-only";');
    }
  });
});

describe("delete-account.ts imports by relative path only, and nothing request-bound", () => {
  const content = () => (fs.existsSync(DELETE_ACCOUNT) ? fs.readFileSync(DELETE_ACCOUNT, "utf8") : "");

  it("has no import, dynamic import or require of an \"@/\" alias", () => {
    expect(fs.existsSync(DELETE_ACCOUNT), "lib/server/account/delete-account.ts is missing").toBe(true);
    expect(content()).not.toMatch(/\bfrom\s*["']@\//);
    expect(content()).not.toMatch(/\bimport\s*\(\s*["']@\//);
    expect(content()).not.toMatch(/\brequire\s*\(\s*["']@\//);
    expect(content()).not.toMatch(/\bimport\s+["']@\//);
  });

  it("does not import next/*, the Supabase server client or cookies (the session client is injected)", () => {
    expect(fs.existsSync(DELETE_ACCOUNT), "lib/server/account/delete-account.ts is missing").toBe(true);
    expect(content()).not.toMatch(/["']next\//);
    expect(content()).not.toMatch(/lib\/supabase\//);
    expect(content()).not.toMatch(/\.\.\/supabase\//);
  });

  it("uses getUser() and never getClaims() for the session check (ADR 0005)", () => {
    expect(fs.existsSync(DELETE_ACCOUNT), "lib/server/account/delete-account.ts is missing").toBe(true);
    expect(content()).toContain("getUser(");
    expect(content()).not.toContain("getClaims");
  });

  it("reuses deleteNotebook from lib/notebooks instead of deleting rows itself", () => {
    expect(fs.existsSync(DELETE_ACCOUNT), "lib/server/account/delete-account.ts is missing").toBe(true);
    expect(content()).toMatch(/\bdeleteNotebook\b/);
    expect(content()).toMatch(/from\s+["'][./]+\/notebooks\/notebooks["']/);
    expect(content()).not.toMatch(/\.from\(\s*["']notebooks["']\s*\)\s*\.delete/);
  });

  it("signs out with scope local", () => {
    expect(fs.existsSync(DELETE_ACCOUNT), "lib/server/account/delete-account.ts is missing").toBe(true);
    expect(content()).toMatch(/scope\s*:\s*["']local["']/);
  });
});

describe("the profil server action and UI", () => {
  it("actions.ts is a server action file that uses deleteAccount and never the admin module or an admin key", () => {
    expect(fs.existsSync(ACTIONS), "app/(app)/profil/actions.ts is missing").toBe(true);
    const content = fs.existsSync(ACTIONS) ? fs.readFileSync(ACTIONS, "utf8") : "";
    expect(content.split("\n")[0]?.trim()).toBe('"use server";');
    expect(content).toMatch(/server\/account\/delete-account/);
    expect(content).not.toMatch(/admin\/accounts|SECRET_KEY|service_role/);
  });

  it("the delete-account UI exists, reuses ConfirmAction and imports nothing from lib/server or lib/supabase", () => {
    expect(fs.existsSync(UI), "app/(app)/profil/delete-account.tsx is missing").toBe(true);
    const content = fs.existsSync(UI) ? fs.readFileSync(UI, "utf8") : "";
    expect(content).toMatch(/components\/confirm-action/);
    expect(content).not.toMatch(/lib\/server|lib\/supabase/);
  });

  it("the UI offers both labels: Konto löschen and, for demo users, Demo beenden und Daten löschen", () => {
    const content = fs.existsSync(UI) ? fs.readFileSync(UI, "utf8") : "";
    expect(content).toContain("Konto löschen");
    expect(content).toContain("Demo beenden und Daten löschen");
  });
});
