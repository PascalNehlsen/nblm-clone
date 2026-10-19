import "server-only";

import type { RetrievedChunk } from "./retrieve";

// Server-side citation check (AGENTS.md): a marker [n: "quote"] counts only if n names a
// chunk retrieved for this turn and the quote is an exact substring of that chunk (after
// NFC). Everything else is removed from the answer. The regex has no nested quantifiers, so
// it runs in linear time on any model output.

export const MAX_CITATIONS = 20;
export const MAX_QUOTE_CHARS = 2000;

export interface ValidCitation {
  ordinal: number;
  chunkId: string;
  quote: string;
}

export interface CitationResult {
  text: string;
  citations: ValidCitation[];
  dropped: number;
}

export const MARKER = /\[(\d{1,2}):\s{0,8}"([^"\]]{1,2000})"\]/g;
// Marker-shaped text the check above does not accept (for example a quote over the limit).
// Single quantifier per part, so still linear.
const LEFTOVER_MARKER = /\[\d{1,2}:\s{0,8}"[^"\]]*"\]/g;

export function validateCitations(answer: string, chunks: RetrievedChunk[]): CitationResult {
  const citations: ValidCitation[] = [];
  const byKey = new Map<string, number>();
  let dropped = 0;

  const text = answer.replace(MARKER, (_match, n: string, rawQuote: string) => {
    const index = Number(n) - 1;
    const chunk = index >= 0 && index < chunks.length ? chunks[index] : undefined;
    const quote = rawQuote.normalize("NFC").trim();
    if (!chunk || quote.length === 0 || quote.length > MAX_QUOTE_CHARS || !chunk.content.normalize("NFC").includes(quote)) {
      dropped++;
      return "";
    }
    const key = `${chunk.id}\n${quote}`;
    const existing = byKey.get(key);
    if (existing !== undefined) return `[${existing}]`;
    if (citations.length >= MAX_CITATIONS) {
      dropped++;
      return "";
    }
    const ordinal = citations.length + 1;
    citations.push({ ordinal, chunkId: chunk.id, quote });
    byKey.set(key, ordinal);
    return `[${ordinal}]`;
  });

  const cleaned = text.replace(LEFTOVER_MARKER, () => {
    dropped++;
    return "";
  });
  return { text: cleaned.trim(), citations, dropped };
}
