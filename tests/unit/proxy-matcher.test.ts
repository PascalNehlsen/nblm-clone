// apps/web/proxy.ts must not run the auth check against Next's static/image
// optimizer assets or the favicon, or every page load would pay for a
// session refresh on every chunk. config.matcher encodes that exclusion as a
// path-to-regexp/regex pattern; this test exercises it against sample paths
// instead of asserting on the literal pattern string.
import { describe, expect, it } from "vitest";
import { config } from "../../apps/web/proxy";

// Next compiles middleware/proxy matcher patterns to a full-path match (via
// path-to-regexp), so a plain `new RegExp(pattern)` here would be unanchored
// and could match a substring that happens to start after the negative
// lookahead (e.g. the second "/" in "/_next/static/..."). Anchoring with
// ^(?:...)$ reproduces that full-path semantics for the test.
function matchesAnyPattern(pathname: string): boolean {
  return config.matcher.some((pattern) => new RegExp(`^(?:${pattern})$`).test(pathname));
}

describe("apps/web/proxy.ts: config.matcher", () => {
  it("is a non-empty array of string patterns", () => {
    expect(Array.isArray(config.matcher)).toBe(true);
    expect(config.matcher.length).toBeGreaterThan(0);
    for (const pattern of config.matcher) {
      expect(typeof pattern).toBe("string");
    }
  });

  it("excludes Next.js static assets (_next/static)", () => {
    expect(matchesAnyPattern("/_next/static/chunks/main.js")).toBe(false);
  });

  it("excludes the Next.js image optimizer path (_next/image)", () => {
    expect(matchesAnyPattern("/_next/image")).toBe(false);
  });

  it("excludes favicon.ico", () => {
    expect(matchesAnyPattern("/favicon.ico")).toBe(false);
  });

  it("excludes static image files", () => {
    expect(matchesAnyPattern("/logo.svg")).toBe(false);
    expect(matchesAnyPattern("/images/cover.png")).toBe(false);
    expect(matchesAnyPattern("/images/cover.jpg")).toBe(false);
  });

  it("still matches ordinary app routes", () => {
    expect(matchesAnyPattern("/")).toBe(true);
    expect(matchesAnyPattern("/login")).toBe(true);
    expect(matchesAnyPattern("/notebooks/abc")).toBe(true);
    expect(matchesAnyPattern("/auth/callback")).toBe(true);
  });
});
