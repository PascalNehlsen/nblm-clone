import "server-only";

import { CLOSE_TAG, OPEN_TAG, removeNonce } from "./echo";

// The stream side of stripEcho (ADR 0018): echoed source or question blocks never reach the
// live preview, and neither does the nonce. Text is emitted with a short delay: a "<" is held
// while it could still become a tag (at most HOLD_MAX characters), and the last
// nonce.length - 1 characters are held so a nonce split across deltas is still caught.

const HOLD_MAX = 96;
const PREFIXES = ["<quelle-", "<frage-", "</quelle-", "</frage-"];

function couldBeTag(s: string): boolean {
  if (s.length > HOLD_MAX || s.includes(">")) return false;
  const lower = s.toLowerCase();
  return PREFIXES.some((p) => (lower.length <= p.length ? p.startsWith(lower) : lower.startsWith(p)));
}

export function createEchoFilter(nonce: string, emit: (text: string) => void): { push(delta: string): void; end(): void } {
  let buffer = "";
  let ready = ""; // outside text not yet emitted (held for a split nonce)
  let closeTag: string | null = null; // set while inside an echoed block
  const keep = Math.max(0, nonce.length - 1);

  const flushReady = (final: boolean) => {
    const cut = final ? ready.length : Math.max(0, ready.length - keep);
    if (cut === 0) return;
    // Remove the nonce over the whole ready text first, so a nonce across the cut is caught.
    const cleaned = removeNonce(ready, nonce).text;
    if (cleaned !== ready) {
      ready = cleaned;
      return flushReady(final);
    }
    const out = ready.slice(0, cut);
    ready = ready.slice(cut);
    if (out) emit(out);
  };

  const process = (final: boolean) => {
    for (;;) {
      if (closeTag !== null) {
        const at = buffer.toLowerCase().indexOf(closeTag);
        if (at === -1) {
          buffer = final ? "" : buffer.slice(Math.max(0, buffer.length - (closeTag.length - 1)));
          return;
        }
        buffer = buffer.slice(at + closeTag.length);
        closeTag = null;
        continue;
      }
      const lt = buffer.indexOf("<");
      if (lt === -1) {
        ready += buffer;
        buffer = "";
        return;
      }
      ready += buffer.slice(0, lt);
      buffer = buffer.slice(lt);
      OPEN_TAG.lastIndex = 0;
      const open = OPEN_TAG.exec(buffer);
      if (open) {
        closeTag = `</${open[1]!.toLowerCase()}-${open[2]!.toLowerCase()}>`;
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
      ready += "<";
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
