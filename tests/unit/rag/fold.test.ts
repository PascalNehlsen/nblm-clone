// Fold for the citation check (ADR 0016): NFC, then one pass that maps whitespace, quote,
// dash, ellipsis and sharp-s variants to one form and keeps start/end maps back to the source.
// Every special character is written as a \u escape so no editor can merge or alter it.
import { describe, expect, it } from "vitest";
import { fold } from "@/lib/rag/fold";

const arr = (a: Int32Array) => Array.from(a);
const hex = (ch: string) => `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;
const cps = (list: number[]) => list.map((n) => String.fromCodePoint(n));

const SS = String.fromCodePoint(0xdf);
const CAP_SS = String.fromCodePoint(0x1e9e);
const AUML = String.fromCodePoint(0xe4);
const AE_UP = String.fromCodePoint(0xc4);
const ELL = String.fromCodePoint(0x2026);

describe("fold: shape", () => {
  it("returns text plus Int32Array maps of the same length as the text", () => {
    const r = fold(`Hallo da${SS}${ELL}`);
    expect(r.start).toBeInstanceOf(Int32Array);
    expect(r.end).toBeInstanceOf(Int32Array);
    expect(r.start).toHaveLength(r.text.length);
    expect(r.end).toHaveLength(r.text.length);
  });

  it("plain text is unchanged with identity maps", () => {
    const r = fold("abc");
    expect(r.text).toBe("abc");
    expect(arr(r.start)).toEqual([0, 1, 2]);
    expect(arr(r.end)).toEqual([1, 2, 3]);
  });

  it("empty input gives empty output", () => {
    const r = fold("");
    expect(r.text).toBe("");
    expect(r.start).toHaveLength(0);
    expect(r.end).toHaveLength(0);
  });

  it("is case-sensitive and keeps diacritics", () => {
    const s = `Hexe B${AUML}r ${AE_UP}pfel`;
    expect(fold(s).text).toBe(s);
  });

  it("does not trim", () => {
    expect(fold(" a ").text).toBe(" a ");
  });
});

describe("fold: NFC first", () => {
  it("composes a decomposed umlaut and maps against the NFC string", () => {
    const decomposed = "äb";
    const input = decomposed.normalize("NFD");
    expect(input).toHaveLength(3);
    const r = fold(input);
    expect(r.text).toBe(`${AUML}b`);
    expect(arr(r.start)).toEqual([0, 1]);
    expect(arr(r.end)).toEqual([1, 2]);
  });
});

describe("fold: whitespace", () => {
  const spaces = cps([
    0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680,
    0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a,
    0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
  ]);
  for (const ch of spaces) {
    it(`${hex(ch)} becomes one space`, () => {
      expect(fold(`a${ch}b`).text).toBe("a b");
    });
  }

  it("a mixed run collapses to one space whose bounds cover the whole run", () => {
    const r = fold("a \t\n b");
    expect(r.text).toBe("a b");
    expect(arr(r.start)).toEqual([0, 1, 5]);
    expect(arr(r.end)).toEqual([1, 5, 6]);
  });

  it("a leading and a trailing run each become one space", () => {
    expect(fold("  a\n\n").text).toBe(" a ");
  });
});

describe("fold: removed characters", () => {
  for (const ch of cps([0xad, 0x200b, 0x200c, 0x200d, 0x2060, 0xfeff])) {
    it(`${hex(ch)} is removed`, () => {
      expect(fold(`a${ch}b`).text).toBe("ab");
    });
  }

  it("the maps skip the removed character", () => {
    const r = fold(`a${String.fromCodePoint(0xad)}b`);
    expect(r.text).toBe("ab");
    expect(arr(r.start)).toEqual([0, 2]);
    expect(arr(r.end)).toEqual([1, 3]);
  });
});

describe("fold: quotes and apostrophes", () => {
  const quotes = cps([
    0x22, 0x27, 0x60, 0xab, 0xb4, 0xbb,
    0x2018, 0x2019, 0x201a, 0x201b, 0x201c, 0x201d, 0x201e, 0x201f,
    0x2032, 0x2033, 0x2039, 0x203a,
  ]);
  for (const ch of quotes) {
    it(`${hex(ch)} becomes '`, () => {
      expect(fold(`a${ch}b`).text).toBe("a'b");
    });
  }
});

describe("fold: dashes, ellipsis, sharp s", () => {
  for (const ch of cps([0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2015, 0x2212])) {
    it(`${hex(ch)} becomes -`, () => {
      expect(fold(`a${ch}b`).text).toBe("a-b");
    });
  }

  it("the ellipsis becomes three dots, all with the bounds of the one character", () => {
    const r = fold(`a${ELL}b`);
    expect(r.text).toBe("a...b");
    expect(arr(r.start)).toEqual([0, 1, 1, 1, 2]);
    expect(arr(r.end)).toEqual([1, 2, 2, 2, 3]);
  });

  it("the sharp s becomes ss, both units with the bounds of the character", () => {
    const r = fold(`Fu${SS}!`);
    expect(r.text).toBe("Fuss!");
    expect(arr(r.start)).toEqual([0, 1, 2, 2, 3]);
    expect(arr(r.end)).toEqual([1, 2, 3, 3, 4]);
  });

  it("the capital sharp s becomes SS", () => {
    const r = fold(`FU${CAP_SS}`);
    expect(r.text).toBe("FUSS");
    expect(arr(r.start)).toEqual([0, 1, 2, 2]);
    expect(arr(r.end)).toEqual([1, 2, 3, 3]);
  });
});

describe("fold: surrogate pairs", () => {
  it("an astral character is one source character: both units share its bounds", () => {
    const r = fold("a\u{1f600}b");
    expect(r.text).toBe("a\u{1f600}b");
    expect(arr(r.start)).toEqual([0, 1, 1, 3]);
    expect(arr(r.end)).toEqual([1, 3, 3, 4]);
  });
});
