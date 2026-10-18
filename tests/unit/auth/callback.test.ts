// New RED test for apps/web/app/auth/callback/route.ts (reviewer finding on
// B1). The callback must: sanitize `next` through safeNextPath before
// building the redirect; always redirect on the configured
// NEXT_PUBLIC_SITE_URL, never the request's own host; redirect to
// /login?fehler=anmeldung on any exchange failure; and never let a redirect
// that may carry a fresh session cookie be cached by a shared cache.
//
// The real Supabase server client is mocked out; this only exercises the
// route's own sanitization/redirect logic.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// See tests/unit/supabase/proxy.test.ts for why this is a relative path into
// apps/web's own node_modules rather than a bare "next/server" specifier.
import { NextRequest } from "../../../apps/web/node_modules/next/server.js";

const hoisted = vi.hoisted(() => ({
  state: {
    exchangeError: null as { message: string } | null,
  },
}));

// Matches the route's own import (apps/web/app/auth/callback/route.ts imports
// `createClient` from "@/lib/supabase/server"). If the "@/" alias is not
// configured for the vitest "unit" project, this whole module fails to
// resolve -- not just this mock -- since the route also imports
// "@/lib/auth/redirect" and "@/lib/supabase/env" the same way.
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: {
      async exchangeCodeForSession() {
        return { error: hoisted.state.exchangeError };
      },
    },
  })),
}));

const MODULE_PATH = "../../../apps/web/app/auth/callback/route";

async function freshModule(): Promise<typeof import("../../../apps/web/app/auth/callback/route")> {
  vi.resetModules();
  return import(MODULE_PATH);
}

function makeRequest(url: string): NextRequest {
  return new NextRequest(url);
}

describe("GET /auth/callback", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_abcdefghijklmnopqrstuvwxyz");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "http://127.0.0.1:3000");
    hoisted.state.exchangeError = null;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("success with next=/notebooks/x redirects to http://127.0.0.1:3000/notebooks/x", async () => {
    const { GET } = await freshModule();
    const request = makeRequest("http://127.0.0.1:3000/auth/callback?code=valid&next=%2Fnotebooks%2Fx");

    const response = await GET(request);

    expect(response.headers.get("location")).toBe("http://127.0.0.1:3000/notebooks/x");
  });

  it("success with next=/.//evil.example redirects to http://127.0.0.1:3000/ (sanitized by safeNextPath)", async () => {
    const { GET } = await freshModule();
    const request = makeRequest(
      `http://127.0.0.1:3000/auth/callback?code=valid&next=${encodeURIComponent("/.//evil.example")}`,
    );

    const response = await GET(request);

    expect(response.headers.get("location")).toBe("http://127.0.0.1:3000/");
  });

  it("a request arriving at host evil.example still redirects to the site URL", async () => {
    const { GET } = await freshModule();
    const request = makeRequest("http://evil.example/auth/callback?code=valid&next=%2Fnotebooks%2Fx");

    const response = await GET(request);

    const location = new URL(response.headers.get("location") ?? "");
    expect(location.origin).toBe("http://127.0.0.1:3000");
    expect(location.pathname).toBe("/notebooks/x");
  });

  it("failure redirects to /login?fehler=anmeldung", async () => {
    hoisted.state.exchangeError = { message: "invalid code" };
    const { GET } = await freshModule();
    const request = makeRequest("http://127.0.0.1:3000/auth/callback?code=invalid&next=%2Fnotebooks%2Fx");

    const response = await GET(request);

    expect(response.headers.get("location")).toBe("http://127.0.0.1:3000/login?fehler=anmeldung");
  });

  it('every response has Cache-Control containing "no-store"', async () => {
    const { GET } = await freshModule();

    const success = await GET(makeRequest("http://127.0.0.1:3000/auth/callback?code=valid&next=%2F"));
    expect(success.headers.get("Cache-Control") ?? "").toContain("no-store");

    hoisted.state.exchangeError = { message: "invalid code" };
    const failure = await GET(makeRequest("http://127.0.0.1:3000/auth/callback?code=invalid"));
    expect(failure.headers.get("Cache-Control") ?? "").toContain("no-store");
  });
});
