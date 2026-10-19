// Static guards for the live eval (spec .git/EVAL-SPEC.md), in the style of
// tests/unit/canary/source-scan.test.ts: server-only modules, no database or admin access,
// a thin POST-only route and a script that reads its inputs from env only.
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const webDir = path.join(repoRoot, "apps/web");
const evalDir = path.join(webDir, "lib/server/eval");
const FILES = ["corpus.ts", "score.ts", "run.ts", "http.ts"];

describe("eval modules", () => {
  it("exist and each begins with `import \"server-only\"`", () => {
    for (const f of FILES) {
      const file = path.join(evalDir, f);
      expect(fs.existsSync(file), `lib/server/eval/${f} is missing`).toBe(true);
      const firstLine = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n")[0]?.trim() : undefined;
      expect(firstLine, f).toBe('import "server-only";');
    }
  });

  it("never touch the database, the admin module or the filesystem", () => {
    for (const f of FILES) {
      const file = path.join(evalDir, f);
      const content = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
      expect(content, `${f} is missing`).not.toBe("");
      expect(content).not.toMatch(/lib\/supabase|server\/admin|admin\/usage/);
      expect(content, `${f} must not read files at runtime`).not.toMatch(/node:fs|from "fs"/);
    }
  });
});

describe("eval route", () => {
  const route = path.join(webDir, "app/api/eval/route.ts");

  it("exists, sets maxDuration = 300, exports POST only and delegates to handleEvalRequest", () => {
    expect(fs.existsSync(route), "app/api/eval/route.ts is missing").toBe(true);
    const content = fs.existsSync(route) ? fs.readFileSync(route, "utf8") : "";
    expect(content).toContain("export const maxDuration = 300");
    expect(content).toContain("handleEvalRequest");
    expect(content).toContain("runEval");
    expect(content).toContain("createCanaryCallers");
    expect(content).toContain("process.env.EVAL_SECRET");
    expect(content).not.toContain("process.env.CANARY_SECRET");
    expect(content).not.toMatch(/model\/bedrock|client-bedrock-runtime/);
    expect(content).toMatch(/export\s+(?:async\s+)?function\s+POST|export\s+const\s+POST/);
    expect(content).not.toMatch(/export\s+(?:async\s+)?function\s+(?:GET|PUT|DELETE|PATCH)\b/);
  });
});

describe("eval script", () => {
  const script = path.join(repoRoot, "scripts/eval.mjs");

  it("exists and takes its inputs from env only, never from argv", () => {
    expect(fs.existsSync(script), "scripts/eval.mjs is missing").toBe(true);
    const content = fs.existsSync(script) ? fs.readFileSync(script, "utf8") : "";
    expect(content).toContain("EVAL_BASE_URL");
    expect(content).toContain("EVAL_SECRET");
    expect(content).not.toContain("process.argv");
  });
});
