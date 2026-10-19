import "server-only";

// HTML to plain text for URL import (ADR 0008). A single-pass string scanner: no DOM, no
// script engine, no network, no backtracking regex, so its time is linear in the input.
// Attributes never reach the output. The result is data for chunks, nothing else.

const DROP_CONTENT = new Set([
  "script", "style", "noscript", "template", "svg", "math", "iframe", "object", "head", "select", "textarea",
]);

const BLOCK = new Set([
  "address", "article", "aside", "blockquote", "br", "caption", "dd", "details", "div", "dl", "dt",
  "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "li",
  "main", "nav", "ol", "p", "pre", "section", "summary", "table", "tbody", "td", "tfoot", "th", "thead",
  "tr", "ul",
]);

const NAMED: Readonly<Record<string, string>> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  auml: "ä", ouml: "ö", uuml: "ü", Auml: "Ä", Ouml: "Ö", Uuml: "Ü", szlig: "ß",
  ndash: "\u2013", mdash: "\u2014", hellip: "…", lsquo: "‘", rsquo: "’",
  ldquo: "“", rdquo: "”", bdquo: "„", sbquo: "‚", laquo: "«", raquo: "»",
  euro: "€", copy: "©", reg: "®", trade: "™", shy: "­", middot: "·",
  deg: "°", sect: "§", para: "¶", times: "×", divide: "÷",
};

function isAsciiLetter(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

function isNameChar(c: number): boolean {
  return isAsciiLetter(c) || (c >= 48 && c <= 57) || c === 45 || c === 95 || c === 58;
}

function codePoint(n: number): string {
  if (!Number.isFinite(n) || n <= 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return "�";
  return String.fromCodePoint(n);
}

// Returns [decoded, length consumed] or null if this is not a known entity.
function entityAt(html: string, i: number): [string, number] | null {
  // Only a short window: an unbounded search per '&' would be quadratic on "&&&&...".
  const semi = html.slice(i + 1, i + 34).indexOf(";");
  if (semi === -1) return null;
  const end = i + 1 + semi;
  const body = html.slice(i + 1, end);
  if (body.startsWith("#x") || body.startsWith("#X")) {
    const hex = body.slice(2);
    return /^[0-9a-fA-F]{1,8}$/.test(hex) ? [codePoint(parseInt(hex, 16)), end - i + 1] : null;
  }
  if (body.startsWith("#")) {
    const dec = body.slice(1);
    return /^[0-9]{1,10}$/.test(dec) ? [codePoint(parseInt(dec, 10)), end - i + 1] : null;
  }
  const named = Object.hasOwn(NAMED, body) ? NAMED[body] : undefined;
  return named === undefined ? null : [named, end - i + 1];
}

// Index just past the '>' that ends the tag starting at i, honoring quoted attribute values.
function tagEnd(html: string, i: number): number {
  let quote = 0;
  for (let j = i; j < html.length; j++) {
    const c = html.charCodeAt(j);
    if (quote !== 0) {
      if (c === quote) quote = 0;
    } else if (c === 34 || c === 39) {
      quote = c;
    } else if (c === 62) {
      return j + 1;
    }
  }
  return html.length;
}

export function htmlToText(html: string): string {
  // ASCII-only lower-casing keeps every index identical to the original.
  const lower = html.replace(/[A-Z]+/g, (s) => s.toLowerCase());
  const out: string[] = [];
  let text = "";
  const flushText = () => {
    if (text) out.push(text.replace(/[ \t\n\f\r]+/g, " "));
    text = "";
  };
  const n = html.length;
  let i = 0;

  while (i < n) {
    const c = html.charCodeAt(i);
    if (c === 60 /* < */) {
      if (lower.startsWith("<!--", i)) {
        const end = html.indexOf("-->", i + 4);
        i = end === -1 ? n : end + 3;
        continue;
      }
      if (lower.startsWith("<![cdata[", i)) {
        const end = html.indexOf("]]>", i + 9);
        i = end === -1 ? n : end + 3;
        continue;
      }
      const next = html.charCodeAt(i + 1);
      if (next === 33 /* ! */ || next === 63 /* ? */) {
        const end = html.indexOf(">", i + 2);
        i = end === -1 ? n : end + 1;
        continue;
      }
      const closing = next === 47; /* / */
      const nameStart = closing ? i + 2 : i + 1;
      if (!isAsciiLetter(html.charCodeAt(nameStart))) {
        text += "<";
        i++;
        continue;
      }
      let nameEnd = nameStart;
      while (nameEnd < n && isNameChar(html.charCodeAt(nameEnd))) nameEnd++;
      const name = lower.slice(nameStart, nameEnd);
      const end = tagEnd(html, nameEnd);
      if (BLOCK.has(name)) {
        flushText();
        out.push("\n");
      }
      const selfClosing = end >= 2 && html.charCodeAt(end - 2) === 47 && html.charCodeAt(end - 1) === 62;
      if (!closing && DROP_CONTENT.has(name) && !selfClosing) {
        const close = lower.indexOf(`</${name}`, end);
        i = close === -1 ? n : tagEnd(html, close + 2 + name.length);
        continue;
      }
      i = end;
      continue;
    }
    if (c === 38 /* & */) {
      const entity = entityAt(html, i);
      if (entity) {
        text += entity[0];
        i += entity[1];
        continue;
      }
      text += "&";
      i++;
      continue;
    }
    // A run of plain text up to the next '<' or '&'.
    let j = i + 1;
    while (j < n) {
      const d = html.charCodeAt(j);
      if (d === 60 || d === 38) break;
      j++;
    }
    text += html.slice(i, j);
    i = j;
  }
  flushText();
  return out
    .join("")
    .split("\n")
    .map((line) => line.trim())
    .join("\n");
}
