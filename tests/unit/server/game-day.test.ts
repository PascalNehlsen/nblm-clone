// Game day fault injection (live-login): a pure, server-only decision function plus the
// fixed 500 response. The fault fires only when the env flag is exactly "live-login", the
// path is exactly "/login" and the request host equals the configured site host, so a
// staged *.vercel.app deployment can never trip it.
import { describe, expect, it } from "vitest";
import * as gameDay from "../../../apps/web/lib/server/game-day";

const SITE = "https://app.sec-nblm.dev";

function fault(over: Partial<Parameters<typeof gameDay.gameDayFault>[0]> = {}): boolean {
  return gameDay.gameDayFault({
    env: "live-login",
    siteUrl: SITE,
    host: "app.sec-nblm.dev",
    pathname: "/login",
    ...over,
  });
}

describe("gameDayFault: the env flag must match exactly", () => {
  it.each([undefined, "", "true", "LIVE-LOGIN", "live-login ", " live-login", "live-logi"])(
    "env %j -> false",
    (env) => {
      expect(fault({ env })).toBe(false);
    },
  );

  it("env live-login, site host, /login -> true", () => {
    expect(fault()).toBe(true);
  });
});

describe("gameDayFault: host", () => {
  it("a staged *.vercel.app host -> false", () => {
    expect(fault({ host: "abc.vercel.app" })).toBe(false);
  });

  it("host case and port are ignored", () => {
    expect(fault({ host: "APP.sec-nblm.dev:443" })).toBe(true);
    expect(fault({ host: "App.Sec-Nblm.Dev" })).toBe(true);
  });

  it("a host that merely contains the site host is not the site host", () => {
    expect(fault({ host: "app.sec-nblm.dev.evil.example" })).toBe(false);
    expect(fault({ host: "evilapp.sec-nblm.dev" })).toBe(false);
  });

  it("host null -> false", () => {
    expect(fault({ host: null })).toBe(false);
  });

  it("an empty host -> false", () => {
    expect(fault({ host: "" })).toBe(false);
  });
});

describe("gameDayFault: path", () => {
  it.each(["/", "/login/x", "/auth/callback", "/LOGIN", "/login/", "/loginx", ""])(
    "path %j -> false",
    (pathname) => {
      expect(fault({ pathname })).toBe(false);
    },
  );
});

describe("gameDayFault: siteUrl is missing or invalid", () => {
  it.each([undefined, "", "not a url"])("siteUrl %j -> false and does not throw", (siteUrl) => {
    expect(() => fault({ siteUrl })).not.toThrow();
    expect(fault({ siteUrl })).toBe(false);
  });
});

describe("the fixed fault response", () => {
  function make(): Response {
    const mod = gameDay as unknown as {
      gameDayResponse?: () => Response;
      GAME_DAY_RESPONSE?: Response;
    };
    if (typeof mod.gameDayResponse === "function") return mod.gameDayResponse();
    if (mod.GAME_DAY_RESPONSE) return mod.GAME_DAY_RESPONSE.clone();
    throw new Error("game-day.ts must export gameDayResponse() or GAME_DAY_RESPONSE");
  }

  it("is a 500 with the exact German body and no-store plain text headers", async () => {
    const response = make();
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Vorübergehend nicht verfügbar.");
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
