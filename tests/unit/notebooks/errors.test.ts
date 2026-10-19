// notebookErrorMessage() turns a Postgres/PostgREST error code from the
// notebooks/membership actions into fixed German copy, the same house style
// as apps/web/lib/auth/errors.ts (see tests/unit/auth/errors.test.ts): never
// echo the raw input, no em dash (AGENTS.md), and every known code reads as
// its own distinct, non-empty sentence.
import { describe, expect, it } from "vitest";
import { notebookErrorMessage } from "@/lib/notebooks/errors";

const KNOWN_CODES = ["42501", "23503", "23505", "P0001"] as const;

describe("notebookErrorMessage: known codes", () => {
  for (const code of KNOWN_CODES) {
    it(`returns a non-empty German string for "${code}", with no em dash`, () => {
      const message = notebookErrorMessage(code);
      expect(typeof message).toBe("string");
      expect(message.trim().length).toBeGreaterThan(0);
      expect(message).not.toContain("—");
    });
  }

  it("every known code maps to a distinct message", () => {
    const messages = KNOWN_CODES.map((code) => notebookErrorMessage(code));
    expect(new Set(messages).size).toBe(KNOWN_CODES.length);
  });

  it('"42501" reads as a permission error (keine Berechtigung)', () => {
    expect(notebookErrorMessage("42501").toLowerCase()).toContain("berechtigung");
  });

  it('"23503" reads as an unknown user id (Nutzer-ID unbekannt)', () => {
    const message = notebookErrorMessage("23503").toLowerCase();
    expect(message).toContain("nutzer");
    expect(message).toContain("unbekannt");
  });

  it('"23505" reads as already a member (schon Mitglied)', () => {
    expect(notebookErrorMessage("23505").toLowerCase()).toContain("mitglied");
  });

  it('"P0001" reads as needing at least one owner (mindestens einen Eigentümer)', () => {
    const message = notebookErrorMessage("P0001").toLowerCase();
    expect(message).toContain("eigentümer");
  });
});

describe("notebookErrorMessage: removal confirmation codes", () => {
  it('"bestaetigung_quelle" asks to confirm removing the source', () => {
    expect(notebookErrorMessage("bestaetigung_quelle")).toBe(
      "Bitte bestätige, dass du die Quelle entfernen möchtest.",
    );
  });

  it('"bestaetigung_mitglied" asks to confirm removing the member', () => {
    expect(notebookErrorMessage("bestaetigung_mitglied")).toBe(
      "Bitte bestätige, dass du das Mitglied entfernen möchtest.",
    );
  });
});

describe("notebookErrorMessage: unknown input gets one generic message, never an echo", () => {
  const unknownCodes: unknown[] = [
    "99999",
    "",
    null,
    undefined,
    42,
    {},
    [],
    "<script>alert(1)</script>",
  ];

  it("returns a non-empty generic string, distinct from every known message, for any unknown code", () => {
    const known = new Set(KNOWN_CODES.map((code) => notebookErrorMessage(code)));
    for (const code of unknownCodes) {
      const message = notebookErrorMessage(code);
      expect(typeof message).toBe("string");
      expect(message.trim().length).toBeGreaterThan(0);
      expect(known.has(message)).toBe(false);
    }
  });

  it("every unknown code maps to the same generic message", () => {
    const messages = unknownCodes.map((code) => notebookErrorMessage(code));
    expect(new Set(messages).size).toBe(1);
  });

  it("never contains the raw input value in its output", () => {
    const marker = "unique-marker-zzz-456-<script>";
    expect(notebookErrorMessage(marker)).not.toContain(marker);
  });

  it("the generic message has no em dash", () => {
    expect(notebookErrorMessage("totally-unknown-code")).not.toContain("—");
  });
});
