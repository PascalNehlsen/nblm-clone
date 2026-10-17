// assertAnonKey() is the single gate clients.ts must run every anon/publishable
// key through before it is used against the local Supabase stack -- both the
// one from SUPABASE_ANON_KEY and the one read out of `supabase status -o env`.
// It must accept exactly an anon JWT or a publishable key, reject everything
// else (in particular anything that can bypass RLS: a secret key or a
// service_role/authenticated JWT), and never put the rejected value into its
// error message -- the whole point is that a secret must never be echoed back
// into test output or logs.
//
// JWTs here are built locally and are never signed (signature segment "x"):
// assertAnonKey only needs to read the payload's `role` claim, never verify a
// signature, so a real secret is never needed to exercise it.
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertAnonKey } from "./helpers/key-guard";

/** Minimal local base64url encoder -- no padding, `+`/`/` swapped for `-`/`_`,
 * matching how JWT segments are actually encoded. */
function base64UrlEncode(input: string): string {
  return Buffer.from(input, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function buildJwt(payload: Record<string, unknown>): string {
  const header = { alg: "HS256", typ: "JWT" };
  return [base64UrlEncode(JSON.stringify(header)), base64UrlEncode(JSON.stringify(payload)), "x"].join(
    ".",
  );
}

/** Asserts assertAnonKey rejects `key`, and that the thrown message never
 * contains the rejected value itself. */
function expectRejectedWithoutLeaking(key: string): void {
  let thrown: unknown;
  try {
    assertAnonKey(key);
  } catch (error) {
    thrown = error;
  }

  expect(thrown, `expected assertAnonKey to reject ${JSON.stringify(key)}`).toBeInstanceOf(Error);
  const message = (thrown as Error).message;
  if (key !== "") {
    expect(message.includes(key), `thrown message must not contain the rejected key: ${message}`).toBe(
      false,
    );
  }
}

describe("assertAnonKey: accepted", () => {
  it("accepts a JWT whose payload role is anon", () => {
    expect(() => assertAnonKey(buildJwt({ role: "anon" }))).not.toThrow();
  });

  it("accepts a publishable key", () => {
    expect(() => assertAnonKey("sb_publishable_abcdefghijklmnopqrstuvwxyz")).not.toThrow();
  });

  it("accepts an anon JWT that carries extra, unrelated claims", () => {
    expect(() =>
      assertAnonKey(
        buildJwt({
          role: "anon",
          iss: "supabase-demo",
          sub: "11111111-1111-1111-1111-111111111111",
          aud: "authenticated",
          exp: 9999999999,
          iat: 1700000000,
          extra_claim: "whatever a future Supabase version adds",
        }),
      ),
    ).not.toThrow();
  });
});

describe("assertAnonKey: rejected", () => {
  it("rejects a secret key", () => {
    expectRejectedWithoutLeaking("sb_secret_abcdefghijklmnopqrstuvwxyz");
  });

  it("rejects a JWT with role service_role", () => {
    expectRejectedWithoutLeaking(buildJwt({ role: "service_role" }));
  });

  it("rejects a JWT with role authenticated", () => {
    expectRejectedWithoutLeaking(buildJwt({ role: "authenticated" }));
  });

  it("rejects a JWT with no role claim at all", () => {
    expectRejectedWithoutLeaking(buildJwt({ sub: "11111111-1111-1111-1111-111111111111" }));
  });

  it("rejects a malformed string with no dot segments", () => {
    expectRejectedWithoutLeaking("not-a-jwt-or-publishable-key");
  });

  it("rejects a string with only two dot segments", () => {
    expectRejectedWithoutLeaking(`${base64UrlEncode(JSON.stringify({ alg: "HS256" }))}.x`);
  });

  it("rejects a three-segment string whose payload segment is not valid base64url JSON", () => {
    expectRejectedWithoutLeaking(`${base64UrlEncode(JSON.stringify({ alg: "HS256" }))}.not-json.x`);
  });

  it("rejects the empty string", () => {
    expectRejectedWithoutLeaking("");
  });

  it("rejects an uppercase SB_SECRET_ prefix (the accepted shapes are case-sensitive)", () => {
    expectRejectedWithoutLeaking("SB_SECRET_abcdefghijklmnopqrstuvwxyz");
  });

  it("rejects a secret key with leading/trailing whitespace", () => {
    expectRejectedWithoutLeaking(" sb_secret_abcdefghijklmnopqrstuvwxyz ");
  });
});

describe("supabaseLocalConfig integration with assertAnonKey", () => {
  const originalUrl = process.env.SUPABASE_URL;
  const originalAnonKey = process.env.SUPABASE_ANON_KEY;

  afterEach(() => {
    if (originalUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = originalUrl;

    if (originalAnonKey === undefined) delete process.env.SUPABASE_ANON_KEY;
    else process.env.SUPABASE_ANON_KEY = originalAnonKey;

    // Each test below needs a fresh module instance: clients.ts caches its
    // config at module scope after the first call, which would otherwise let
    // one test's env leak into the next test's result.
    vi.resetModules();
  });

  it("throws when SUPABASE_ANON_KEY is a service_role JWT", async () => {
    vi.resetModules();
    process.env.SUPABASE_URL = "http://127.0.0.1:54321";
    process.env.SUPABASE_ANON_KEY = buildJwt({ role: "service_role" });

    const { supabaseLocalConfig } = await import("./helpers/clients");
    expect(() => supabaseLocalConfig()).toThrow();
  });

  it("does not throw when SUPABASE_ANON_KEY is a publishable key", async () => {
    vi.resetModules();
    process.env.SUPABASE_URL = "http://127.0.0.1:54321";
    process.env.SUPABASE_ANON_KEY = "sb_publishable_abcdefghijklmnopqrstuvwxyz";

    const { supabaseLocalConfig } = await import("./helpers/clients");
    expect(() => supabaseLocalConfig()).not.toThrow();
  });
});

// clients.ts falls back to `supabase status -o env` (via node:child_process's
// execFileSync) whenever SUPABASE_URL/SUPABASE_ANON_KEY are not both set. That
// path must run through assertAnonKey() exactly like the env-provided key
// does -- a local `supabase status` returning an admin credential (e.g. a
// stale/misconfigured CLI config) must not silently become the key this
// harness signs real users in with.
describe("supabaseLocalConfig integration with assertAnonKey: the `supabase status` CLI path", () => {
  const originalUrl = process.env.SUPABASE_URL;
  const originalAnonKey = process.env.SUPABASE_ANON_KEY;

  afterEach(() => {
    if (originalUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = originalUrl;

    if (originalAnonKey === undefined) delete process.env.SUPABASE_ANON_KEY;
    else process.env.SUPABASE_ANON_KEY = originalAnonKey;

    vi.doUnmock("node:child_process");
    vi.resetModules();
  });

  it("throws when the CLI reports a service_role JWT as ANON_KEY, without leaking it", async () => {
    vi.resetModules();
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_ANON_KEY;

    const serviceRoleJwt = buildJwt({ role: "service_role" });
    vi.doMock("node:child_process", () => ({
      execFileSync: () => `API_URL="http://127.0.0.1:54321"\nANON_KEY="${serviceRoleJwt}"\n`,
    }));

    const { supabaseLocalConfig } = await import("./helpers/clients");

    let thrown: unknown;
    try {
      supabaseLocalConfig();
    } catch (error) {
      thrown = error;
    }

    expect(thrown, "expected supabaseLocalConfig() to reject a CLI-provided service_role key").toBeInstanceOf(
      Error,
    );
    expect(
      (thrown as Error).message.includes(serviceRoleJwt),
      "thrown message must not contain the rejected key",
    ).toBe(false);
  });

  it("does not throw when the CLI reports an anon JWT as ANON_KEY", async () => {
    vi.resetModules();
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_ANON_KEY;

    const anonJwt = buildJwt({ role: "anon" });
    vi.doMock("node:child_process", () => ({
      execFileSync: () => `API_URL="http://127.0.0.1:54321"\nANON_KEY="${anonJwt}"\n`,
    }));

    const { supabaseLocalConfig } = await import("./helpers/clients");
    expect(() => supabaseLocalConfig()).not.toThrow();
  });
});
