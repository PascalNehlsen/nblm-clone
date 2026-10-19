// R2: static guards for the release canary (spec .git/R2-SPEC.md), in the style of
// tests/unit/auth-boundary.test.ts. The canary modules are server-only, the route is a thin
// wrapper, /api/canary is a public path and the scripts never read secrets from argv.
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { isPublicPath, PUBLIC_PATHS } from "../../../apps/web/lib/auth/paths";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const webDir = path.join(repoRoot, "apps/web");
const canaryDir = path.join(webDir, "lib/server/canary");

describe("canary modules are server-only", () => {
  const files = ["fixture.ts", "canary.ts", "http.ts"].map((f) => path.join(canaryDir, f));

  it("fixture.ts, canary.ts and http.ts exist", () => {
    for (const file of files) {
      expect(fs.existsSync(file), `${path.relative(webDir, file)} is missing`).toBe(true);
    }
  });

  it('each begins with `import "server-only"` as its first line', () => {
    for (const file of files) {
      const firstLine = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n")[0]?.trim() : undefined;
      expect(firstLine, `${path.relative(webDir, file)} must start with import "server-only"`).toBe(
        'import "server-only";',
      );
    }
  });

  it('every file in lib/server/canary/ begins with `import "server-only"`', () => {
    expect(fs.existsSync(canaryDir), "lib/server/canary is missing").toBe(true);
    const found = fs.existsSync(canaryDir) ? fs.readdirSync(canaryDir).filter((f) => /\.(ts|tsx|mjs|js)$/.test(f)) : [];
    expect(found.length).toBeGreaterThan(0);
    for (const f of found) {
      const firstLine = fs.readFileSync(path.join(canaryDir, f), "utf8").split("\n")[0]?.trim();
      expect(firstLine, `lib/server/canary/${f} must start with import "server-only"`).toBe('import "server-only";');
    }
  });

  it("canary.ts and http.ts never touch the database or the admin module", () => {
    for (const f of ["canary.ts", "http.ts", "fixture.ts"]) {
      const file = path.join(canaryDir, f);
      const content = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
      expect(content, `${f} is missing`).not.toBe("");
      expect(content).not.toMatch(/lib\/supabase|server\/admin|admin\/usage/);
    }
  });
});

// The canary's budget subject comes from the environment, so the wiring may be reached from
// exactly these files (same source-text backstop as the admin and Bedrock scans in
// auth-boundary.test.ts, which also sees import(), require() and plain .js/.mjs files).
const skippedDirNames = new Set(["node_modules", ".next"]);
const sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);

function collectSourceFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!skippedDirNames.has(entry.name)) files.push(...collectSourceFiles(path.join(dir, entry.name)));
    } else if (sourceExtensions.has(path.extname(entry.name))) {
      files.push(path.join(dir, entry.name));
    }
  }
  return files;
}

function offenders(
  files: Array<{ relativePath: string; content: string }>,
  pattern: RegExp,
  allowed: string[],
): string[] {
  return files.filter((f) => !allowed.includes(f.relativePath) && pattern.test(f.content)).map((f) => f.relativePath);
}

const SINGULAR = /\bcreateCanaryCaller\b/;
const PLURAL = /\bcreateCanaryCallers\b|model\/canary-callers/;
const SINGULAR_ALLOWED = ["lib/server/model/call.ts", "lib/server/model/canary-callers.ts"];
const PLURAL_ALLOWED = ["app/api/canary/route.ts", "lib/server/model/canary-callers.ts"];

describe("boundary scan: who may reach the canary caller", () => {
  it("the detectors flag other files and allow the named ones", () => {
    const bad = [{ relativePath: "app/actions.ts", content: 'const m = await import("@/lib/server/model/call"); m.createCanaryCaller;' }];
    expect(offenders(bad, SINGULAR, SINGULAR_ALLOWED)).toEqual(["app/actions.ts"]);
    const bad2 = [{ relativePath: "lib/x.cjs", content: 'require("../server/model/canary-callers")' }];
    expect(offenders(bad2, PLURAL, PLURAL_ALLOWED)).toEqual(["lib/x.cjs"]);
    const ok = [
      { relativePath: "lib/server/model/call.ts", content: "export function createCanaryCaller() {}" },
      { relativePath: "app/api/canary/route.ts", content: 'import { createCanaryCallers } from "@/lib/server/model/canary-callers";' },
    ];
    expect(offenders(ok, SINGULAR, SINGULAR_ALLOWED)).toEqual([]);
    expect(offenders(ok, PLURAL, PLURAL_ALLOWED)).toEqual([]);
  });

  const files = () =>
    collectSourceFiles(webDir).map((file) => ({
      relativePath: path.relative(webDir, file).split(path.sep).join("/"),
      content: fs.readFileSync(file, "utf8"),
    }));

  it("createCanaryCaller appears only in model/call.ts and model/canary-callers.ts", () => {
    expect(offenders(files(), SINGULAR, SINGULAR_ALLOWED)).toEqual([]);
  });

  it("createCanaryCallers and model/canary-callers appear only in the canary route and the defining file", () => {
    expect(offenders(files(), PLURAL, PLURAL_ALLOWED)).toEqual([]);
  });

  it("the defining files exist, so the scans above are not vacuous", () => {
    expect(fs.existsSync(path.join(webDir, "lib/server/model/canary-callers.ts"))).toBe(true);
    expect(SINGULAR.test(fs.readFileSync(path.join(webDir, "lib/server/model/call.ts"), "utf8"))).toBe(true);
  });
});

describe("canary route", () => {
  const route = path.join(webDir, "app/api/canary/route.ts");

  it("exists, sets maxDuration = 180, exports POST only and delegates to handleCanaryRequest", () => {
    expect(fs.existsSync(route), "app/api/canary/route.ts is missing").toBe(true);
    const content = fs.existsSync(route) ? fs.readFileSync(route, "utf8") : "";
    expect(content).toContain("export const maxDuration = 180");
    expect(content).toContain("handleCanaryRequest");
    // The providers are bound in lib/server/model/canary-callers.ts (createCanaryCallers),
    // because ESLint forbids importing the Bedrock provider outside lib/server/model.
    expect(content).toContain("createCanaryCallers");
    expect(content).toContain("@/lib/server/model/canary-callers");
    expect(content).not.toMatch(/model\/bedrock|client-bedrock-runtime/);
    expect(content).toContain("process.env.CANARY_SECRET");
    expect(content).toMatch(/export\s+(?:async\s+)?function\s+POST|export\s+const\s+POST/);
    expect(content).not.toMatch(/export\s+(?:async\s+)?function\s+(?:GET|PUT|DELETE|PATCH)\b/);
  });
});

describe("/api/canary is a public path", () => {
  it("is listed and matches exactly", () => {
    expect(PUBLIC_PATHS).toContain("/api/canary");
    expect(isPublicPath("/api/canary")).toBe(true);
  });

  it("does not open anything below or next to it", () => {
    expect(isPublicPath("/api/canary/x")).toBe(false);
    expect(isPublicPath("/api/canaryx")).toBe(false);
    expect(isPublicPath("/api")).toBe(false);
    expect(isPublicPath("/api/chat")).toBe(false);
  });

  it("keeps the two existing public paths", () => {
    expect(isPublicPath("/login")).toBe(true);
    expect(isPublicPath("/auth/callback")).toBe(true);
  });
});

describe("canary script", () => {
  const script = path.join(repoRoot, "scripts/canary.mjs");

  it("exists and takes its inputs from env only, never from argv", () => {
    expect(fs.existsSync(script), "scripts/canary.mjs is missing").toBe(true);
    const content = fs.existsSync(script) ? fs.readFileSync(script, "utf8") : "";
    expect(content).toContain("CANARY_BASE_URL");
    expect(content).toContain("CANARY_SECRET");
    expect(content).not.toContain("process.argv");
  });
});
