// Static guards for PR B1 (auth/session), mirroring the style of
// tests/unit/web-shell.test.tsx and tests/rls/harness.test.ts's source scans:
// no admin-credential-shaped substrings anywhere under apps/web, no
// NEXT_PUBLIC_ variable name that looks like it carries a secret, the two
// server-only Supabase modules are actually marked server-only, and no
// "use client" file imports them (or lib/server/).
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const webDir = path.join(repoRoot, "apps/web");
const skippedDirNames = new Set(["node_modules", ".next"]);
// Next also serves .jsx (page.jsx, route.jsx) and the codebase can contain
// .cjs/.mts/.cts; the eslint `files` glob covers all of these (eslint.config.mjs
// B1 fix), so the scan must see the same set or a file in one of these
// extensions is invisible to it.
const sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);

function collectSourceFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (skippedDirNames.has(entry.name)) continue;
      files.push(...collectSourceFiles(path.join(dir, entry.name)));
      continue;
    }
    if (sourceExtensions.has(path.extname(entry.name))) {
      files.push(path.join(dir, entry.name));
    }
  }

  return files;
}

// PR E2 (model call wrapper): lib/server/admin/usage.ts is the one module ADR 0006
// names as holding the service_role credential. It legitimately contains
// "SECRET_KEY" (the SUPABASE_SECRET_KEY env var name), "sb_secret_" (the key-shape
// check) and "service_role" (the JWT role check), so it needs a narrow, explicit
// exemption from the substring scan below -- every other file stays covered.
const EXEMPT_FROM_SUBSTRING_SCAN = ["lib/server/admin/usage.ts"];

// The exemption logic itself, as a pure function over synthetic files, so a
// forbidden substring in some other (non-exempt) file is still proven to fail
// even though test-author cannot add a real offending file under apps/web.
function collectForbiddenOffenders(
  files: Array<{ relativePath: string; content: string }>,
  forbidden: string[],
  exempt: string[],
): string[] {
  const offenders: string[] = [];
  for (const file of files) {
    if (exempt.includes(file.relativePath)) continue;
    for (const needle of forbidden) {
      if (file.content.includes(needle)) {
        offenders.push(`${file.relativePath}: contains "${needle}"`);
      }
    }
  }
  return offenders;
}

describe("boundary scan: no admin-credential-shaped substrings under apps/web", () => {
  const forbiddenSubstrings = ["service_role", "SERVICE_ROLE", "sb_secret_", "SECRET_KEY", "JWT_SECRET"];

  it("apps/web exists and contains at least one source file", () => {
    expect(fs.existsSync(webDir)).toBe(true);
    expect(collectSourceFiles(webDir).length).toBeGreaterThan(0);
  });

  it("contains none of the forbidden substrings, except in the exempted admin usage module", () => {
    const files = collectSourceFiles(webDir).map((file) => ({
      relativePath: path.relative(webDir, file).split(path.sep).join("/"),
      content: fs.readFileSync(file, "utf8"),
    }));
    const offenders = collectForbiddenOffenders(files, forbiddenSubstrings, EXEMPT_FROM_SUBSTRING_SCAN);
    expect(offenders).toEqual([]);
  });

  it("a forbidden substring in any other (non-exempt) file is still caught", () => {
    const files = [
      { relativePath: "lib/server/admin/usage.ts", content: "const x = 'service_role';" },
      { relativePath: "lib/notebooks/notebooks.ts", content: "const x = 'service_role';" },
    ];
    const offenders = collectForbiddenOffenders(files, forbiddenSubstrings, EXEMPT_FROM_SUBSTRING_SCAN);
    expect(offenders).toEqual(['lib/notebooks/notebooks.ts: contains "service_role"']);
  });

  it("no NEXT_PUBLIC_ variable name contains SECRET or SERVICE", () => {
    const pattern = /NEXT_PUBLIC_[A-Z0-9_]*(?:SECRET|SERVICE)[A-Z0-9_]*/g;
    const offenders: string[] = [];
    for (const file of collectSourceFiles(webDir)) {
      const content = fs.readFileSync(file, "utf8");
      const matches = content.match(pattern);
      if (matches) {
        offenders.push(`${path.relative(webDir, file)}: ${matches.join(", ")}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

// Reviewer finding on E2: ESLint's no-restricted-imports (tested in
// eslint-imports.test.ts) only sees static import specifiers. It does not see a
// dynamic `import()`, a `require()` call or a plain .js/.mjs file, so
// `await import("@/lib/server/admin/usage")` written anywhere -- a server action,
// a route handler -- would pass lint today even though it reaches the
// service_role credential. This is a source-text backstop for that blind spot:
// nothing outside the two files ADR 0006 names may reference the admin module
// path at all, in any import form.
const ADMIN_REFERENCE_SUBSTRINGS = ["server/admin", "admin/usage"];
const ALLOWED_ADMIN_REFERENCE_FILES = ["lib/server/model/call.ts", "lib/server/admin/usage.ts"];

describe("boundary scan: only call.ts and admin/usage.ts may reference the admin module path", () => {
  it("a dynamic import of the admin module elsewhere is caught; the same text in call.ts is not", () => {
    const files = [
      { relativePath: "app/actions.ts", content: 'await import("@/lib/server/admin/usage");' },
      { relativePath: "lib/server/model/call.ts", content: 'await import("../admin/usage");' },
    ];
    const offenders = collectForbiddenOffenders(files, ADMIN_REFERENCE_SUBSTRINGS, ALLOWED_ADMIN_REFERENCE_FILES);
    // The synthetic specifier contains both needles ("server/admin" and "admin/usage"),
    // so collectForbiddenOffenders reports one line per needle; what matters here is
    // that every offender line is about app/actions.ts and none is about call.ts.
    expect(offenders.length).toBeGreaterThan(0);
    expect(offenders.every((offender) => offender.startsWith("app/actions.ts:"))).toBe(true);
  });

  it("a require() of the admin module elsewhere is also caught", () => {
    const files = [{ relativePath: "lib/notebooks/x.ts", content: 'const { reserve } = require("../server/admin/usage");' }];
    const offenders = collectForbiddenOffenders(files, ADMIN_REFERENCE_SUBSTRINGS, ALLOWED_ADMIN_REFERENCE_FILES);
    expect(offenders.length).toBeGreaterThan(0);
    expect(offenders.every((offender) => offender.startsWith("lib/notebooks/x.ts:"))).toBe(true);
  });

  it("call-core.ts referencing the admin path is caught (it is not on the admin allowlist)", () => {
    const files = [{ relativePath: "lib/server/model/call-core.ts", content: 'import { reserve } from "../admin/usage";' }];
    const offenders = collectForbiddenOffenders(files, ADMIN_REFERENCE_SUBSTRINGS, ALLOWED_ADMIN_REFERENCE_FILES);
    expect(offenders.length).toBeGreaterThan(0);
    expect(offenders.every((offender) => offender.startsWith("lib/server/model/call-core.ts:"))).toBe(true);
  });

  // B1 fix: Next serves .jsx (page.jsx, route.jsx); the scan must see it too,
  // or a page/route file in .jsx is invisible to this backstop.
  it("a page.jsx importing the admin module is caught", () => {
    const files = [{ relativePath: "app/x/page.jsx", content: 'import { reserve } from "@/lib/server/admin/usage";' }];
    const offenders = collectForbiddenOffenders(files, ADMIN_REFERENCE_SUBSTRINGS, ALLOWED_ADMIN_REFERENCE_FILES);
    expect(offenders.length).toBeGreaterThan(0);
    expect(offenders.every((offender) => offender.startsWith("app/x/page.jsx:"))).toBe(true);
  });

  it("the real tree has no reference to the admin module path outside call.ts and admin/usage.ts", () => {
    const files = collectSourceFiles(webDir).map((file) => ({
      relativePath: path.relative(webDir, file).split(path.sep).join("/"),
      content: fs.readFileSync(file, "utf8"),
    }));
    const offenders = collectForbiddenOffenders(files, ADMIN_REFERENCE_SUBSTRINGS, ALLOWED_ADMIN_REFERENCE_FILES);
    expect(offenders).toEqual([]);
  });
});

// Reviewer finding on E2 (2026-10-19, approved): createModelCallerForTests lets
// injectable deps bypass the budget check (ADR 0006), so it must never reach
// production code. testing.ts is the only file allowed to reference itself;
// nothing else under apps/web may import it, dynamically or otherwise.
const TESTING_REFERENCE_SUBSTRINGS = ["model/testing", "./testing"];
const ALLOWED_TESTING_REFERENCE_FILES = ["lib/server/model/testing.ts"];

describe("boundary scan: only testing.ts may reference the test-only model/testing entry point", () => {
  it("a dynamic import of model/testing in a .mjs file is caught; testing.ts referencing itself is not", () => {
    const files = [
      { relativePath: "app/actions.mjs", content: 'await import("@/lib/server/model/testing");' },
      { relativePath: "lib/server/model/testing.ts", content: "// this file is lib/server/model/testing.ts" },
    ];
    const offenders = collectForbiddenOffenders(files, TESTING_REFERENCE_SUBSTRINGS, ALLOWED_TESTING_REFERENCE_FILES);
    expect(offenders.length).toBeGreaterThan(0);
    expect(offenders.every((offender) => offender.startsWith("app/actions.mjs:"))).toBe(true);
  });

  it('a relative "./testing" specifier elsewhere is also caught', () => {
    const files = [{ relativePath: "lib/server/model/other.ts", content: 'import { x } from "./testing";' }];
    const offenders = collectForbiddenOffenders(files, TESTING_REFERENCE_SUBSTRINGS, ALLOWED_TESTING_REFERENCE_FILES);
    expect(offenders.length).toBeGreaterThan(0);
    expect(offenders.every((offender) => offender.startsWith("lib/server/model/other.ts:"))).toBe(true);
  });

  it("call.ts referencing testing.ts is also caught (the production entry must not use the test harness)", () => {
    const files = [{ relativePath: "lib/server/model/call.ts", content: 'import { x } from "./testing";' }];
    const offenders = collectForbiddenOffenders(files, TESTING_REFERENCE_SUBSTRINGS, ALLOWED_TESTING_REFERENCE_FILES);
    expect(offenders.length).toBeGreaterThan(0);
    expect(offenders.every((offender) => offender.startsWith("lib/server/model/call.ts:"))).toBe(true);
  });

  it("the real tree has no reference to model/testing outside testing.ts itself", () => {
    const files = collectSourceFiles(webDir).map((file) => ({
      relativePath: path.relative(webDir, file).split(path.sep).join("/"),
      content: fs.readFileSync(file, "utf8"),
    }));
    const offenders = collectForbiddenOffenders(files, TESTING_REFERENCE_SUBSTRINGS, ALLOWED_TESTING_REFERENCE_FILES);
    expect(offenders).toEqual([]);
  });
});

// call-core.ts holds the engine (buildModelCaller) and is meant to be wired by
// exactly two production-shaped entry points: the real call.ts and the
// test-only testing.ts. Nothing else, including app code, should reach past
// the thin wrappers into the engine directly.
const CALL_CORE_REFERENCE_SUBSTRINGS = ["call-core"];
const ALLOWED_CALL_CORE_REFERENCE_FILES = ["lib/server/model/call.ts", "lib/server/model/testing.ts"];

describe("boundary scan: only call.ts and testing.ts may reference call-core", () => {
  it("a require() of call-core in a .js file is caught; call.ts referencing it is not", () => {
    const files = [
      { relativePath: "lib/server/model/other.js", content: 'const { buildModelCaller } = require("./call-core");' },
      { relativePath: "lib/server/model/call.ts", content: 'import { buildModelCaller } from "./call-core";' },
    ];
    const offenders = collectForbiddenOffenders(files, CALL_CORE_REFERENCE_SUBSTRINGS, ALLOWED_CALL_CORE_REFERENCE_FILES);
    expect(offenders.length).toBeGreaterThan(0);
    expect(offenders.every((offender) => offender.startsWith("lib/server/model/other.js:"))).toBe(true);
  });

  it("the real tree has no reference to call-core outside call.ts and testing.ts", () => {
    const files = collectSourceFiles(webDir).map((file) => ({
      relativePath: path.relative(webDir, file).split(path.sep).join("/"),
      content: fs.readFileSync(file, "utf8"),
    }));
    const offenders = collectForbiddenOffenders(files, CALL_CORE_REFERENCE_SUBSTRINGS, ALLOWED_CALL_CORE_REFERENCE_FILES);
    expect(offenders).toEqual([]);
  });
});

describe("lib/supabase/server.ts and lib/supabase/proxy.ts are marked server-only", () => {
  const serverFile = path.join(webDir, "lib/supabase/server.ts");
  const proxyLibFile = path.join(webDir, "lib/supabase/proxy.ts");

  it("both files exist", () => {
    expect(fs.existsSync(serverFile), "lib/supabase/server.ts is missing").toBe(true);
    expect(fs.existsSync(proxyLibFile), "lib/supabase/proxy.ts is missing").toBe(true);
  });

  it("both begin with `import \"server-only\"` as their first line", () => {
    for (const file of [serverFile, proxyLibFile]) {
      const firstLine = fs.readFileSync(file, "utf8").split("\n")[0]?.trim();
      expect(firstLine, `${path.relative(webDir, file)} must start with import "server-only"`).toBe(
        'import "server-only";',
      );
    }
  });
});

// PR E2: every module that holds, derives from or spends the service_role /
// provider budget path must be server-only, same as lib/supabase/server.ts above.
describe("the model call wrapper's server-only modules are marked server-only", () => {
  const modelCallFiles = [
    "lib/server/model/call.ts",
    "lib/server/model/call-core.ts",
    "lib/server/admin/usage.ts",
    "lib/server/model/caller.ts",
    "lib/server/model/config.ts",
    "lib/server/model/prices.ts",
    "lib/server/model/testing.ts",
  ].map((relative) => path.join(webDir, relative));

  it("all seven files exist", () => {
    for (const file of modelCallFiles) {
      expect(fs.existsSync(file), `${path.relative(webDir, file)} is missing`).toBe(true);
    }
  });

  it("all seven begin with `import \"server-only\"` as their first line", () => {
    for (const file of modelCallFiles) {
      const firstLine = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n")[0]?.trim() : undefined;
      expect(firstLine, `${path.relative(webDir, file)} must start with import "server-only"`).toBe(
        'import "server-only";',
      );
    }
  });
});

describe("no \"use client\" file imports a server-only module", () => {
  const forbiddenImportTargets = ["lib/supabase/server", "lib/supabase/proxy", "lib/server/"];

  function isClientComponent(content: string): boolean {
    const firstMeaningfulLine = content
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    return firstMeaningfulLine === '"use client";' || firstMeaningfulLine === "'use client';";
  }

  it("has no offenders", () => {
    const offenders: string[] = [];
    for (const file of collectSourceFiles(webDir).filter((f) => path.extname(f) !== ".mjs")) {
      const content = fs.readFileSync(file, "utf8");
      if (!isClientComponent(content)) continue;

      for (const target of forbiddenImportTargets) {
        if (content.includes(target)) {
          offenders.push(`${path.relative(webDir, file)}: "use client" file imports "${target}"`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
