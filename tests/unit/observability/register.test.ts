// instrumentation.ts register(): the SDK is initialised only on the Node runtime and only with an
// EU DSN. Without a DSN, or with a non-EU one, Sentry.init is never called.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const init = vi.fn();
const captureRequestError = vi.fn();

vi.mock("@sentry/nextjs", () => ({ init, captureRequestError, captureException: vi.fn() }));

const EU_DSN = "https://abc@o123.ingest.de.sentry.io/456";

async function register() {
  vi.resetModules();
  const mod = (await import("../../../apps/web/instrumentation")) as {
    register: () => void | Promise<void>;
    onRequestError: unknown;
  };
  await mod.register();
  return mod;
}

beforeEach(() => {
  init.mockClear();
  vi.unstubAllEnvs();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("instrumentation register()", () => {
  it("never calls Sentry.init without a DSN", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    delete process.env.NEXT_PUBLIC_SENTRY_DSN;
    await register();
    expect(init).not.toHaveBeenCalled();
  });

  it("never calls Sentry.init for an empty DSN", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "");
    await register();
    expect(init).not.toHaveBeenCalled();
  });

  it("never calls Sentry.init for a US DSN", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "https://abc@o123.ingest.us.sentry.io/456");
    await register();
    expect(init).not.toHaveBeenCalled();
  });

  it("never calls Sentry.init for a lookalike host", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "https://abc@o1.ingest.de.sentry.io.evil.com/456");
    await register();
    expect(init).not.toHaveBeenCalled();
  });

  it("never calls Sentry.init on the edge runtime, even with an EU DSN", async () => {
    vi.stubEnv("NEXT_RUNTIME", "edge");
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", EU_DSN);
    await register();
    expect(init).not.toHaveBeenCalled();
  });

  it("calls Sentry.init once on nodejs with an EU DSN, with the hardened options", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", EU_DSN);
    vi.stubEnv("NEXT_PUBLIC_VERCEL_ENV", "production");
    await register();
    expect(init).toHaveBeenCalledTimes(1);
    const options = init.mock.calls[0]![0] as Record<string, unknown> & {
      beforeSendTransaction: (e: unknown) => unknown;
      beforeBreadcrumb: (b: unknown) => unknown;
      integrations?: unknown;
    };
    expect(options.dsn).toBe(EU_DSN);
    expect(options.environment).toBe("production");
    expect(options.sendDefaultPii).toBe(false);
    expect(options.tracesSampleRate).toBe(0);
    expect(options.tracePropagationTargets).toEqual([]);
    expect(options.beforeSend).toBeTypeOf("function");
    expect(options.beforeSendTransaction({})).toBeNull();
    expect(options.beforeBreadcrumb({ category: "console" })).toBeNull();
    if (Array.isArray(options.integrations)) {
      for (const i of options.integrations) {
        expect(String((i as { name?: string }).name)).not.toMatch(/replay|feedback|console/i);
      }
    }
  });

  it("falls back to environment 'development' without NEXT_PUBLIC_VERCEL_ENV", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", EU_DSN);
    delete process.env.NEXT_PUBLIC_VERCEL_ENV;
    await register();
    expect(init).toHaveBeenCalledTimes(1);
    expect((init.mock.calls[0]![0] as { environment: string }).environment).toBe("development");
  });

  it("exports Sentry.captureRequestError as onRequestError", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    const mod = await register();
    expect(mod.onRequestError).toBe(captureRequestError);
  });
});
