import "server-only";

import { fold, type Folded } from "./fold";
import type { RetrievedChunk } from "./retrieve";

// Server-side citation check (AGENTS.md): a marker [n: "quote"] counts only if n names a
// chunk retrieved for this turn and the quote is an exact substring of that chunk (after
// NFC). Everything else is removed from the answer. The regex has no nested quantifiers, so
// it runs in linear time on any model output. A quote that differs from the chunk only in
// whitespace, quotation marks, dashes or ß/ss is accepted through folding (ADR 0016); the
// stored quote is then the verbatim chunk span, never the model's text.

export const MAX_CITATIONS = 20;
export const MAX_QUOTE_CHARS = 2000;

export interface ValidCitation {
  ordinal: number;
  chunkId: string;
  quote: string;
}

export interface DroppedBy {
  unknown_chunk: number;
  not_in_chunk: number;
  malformed: number;
  over_limit: number;
}

export interface CitationResult {
  text: string;
  citations: ValidCitation[];
  dropped: number;
  droppedBy: DroppedBy;
  /** Valid citations accepted only through folding. */
  folded: number;
}

// Misaligned occurrences tried per quote. Bounds the work on adversarial input (an odd run of
// "s" against a chunk of ß never aligns); a quote found only beyond this is dropped, the safe
// direction.
const MAX_FOLD_ATTEMPTS = 32;

// The verbatim span of `base` matching `quote` after folding, or null. A match must start at
// the start and end at the end of a source character (half of a folded ß does not count).
function foldedSpan(base: string, chunkFold: Folded, quote: string): string | null {
  const q = fold(quote).text.trim();
  if (q.length === 0) return null;
  const { text, start, end } = chunkFold;
  let k = text.indexOf(q);
  for (let attempt = 0; k !== -1 && attempt < MAX_FOLD_ATTEMPTS; attempt++) {
    const j = k + q.length - 1;
    const alignedStart = k === 0 || start[k] !== start[k - 1];
    const alignedEnd = j === text.length - 1 || start[j + 1] !== start[j];
    if (alignedStart && alignedEnd) return base.slice(start[k], end[j]);
    k = text.indexOf(q, k + 1);
  }
  return null;
}

export const MARKER = /\[(\d{1,2}):\s{0,8}"([^"\]]{1,2000})"\]/g;
// Marker-shaped text the check above does not accept (a quote over the limit, or a number
// with more than two digits, of any length). One quantifier per part, so still linear.
const LEFTOVER_MARKER = /\[\d+:\s{0,8}"[^"\]]*"\]/g;

export function validateCitations(answer: string, chunks: RetrievedChunk[]): CitationResult {
  const citations: ValidCitation[] = [];
  const byKey = new Map<string, number>();
  const droppedBy: DroppedBy = { unknown_chunk: 0, not_in_chunk: 0, malformed: 0, over_limit: 0 };
  const folds = new Map<number, Folded>();
  let folded = 0;

  const text = answer.replace(MARKER, (_match, n: string, rawQuote: string) => {
    const index = Number(n) - 1;
    const chunk = index >= 0 && index < chunks.length ? chunks[index] : undefined;
    const quote = rawQuote.normalize("NFC").trim();
    if (!chunk) {
      droppedBy.unknown_chunk++;
      return "";
    }
    if (quote.length === 0 || quote.length > MAX_QUOTE_CHARS) {
      droppedBy.malformed++;
      return "";
    }
    const base = chunk.content.normalize("NFC");
    let span: string | null = base.includes(quote) ? quote : null;
    let viaFold = false;
    if (span === null) {
      let chunkFold = folds.get(index);
      if (!chunkFold) {
        chunkFold = fold(base);
        folds.set(index, chunkFold);
      }
      span = foldedSpan(base, chunkFold, quote);
      viaFold = span !== null;
    }
    if (span === null) {
      droppedBy.not_in_chunk++;
      return "";
    }
    if (span.length > MAX_QUOTE_CHARS) {
      droppedBy.malformed++;
      return "";
    }
    const key = `${chunk.id}\n${span}`;
    const existing = byKey.get(key);
    if (existing !== undefined) return `[${existing}]`;
    if (citations.length >= MAX_CITATIONS) {
      droppedBy.over_limit++;
      return "";
    }
    const ordinal = citations.length + 1;
    citations.push({ ordinal, chunkId: chunk.id, quote: span });
    byKey.set(key, ordinal);
    if (viaFold) folded++;
    return `[${ordinal}]`;
  });

  const cleaned = text.replace(LEFTOVER_MARKER, () => {
    droppedBy.malformed++;
    return "";
  });
  const dropped = droppedBy.unknown_chunk + droppedBy.not_in_chunk + droppedBy.malformed + droppedBy.over_limit;
  return { text: cleaned.trim(), citations, dropped, droppedBy, folded };
}
