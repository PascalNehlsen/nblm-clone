// "Lesesaal" design: every source gets one of HUE_SLOTS colors, so a citation chip, its passage
// and the source in the list share one color. Derived from the title, so the source list and a
// citation (which only knows the title) agree without extra data. Rendered as a data-hue
// attribute (no inline style, so a strict CSP keeps working). Pure, client-safe.

export const HUE_SLOTS = 8;

export function sourceHue(title: string): number {
  let h = 2166136261;
  for (let i = 0; i < title.length; i++) {
    h ^= title.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % HUE_SLOTS;
}

export type TextPart = { text: string } | { ref: number };

// Splits an answer into text and its [n] markers, so the markers can be shown as colored
// references. Plain strings only; React renders them as text.
export function splitRefs(content: string): TextPart[] {
  const parts: TextPart[] = [];
  const re = /\[(\d{1,2})\]/g;
  let last = 0;
  for (let m = re.exec(content); m !== null; m = re.exec(content)) {
    if (m.index > last) parts.push({ text: content.slice(last, m.index) });
    parts.push({ ref: Number(m[1]) });
    last = m.index + m[0].length;
  }
  if (last < content.length) parts.push({ text: content.slice(last) });
  return parts;
}

// Distinct slots for the sources of one notebook, in list order (up to HUE_SLOTS before they
// repeat). A title not in the map (a citation of a deleted source) falls back to sourceHue.
export function assignHues(titles: readonly string[]): Record<string, number> {
  const map: Record<string, number> = {};
  let next = 0;
  for (const title of titles) {
    if (Object.hasOwn(map, title)) continue;
    // defineProperty, not assignment: a title "__proto__" must become a key, not a prototype.
    Object.defineProperty(map, title, { value: next % HUE_SLOTS, enumerable: true, writable: true, configurable: true });
    next++;
  }
  return map;
}

export function hueFor(map: Record<string, number>, title: string): number {
  return Object.hasOwn(map, title) ? map[title]! : sourceHue(title);
}
