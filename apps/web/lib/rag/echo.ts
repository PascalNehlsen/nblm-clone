import "server-only";

// Echoed prompt blocks (ADR 0018). The model sometimes copies the delimited source blocks
// (and their per-turn nonce) into its answer. Those parts are removed before the citation
// check, so markers inside an echoed block never count and the nonce is never stored.
// Linear: one cursor over the text, sticky regexes with bounded lengths, indexOf for the
// matching close tag.

export const OPEN_TAG = /<(quelle|frage)-([0-9a-z]{1,64})(?:\s[^<>]{0,200})?>/iy;
export const CLOSE_TAG = /<\/(quelle|frage)-[0-9a-z]{0,64}\s*>/iy;

export function removeNonce(text: string, nonce: string): { text: string; count: number } {
  if (!nonce) return { text, count: 0 };
  const lower = text.toLowerCase();
  const needle = nonce.toLowerCase();
  let out = "";
  let count = 0;
  let from = 0;
  for (let i = lower.indexOf(needle); i !== -1; i = lower.indexOf(needle, from)) {
    out += text.slice(from, i);
    from = i + needle.length;
    count++;
  }
  return { text: out + text.slice(from), count };
}

export function stripEcho(text: string, nonce: string): { text: string; stripped: number } {
  const lower = text.toLowerCase();
  let out = "";
  let stripped = 0;
  let i = 0;
  let copyFrom = 0;
  while (i < text.length) {
    const lt = text.indexOf("<", i);
    if (lt === -1) break;
    OPEN_TAG.lastIndex = lt;
    const open = OPEN_TAG.exec(text);
    if (open) {
      out += text.slice(copyFrom, lt);
      const close = `</${open[1]!.toLowerCase()}-${open[2]!.toLowerCase()}>`;
      const end = lower.indexOf(close, lt + open[0].length);
      stripped++;
      i = copyFrom = end === -1 ? text.length : end + close.length;
      continue;
    }
    CLOSE_TAG.lastIndex = lt;
    const stray = CLOSE_TAG.exec(text);
    if (stray) {
      out += text.slice(copyFrom, lt);
      stripped++;
      i = copyFrom = lt + stray[0].length;
      continue;
    }
    i = lt + 1;
  }
  out += text.slice(copyFrom);
  const cleaned = removeNonce(out, nonce);
  return { text: cleaned.text.trim(), stripped: stripped + cleaned.count };
}
