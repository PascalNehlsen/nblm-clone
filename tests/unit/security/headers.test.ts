// The enforced security headers (CSP and friends). securityHeaders() is a pure module (no
// server-only import) so next.config.ts can use it. The policy is checked directive by
// directive with exact token sets: a loosened directive (data:, https:, *, a path, wss:)
// must fail here, not just "contains img-src 'self'".
import { afterEach, describe, expect, it, vi } from "vitest";

const MODULE_PATH = "../../../apps/web/lib/security/headers";
const CONFIG_PATH = "../../../apps/web/next.config";

const SUPABASE = "https://abcdefghijklmnop.supabase.co";
const SITE_HTTPS = "https://nblm-web.vercel.app";
const SITE_HTTP = "http://127.0.0.1:3000";

type Header = { key: string; value: string };
type Build = (input: { supabaseUrl: string | null; siteUrl: string; isDev: boolean }) => Header[];

async function load(): Promise<Build> {
  const mod = (await import(MODULE_PATH)) as { securityHeaders: Build };
  return mod.securityHeaders;
}

function headerMap(headers: Header[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const { key, value } of headers) {
    expect(map.has(key.toLowerCase()), `duplicate header ${key}`).toBe(false);
    map.set(key.toLowerCase(), value);
  }
  return map;
}

function parseCsp(value: string): Map<string, string[]> {
  const directives = new Map<string, string[]>();
  for (const part of value.split(";")) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    const [name, ...sources] = tokens;
    expect(directives.has(name!), `duplicate directive ${name}`).toBe(false);
    directives.set(name!, sources);
  }
  return directives;
}

async function csp(input: { supabaseUrl?: string; siteUrl?: string; isDev?: boolean } = {}) {
  const build = await load();
  const headers = headerMap(
    build({ supabaseUrl: SUPABASE, siteUrl: SITE_HTTPS, isDev: false, ...input }),
  );
  const value = headers.get("content-security-policy");
  expect(value, "Content-Security-Policy header").toBeTypeOf("string");
  return parseCsp(value!);
}

describe("securityHeaders: Content-Security-Policy directives", () => {
  it("is enforced (Content-Security-Policy), never report-only", async () => {
    const build = await load();
    const headers = headerMap(build({ supabaseUrl: SUPABASE, siteUrl: SITE_HTTPS, isDev: false }));
    expect(headers.has("content-security-policy")).toBe(true);
    expect(headers.has("content-security-policy-report-only")).toBe(false);
  });

  it("default-src is 'self' only", async () => {
    expect((await csp()).get("default-src")).toEqual(["'self'"]);
  });

  it("img-src is exactly 'self': no data:, blob:, https:, * or remote hosts", async () => {
    expect((await csp()).get("img-src")).toEqual(["'self'"]);
    expect((await csp({ isDev: true })).get("img-src")).toEqual(["'self'"]);
  });

  it("script-src allows self, inline and Turnstile, and no 'unsafe-eval' outside dev", async () => {
    const sources = (await csp({ isDev: false })).get("script-src");
    expect(sources).toBeDefined();
    expect([...sources!].sort()).toEqual(
      ["'self'", "'unsafe-inline'", "https://challenges.cloudflare.com"].sort(),
    );
  });

  it("script-src adds 'unsafe-eval' only in dev", async () => {
    const sources = (await csp({ isDev: true })).get("script-src");
    expect([...sources!].sort()).toEqual(
      ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://challenges.cloudflare.com"].sort(),
    );
  });

  it("style-src is self and inline", async () => {
    expect([...(await csp()).get("style-src")!].sort()).toEqual(["'self'", "'unsafe-inline'"]);
  });

  it("font-src is 'self'", async () => {
    expect((await csp()).get("font-src")).toEqual(["'self'"]);
  });

  it("connect-src is self plus the Supabase origin only (no path, wildcard or wss:)", async () => {
    const sources = (await csp({ supabaseUrl: `${SUPABASE}/` })).get("connect-src");
    expect(sources).toEqual(["'self'", SUPABASE]);
    const local = (await csp({ supabaseUrl: "http://127.0.0.1:54321", siteUrl: SITE_HTTP })).get(
      "connect-src",
    );
    expect(local).toEqual(["'self'", "http://127.0.0.1:54321"]);
  });

  it("reduces a Supabase URL with a path to its origin", async () => {
    const sources = (await csp({ supabaseUrl: `${SUPABASE}/rest/v1` })).get("connect-src");
    expect(sources).toEqual(["'self'", SUPABASE]);
  });

  it("frame-src is Turnstile only", async () => {
    expect((await csp()).get("frame-src")).toEqual(["https://challenges.cloudflare.com"]);
  });

  it("frame-ancestors 'none', object-src 'none', base-uri 'self'", async () => {
    const directives = await csp();
    expect(directives.get("frame-ancestors")).toEqual(["'none'"]);
    expect(directives.get("object-src")).toEqual(["'none'"]);
    expect(directives.get("base-uri")).toEqual(["'self'"]);
  });

  it("form-action is self, the Supabase origin and github.com", async () => {
    const sources = (await csp()).get("form-action");
    expect([...sources!].sort()).toEqual(["'self'", SUPABASE, "https://github.com"].sort());
  });

  it("has no directive outside the planned set", async () => {
    const names = [...(await csp()).keys()].sort();
    expect(names).toEqual(
      [
        "base-uri",
        "connect-src",
        "default-src",
        "font-src",
        "form-action",
        "frame-ancestors",
        "frame-src",
        "img-src",
        "object-src",
        "script-src",
        "style-src",
        "upgrade-insecure-requests",
      ].sort(),
    );
  });

  it("never allows a wildcard, data:, blob: or a bare scheme anywhere", async () => {
    for (const [name, sources] of await csp({ isDev: true })) {
      for (const source of sources) {
        expect(source, `${name} ${source}`).not.toBe("*");
        expect(source, `${name} ${source}`).not.toMatch(/^(data|blob|https?|wss?):$/);
        expect(source, `${name} ${source}`).not.toContain("*");
      }
    }
  });
});

describe("securityHeaders: https-only parts", () => {
  it("adds upgrade-insecure-requests and HSTS when siteUrl is https", async () => {
    const build = await load();
    const headers = headerMap(build({ supabaseUrl: SUPABASE, siteUrl: SITE_HTTPS, isDev: false }));
    const directives = parseCsp(headers.get("content-security-policy")!);
    expect(directives.get("upgrade-insecure-requests")).toEqual([]);
    expect(headers.get("strict-transport-security")).toBe("max-age=63072000; includeSubDomains");
    expect(headers.get("strict-transport-security")).not.toContain("preload");
  });

  it("omits upgrade-insecure-requests and HSTS when siteUrl is http", async () => {
    const build = await load();
    const headers = headerMap(
      build({ supabaseUrl: "http://127.0.0.1:54321", siteUrl: SITE_HTTP, isDev: true }),
    );
    const directives = parseCsp(headers.get("content-security-policy")!);
    expect(directives.has("upgrade-insecure-requests")).toBe(false);
    expect(headers.has("strict-transport-security")).toBe(false);
  });
});

describe("securityHeaders: the other headers", () => {
  it("sets the fixed set with exact values", async () => {
    const build = await load();
    const headers = headerMap(build({ supabaseUrl: SUPABASE, siteUrl: SITE_HTTPS, isDev: false }));
    expect(headers.get("x-content-type-options")).toBe("nosniff");
    expect(headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(headers.get("permissions-policy")).toBe(
      "camera=(), microphone=(), geolocation=(), browsing-topics=()",
    );
    expect(headers.get("cross-origin-opener-policy")).toBe("same-origin");
    expect(headers.get("x-frame-options")).toBe("DENY");
  });

  it("returns exactly the planned header names (https)", async () => {
    const build = await load();
    const names = build({ supabaseUrl: SUPABASE, siteUrl: SITE_HTTPS, isDev: false })
      .map((h) => h.key.toLowerCase())
      .sort();
    expect(names).toEqual(
      [
        "content-security-policy",
        "cross-origin-opener-policy",
        "permissions-policy",
        "referrer-policy",
        "strict-transport-security",
        "x-content-type-options",
        "x-frame-options",
      ].sort(),
    );
  });

  it("header values contain no newline", async () => {
    const build = await load();
    for (const { key, value } of build({ supabaseUrl: SUPABASE, siteUrl: SITE_HTTPS, isDev: false })) {
      expect(key).not.toMatch(/[\r\n]/);
      expect(value).not.toMatch(/[\r\n]/);
    }
  });
});

describe("securityHeaders: refuses a bad Supabase URL", () => {
  const bad = [
    "",
    "not a url",
    "ftp://abcdefghijklmnop.supabase.co",
    "javascript:alert(1)",
    "https://a.supabase.co; script-src *",
    "https://a.supabase.co, https://evil.example",
    "https://a.supabase.co https://evil.example",
    "https://a.supabase.co\nhttps://evil.example",
  ];
  for (const supabaseUrl of bad) {
    it(`throws for ${JSON.stringify(supabaseUrl)}`, async () => {
      const build = await load();
      expect(() => build({ supabaseUrl, siteUrl: SITE_HTTPS, isDev: false })).toThrow();
    });
  }

  it("throws for an undefined value", async () => {
    const build = await load();
    expect(() =>
      build({ supabaseUrl: undefined as unknown as string, siteUrl: SITE_HTTPS, isDev: false }),
    ).toThrow();
  });
});

describe("securityHeaders: no Supabase origin (supabaseUrl null, build without env)", () => {
  it("connect-src is exactly 'self' and form-action is self plus github.com", async () => {
    const build = await load();
    const headers = headerMap(build({ supabaseUrl: null, siteUrl: SITE_HTTPS, isDev: false }));
    const directives = parseCsp(headers.get("content-security-policy")!);
    expect(directives.get("connect-src")).toEqual(["'self'"]);
    expect(directives.get("form-action")).toEqual(["'self'", "https://github.com"]);
    expect(directives.get("img-src")).toEqual(["'self'"]);
  });

  it("is never looser: every other directive equals the policy with a Supabase origin", async () => {
    const build = await load();
    const withNull = parseCsp(
      headerMap(build({ supabaseUrl: null, siteUrl: SITE_HTTPS, isDev: false })).get(
        "content-security-policy",
      )!,
    );
    const withUrl = parseCsp(
      headerMap(build({ supabaseUrl: SUPABASE, siteUrl: SITE_HTTPS, isDev: false })).get(
        "content-security-policy",
      )!,
    );
    expect([...withNull.keys()].sort()).toEqual([...withUrl.keys()].sort());
    for (const [name, sources] of withUrl) {
      if (name === "connect-src" || name === "form-action") continue;
      expect(withNull.get(name), name).toEqual(sources);
    }
  });

  it("has no HSTS and no upgrade-insecure-requests for an empty siteUrl", async () => {
    const build = await load();
    const headers = headerMap(build({ supabaseUrl: null, siteUrl: "", isDev: false }));
    expect(headers.has("strict-transport-security")).toBe(false);
    const directives = parseCsp(headers.get("content-security-policy")!);
    expect(directives.has("upgrade-insecure-requests")).toBe(false);
    expect(directives.get("connect-src")).toEqual(["'self'"]);
  });

  it("still throws for empty or invalid strings (only null means none)", async () => {
    const build = await load();
    expect(() => build({ supabaseUrl: "", siteUrl: "", isDev: false })).toThrow();
    expect(() => build({ supabaseUrl: "not a url", siteUrl: "", isDev: false })).toThrow();
  });
});

describe("next.config headers() without public env", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("does not throw and returns the strict policy", async () => {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", undefined);
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", undefined);
    // stubEnv(undefined) deletes the key in vitest 3+; make that explicit for older versions.
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SITE_URL;
    const mod = (await import(CONFIG_PATH)) as {
      default: { headers?: () => Promise<{ source: string; headers: Header[] }[]> };
    };
    const rules = await mod.default.headers!();
    expect(rules).toHaveLength(1);
    const map = headerMap(rules[0]!.headers);
    expect(map.has("strict-transport-security")).toBe(false);
    const directives = parseCsp(map.get("content-security-policy")!);
    expect(directives.get("connect-src")).toEqual(["'self'"]);
    expect(directives.get("form-action")).toEqual(["'self'", "https://github.com"]);
    expect(directives.get("img-src")).toEqual(["'self'"]);
  });
});

describe("next.config headers()", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function loadConfig() {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", SUPABASE);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_abcdefghijklmnopqrstuvwxyz");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", SITE_HTTPS);
    const mod = (await import(CONFIG_PATH)) as {
      default: {
        poweredByHeader?: boolean;
        headers?: () => Promise<{ source: string; headers: Header[] }[]>;
      };
    };
    return mod.default;
  }

  it("keeps poweredByHeader false", async () => {
    expect((await loadConfig()).poweredByHeader).toBe(false);
  });

  it("returns the security headers for /:path* only, built from the env", async () => {
    const config = await loadConfig();
    expect(config.headers).toBeTypeOf("function");
    const rules = await config.headers!();
    expect(rules).toHaveLength(1);
    expect(rules[0]!.source).toBe("/:path*");

    const build = await load();
    const expected = build({ supabaseUrl: SUPABASE, siteUrl: SITE_HTTPS, isDev: false });
    expect(
      [...rules[0]!.headers].sort((a, b) => a.key.localeCompare(b.key)),
    ).toEqual([...expected].sort((a, b) => a.key.localeCompare(b.key)));
  });
});
