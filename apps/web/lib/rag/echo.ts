import "server-only";

// Echoed prompt blocks (ADR 0018). The model sometimes copies the delimited source blocks
// (and their per-turn nonce) into its answer. Those parts are removed before the citation
// check, so markers inside an echoed block never count and the nonce is never stored.
// Linear per pass: one cursor over the text, sticky regexes with bounded lengths, indexOf
// for the matching close tag. Case-insensitive matching lowercases ASCII only, so indexes
// in the lowered copy are indexes in the text (Unicode lowercasing can change the length,
// e.g. "İ" becomes two code units).

// Bounded so the longest possible tag fits in the stream filter's hold (HOLD_MAX = 96).
export const OPEN_TAG = /<(quelle|frage)-([0-9a-z]{1,32})(?:\s[^<>]{0,24})?>/iy;
export const CLOSE_TAG = /<\/(quelle|frage)-[0-9a-z]{0,32}\s{0,8}>/iy;
const MAX_PASSES = 3;

export function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

// Removes every occurrence of the nonce, also ones that only appear once an inner one is gone
// (p + NONCE + s where p + s is the nonce): characters go onto a stack and whenever its top
// spells the nonce it is popped. One pass, O(text length x nonce length).
export function removeNonce(text: string, nonce: string): { text: string; count: number } {
  if (!nonce) return { text, count: 0 };
  const needle = asciiLower(nonce);
  const n = needle.length;
  const out: string[] = [];
  const low: string[] = [];
  let count = 0;
  for (const ch of text) {
    out.push(ch);
    low.push(ch.length === 1 ? asciiLower(ch) : ch);
    if (low.length >= n && low[low.length - 1] === needle[n - 1]) {
      let match = true;
      for (let k = 0; k < n; k++) {
        if (low[low.length - n + k] !== needle[k]) {
          match = false;
          break;
        }
      }
      if (match) {
        out.length -= n;
        low.length -= n;
        count++;
      }
    }
  }
  return { text: count === 0 ? text : out.join(""), count };
}

// The matching close tag of a block: `</name-x>` with up to 8 whitespace characters before ">".
function findClose(lower: string, name: string, from: number): { at: number; end: number } | null {
  const head = `</${name}`;
  for (let at = lower.indexOf(head, from); at !== -1; at = lower.indexOf(head, at + 1)) {
    let i = at + head.length;
    let spaces = 0;
    while (spaces < 8 && /\s/.test(lower[i] ?? "")) {
      i++;
      spaces++;
    }
    if (lower[i] === ">") return { at, end: i + 1 };
  }
  return null;
}

function stripOnce(text: string, nonce: string): { text: string; stripped: number } {
  const lower = asciiLower(text);
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
      const close = findClose(lower, `${asciiLower(open[1]!)}-${asciiLower(open[2]!)}`, lt + open[0].length);
      stripped++;
      i = copyFrom = close === null ? text.length : close.end;
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
  return { text: cleaned.text, stripped: stripped + cleaned.count };
}

// Repeats until stable (at most MAX_PASSES): removing the nonce can rebuild a tag.
export function stripEcho(text: string, nonce: string): { text: string; stripped: number } {
  let total = 0;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const r = stripOnce(text, nonce);
    text = r.text;
    total += r.stripped;
    if (r.stripped === 0) break;
  }
  return { text: text.trim(), stripped: total };
}
