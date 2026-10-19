import { CHUNK_OVERLAP } from "./limits";

// Rebuilds a page's text from its chunks for reading. Neighbouring chunks overlap: the next
// one starts at a word start within the last CHUNK_OVERLAP characters of the previous one
// (lib/server/ingest/chunk.ts), so its first characters repeat the previous chunk's end.
// The longest such prefix that starts at a word boundary in the previous chunk is dropped.
// Chunks that do not overlap (rare: a cut in a long whitespace run) are joined with "\n".

const isSpace = (ch: string | undefined) => ch !== undefined && /\s/.test(ch);

function overlap(prev: string, next: string): number {
  const max = Math.min(CHUNK_OVERLAP, prev.length - 1, next.length);
  for (let k = max; k > 0; k--) {
    if (!isSpace(prev[prev.length - k - 1])) continue; // must start at a word start in prev
    if (prev.endsWith(next.slice(0, k))) return k;
  }
  return 0;
}

export function mergeChunks(contents: readonly string[]): string {
  let out = "";
  for (const content of contents) {
    if (out === "") {
      out = content;
      continue;
    }
    const k = overlap(out, content);
    out = k > 0 ? out + content.slice(k) : `${out}\n${content}`;
  }
  return out;
}

export function mergeByPage(
  chunks: readonly { page: number | null; content: string }[],
): { page: number | null; text: string }[] {
  const sections: { page: number | null; parts: string[] }[] = [];
  for (const c of chunks) {
    const last = sections[sections.length - 1];
    if (last && last.page === c.page) last.parts.push(c.content);
    else sections.push({ page: c.page, parts: [c.content] });
  }
  return sections.map((s) => ({ page: s.page, text: mergeChunks(s.parts) }));
}
