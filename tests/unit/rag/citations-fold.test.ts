// Folded citation matching (ADR 0016): the model's quote may differ from the chunk in spelling
// of whitespace, quotes, dashes and ss/sharp-s. The stored quote is always the original chunk
// span, so the highlight and the exact-substring rule for stored data keep holding.
// Special characters are built with String.fromCodePoint so no editor can alter them.
import { describe, expect, it } from "vitest";
import { highlight } from "@/lib/chat/passage";
import { MAX_CITATIONS, MAX_QUOTE_CHARS, validateCitations } from "@/lib/rag/citations";
import type { RetrievedChunk } from "@/lib/rag/retrieve";

const c = (...cp: number[]) => String.fromCodePoint(...cp);
const SS = c(0xdf);
const AUML = c(0xe4);
const RAQUO = c(0xbb); // »
const LAQUO = c(0xab); // «
const LDQ = c(0x201c);
const RDQ = c(0x201d);
const LOW_DQ = c(0x201e);
const RSQ = c(0x2019);
const EN = c(0x2013);
const EM = c(0x2014);

function chunk(n: number, content: string): RetrievedChunk {
  return { id: `chunk-${n}`, sourceId: `source-${n}`, ordinal: n, page: null, content, score: 0.9 };
}

// One accepted folded citation: stored quote is the original span, a real NFC substring of
// the chunk, and the UI highlight finds it.
function expectAccepted(content: string, quote: string, stored: string) {
  const r = validateCitations(`Antwort [1: "${quote}"].`, [chunk(1, content)]);
  expect(r.citations).toEqual([{ ordinal: 1, chunkId: "chunk-1", quote: stored }]);
  expect(r.text).toBe("Antwort [1].");
  expect(r.dropped).toBe(0);
  expect(r.folded).toBe(1);
  expect(content.normalize("NFC").includes(stored)).toBe(true);
  expect(highlight(content, stored)).not.toBeNull();
  return r;
}

describe("validateCitations: result shape", () => {
  it("carries droppedBy and folded, all zero for an exact match", () => {
    const r = validateCitations('X [1: "Bonn"]', [chunk(1, "Die Firma sitzt in Bonn.")]);
    expect(r.dropped).toBe(0);
    expect(r.droppedBy).toEqual({ unknown_chunk: 0, not_in_chunk: 0, malformed: 0, over_limit: 0 });
    expect(r.folded).toBe(0);
  });
});

describe("validateCitations: folded match returns the original span", () => {
  it(`dass vs da${SS}`, () => {
    expectAccepted(`Er sagte, da${SS} er kommt.`, "dass er", `da${SS} er`);
  });

  it("a quote with the sharp s against a chunk with ss", () => {
    expectAccepted("Er sagte, dass er kommt.", `da${SS} er`, "dass er");
  });

  it("'komm', curly, low and guillemet variants against the German quotes in the chunk", () => {
    const content = `Er rief ${RAQUO}komm${LAQUO} und ging.`;
    const stored = `${RAQUO}komm${LAQUO}`;
    for (const quote of [
      "'komm'",
      `${LDQ}komm${RDQ}`,
      `${LOW_DQ}komm${LDQ}`,
      `${LAQUO}komm${RAQUO}`,
    ]) {
      expectAccepted(content, quote, stored);
    }
  });

  it("an apostrophe against the typographic one in the chunk", () => {
    expectAccepted(`Das war H${AUML}nsel${RSQ}s Schwester.`, `H${AUML}nsel's`, `H${AUML}nsel${RSQ}s`);
  });

  it("a single space in the quote against a line break in the chunk keeps the line break", () => {
    expectAccepted("Es war einmal\nein armer Holzhacker.", "einmal ein armer", "einmal\nein armer");
  });

  it("a single space in the quote against a double space in the chunk keeps both spaces", () => {
    expectAccepted("Es war einmal  ein armer Holzhacker.", "einmal ein armer", "einmal  ein armer");
  });

  it("two spaces in the quote against one space in the chunk", () => {
    expectAccepted("Es war einmal ein armer Holzhacker.", "einmal  ein armer", "einmal ein armer");
  });

  it("an em dash in the quote against an en dash in the chunk, and a hyphen", () => {
    const content = `Berlin ${EN} Bonn liegt weit.`;
    expectAccepted(content, `Berlin ${EM} Bonn`, `Berlin ${EN} Bonn`);
    expectAccepted(content, "Berlin - Bonn", `Berlin ${EN} Bonn`);
  });

  it("a decomposed quote against a composed chunk still stores the composed span", () => {
    const content = `Die B${AUML}renh${c(0xf6)}hle ist gro${SS}.`;
    const quote = `B${AUML}renh${c(0xf6)}hle ist gross`.normalize("NFD");
    expectAccepted(content, quote, `B${AUML}renh${c(0xf6)}hle ist gro${SS}`);
  });

  it("the exact match wins when the chunk has both spellings", () => {
    const r = validateCitations('X [1: "dass er"]', [chunk(1, `Erst da${SS} er, dann dass er.`)]);
    expect(r.citations).toEqual([{ ordinal: 1, chunkId: "chunk-1", quote: "dass er" }]);
    expect(r.folded).toBe(0);
  });

  it("two spellings of one passage get one ordinal and one citation", () => {
    const content = `Er sagte, da${SS} er kommt.`;
    const answer = `A [1: "dass er"] B [1: "dass  er"] C [1: "da${SS} er"]`;
    const r = validateCitations(answer, [chunk(1, content)]);
    expect(r.text).toBe("A [1] B [1] C [1]");
    expect(r.citations).toEqual([{ ordinal: 1, chunkId: "chunk-1", quote: `da${SS} er` }]);
    expect(r.dropped).toBe(0);
  });

  it("folded counts only the valid citations accepted through folding", () => {
    const content = `Gegr${c(0xfc)}ndet in Bonn. Er sagte, da${SS} er kommt.`;
    const r = validateCitations('A [1: "in Bonn"] B [1: "dass er"] C [1: "nicht da"]', [chunk(1, content)]);
    expect(r.citations).toHaveLength(2);
    expect(r.folded).toBe(1);
    expect(r.dropped).toBe(1);
  });
});

describe("validateCitations: folded match, still dropped", () => {
  const content = `Die Hexe wohnt im Wald. Der Fu${SS} ist weg. B${AUML}r und Wolf.`;
  const run = (quote: string, n = 1) => validateCitations(`X [${n}: "${quote}"] Y`, [chunk(1, content), chunk(2, "Zweiter Text")]);

  it("a fabricated quote is not_in_chunk", () => {
    const r = run("Die Hexe frisst Kinder");
    expect(r.citations).toEqual([]);
    expect(r.droppedBy).toEqual({ unknown_chunk: 0, not_in_chunk: 1, malformed: 0, over_limit: 0 });
    expect(r.text).toBe("X  Y");
  });

  it("a valid quote under the wrong chunk number is not_in_chunk", () => {
    const r = run("Die Hexe wohnt", 2);
    expect(r.citations).toEqual([]);
    expect(r.droppedBy.not_in_chunk).toBe(1);
    expect(r.dropped).toBe(1);
  });

  it("case differences are not folded", () => {
    const r = run("die hexe wohnt");
    expect(r.citations).toEqual([]);
    expect(r.droppedBy.not_in_chunk).toBe(1);
  });

  it("a vs umlaut is not folded", () => {
    const r = run("Bar und Wolf");
    expect(r.citations).toEqual([]);
    expect(r.droppedBy.not_in_chunk).toBe(1);
  });

  it("half of a sharp s does not match: Fus vs Fu + sharp s", () => {
    const r = run("Fus");
    expect(r.citations).toEqual([]);
    expect(r.droppedBy.not_in_chunk).toBe(1);
  });

  it("a quote that starts in the middle of a sharp s does not match", () => {
    const r = validateCitations('X [1: "sen sind"]', [chunk(1, `Die Fu${SS}en sind kalt.`)]);
    expect(r.citations).toEqual([]);
    expect(r.droppedBy.not_in_chunk).toBe(1);
  });

  it("a quote of ss covering the whole sharp s does match", () => {
    const r = validateCitations('X [1: "Fussen sind"]', [chunk(1, `Die Fu${SS}en sind kalt.`)]);
    expect(r.citations).toEqual([{ ordinal: 1, chunkId: "chunk-1", quote: `Fu${SS}en sind` }]);
  });

  it("when the first folded occurrence is not aligned, a later aligned one is used", () => {
    // Folded chunk: "Fuss d. Es d". "s d" first occurs inside the sharp s (start not aligned),
    // then at "Es  d" (aligned, but only after folding the double space).
    const r = validateCitations('X [1: "s d"]', [chunk(1, `Fu${SS} d. Es  d`)]);
    expect(r.citations).toEqual([{ ordinal: 1, chunkId: "chunk-1", quote: "s  d" }]);
    expect(r.dropped).toBe(0);
    expect(r.folded).toBe(1);
  });

  it("n out of range is unknown_chunk, not not_in_chunk", () => {
    const r = validateCitations('A [0: "Hexe"] B [3: "Hexe"] C [99: "Hexe"]', [chunk(1, content), chunk(2, "Zweiter Text")]);
    expect(r.citations).toEqual([]);
    expect(r.droppedBy).toEqual({ unknown_chunk: 3, not_in_chunk: 0, malformed: 0, over_limit: 0 });
  });

  it("a quote of 2001 characters is malformed", () => {
    const big = "a".repeat(MAX_QUOTE_CHARS + 1);
    const r = validateCitations(`Z [1: "${big}"]`, [chunk(1, big)]);
    expect(r.citations).toEqual([]);
    expect(r.droppedBy).toEqual({ unknown_chunk: 0, not_in_chunk: 0, malformed: 1, over_limit: 0 });
  });

  it("a whitespace-only quote is malformed", () => {
    const r = validateCitations('A [1: " "] B', [chunk(1, "a b")]);
    expect(r.droppedBy.malformed).toBe(1);
    expect(r.dropped).toBe(1);
  });

  it("a quote of at most 2000 characters whose chunk span is longer is malformed", () => {
    const text = "a" + " ".repeat(2500) + "b";
    const r = validateCitations('Z [1: "a b"]', [chunk(1, text)]);
    expect(r.citations).toEqual([]);
    expect(r.droppedBy).toEqual({ unknown_chunk: 0, not_in_chunk: 0, malformed: 1, over_limit: 0 });
  });

  it("a span of exactly 2000 characters is accepted", () => {
    const text = "a" + " ".repeat(1998) + "b";
    expect(text).toHaveLength(2000);
    const r = validateCitations('Z [1: "a b"]', [chunk(1, text)]);
    expect(r.citations).toEqual([{ ordinal: 1, chunkId: "chunk-1", quote: text }]);
    expect(r.folded).toBe(1);
  });

  it("a straight double quote inside a quote stays unaccepted", () => {
    const r = validateCitations('X [1: "sagte "hallo" dann"]', [chunk(1, 'Er sagte "hallo" dann')]);
    expect(r.citations).toEqual([]);
  });

  it("the 21st distinct citation is over_limit", () => {
    const body = Array.from({ length: 25 }, (_, i) => `satz${String(i).padStart(2, "0")}`).join("\n");
    const answer = Array.from({ length: 25 }, (_, i) => `[1: "satz${String(i).padStart(2, "0")}"]`).join(" ");
    const r = validateCitations(answer, [chunk(1, body)]);
    expect(r.citations).toHaveLength(MAX_CITATIONS);
    expect(r.droppedBy.over_limit).toBe(5);
    expect(r.dropped).toBe(5);
  });

  it("droppedBy sums to dropped across all four reasons, leftover markers included", () => {
    const body = Array.from({ length: 21 }, (_, i) => `satz${String(i).padStart(2, "0")}`).join(" ");
    const markers = Array.from({ length: 21 }, (_, i) => `[1: "satz${String(i).padStart(2, "0")}"]`).join(" ");
    const answer = `${markers} [9: "x"] [1: "gibt es nicht"] [123: "satz00"] [1: "${"a".repeat(2001)}"]`;
    const r = validateCitations(answer, [chunk(1, body)]);
    expect(r.droppedBy).toEqual({ unknown_chunk: 1, not_in_chunk: 1, malformed: 2, over_limit: 1 });
    expect(r.dropped).toBe(5);
    const sum = r.droppedBy.unknown_chunk + r.droppedBy.not_in_chunk + r.droppedBy.malformed + r.droppedBy.over_limit;
    expect(sum).toBe(r.dropped);
  });
});

describe("validateCitations: folded matching runs in linear time", () => {
  // Catches super-linear growth by a wide margin (quadratic takes many seconds on 200 KB) and tolerates runner load.
  const limit = 2000;

  it("a 200 KB chunk of whitespace with a long folded quote", () => {
    const text = "a" + " \n".repeat(100_000) + "b";
    const quote = "a b".repeat(1);
    const start = performance.now();
    const r = validateCitations(`[1: "${quote}"]`, [chunk(1, text)]);
    expect(performance.now() - start).toBeLessThan(limit);
    expect(r.droppedBy.malformed).toBe(1);

    const spaced = "ab ".repeat(66_000);
    const start2 = performance.now();
    validateCitations(`[1: "${"ab ".repeat(665)}x"]`, [chunk(1, spaced)]);
    expect(performance.now() - start2).toBeLessThan(limit);
  });

  it("a 200 KB chunk of sharp s characters with a 2000-character folded quote that never aligns", () => {
    const text = SS.repeat(100_000);
    const quote = "s".repeat(1999);
    const start = performance.now();
    const r = validateCitations(`[1: "${quote}"]`, [chunk(1, text)]);
    expect(performance.now() - start).toBeLessThan(limit);
    expect(r.citations).toEqual([]);
    expect(r.droppedBy.not_in_chunk).toBe(1);
  });

  it("a 200 KB chunk of sharp s characters with a quote that aligns accepts it", () => {
    const text = SS.repeat(100_000);
    const start = performance.now();
    const r = validateCitations(`[1: "${"s".repeat(2000)}"]`, [chunk(1, text)]);
    expect(performance.now() - start).toBeLessThan(limit);
    expect(r.citations).toEqual([{ ordinal: 1, chunkId: "chunk-1", quote: SS.repeat(1000) }]);
  });

  it("1000 folded markers against one 200 KB chunk", () => {
    const tokens = Array.from({ length: 28_000 }, (_, i) => `w${String(i).padStart(5, "0")}`);
    const text = tokens.join(" ");
    expect(text.length).toBeGreaterThan(190_000);
    const answer = Array.from({ length: 1000 }, (_, i) => `[1: "${tokens[i * 25]}  ${tokens[i * 25 + 1]}"]`).join(" ");
    const start = performance.now();
    const r = validateCitations(answer, [chunk(1, text)]);
    expect(performance.now() - start).toBeLessThan(limit);
    expect(r.citations).toHaveLength(MAX_CITATIONS);
    expect(r.droppedBy.over_limit).toBe(1000 - MAX_CITATIONS);
  });
});
