import "server-only";

// Hides citation markers from the streamed answer. Unchecked quotes never reach the browser:
// the final event carries the checked message, which replaces the streamed text. Text from a
// "[" is held back until it is clearly a marker (dropped) or clearly not (emitted).

// Same grammar as MARKER in citations.ts: at most 8 whitespace characters after "n:", so a
// marker can never be longer than the held-text limit below.
const FULL_MARKER = /^\[\d{1,2}:\s{0,8}"[^"\]]{1,2000}"\]$/;
const MARKER_PREFIX = [
  /^\[\d{0,2}$/,
  /^\[\d{1,2}:\s{0,8}$/,
  /^\[\d{1,2}:\s{0,8}"[^"\]]{0,2000}$/,
  /^\[\d{1,2}:\s{0,8}"[^"\]]{1,2000}"$/,
];
const STARTED_MARKER = /^\[\d{1,2}:/;
const MAX_HELD = 2100;

function couldBeMarker(held: string): boolean {
  return MARKER_PREFIX.some((re) => re.test(held));
}

export function createMarkerFilter(emit: (text: string) => void): { push(delta: string): void; end(): void } {
  let held = "";

  const feed = (input: string): string => {
    let out = "";
    const queue = [...input];
    while (queue.length > 0) {
      const c = queue.shift()!;
      if (held === "") {
        if (c === "[") held = "[";
        else out += c;
        continue;
      }
      held += c;
      if (FULL_MARKER.test(held)) {
        held = "";
      } else if (!couldBeMarker(held)) {
        // Not a marker: the "[" goes out, the rest is looked at again (it may hold a new "[").
        out += "[";
        queue.unshift(...held.slice(1));
        held = "";
      } else if (held.length > MAX_HELD) {
        out += held;
        held = "";
      }
    }
    return out;
  };

  return {
    push(delta) {
      const out = feed(delta);
      if (out) emit(out);
    },
    end() {
      if (held && !STARTED_MARKER.test(held)) emit(held);
      held = "";
    },
  };
}
