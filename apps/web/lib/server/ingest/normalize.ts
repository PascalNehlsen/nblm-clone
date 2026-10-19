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
    .replace(/[ \t]+$/gm, "")
    .replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, "\n\n");
}
