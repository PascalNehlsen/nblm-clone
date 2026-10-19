// isPublicPath() decides whether proxy.ts lets a request through without a
// session. It must match exactly: a path that merely starts with a public
// path (e.g. "/login/x") is a different route and must stay protected.
import { describe, expect, it } from "vitest";
import { isPublicPath, PUBLIC_PATHS } from "../../../apps/web/lib/auth/paths";

describe("PUBLIC_PATHS", () => {
  it("is exactly /login, /auth/callback, /api/canary, /api/eval, /impressum and /datenschutz", () => {
    // /api/canary is the release canary entry (ADR 0014, R2); its secret header protects it.
    // /api/eval is the live eval entry; its own secret header protects it the same way.
    // /impressum and /datenschutz are the public legal pages.
    expect(PUBLIC_PATHS).toEqual([
      "/login",
      "/auth/callback",
      "/api/canary",
      "/api/eval",
      "/impressum",
      "/datenschutz",
    ]);
  });
});

describe("isPublicPath: legal pages", () => {
  it("matches /impressum and /datenschutz exactly", () => {
    expect(isPublicPath("/impressum")).toBe(true);
    expect(isPublicPath("/datenschutz")).toBe(true);
  });

  it("keeps everything below or next to them protected", () => {
    expect(isPublicPath("/impressum/x")).toBe(false);
    expect(isPublicPath("/impressum/")).toBe(false);
    expect(isPublicPath("/impressumx")).toBe(false);
    expect(isPublicPath("/datenschutz/x")).toBe(false);
    expect(isPublicPath("/datenschutz/")).toBe(false);
    expect(isPublicPath("/datenschutzx")).toBe(false);
  });
});

describe("isPublicPath: /api/eval", () => {
  it("matches /api/eval exactly", () => {
    expect(isPublicPath("/api/eval")).toBe(true);
  });

  it("keeps everything below or next to it protected, like /api/canary", () => {
    expect(isPublicPath("/api/eval/x")).toBe(false);
    expect(isPublicPath("/api/eval/")).toBe(false);
    expect(isPublicPath("/api/evalx")).toBe(false);
    expect(isPublicPath("/api/canary/x")).toBe(false);
    expect(isPublicPath("/api")).toBe(false);
  });
});

describe("isPublicPath", () => {
  it("matches each public path exactly", () => {
    expect(isPublicPath("/login")).toBe(true);
    expect(isPublicPath("/auth/callback")).toBe(true);
  });

  it("does not match a path that only starts with a public path", () => {
    expect(isPublicPath("/login/x")).toBe(false);
    expect(isPublicPath("/loginx")).toBe(false);
    expect(isPublicPath("/auth/callbackx")).toBe(false);
    expect(isPublicPath("/auth/callback/x")).toBe(false);
  });

  it("does not match unrelated paths", () => {
    expect(isPublicPath("/")).toBe(false);
    expect(isPublicPath("")).toBe(false);
    expect(isPublicPath("/auth")).toBe(false);
  });
});
