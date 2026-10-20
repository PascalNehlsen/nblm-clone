import "server-only";

import { CLOSE_TAG, OPEN_TAG, asciiLower } from "./echo";

// The stream side of stripEcho (ADR 0018): echoed source or question blocks never reach the
// live preview, and neither does the nonce. Text is emitted with a short delay: a "<" is held
// while it could still become a tag (at most HOLD_MAX characters, which covers the longest tag
// OPEN_TAG / CLOSE_TAG accept), and a trailing run of hex characters is held (the nonce is
// hex), so a nonce split across deltas, or rebuilt around an inner one or an echoed block,
// is removed before anything of it is shown.

const HOLD_MAX = 96;
const HEX_HOLD_MAX = 512;
const PREFIXES = ["<quelle-", "<frage-", "</quelle-", "</frage-"];

function couldBeTag(s: string): boolean {
  if (s.length > HOLD_MAX || s.includes(">")) return false;
  const lower = asciiLower(s);
  return PREFIXES.some((p) => (lower.length <= p.length ? p.startsWith(lower) : lower.startsWith(p)));
}

const isHex = (ch: string) => /^[0-9a-fA-F]$/.test(ch);

export function createEchoFilter(nonce: string, emit: (text: string) => void): { push(delta: string): void; end(): void } {
  let buffer = "";
  let closeTag: string | null = null; // set while inside an echoed block, e.g. "</quelle-ab12"
  const needle = asciiLower(nonce);
  const n = needle.length;
  const keep = Math.max(0, n - 1);

  // Text outside blocks, nonce-free, not emitted yet: chars[head..]. Every character is checked
  // once on arrival (the same stack as removeNonce), so the filter stays linear.
  let chars: string[] = [];
  let lows: string[] = [];
  let head = 0;
  let hexRun = 0;

  const recountHex = () => {
    hexRun = 0;
    for (let i = chars.length - 1; i >= head && hexRun < HEX_HOLD_MAX && isHex(chars[i]!); i--) hexRun++;
  };

  const addReady = (text: string) => {
    for (const ch of text) {
      chars.push(ch);
      lows.push(ch.length === 1 ? asciiLower(ch) : ch);
      hexRun = isHex(ch) ? Math.min(hexRun + 1, HEX_HOLD_MAX) : 0;
      if (n > 0 && chars.length - head >= n && lows[lows.length - 1] === needle[n - 1]) {
        let match = true;
        for (let k = 0; k < n; k++) {
          if (lows[lows.length - n + k] !== needle[k]) {
            match = false;
            break;
          }
        }
        if (match) {
          chars.length -= n;
          lows.length -= n;
          recountHex();
        }
      }
    }
  };

  const flushReady = (final: boolean) => {
    const hold = final ? 0 : Math.max(keep, hexRun);
    const cut = chars.length - head - hold;
    if (cut <= 0) return;
    const out = chars.slice(head, head + cut).join("");
    head += cut;
    if (head > 4096) {
      chars = chars.slice(head);
      lows = lows.slice(head);
      head = 0;
    }
    emit(out);
  };

  // The end of the block's close tag in `buffer` (up to 8 whitespace characters before ">"),
  // or -1. While searching, `buffer` keeps only what could still be the start of it.
  const findClose = (): number => {
    const lower = asciiLower(buffer);
    const head = closeTag!;
    for (let at = lower.indexOf(head); at !== -1; at = lower.indexOf(head, at + 1)) {
      let i = at + head.length;
      let spaces = 0;
      while (spaces < 8 && i < lower.length && /\s/.test(lower[i]!)) {
        i++;
        spaces++;
      }
      if (lower[i] === ">") return i + 1;
    }
    return -1;
  };

  const process = (final: boolean) => {
    for (;;) {
      if (closeTag !== null) {
        const end = findClose();
        if (end === -1) {
          buffer = final ? "" : buffer.slice(Math.max(0, buffer.length - (closeTag.length + 8)));
          return;
        }
        buffer = buffer.slice(end);
        closeTag = null;
        continue;
      }
      const lt = buffer.indexOf("<");
      if (lt === -1) {
        addReady(buffer);
        buffer = "";
        return;
      }
      addReady(buffer.slice(0, lt));
      buffer = buffer.slice(lt);
      OPEN_TAG.lastIndex = 0;
      const open = OPEN_TAG.exec(buffer);
      if (open) {
        closeTag = `</${asciiLower(open[1]!)}-${asciiLower(open[2]!)}`;
        buffer = buffer.slice(open[0].length);
        continue;
      }
      CLOSE_TAG.lastIndex = 0;
      const stray = CLOSE_TAG.exec(buffer);
      if (stray) {
        buffer = buffer.slice(stray[0].length);
        continue;
      }
      if (!final && couldBeTag(buffer)) return; // wait for more text
      addReady("<");
      buffer = buffer.slice(1);
    }
  };

  return {
    push(delta) {
      buffer += delta;
      process(false);
      flushReady(false);
    },
    end() {
      process(true);
      flushReady(true);
    },
  };
}
