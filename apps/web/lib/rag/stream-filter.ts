import "server-only";

// Hides citation markers from the streamed answer. Unchecked quotes never reach the browser:
// the final event carries the checked message, which replaces the streamed text. Text from a
// "[" is held back until it is clearly a marker (dropped) or clearly not (emitted). One pass
// with a cursor, so the time is linear in the input (the held text is at most MAX_HELD).

// Marker-shaped text as citations.ts removes it: any number of digits (only 1 to 2 can be
// valid), at most 8 whitespace characters after "n:". Held text is capped at MAX_HELD, so
// each check below runs on at most that many characters.
const FULL_MARKER = /^\[\d+:\s{0,8}"[^"\]]{1,2000}"\]$/;
const MARKER_PREFIX = [
  /^\[\d*$/,
  /^\[\d+:\s{0,8}$/,
  /^\[\d+:\s{0,8}"[^"\]]{0,2000}$/,
  /^\[\d+:\s{0,8}"[^"\]]{1,2000}"$/,
];
const STARTED_MARKER = /^\[\d+:/;
const STARTED_QUOTE = /^\[\d+:\s{0,8}"/;
const QUOTE_TOO_LONG = /^\[\d+:\s{0,8}"[^"\]]{2001}/;
const MAX_HELD = 2100;

function couldBeMarker(held: string): boolean {
  return MARKER_PREFIX.some((re) => re.test(held));
}

export function createMarkerFilter(emit: (text: string) => void): { push(delta: string): void; end(): void } {
  let held = "";
  // After an overlong open quote: skip the rest of the quote, then one '"' and one ']'.
  let discard: "quote" | "close-bracket" | null = null;

  const feed = (input: string): string => {
    const out: string[] = [];
    let i = 0;
    while (i < input.length) {
      if (discard !== null) {
        const c = input[i];
        if (discard === "quote") {
          if (c === '"') {
            discard = "close-bracket";
            i++;
          } else if (c === "]") {
            discard = null;
            i++;
          } else {
            i++;
          }
          continue;
        }
        // close-bracket: swallow one ']' if it follows the closing quote, else resume as text.
        if (c === "]") i++;
        discard = null;
        continue;
      }
      if (held === "") {
        // Copy the run of plain text up to the next "[" in one step.
        const next = input.indexOf("[", i);
        if (next === -1) {
          out.push(input.slice(i));
          break;
        }
        if (next > i) out.push(input.slice(i, next));
        held = "[";
        i = next + 1;
        continue;
      }
      held += input[i];
      i++;
      if (FULL_MARKER.test(held)) {
        held = "";
      } else if (QUOTE_TOO_LONG.test(held)) {
        // An open quote longer than any valid one (2,000 characters): drop the whole marker
        // through its end (citations.ts removes it from the saved answer the same way).
        held = "";
        discard = "quote";
      } else if (!couldBeMarker(held)) {
        // Not a marker: the "[" goes out, the rest is read again (it may hold a new "[").
        out.push("[");
        const rest = held.slice(1);
        held = "";
        const inner = feed(rest);
        if (inner) out.push(inner);
      } else if (held.length > MAX_HELD) {
        // Too long to be a valid marker: a quote has at most 2,000 characters. Text that still
        // starts like a marker is dropped (citations.ts removes it from the saved answer too);
        // anything else goes out unchanged.
        if (!STARTED_QUOTE.test(held)) out.push(held);
        held = "";
      }
    }
    return out.join("");
  };

  return {
    push(delta) {
      const out = feed(delta);
      if (out) emit(out);
    },
    end() {
      if (held && !STARTED_MARKER.test(held)) emit(held);
      held = "";
      discard = null;
    },
  };
}
