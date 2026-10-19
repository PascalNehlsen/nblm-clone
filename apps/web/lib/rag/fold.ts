import "server-only";

// Folding for the citation check (ADR 0016): maps spelling and typography variants that the
// model tends to change (whitespace, quotation marks, apostrophes, dashes, ellipsis, ß) to one
// form, and records for every folded code unit which source character produced it, so a match
// in the folded text can be mapped back to the verbatim source span. Case and diacritics are
// kept. One pass, no regex: linear in the input length.

export interface Folded {
  text: string;
  /** start[j], end[j]: bounds in the NFC input of the source character behind folded unit j. */
  start: Int32Array;
  end: Int32Array;
}

function isSpace(c: number): boolean {
  return (
    (c >= 0x09 && c <= 0x0d) ||
    c === 0x20 ||
    c === 0x85 ||
    c === 0xa0 ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000
  );
}

function isRemoved(c: number): boolean {
  return c === 0xad || (c >= 0x200b && c <= 0x200d) || c === 0x2060 || c === 0xfeff;
}

function isQuote(c: number): boolean {
  return (
    c === 0x22 ||
    c === 0x27 ||
    c === 0x60 ||
    c === 0xab ||
    c === 0xb4 ||
    c === 0xbb ||
    (c >= 0x2018 && c <= 0x201f) ||
    c === 0x2032 ||
    c === 0x2033 ||
    c === 0x2039 ||
    c === 0x203a
  );
}

function isDash(c: number): boolean {
  return (c >= 0x2010 && c <= 0x2015) || c === 0x2212;
}

function replacement(c: number): string | null {
  if (isQuote(c)) return "'";
  if (isDash(c)) return "-";
  if (c === 0x2026) return "...";
  if (c === 0xdf) return "ss";
  if (c === 0x1e9e) return "SS";
  return null;
}

export function fold(input: string): Folded {
  const s = input.normalize("NFC");
  // Every source code unit yields at most three folded units ("..." from one unit).
  const start = new Int32Array(s.length * 3);
  const end = new Int32Array(s.length * 3);
  let out = "";
  let n = 0;
  const emit = (text: string, from: number, to: number) => {
    for (let k = 0; k < text.length; k++) {
      start[n] = from;
      end[n] = to;
      n++;
    }
    out += text;
  };

  let i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (isSpace(c)) {
      let j = i + 1;
      while (j < s.length && isSpace(s.charCodeAt(j))) j++;
      emit(" ", i, j);
      i = j;
      continue;
    }
    if (isRemoved(c)) {
      i++;
      continue;
    }
    const isPair = c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && s.charCodeAt(i + 1) >= 0xdc00 && s.charCodeAt(i + 1) <= 0xdfff;
    if (isPair) {
      emit(s.slice(i, i + 2), i, i + 2);
      i += 2;
      continue;
    }
    emit(replacement(c) ?? s[i]!, i, i + 1);
    i++;
  }

  return { text: out, start: start.slice(0, n), end: end.slice(0, n) };
}
