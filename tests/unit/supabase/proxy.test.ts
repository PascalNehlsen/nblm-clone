// Reviewer finding on B1: apps/web/lib/supabase/proxy.ts's updateSession()
// must (a) forward the cache-control headers @supabase/ssr asks it to set
// whenever it writes a refreshed auth cookie -- a CDN/reverse proxy that
// caches that response could serve one user's session to another -- and (b)
// always redirect to the configured NEXT_PUBLIC_SITE_URL origin, never to
// whatever host the incoming request happens to carry (a request behind a
// misconfigured proxy, or a crafted Host header, must not be able to steer
// the login redirect to another origin).
//
// @supabase/ssr itself is mocked: the real client talks to the network, this
// test only needs to prove that updateSession's `cookies.setAll` bridge
// faithfully carries whatever cookies *and* headers the SDK hands it through
// to the actual NextResponse, and that the redirect target is pinned to the
// configured site origin.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// "next" is only a dependency of the apps/web workspace package (pnpm keeps
// workspace node_modules isolated), so a bare `from "next/server"` does not
// resolve from a test file under tests/unit/. The module under test lives
// inside apps/web and resolves "next/server" just fine from there; this
// relative path reaches the exact same real, installed file.
import { NextRequest } from "../../../apps/web/node_modules/next/server.js";

interface CookieToSet {
  name: string;
  value: string;
  options: Record<string, unknown>;
}

const hoisted = vi.hoisted(() => ({
  state: {
    claims: null as Record<string, unknown> | null,
  },
  // @supabase/ssr 0.12.7 writes more than one cookie per refresh (e.g. the
  // auth token and a PKCE code verifier), and it calls `setAll` once per
  // write within the same auth operation -- see CookieMethodsServer.setAll's
  // own docs: "This object is empty on later calls from the same client."
  // Only the *first* call carries the cache-control headers; the proxy must
  // still end up with every cookie and the headers in the final response.
  cookieA: { name: "sb-test-auth-token", value: "cookie-a-value" },
  cookieB: { name: "sb-test-auth-token-code-verifier", value: "cookie-b-value" },
  cacheHeaders: {
    "Cache-Control": "private, no-cache, no-store, must-revalidate, max-age=0",
    Expires: "0",
    Pragma: "no-cache",
  },
}));

vi.mock("@supabase/ssr", () => ({
  createServerClient: vi.fn(
    (
      _url: string,
      _key: string,
      options: { cookies: { setAll: (cookies: CookieToSet[], headers: Record<string, string>) => void } },
    ) => ({
      auth: {
        async getClaims() {
          options.cookies.setAll([{ name: hoisted.cookieA.name, value: hoisted.cookieA.value, options: {} }], hoisted.cacheHeaders);
          options.cookies.setAll([{ name: hoisted.cookieB.name, value: hoisted.cookieB.value, options: {} }], {});
          return { data: hoisted.state.claims ? { claims: hoisted.state.claims } : null };
        },
      },
    }),
  ),
}));

const MODULE_PATH = "../../../apps/web/lib/supabase/proxy";

async function freshModule(): Promise<typeof import("../../../apps/web/lib/supabase/proxy")> {
  vi.resetModules();
  return import(MODULE_PATH);
}

function expectCacheHeaders(response: Response): void {
  expect(response.headers.get("Cache-Control")).toBe(hoisted.cacheHeaders["Cache-Control"]);
  expect(response.headers.get("Expires")).toBe(hoisted.cacheHeaders.Expires);
  expect(response.headers.get("Pragma")).toBe(hoisted.cacheHeaders.Pragma);
}

function expectBothCookies(response: { cookies: { get: (name: string) => { value: string } | undefined } }): void {
  expect(response.cookies.get(hoisted.cookieA.name)?.value).toBe(hoisted.cookieA.value);
  expect(response.cookies.get(hoisted.cookieB.name)?.value).toBe(hoisted.cookieB.value);
}

describe("updateSession: refreshed-cookie cache headers and site-pinned redirects", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_abcdefghijklmnopqrstuvwxyz");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "http://127.0.0.1:3000");
    hoisted.state.claims = null;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('(a) with claims on "/": the response carries both refreshed cookies and the three cache headers', async () => {
    hoisted.state.claims = { sub: "user-1" };
    const { updateSession } = await freshModule();

    const request = new NextRequest("http://127.0.0.1:3000/");
    const response = await updateSession(request);

    expectBothCookies(response);
    expectCacheHeaders(response);
  });

  it('(b) without claims on "/x": redirects to /login?next=%2Fx, carrying both refreshed cookies and cache headers', async () => {
    hoisted.state.claims = null;
    const { updateSession } = await freshModule();

    const request = new NextRequest("http://127.0.0.1:3000/x");
    const response = await updateSession(request);

    expect(response.status).toBeGreaterThanOrEqual(300);
    expect(response.status).toBeLessThan(400);

    const location = new URL(response.headers.get("location") ?? "", "http://127.0.0.1:3000");
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("next")).toBe("/x");

    expectBothCookies(response);
    expectCacheHeaders(response);
  });

  it("(c) the redirect Location's origin is NEXT_PUBLIC_SITE_URL even if the request URL has another host", async () => {
    hoisted.state.claims = null;
    const { updateSession } = await freshModule();

    const request = new NextRequest("http://evil.example/x");
    const response = await updateSession(request);

    const location = new URL(response.headers.get("location") ?? "", "http://127.0.0.1:3000");
    expect(location.origin).toBe("http://127.0.0.1:3000");
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("next")).toBe("/x");
  });
});
