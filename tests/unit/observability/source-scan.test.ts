// Static guards for the Sentry integration: the SDK is reached from a fixed set of files, and no
// optional data channel (replay, feedback, console capture, PII, tracing, source map upload,
// tunnel) is switched on anywhere in apps/web.
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const webDir = path.resolve(import.meta.dirname, "../../../apps/web");
const skipped = new Set(["node_modules", ".next"]);
const extensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);

function collect(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!skipped.has(entry.name)) out.push(...collect(path.join(dir, entry.name)));
    } else if (extensions.has(path.extname(entry.name))) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

const files = () =>
  collect(webDir).map((file) => ({
    rel: path.relative(webDir, file).split(path.sep).join("/"),
    content: fs.readFileSync(file, "utf8"),
  }));

const ALLOWED = (rel: string) =>
  [
    "instrumentation.ts",
    "instrumentation-client.ts",
    "app/global-error.tsx",
    "app/error.tsx",
  ].includes(rel) || rel.startsWith("lib/observability/");

const SENTRY_IMPORT = /@sentry\//;

describe("Sentry import boundary", () => {
  it("the detector flags a stray file and allows the named ones", () => {
    expect(ALLOWED("app/page.tsx")).toBe(false);
    expect(ALLOWED("lib/server/chat/x.ts")).toBe(false);
    expect(ALLOWED("instrumentation.ts")).toBe(true);
    expect(ALLOWED("lib/observability/sentry-options.ts")).toBe(true);
  });

  it("the wiring files exist, so the scan is not vacuous", () => {
    for (const rel of [
      "instrumentation.ts",
      "instrumentation-client.ts",
      "app/global-error.tsx",
      "lib/observability/sentry-options.ts",
    ]) {
      expect(fs.existsSync(path.join(webDir, rel)), `${rel} is missing`).toBe(true);
    }
    expect(fs.readFileSync(path.join(webDir, "app/error.tsx"), "utf8")).toContain("@sentry/nextjs");
  });

  it("@sentry/* is imported only by the instrumentation files, the error pages and lib/observability", () => {
    const bad = files()
      .filter((f) => !ALLOWED(f.rel) && SENTRY_IMPORT.test(f.content))
      .map((f) => f.rel);
    expect(bad).toEqual([]);
  });

  it("only @sentry/nextjs is used (no other @sentry package)", () => {
    const bad = files()
      .filter((f) => /@sentry\/(?!nextjs\b)/.test(f.content))
      .map((f) => f.rel);
    expect(bad).toEqual([]);
  });

  it("@sentry/nextjs is a dependency of apps/web, pinned exactly (no range)", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(webDir, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    const version = pkg.dependencies?.["@sentry/nextjs"];
    expect(version, "@sentry/nextjs dependency").toBeTypeOf("string");
    expect(version).toMatch(/^10\.76\.\d+$/);
  });
});

describe("no optional Sentry data channel anywhere in apps/web", () => {
  const banned: [string, RegExp][] = [
    ["replayIntegration", /replayIntegration|replayCanvasIntegration|Sentry\.Replay\b/],
    ["feedbackIntegration", /feedbackIntegration|feedbackModalIntegration|feedbackScreenshotIntegration/],
    ["captureConsoleIntegration", /captureConsoleIntegration/],
    ["consoleLoggingIntegration", /consoleLoggingIntegration/],
    ["sendDefaultPii: true", /sendDefaultPii\s*:\s*true/],
    ["replay sample rates", /replaysSessionSampleRate|replaysOnErrorSampleRate/],
    ["enableLogs", /enableLogs\s*:\s*true/],
    ["withSentryConfig", /withSentryConfig/],
    ["tunnelRoute", /tunnelRoute|tunnel\s*:/],
    ["browserTracingIntegration", /browserTracingIntegration/],
  ];
  for (const [name, pattern] of banned) {
    it(`does not use ${name}`, () => {
      const bad = files()
        .filter((f) => pattern.test(f.content))
        .map((f) => f.rel);
      expect(bad).toEqual([]);
    });
  }

  it("every tracesSampleRate is 0", () => {
    const bad: string[] = [];
    for (const f of files()) {
      for (const m of f.content.matchAll(/tracesSampleRate\s*:\s*([^,}\n]+)/g)) {
        if (m[1]!.trim() !== "0") bad.push(`${f.rel}: ${m[0]}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("the Sentry build plugin is not configured (no source map upload, no auth token)", () => {
    const next = fs.readFileSync(path.join(webDir, "next.config.ts"), "utf8");
    expect(next).not.toMatch(/@sentry|SENTRY_AUTH_TOKEN|sourcemaps|widenClientFileUpload/);
  });
});
