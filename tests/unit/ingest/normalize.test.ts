// C1 ingestion (plan approved by Pascal, 2026-10-19). See .git/C1-API-SPEC.md
// ("normalize.ts"): lone surrogates -> U+FFFD, NFC, CRLF/CR -> LF, drop NUL and
// C0/C1 controls except \n and \t, collapse 3+ newlines (with only spaces/tabs
// between) to exactly 2, trim trailing spaces/tabs per line, idempotent.
//
// Pure ASCII source: every non-ASCII character is built with String.fromCharCode
// from a numeric code point, never a typed Unicode glyph or a \u escape literal --
// both of those have been observed to get silently NFC-normalized somewhere between
// this tool and the file on disk, which would quietly turn the "decomposed" NFC
// test input below into the already-composed form and make the test meaningless.
import { describe, expect, it } from "vitest";
import { normalizeText } from "@/lib/server/ingest/normalize";

const A_UMLAUT_PRECOMPOSED = String.fromCharCode(0x00e4); // single code point, NFC
const A_UMLAUT_DECOMPOSED = "a" + String.fromCharCode(0x0308); // "a" + combining diaeresis, NFD
const SHARP_S = String.fromCharCode(0x00df);
const E_UMLAUT = String.fromCharCode(0x00eb);
const REPLACEMENT_CHAR = String.fromCharCode(0xfffd);
const LONE_HIGH_SURROGATE = String.fromCharCode(0xd800);

describe("normalizeText", () => {
  it("converts CRLF and lone CR to LF", () => {
    expect(normalizeText("a\r\nb\rc")).toBe("a\nb\nc");
  });

  it("removes NUL, BEL (code 7) and NEL (code 0x85), but keeps \\t and \\n", () => {
    const input =
      "a" + String.fromCharCode(0x00) + "b" + String.fromCharCode(0x07) + "c" + String.fromCharCode(0x85) + "d\te\nf";
    expect(normalizeText(input)).toBe("abcd\te\nf");
  });

  it("applies NFC: 'a' + combining diaeresis becomes the precomposed a-umlaut", () => {
    expect(A_UMLAUT_DECOMPOSED.length).toBe(2); // sanity: input really is two code units
    expect(A_UMLAUT_DECOMPOSED).not.toBe(A_UMLAUT_PRECOMPOSED);
    expect(normalizeText(A_UMLAUT_DECOMPOSED)).toBe(A_UMLAUT_PRECOMPOSED);
    // Already-composed input is unchanged.
    expect(normalizeText(A_UMLAUT_PRECOMPOSED)).toBe(A_UMLAUT_PRECOMPOSED);
  });

  it("replaces a lone surrogate with U+FFFD", () => {
    const input = `x${LONE_HIGH_SURROGATE}y`;
    expect(normalizeText(input)).toBe(`x${REPLACEMENT_CHAR}y`);
  });

  it("collapses 4 newlines separated only by spaces/tabs into exactly 2", () => {
    const input = "a\n \n\t\n \nb";
    expect(normalizeText(input)).toBe("a\n\nb");
  });

  it("trims trailing spaces and tabs on each line", () => {
    const input = "line1   \nline2\t\t\nline3";
    expect(normalizeText(input)).toBe("line1\nline2\nline3");
  });

  it("is idempotent", () => {
    const messy =
      `Stra${SHARP_S}e\r\n\r\n\r\n  Zeile mit ${String.fromCharCode(0x07)}Kontrolle${String.fromCharCode(0x00)}zeichen${String.fromCharCode(0x85)}und Leerzeichen   \n\n${E_UMLAUT}nde  `;
    const once = normalizeText(messy);
    const twice = normalizeText(once);
    expect(twice).toBe(once);
  });
});
