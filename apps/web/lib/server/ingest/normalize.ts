import "server-only";

// Text as stored in chunks: Postgres rejects NUL, and the citation check in block D
// compares substrings, so every source goes through the same normalization first.
// A high surrogate without a low one after it, or a low one without a high one before it.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function normalizeText(input: string): string {
  return input
    .replace(LONE_SURROGATE, "\uFFFD")
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "")
    .split("\n")
    .map(stripTrailingBlanks)
    .join("\n")
    .replace(/\n\n\n+/g, "\n\n");
}

// Spaces and tabs at the end of a line, removed by a backwards scan. The regex
// /[ \t]+$/gm backtracks quadratically on a long blank run followed by any other character
// (200,000 spaces took about 40 s), and every source passes through here.
function stripTrailingBlanks(line: string): string {
  let end = line.length;
  while (end > 0) {
    const c = line.charCodeAt(end - 1);
    if (c !== 32 && c !== 9) break;
    end--;
  }
  return end === line.length ? line : line.slice(0, end);
}
