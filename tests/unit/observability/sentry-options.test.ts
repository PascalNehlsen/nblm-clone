// Sentry options (new data processor, EU only). The module is pure (no server-only) because
// both runtimes import it. The SDK stays off unless the DSN is an EU ingest host, and the
// options switch off every optional data channel (PII, tracing, replay, breadcrumbs).
import { describe, expect, it } from "vitest";

const MODULE_PATH = "../../../apps/web/lib/observability/sentry-options";

const EU_DSN = "https://abc@o123.ingest.de.sentry.io/456";
const EU_ORIGIN = "https://o123.ingest.de.sentry.io";

interface Options {
  dsn?: string;
  environment?: string;
  release?: string;
  sendDefaultPii?: boolean;
  tracesSampleRate?: number;
  sampleRate?: number;
  tracePropagationTargets?: unknown[];
  integrations?: unknown;
  beforeBreadcrumb?: (b: Record<string, unknown>) => unknown;
  beforeSend?: unknown;
  beforeSendTransaction?: (e: Record<string, unknown>) => unknown;
}
interface Mod {
  sentryDsnOrigin: (dsn: string | undefined) => string | null;
  buildSentryOptions: (env: { dsn?: string; environment?: string; release?: string }) => Options | null;
}

async function load(): Promise<Mod> {
  return (await import(MODULE_PATH)) as Mod;
}

const REJECTED: [string, string | undefined][] = [
  ["undefined", undefined],
  ["empty", ""],
  ["http", "http://abc@o123.ingest.de.sentry.io/456"],
  ["US legacy host", "https://abc@o123.ingest.sentry.io/456"],
  ["US host", "https://abc@o123.ingest.us.sentry.io/456"],
  ["suffix attack", "https://abc@o1.ingest.de.sentry.io.evil.com/456"],
  ["prefix attack", "https://abc@evil.com.o1.ingest.de.sentry.io/456"],
  ["host without o<digits>", "https://abc@ingest.de.sentry.io/456"],
  ["non-numeric org", "https://abc@oabc.ingest.de.sentry.io/456"],
  ["missing public key", "https://o123.ingest.de.sentry.io/456"],
  ["garbage", "not a dsn"],
  ["javascript scheme", "javascript:alert(1)"],
];

describe("sentryDsnOrigin", () => {
  it("returns the https origin for an EU DSN", async () => {
    const { sentryDsnOrigin } = await load();
    expect(sentryDsnOrigin(EU_DSN)).toBe(EU_ORIGIN);
  });

  it("returns only the origin (no key, no project path)", async () => {
    const { sentryDsnOrigin } = await load();
    const origin = sentryDsnOrigin("https://key:secret@o99.ingest.de.sentry.io/12345");
    expect(origin).toBe("https://o99.ingest.de.sentry.io");
  });

  for (const [name, dsn] of REJECTED) {
    it(`returns null for ${name}`, async () => {
      const { sentryDsnOrigin } = await load();
      expect(sentryDsnOrigin(dsn)).toBeNull();
    });
  }
});

describe("buildSentryOptions", () => {
  for (const [name, dsn] of REJECTED) {
    it(`returns null (SDK off) for ${name}`, async () => {
      const { buildSentryOptions } = await load();
      expect(buildSentryOptions({ dsn, environment: "production", release: "abc" })).toBeNull();
    });
  }

  it("returns null without any env", async () => {
    const { buildSentryOptions } = await load();
    expect(buildSentryOptions({})).toBeNull();
  });

  it("passes dsn, environment and release through for an EU DSN", async () => {
    const { buildSentryOptions } = await load();
    const options = buildSentryOptions({ dsn: EU_DSN, environment: "production", release: "sha123" });
    expect(options).not.toBeNull();
    expect(options!.dsn).toBe(EU_DSN);
    expect(options!.environment).toBe("production");
    expect(options!.release).toBe("sha123");
  });

  it("switches off PII, tracing and propagation, and samples every error", async () => {
    const { buildSentryOptions } = await load();
    const options = buildSentryOptions({ dsn: EU_DSN, environment: "production" })!;
    expect(options.sendDefaultPii).toBe(false);
    expect(options.tracesSampleRate).toBe(0);
    expect(options.tracePropagationTargets).toEqual([]);
    expect(options.sampleRate).toBe(1);
  });

  it("has no replay, feedback or console-capture integration", async () => {
    const { buildSentryOptions } = await load();
    const options = buildSentryOptions({ dsn: EU_DSN })!;
    const list = Array.isArray(options.integrations) ? options.integrations : [];
    for (const integration of list) {
      const name = String((integration as { name?: unknown }).name ?? "");
      expect(name).not.toMatch(/replay|feedback|captureconsole|console/i);
    }
  });

  it("drops every transaction", async () => {
    const { buildSentryOptions } = await load();
    const options = buildSentryOptions({ dsn: EU_DSN })!;
    expect(options.beforeSendTransaction).toBeTypeOf("function");
    expect(options.beforeSendTransaction!({ type: "transaction", transaction: "/x" })).toBeNull();
  });

  it("drops every breadcrumb (console, fetch, xhr, navigation, ui)", async () => {
    const { buildSentryOptions } = await load();
    const options = buildSentryOptions({ dsn: EU_DSN })!;
    expect(options.beforeBreadcrumb).toBeTypeOf("function");
    for (const category of ["console", "fetch", "xhr", "navigation", "ui.click", "ui.input"]) {
      expect(options.beforeBreadcrumb!({ category, message: "SENTINEL" }), category).toBeNull();
    }
  });

  it("scrubs events through beforeSend", async () => {
    const { buildSentryOptions } = await load();
    const options = buildSentryOptions({ dsn: EU_DSN })!;
    expect(options.beforeSend).toBeTypeOf("function");
    const out = (options.beforeSend as (e: unknown) => unknown)({
      exception: { values: [{ type: "Error", value: "SENTINEL-USER-TEXT" }] },
      message: "SENTINEL-USER-TEXT",
    });
    expect(JSON.stringify(out)).not.toContain("SENTINEL-USER-TEXT");
  });
});
