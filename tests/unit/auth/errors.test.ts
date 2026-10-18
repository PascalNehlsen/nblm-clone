// loginErrorMessage() turns the `fehler` query code on /login into fixed
// German copy. It must never echo whatever code was actually passed in: an
// unknown or crafted code (e.g. from a tampered link) always yields null, not
// a reflected string.
import { describe, expect, it } from "vitest";
import { loginErrorMessage } from "../../../apps/web/lib/auth/errors";

describe("loginErrorMessage: known codes", () => {
  it("returns a non-empty German string for \"anmeldung\"", () => {
    const message = loginErrorMessage("anmeldung");
    expect(typeof message).toBe("string");
    expect((message as string).trim().length).toBeGreaterThan(0);
    expect(message).not.toContain("—"); // no em dash, per AGENTS.md
  });

  it("returns a non-empty German string for \"abgemeldet\"", () => {
    const message = loginErrorMessage("abgemeldet");
    expect(typeof message).toBe("string");
    expect((message as string).trim().length).toBeGreaterThan(0);
    expect(message).not.toContain("—");
  });

  it("the two known codes map to different messages", () => {
    expect(loginErrorMessage("anmeldung")).not.toBe(loginErrorMessage("abgemeldet"));
  });
});

describe("loginErrorMessage: unknown input gives null, never an echo", () => {
  const unknown: unknown[] = [
    "<script>alert(1)</script>",
    "x".repeat(5000),
    "ANMELDUNG",
    "Anmeldung",
    "anmeldungx",
    "",
    null,
    undefined,
    42,
    {},
    [],
  ];

  for (const code of unknown) {
    it(`returns null for ${JSON.stringify(code)}`, () => {
      expect(loginErrorMessage(code)).toBeNull();
    });
  }

  it("never contains the raw input value in its output", () => {
    const marker = "unique-marker-zzz-123-<script>";
    expect(loginErrorMessage(marker)).toBeNull();
  });
});
