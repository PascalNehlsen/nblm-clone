// D2 citation validation (spec .git/D2-API-SPEC.md "citations.ts").
import { describe, expect, it } from "vitest";
import { MAX_CITATIONS, MAX_QUOTE_CHARS, validateCitations } from "@/lib/rag/citations";
import type { RetrievedChunk } from "@/lib/rag/retrieve";

function chunk(n: number, content: string): RetrievedChunk {
  return { id: `chunk-${n}`, sourceId: `source-${n}`, ordinal: n, page: null, content, score: 0.9 };
}

const CHUNKS = [chunk(1, "Die Fiktiva GmbH wurde 1999 in Bonn gegründet."), chunk(2, "Der Kaffee schmeckt nach Nuss.")];

describe("constants", () => {
  it("MAX_CITATIONS is 20 and MAX_QUOTE_CHARS is 2000", () => {
    expect(MAX_CITATIONS).toBe(20);
    expect(MAX_QUOTE_CHARS).toBe(2000);
  });
});

describe("validateCitations: marker-shaped text with 3 to 6 digits", () => {
  it("removes [123: \"Bonn\"] and counts it as dropped", () => {
    const r = validateCitations('Text [123: "Bonn"] Ende', [chunk(1, "Die Firma sitzt in Bonn.")]);
    expect(r.text).toBe("Text  Ende");
    expect(r.citations).toEqual([]);
    expect(r.dropped).toBe(1);
  });

  it("still removes [123: ...] when a valid [1: ...] is present", () => {
    const r = validateCitations('A [1: "Bonn"] B [123: "Bonn"] C', [chunk(1, "Die Firma sitzt in Bonn.")]);
    expect(r.text).toBe("A [1] B  C");
    expect(r.citations).toEqual([{ ordinal: 1, chunkId: "chunk-1", quote: "Bonn" }]);
    expect(r.dropped).toBe(1);
  });

  it("removes a 6-digit marker with up to 8 spaces before the quote", () => {
    const r = validateCitations(`A [123456:${" ".repeat(8)}"Bonn"] B`, [chunk(1, "Bonn")]);
    expect(r.text).toBe("A  B");
    expect(r.dropped).toBe(1);
  });
});

describe("validateCitations: marker-shaped text with 7 or more digits", () => {
  it("removes [1234567: \"Bonn\"] next to a valid marker and counts it as dropped", () => {
    const r = validateCitations('A [1: "Bonn"] B [1234567: "Bonn"] C', [chunk(1, "Die Firma sitzt in Bonn.")]);
    expect(r.text).toBe("A [1] B  C");
    expect(r.citations).toEqual([{ ordinal: 1, chunkId: "chunk-1", quote: "Bonn" }]);
    expect(r.dropped).toBe(1);
  });

  it("removes a 30-digit marker", () => {
    const r = validateCitations(`A [${"1".repeat(30)}: "Bonn"] B`, [chunk(1, "Bonn")]);
    expect(r.text).toBe("A  B");
    expect(r.citations).toEqual([]);
    expect(r.dropped).toBe(1);
  });

  it("runs in linear time on [ followed by 200,000 digits without a colon", () => {
    const input = "[" + "1".repeat(200_000);
    const start = performance.now();
    validateCitations(input, CHUNKS);
    expect(performance.now() - start).toBeLessThan(500);
  });
});

describe("validateCitations", () => {
  it("keeps a valid marker and replaces it with [ordinal]", () => {
    const r = validateCitations('Gegründet in Bonn [1: "1999 in Bonn"].', CHUNKS);
    expect(r.text).toBe("Gegründet in Bonn [1].");
    expect(r.citations).toEqual([{ ordinal: 1, chunkId: "chunk-1", quote: "1999 in Bonn" }]);
    expect(r.dropped).toBe(0);
  });

  it("drops n out of range (0, too high, 99)", () => {
    for (const n of [0, 3, 99]) {
      const r = validateCitations(`A [${n}: "Kaffee"] B`, CHUNKS);
      expect(r.citations).toEqual([]);
      expect(r.dropped).toBe(1);
      expect(r.text).not.toContain("[");
    }
  });

  it("drops a quote that is not a substring of the cited chunk, even if it is in another chunk", () => {
    const r = validateCitations('X [1: "Kaffee schmeckt"] Y', CHUNKS);
    expect(r.citations).toEqual([]);
    expect(r.dropped).toBe(1);
    expect(r.text).toBe("X  Y");
  });

  it("does not match a quote over 2000 characters", () => {
    const big = "a".repeat(2001);
    const r = validateCitations(`Z [1: "${big}"]`, [chunk(1, big)]);
    expect(r.citations).toEqual([]);
    expect(r.text).not.toContain(big);
  });

  it("accepts a quote of exactly 2000 characters that is in the chunk", () => {
    const q = "b".repeat(2000);
    const r = validateCitations(`Z [1: "${q}"]`, [chunk(1, `vorne ${q} hinten`)]);
    expect(r.citations).toHaveLength(1);
    expect(r.text).toBe("Z [1]");
  });

  it("caps at 20 distinct citations; the rest count as dropped", () => {
    const content = Array.from({ length: 25 }, (_, i) => `satz${String(i).padStart(2, "0")}`).join(" ");
    const answer = Array.from({ length: 25 }, (_, i) => `[1: "satz${String(i).padStart(2, "0")}"]`).join(" ");
    const r = validateCitations(answer, [chunk(1, content)]);
    expect(r.citations).toHaveLength(20);
    expect(r.citations.map((c) => c.ordinal)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(r.dropped).toBe(5);
    expect(r.text).not.toContain("satz");
  });

  it("the same (chunk, quote) again reuses its ordinal", () => {
    const r = validateCitations('A [1: "Bonn"] B [2: "Nuss"] C [1: "Bonn"]', CHUNKS);
    expect(r.text).toBe("A [1] B [2] C [1]");
    expect(r.citations.map((c) => c.ordinal)).toEqual([1, 2]);
  });

  it("ordinals follow the first appearance, not the chunk number", () => {
    const r = validateCitations('A [2: "Nuss"] B [1: "Bonn"]', CHUNKS);
    expect(r.text).toBe("A [1] B [2]");
    expect(r.citations).toEqual([
      { ordinal: 1, chunkId: "chunk-2", quote: "Nuss" },
      { ordinal: 2, chunkId: "chunk-1", quote: "Bonn" },
    ]);
  });

  it("compares after NFC: explicitly decomposed umlauts in the quote, composed in the chunk", () => {
    const chunkText = "Die Bärenhöhle ist groß.".normalize("NFC");
    const quote = "Bärenhöhle".normalize("NFD");
    expect(quote).not.toBe(quote.normalize("NFC"));
    const r = validateCitations(`X [1: "${quote}"]`, [chunk(1, chunkText)]);
    expect(r.citations).toHaveLength(1);
    expect(r.dropped).toBe(0);
  });

  it("compares after NFC: the reverse (composed quote, decomposed chunk)", () => {
    const chunkText = "Die Bärenhöhle ist groß.".normalize("NFD");
    const quote = "Bärenhöhle".normalize("NFC");
    const r = validateCitations(`X [1: "${quote}"]`, [chunk(1, chunkText)]);
    expect(r.citations).toHaveLength(1);
  });

  it("plain umlaut quote matches", () => {
    const composed = "Die Bärenhöhle ist groß.";
    const decomposedQuote = "Bärenhöhle";
    const r = validateCitations(`X [1: "${decomposedQuote}"]`, [chunk(1, composed)]);
    expect(r.citations).toHaveLength(1);
    expect(r.citations[0]?.chunkId).toBe("chunk-1");
    expect(r.dropped).toBe(0);
  });

  it("removes invalid markers from the text and counts them", () => {
    const r = validateCitations('Eins [1: "Bonn"] zwei [7: "x"] drei [2: "nicht da"].', CHUNKS);
    expect(r.text).toBe("Eins [1] zwei  drei .");
    expect(r.dropped).toBe(2);
  });

  it("text without markers is returned trimmed with no citations", () => {
    const r = validateCitations("  Nur Text.  ", CHUNKS);
    expect(r).toEqual({ text: "Nur Text.", citations: [], dropped: 0 });
  });

  it("allows at most 8 whitespace characters between n: and the quote", () => {
    const bonn = [chunk(1, "Die Fiktiva GmbH wurde 1999 in Bonn gegründet.")];
    const ok = validateCitations("[1:" + " ".repeat(8) + '"Bonn"]', bonn);
    expect(ok.citations).toEqual([{ ordinal: 1, chunkId: "chunk-1", quote: "Bonn" }]);
    const tooMany = validateCitations("[1:" + " ".repeat(9) + '"Bonn"]', bonn);
    expect(tooMany.citations).toEqual([]);
    const huge = validateCitations("[1:" + " ".repeat(3000) + '"Bonn"]', bonn);
    expect(huge.citations).toEqual([]);
  });

  it("an empty or whitespace-only quote is not valid", () => {
    const r = validateCitations('A [1: " "] B', CHUNKS);
    expect(r.citations).toEqual([]);
  });

  it("runs in linear time on a 200 KB adversarial string", () => {
    const inputs = [
      "[1:".repeat(70_000),
      `[1: "${"a".repeat(200_000)}`,
      '[1: "' + 'a"'.repeat(100_000),
      "[1:  ".repeat(40_000) + '"',
    ];
    for (const input of inputs) {
      const start = performance.now();
      validateCitations(input, CHUNKS);
      expect(performance.now() - start).toBeLessThan(500);
    }
  });
});
