import "server-only";

import { CHUNK_MAX, CHUNK_MIN_TAIL, CHUNK_OVERLAP } from "@/lib/sources/limits";

export interface PageText {
  page: number | null; // 1-based for PDFs, null for text and URL sources
  text: string; // already normalized
}

export interface ChunkDraft {
  ordinal: number;
  page: number | null;
  start: number; // offset of content in its page text
  content: string;
}

const MIN_CUT = 600; // a cut is searched in [start + MIN_CUT, start + CHUNK_MAX]

const isSpace = (ch: string | undefined) => ch !== undefined && /\s/.test(ch);

function skipSpace(text: string, i: number): number {
  while (i < text.length && isSpace(text[i])) i++;
  return i;
}

function trimmedEnd(text: string, start: number, end: number): number {
  while (end > start && isSpace(text[end - 1])) end--;
  return end;
}

// End (exclusive) of the chunk starting at `start`: a paragraph break, else a sentence
// end, else whitespace, else a hard cut, each searched backwards from the window end.
function cutEnd(text: string, start: number): number {
  const from = start + MIN_CUT;
  const to = start + CHUNK_MAX;
  for (let i = to; i >= from; i--) {
    if (text[i] === "\n" && text[i + 1] === "\n") return i;
  }
  for (let i = to - 1; i >= from - 1; i--) {
    if ((text[i] === "." || text[i] === "!" || text[i] === "?") && isSpace(text[i + 1])) return i + 1;
  }
  for (let i = to; i >= from; i--) {
    if (isSpace(text[i])) return i;
  }
  return to;
}

// Start of the next chunk: the first word start in the last CHUNK_OVERLAP characters of
// the previous chunk, so neighbours overlap without cutting a word. Inside one long word
// the overlap is a hard cut. Otherwise (a chunk that is short because its cut fell into a
// long whitespace run) the next chunk starts after the previous one, without overlap.
// The result is always past prevStart, so the loop in chunkPage always advances.
function nextStart(text: string, prevStart: number, prevEnd: number): number {
  const from = Math.max(prevStart + 1, prevEnd - CHUNK_OVERLAP);
  for (let i = from; i < prevEnd; i++) {
    if (isSpace(text[i - 1]) && !isSpace(text[i])) return i;
  }
  if (from < prevEnd && !/\s/.test(text.slice(from, prevEnd))) return from;
  return skipSpace(text, prevEnd);
}

function chunkPage(text: string): { start: number; content: string }[] {
  const out: { start: number; content: string }[] = [];
  let start = skipSpace(text, 0);
  while (start < text.length) {
    const last = text.length - start <= CHUNK_MAX;
    const end = trimmedEnd(text, start, last ? text.length : cutEnd(text, start));
    out.push({ start, content: text.slice(start, end) });
    if (last) break;
    start = nextStart(text, start, end);
  }
  const tail = out[out.length - 1];
  const prev = out[out.length - 2];
  if (tail && prev && tail.content.length < CHUNK_MIN_TAIL) {
    const merged = text.slice(prev.start, tail.start + tail.content.length);
    if (merged.length <= CHUNK_MAX) out.splice(-2, 2, { start: prev.start, content: merged });
  }
  return out;
}

// Chunks never span pages, and each one is an exact substring of its page text: the
// citation check in block D relies on that.
export function chunkPages(pages: PageText[]): ChunkDraft[] {
  const chunks: ChunkDraft[] = [];
  for (const { page, text } of pages) {
    for (const { start, content } of chunkPage(text)) {
      chunks.push({ ordinal: chunks.length, page, start, content });
    }
  }
  return chunks;
}
