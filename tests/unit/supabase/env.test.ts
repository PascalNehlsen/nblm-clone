// publicSupabaseEnv() is the one place the client-exposed Supabase config is
// read. It must stay lazy (a plain `next build` without env vars must not
// throw at import time) and it must refuse to hand back anything that looks
// like a secret/service-role credential, without ever putting that value
// into the thrown error message.
import { afterEach, describe, expect, it, vi } from "vitest";

const MODULE_PATH = "../../../apps/web/lib/supabase/env";

function base64Url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function fakeJwt(role: string): string {
  const header = { alg: "HS256", typ: "JWT" };
  const payload = { role, iss: "supabase-demo", iat: 0, exp: 9999999999 };
  return `${base64Url(header)}.${base64Url(payload)}.signature`;
}

async function freshModule(): Promise<typeof import("../../../apps/web/lib/supabase/env")> {
  vi.resetModules();
  return import(MODULE_PATH);
}

describe("publicSupabaseEnv", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("importing the module does not throw when no env vars are set", async () => {
    vi.unstubAllEnvs();
    await expect(freshModule()).resolves.toBeDefined();
  });

  it("accepts an anon-role JWT as the publishable key", async () => {
    const anonJwt = fakeJwt("anon");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", anonJwt);
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "http://127.0.0.1:3000");
    const { publicSupabaseEnv } = await freshModule();

    const env = publicSupabaseEnv();
    expect(env.url).toBe("http://127.0.0.1:54321");
    expect(env.publishableKey).toBe(anonJwt);
    expect(env.siteUrl).toBe("http://127.0.0.1:3000");
  });

  it("accepts an sb_publishable_ key", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_abcdefghijklmnopqrstuvwxyz");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "http://127.0.0.1:3000");
    const { publicSupabaseEnv } = await freshModule();

    expect(publicSupabaseEnv().publishableKey).toBe("sb_publishable_abcdefghijklmnopqrstuvwxyz");
  });

  it("rejects an sb_secret_ key without leaking it in the error message", async () => {
    const secret = "sb_secret_abcdefghijklmnopqrstuvwxyz";
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", secret);
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "http://127.0.0.1:3000");
    const { publicSupabaseEnv } = await freshModule();

    let thrown: unknown;
    try {
      publicSupabaseEnv();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(String(thrown)).not.toContain(secret);
  });

  it("rejects a service_role JWT without leaking it in the error message", async () => {
    const serviceRoleJwt = fakeJwt("service_role");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", serviceRoleJwt);
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "http://127.0.0.1:3000");
    const { publicSupabaseEnv } = await freshModule();

    let thrown: unknown;
    try {
      publicSupabaseEnv();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(String(thrown)).not.toContain(serviceRoleJwt);
  });

  it("rejects an authenticated-role JWT", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", fakeJwt("authenticated"));
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "http://127.0.0.1:3000");
    const { publicSupabaseEnv } = await freshModule();

    expect(() => publicSupabaseEnv()).toThrow();
  });
});
