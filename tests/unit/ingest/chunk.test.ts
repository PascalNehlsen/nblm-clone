// C1 ingestion (plan approved by Pascal, 2026-10-19). See .git/C1-API-SPEC.md
// ("chunk.ts") for the full cut-rule, next-start and tail-merge spec. All text
// generators below are deterministic (fixed repeated units, no Math.random, no
// Date.now), so the suite is reproducible.
import { describe, expect, it } from "vitest";
import { chunkPages, type ChunkDraft, type PageText } from "@/lib/server/ingest/chunk";
import { CHUNK_MAX, CHUNK_MIN_TAIL, CHUNK_OVERLAP } from "@/lib/sources/limits";

const SENTENCE = "Dies ist ein Testsatz mit genuegend Zeichen fuer den Chunk-Test. ";

function repeatToLength(unit: string, minLength: number): string {
  let out = "";
  while (out.length < minLength) out += unit;
  return out;
}

// No "\n\n" anywhere, so the cut rule exercises the sentence-end / whitespace
// rules rather than the paragraph rule.
function longSingleParagraphText(minLength: number): string {
  return repeatToLength(SENTENCE, minLength);
}

function isWhitespaceChar(ch: string): boolean {
  return /\s/.test(ch);
}

function assertNoLeadingOrTrailingWhitespace(content: string): void {
  expect(content.length).toBeGreaterThan(0);
  expect(isWhitespaceChar(content[0] as string)).toBe(false);
  expect(isWhitespaceChar(content[content.length - 1] as string)).toBe(false);
}

function assertCoversNonWhitespace(pageText: string, chunks: ChunkDraft[]): void {
  const covered = new Array<boolean>(pageText.length).fill(false);
  for (const c of chunks) {
    for (let i = c.start; i < c.start + c.content.length; i++) covered[i] = true;
  }
  for (let i = 0; i < pageText.length; i++) {
    if (!isWhitespaceChar(pageText[i] as string)) {
      expect(covered[i], `index ${i} ('${pageText[i]}') not covered by any chunk`).toBe(true);
    }
  }
}

function assertStartsStrictlyIncreasing(chunks: ChunkDraft[]): void {
  for (let i = 1; i < chunks.length; i++) {
    const prev = chunks[i - 1] as ChunkDraft;
    const next = chunks[i] as ChunkDraft;
    expect(next.start, `chunk ${i}.start (${next.start}) must be > chunk ${i - 1}.start (${prev.start})`).toBeGreaterThan(
      prev.start,
    );
  }
}

// Reviewer-found bug (approved fix, 2026-10-19): a long whitespace run makes the
// original next-start rule return a position before prevStart (even negative),
// so chunkPages never terminates. The fixed rule: next start is always >
// prevStart and >= 0; if no word start exists in [prevEnd - CHUNK_OVERLAP,
// prevEnd), or the overlap would not advance, the next chunk starts at the first
// non-whitespace character at or after prevEnd, with no overlap. These checks
// bound every chunk's shape; the real failure mode for the bug itself is a hang,
// which the test run turns red by timing out (see the file-level comment at the
// bottom of this file for the exact command).
function assertWellFormedChunks(pageText: string, chunks: ChunkDraft[]): void {
  expect(chunks.length).toBeGreaterThan(0);
  chunks.forEach((c, i) => expect(c.ordinal).toBe(i));
  assertStartsStrictlyIncreasing(chunks);
  for (const c of chunks) {
    expect(c.start).toBeGreaterThanOrEqual(0);
    expect(c.content.length).toBeGreaterThan(0);
    expect(c.content).toBe(pageText.slice(c.start, c.start + c.content.length));
    assertNoLeadingOrTrailingWhitespace(c.content);
  }
  assertCoversNonWhitespace(pageText, chunks);
}

describe("chunkPages: trivial inputs", () => {
  it("chunkPages([]) -> []", () => {
    expect(chunkPages([])).toEqual([]);
  });

  it("a whitespace-only page produces no chunks", () => {
    const pages: PageText[] = [{ page: 1, text: "   \n\t\n  " }];
    expect(chunkPages(pages)).toEqual([]);
  });

  it("a short text -> one chunk equal to the trimmed text, ordinal 0, start correct", () => {
    const text = "  Kurzer Text.  ";
    const pages: PageText[] = [{ page: 3, text }];
    const chunks = chunkPages(pages);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual({
      ordinal: 0,
      page: 3,
      start: text.indexOf("Kurzer"),
      content: "Kurzer Text.",
    });
  });
});

describe("chunkPages: long single-page text", () => {
  const text = longSingleParagraphText(10_000);
  const pages: PageText[] = [{ page: 1, text }];
  const chunks = chunkPages(pages);

  it("produces more than one chunk", () => {
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("every chunk is 1..CHUNK_MAX characters, with no leading/trailing whitespace", () => {
    for (const c of chunks) {
      expect(c.content.length).toBeGreaterThan(0);
      expect(c.content.length).toBeLessThanOrEqual(CHUNK_MAX);
      assertNoLeadingOrTrailingWhitespace(c.content);
    }
  });

  it("content matches page.text.slice(start, start + content.length) exactly", () => {
    for (const c of chunks) {
      expect(c.content).toBe(text.slice(c.start, c.start + c.content.length));
    }
  });

  it("ordinals are contiguous from 0", () => {
    chunks.forEach((c, i) => expect(c.ordinal).toBe(i));
  });

  it("same-page neighbours overlap by more than 0 and at most CHUNK_OVERLAP", () => {
    for (let i = 1; i < chunks.length; i++) {
      const prev = chunks[i - 1] as ChunkDraft;
      const next = chunks[i] as ChunkDraft;
      if (prev.page !== next.page) continue;
      const overlap = prev.start + prev.content.length - next.start;
      expect(overlap).toBeGreaterThan(0);
      expect(overlap).toBeLessThanOrEqual(CHUNK_OVERLAP);
    }
  });

  it("every non-whitespace character of the page is covered by some chunk", () => {
    assertCoversNonWhitespace(text, chunks);
  });

  it("is deterministic: chunking the same text twice gives deep-equal output", () => {
    const again = chunkPages([{ page: 1, text }]);
    expect(again).toEqual(chunks);
  });
});

describe("chunkPages: multi-page text", () => {
  const pageOneText = longSingleParagraphText(3_000);
  const pageTwoText = longSingleParagraphText(3_000);
  const pages: PageText[] = [
    { page: 1, text: pageOneText },
    { page: 2, text: pageTwoText },
  ];
  const chunks = chunkPages(pages);

  it("no chunk crosses a page: content always matches its own page's text", () => {
    for (const c of chunks) {
      const pageText = c.page === 1 ? pageOneText : pageTwoText;
      expect(c.content).toBe(pageText.slice(c.start, c.start + c.content.length));
    }
  });

  it("keeps page numbers, with all page-1 chunks before all page-2 chunks", () => {
    const pageNumbers = chunks.map((c) => c.page);
    const firstPageTwoIndex = pageNumbers.indexOf(2);
    expect(firstPageTwoIndex).toBeGreaterThan(0);
    for (let i = 0; i < firstPageTwoIndex; i++) expect(pageNumbers[i]).toBe(1);
    for (let i = firstPageTwoIndex; i < pageNumbers.length; i++) expect(pageNumbers[i]).toBe(2);
  });

  it("ordinals continue contiguously across pages", () => {
    chunks.forEach((c, i) => expect(c.ordinal).toBe(i));
  });
});

describe("chunkPages: cut-rule priority", () => {
  it("a paragraph break inside the window wins over a sentence end: the first chunk ends right before it", () => {
    const before = "A".repeat(1000); // no whitespace, no punctuation
    // A sentence end ("B. ") appears repeatedly right after the paragraph break, so
    // if the paragraph break were not preferred, a later sentence end inside the
    // window would otherwise win instead.
    const after = repeatToLength("B. ", 820);
    const text = `${before}\n\n${after}`;
    const pages: PageText[] = [{ page: 1, text }];
    const chunks = chunkPages(pages);

    expect(text.length).toBeGreaterThan(CHUNK_MAX); // a cut is actually forced
    expect(chunks[0]?.start).toBe(0);
    expect(chunks[0]?.content).toBe(before);
  });

  it("with no paragraph break, a sentence end wins over plain whitespace", () => {
    const filler = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod ";
    const before = repeatToLength(filler, 650).slice(0, 650); // plain whitespace, no punctuation
    const sentenceEnd = "Ende des Satzes. "; // one '.', followed by whitespace
    const tail = repeatToLength("tempor incididunt ut labore et dolore magna aliqua ", 900).slice(0, 900);
    const text = before + sentenceEnd + tail;
    expect(text.includes("\n\n")).toBe(false);
    expect(text.length).toBeGreaterThan(CHUNK_MAX);

    const periodIndex = text.indexOf(".");
    expect(periodIndex).toBeGreaterThanOrEqual(600);
    expect(periodIndex).toBeLessThanOrEqual(CHUNK_MAX);

    const pages: PageText[] = [{ page: 1, text }];
    const chunks = chunkPages(pages);

    expect(chunks[0]?.start).toBe(0);
    // Cutting after the punctuation: content ends with the period itself.
    expect(chunks[0]?.content).toBe(text.slice(0, periodIndex + 1));
  });
});

describe("chunkPages: hard split", () => {
  it("a 5000-character word without any whitespace is hard-split: every chunk <= CHUNK_MAX, coverage holds", () => {
    const text = "x".repeat(5000);
    const pages: PageText[] = [{ page: 1, text }];
    const chunks = chunkPages(pages);

    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.content.length).toBeGreaterThan(0);
      expect(c.content.length).toBeLessThanOrEqual(CHUNK_MAX);
    }
    assertCoversNonWhitespace(text, chunks);
  });
});

describe("chunkPages: tail merge", () => {
  it("merges a final tail shorter than CHUNK_MIN_TAIL into the previous chunk when it still fits CHUNK_MAX", () => {
    // `A` has two spaces close together (3 characters apart). Both land inside the
    // relevant cut window, so the "last whitespace in window" rule picks the later
    // one, while the next-start rule's "follows a whitespace character" search then
    // finds the earlier one close by, giving a small overlap instead of the default
    // CHUNK_OVERLAP. Repeating the same block means the next chunk starts only a
    // few characters before the second block's own small-overlap point, so ending
    // the page shortly after that leaves a tail under CHUNK_MIN_TAIL.
    const A = "a".repeat(1490) + " " + "a".repeat(2) + " ";
    const text = A + A + "xyz";
    const pages: PageText[] = [{ page: 1, text }];
    const chunks = chunkPages(pages);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.ordinal).toBe(0);
    expect(chunks[0]?.start).toBe(0);
    expect(chunks[0]?.content.length).toBeLessThan(CHUNK_MAX);

    const last = chunks[1] as ChunkDraft;
    expect(last.ordinal).toBe(1);
    // The merged chunk reaches all the way to the end of the page: the tiny "xyz"
    // tail was absorbed into it rather than forming its own sub-CHUNK_MIN_TAIL chunk.
    expect(last.content).toBe(text.slice(last.start, text.length));
    expect(last.content.endsWith("xyz")).toBe(true);
    expect(last.content.length).toBeLessThanOrEqual(CHUNK_MAX);
    expect(last.content.length).toBeGreaterThanOrEqual(CHUNK_MIN_TAIL);
  });
});

// Reviewer-found bug (approved fix, 2026-10-19): a long whitespace run can put
// prevEnd deep inside the run after trimming, so there is no word start in
// [prevEnd - CHUNK_OVERLAP, prevEnd) and the original next-start rule returns
// `skipSpace(text, prevEnd - CHUNK_OVERLAP)`, which can land before prevStart (even
// negative), and the resulting slice is empty -- chunkPages(text) never returns.
//
// The fixed rule (spec amendment, implemented by the builder):
//   - the next start is always > prevStart and >= 0;
//   - if no qualifying word start exists in that window, or using it would not
//     advance past prevStart, the next chunk starts at the first non-whitespace
//     character at or after prevEnd (skipSpace(text, prevEnd)), with no overlap;
//   - every chunk stays non-empty, start >= 0, and the exact-substring rule holds.
//
// A still-broken chunker does not fail an assertion here -- it hangs, so the run
// never reaches a failure message. The builder must run this file in isolation
// under a wall-clock timeout (see the command below); a hang shows up as the
// wrapper's exit code 124, not as a vitest failure line. Each test below also
// sets a 2000ms per-test timeout (the plain-number third argument to `it`/
// `it.each`) as defense in depth, in case a fix is slow-but-terminating rather
// than a clean infinite loop; it cannot interrupt a true synchronous hang
// (chunkPages is synchronous and never yields back to the event loop), so the
// wall-clock wrapper below is still the real guard.
//
// Run in isolation with a wall-clock timeout:
//   timeout 120 pnpm exec vitest run --project unit tests/unit/ingest/chunk.test.ts
describe("chunkPages: terminates on long whitespace runs", () => {
  it(
    "a whitespace run right after the first character terminates and stays well-formed",
    () => {
      const text = "a" + " ".repeat(700) + "x".repeat(1000);
      const chunks = chunkPages([{ page: 1, text }]);
      assertWellFormedChunks(text, chunks);
    },
    2000,
  );

  it(
    "a whitespace run in the middle of the text terminates and stays well-formed",
    () => {
      const text = "x".repeat(900) + " ".repeat(800) + "y".repeat(900);
      const chunks = chunkPages([{ page: 1, text }]);
      assertWellFormedChunks(text, chunks);
    },
    2000,
  );

  it(
    "a run of NBSP (U+00A0, which \\s also matches) between words terminates and stays well-formed",
    () => {
      const nbsp = String.fromCharCode(0xa0).repeat(700);
      const text = "wordone" + nbsp + "wordtwo".repeat(150);
      const chunks = chunkPages([{ page: 1, text }]);
      assertWellFormedChunks(text, chunks);
    },
    2000,
  );

  // A deterministic sweep: a whitespace run of every length from 0 to 1600 (step
  // 50), inserted at four different offsets into a fixed 3000-character words
  // text, so the run can start at the very beginning, well before the first cut
  // window, right at a typical cut point, and right at the edge of CHUNK_MAX.
  const SWEEP_BASE_TEXT = repeatToLength(SENTENCE, 3000).slice(0, 3000);
  const SWEEP_OFFSETS = [0, 300, 1000, 1499];
  const SWEEP_RUN_LENGTHS = Array.from({ length: 33 }, (_, i) => i * 50); // 0, 50, ..., 1600

  const sweepCases: Array<[number, number]> = [];
  for (const offset of SWEEP_OFFSETS) {
    for (const runLength of SWEEP_RUN_LENGTHS) {
      sweepCases.push([offset, runLength]);
    }
  }

  it.each(sweepCases)(
    "offset %i, whitespace run length %i: terminates and stays well-formed",
    (offset, runLength) => {
      const text = SWEEP_BASE_TEXT.slice(0, offset) + " ".repeat(runLength) + SWEEP_BASE_TEXT.slice(offset);
      const chunks = chunkPages([{ page: 1, text }]);
      assertWellFormedChunks(text, chunks);
      for (const c of chunks) {
        expect(c.content.length).toBeLessThanOrEqual(CHUNK_MAX);
      }
    },
    2000,
  );
});
