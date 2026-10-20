// apps/web/proxy.ts runs the game day fault first: on a match it logs one fixed line,
// returns the 500 and never touches the Supabase session. Otherwise it is unchanged.
// Mocking follows tests/unit/supabase/proxy.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "../../../apps/web/node_modules/next/server.js";

const hoisted = vi.hoisted(() => ({
  createServerClient: vi.fn(() => ({
    auth: {
      async getClaims() {
        return { data: null };
      },
      async getUser() {
        return { data: { user: null }, error: null };
      },
    },
  })),
}));

vi.mock("@supabase/ssr", () => ({ createServerClient: hoisted.createServerClient }));

const SITE_HOST = "app.sec-nblm.dev";

function req(host: string, path: string): NextRequest {
  return new NextRequest(`https://${host}${path}`, { headers: { host } });
}

async function runProxy(request: NextRequest): Promise<Response> {
  vi.resetModules();
  const { proxy } = await import("../../../apps/web/proxy");
  return proxy(request);
}

describe("proxy: game day fault", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_abcdefghijklmnopqrstuvwxyz");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", `https://${SITE_HOST}`);
    hoisted.createServerClient.mockClear();
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    warn.mockRestore();
  });

  it("fault on: 500 with the exact body and headers, no Supabase client, one fixed warning", async () => {
    vi.stubEnv("GAME_DAY_FAULT", "live-login");
    const response = await runProxy(req(SITE_HOST, "/login"));

    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Vorübergehend nicht verfügbar.");
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(hoisted.createServerClient).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]).toEqual(["game day fault: live-login"]);
  });

  it("flag unset: normal behaviour (session refresh runs), no log", async () => {
    vi.stubEnv("GAME_DAY_FAULT", "");
    const response = await runProxy(req(SITE_HOST, "/login"));

    expect(response.status).toBe(200);
    expect(hoisted.createServerClient).toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("flag set but a staged *.vercel.app host: normal behaviour, no log", async () => {
    vi.stubEnv("GAME_DAY_FAULT", "live-login");
    const response = await runProxy(req("abc.vercel.app", "/login"));

    expect(response.status).not.toBe(500);
    expect(hoisted.createServerClient).toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('flag set, site host, but path "/": normal behaviour (redirect to login), no log', async () => {
    vi.stubEnv("GAME_DAY_FAULT", "live-login");
    const response = await runProxy(req(SITE_HOST, "/"));

    expect(response.status).toBeGreaterThanOrEqual(300);
    expect(response.status).toBeLessThan(400);
    expect(hoisted.createServerClient).toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});
