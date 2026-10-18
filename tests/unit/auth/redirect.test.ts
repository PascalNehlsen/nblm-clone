// safeNextPath() is the sanitizer that stands between an attacker-controlled
// `next` query parameter (shared in a phishing link, or round-tripped through
// /auth/callback) and a client-side redirect. Anything that is not clearly a
// same-origin, same-app path must fall back to "/".
import { describe, expect, it } from "vitest";
import { safeNextPath } from "../../../apps/web/lib/auth/redirect";

describe("safeNextPath: accepted same-origin paths are returned unchanged", () => {
  const accepted = ["/", "/notebooks/abc?x=1", "/a#b"];

  for (const raw of accepted) {
    it(`keeps ${JSON.stringify(raw)}`, () => {
      expect(safeNextPath(raw)).toBe(raw);
    });
  }
});

describe("safeNextPath: falls back to \"/\" for anything unsafe or malformed", () => {
  const longPath = "/" + "a".repeat(512); // 513 chars, over the 512 limit

  const rejectedStrings = [
    "//evil.example",
    "/\\evil.example",
    "\\/evil",
    "https://evil.example",
    "javascript:alert(1)",
    "/%2F%2Fevil",
    "/%2fevil",
    "/%5Cevil",
    "/a\tb",
    "/a\nb",
    "/a b",
    "",
    longPath,
    // Dot-segment normalization: `new URL(raw, base)` collapses "/." and
    // "/.." *before* the leading-slash/origin check runs its course, so each
    // of these resolves to "//evil.example" -- a protocol-relative URL whose
    // origin becomes evil.example once a browser (or the callback route)
    // actually navigates to it. Checking url.origin after construction is
    // too late if the raw string was never rejected for containing a
    // dot-segment in the first place.
    "/.//evil.example",
    "/..//evil.example",
    "/%2e%2e//evil.example",
    "/a/..//evil.example",
    // "/%2e/%2fevil" decodes its *second* segment's encoded slash only after
    // the (single) dot-segment in front of it is resolved away, so a check
    // that only looks for a literal "%2f" immediately after the leading "/"
    // can miss it.
    "/%2e/%2fevil",
  ];

  for (const raw of rejectedStrings) {
    it(`rejects ${JSON.stringify(raw)}`, () => {
      expect(safeNextPath(raw)).toBe("/");
    });
  }

  it("rejects undefined", () => {
    expect(safeNextPath(undefined)).toBe("/");
  });

  it("rejects a number", () => {
    expect(safeNextPath(42)).toBe("/");
  });

  it("property: no output for any string in this file's test lists ever starts with \"//\" or \"/\\\\\"", () => {
    const accepted = ["/", "/notebooks/abc?x=1", "/a#b"];
    for (const raw of [...accepted, ...rejectedStrings]) {
      const result = safeNextPath(raw);
      expect(result.startsWith("//")).toBe(false);
      expect(result.startsWith("/\\")).toBe(false);
    }
  });
});
