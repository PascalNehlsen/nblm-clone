// C2 URL import: htmlToText is our own single-pass HTML-to-text scanner (no DOM, no
// script engine, no network, no regex backtracking). See .git/C2-API-SPEC.md
// ("html.ts") and ADR 0008. Pure ASCII source: non-ASCII characters are built from
// code points so no tool can normalize them silently.
import { describe, expect, it } from "vitest";
import { htmlToText } from "@/lib/server/ingest/html";

const A_UMLAUT = String.fromCharCode(0x00e4);
const O_UMLAUT = String.fromCharCode(0x00f6);
const U_UMLAUT = String.fromCharCode(0x00fc);
const SHARP_S = String.fromCharCode(0x00df);
const REPLACEMENT = String.fromCharCode(0xfffd);
const EURO = String.fromCharCode(0x20ac);

describe("htmlToText: dropped content", () => {
  it("drops script, style, template and noscript including their contents", () => {
    const out = htmlToText(
      "<p>keep</p><script>var SECRETJS = 1;</script><style>.SECRETCSS{}</style>" +
        "<template><p>SECRETTPL</p></template><noscript>SECRETNOSCRIPT</noscript><p>end</p>",
    );
    expect(out).toContain("keep");
    expect(out).toContain("end");
    for (const secret of ["SECRETJS", "SECRETCSS", "SECRETTPL", "SECRETNOSCRIPT"]) {
      expect(out).not.toContain(secret);
    }
  });

  it("drops svg, math, iframe, object, head, select and textarea contents", () => {
    const out = htmlToText(
      "<head><title>SECRETTITLE</title></head><body>visible" +
        "<svg><text>SECRETSVG</text></svg><math>SECRETMATH</math><iframe>SECRETIFRAME</iframe>" +
        "<object>SECRETOBJECT</object><select><option>SECRETOPTION</option></select>" +
        "<textarea>SECRETTEXTAREA</textarea></body>",
    );
    expect(out).toContain("visible");
    for (const secret of ["SECRETTITLE", "SECRETSVG", "SECRETMATH", "SECRETIFRAME", "SECRETOBJECT", "SECRETOPTION", "SECRETTEXTAREA"]) {
      expect(out).not.toContain(secret);
    }
  });

  it("matches tag names case-insensitively", () => {
    const out = htmlToText("a<SCRIPT>SECRETJS</SCRIPT>b<Style>SECRETCSS</Style>c");
    expect(out).not.toContain("SECRET");
    expect(out).toContain("a");
    expect(out).toContain("c");
  });

  it("does not end a script at markup-looking text inside it", () => {
    const out = htmlToText("<script>if (a < b) { x = '<div>SECRETJS</div>'; }</script>after");
    expect(out).not.toContain("SECRETJS");
    expect(out).toContain("after");
  });

  it("drops comments, CDATA, doctype and processing instructions", () => {
    const out = htmlToText(
      "<!DOCTYPE html><?xml version='1.0'?><!-- SECRETCOMMENT --><![CDATA[SECRETCDATA]]><p>shown</p>",
    );
    expect(out).toContain("shown");
    for (const secret of ["SECRETCOMMENT", "SECRETCDATA", "DOCTYPE", "xml version"]) {
      expect(out).not.toContain(secret);
    }
  });

  it("drops an unterminated script at end of input, with or without the closing bracket", () => {
    const open = htmlToText("before<script>SECRETJS(1)");
    expect(open).toContain("before");
    expect(open).not.toContain("SECRETJS");

    const noBracket = htmlToText("before<script src=SECRETSRC");
    expect(noBracket).toContain("before");
    expect(noBracket).not.toContain("SECRET");
    expect(noBracket).not.toContain("<");
  });

  it("drops an unterminated comment and an unterminated style at end of input", () => {
    const comment = htmlToText("before<!-- SECRETCOMMENT never closed");
    expect(comment).toContain("before");
    expect(comment).not.toContain("SECRETCOMMENT");

    const style = htmlToText("before<style>.SECRETCSS{");
    expect(style).toContain("before");
    expect(style).not.toContain("SECRETCSS");
  });
});

describe("htmlToText: structure", () => {
  it("turns block tags into newlines", () => {
    for (const markup of [
      "<p>one</p><p>two</p>",
      "<div>one</div><div>two</div>",
      "one<br>two",
      "one<br/>two",
      "<ul><li>one</li><li>two</li></ul>",
      "<h1>one</h1><h2>two</h2>",
      "<section>one</section><article>two</article>",
      "<table><tr><td>one</td></tr><tr><td>two</td></tr></table>",
    ]) {
      expect(htmlToText(markup), markup).toMatch(/one\n+\s*two/);
    }
  });

  it("does not insert breaks for inline tags", () => {
    expect(htmlToText("ab<b>c</b>d<span>e</span>f")).toContain("abcdef");
  });
});

describe("htmlToText: attributes never reach the output", () => {
  it("ignores alt, src, href and title", () => {
    const out = htmlToText(
      '<img alt="SECRETALT" src="http://evil.example/x.png"><a href="javascript:alert(1)" title="SECRETTITLE">link text</a>',
    );
    expect(out).toContain("link text");
    for (const secret of ["SECRETALT", "evil.example", "javascript", "alert", "SECRETTITLE", "href", "src"]) {
      expect(out).not.toContain(secret);
    }
  });

  it("handles a quoted attribute value that contains > or a tag", () => {
    const out = htmlToText('<a title="a>SECRETGT" data-x=\'<script>SECRETSCR</script>\'>shown</a>tail');
    expect(out).toContain("shown");
    expect(out).toContain("tail");
    expect(out).not.toContain("SECRET");
  });
});

describe("htmlToText: entities", () => {
  it("decodes numeric entities (decimal and hex, either case)", () => {
    expect(htmlToText("&#228; &#xE4; &#xe4; &#8364; &#x20AC;")).toBe(
      `${A_UMLAUT} ${A_UMLAUT} ${A_UMLAUT} ${EURO} ${EURO}`,
    );
  });

  it("decodes the named subset", () => {
    expect(htmlToText("&amp; &lt; &gt; &quot; &apos;")).toBe("& < > \" '");
    expect(htmlToText("&auml;&ouml;&uuml;&szlig;")).toBe(`${A_UMLAUT}${O_UMLAUT}${U_UMLAUT}${SHARP_S}`);
    expect(htmlToText("a&nbsp;b")).not.toContain("&nbsp;");
  });

  it("turns surrogate and out-of-range code points into U+FFFD", () => {
    expect(htmlToText("x&#xD800;y")).toBe(`x${REPLACEMENT}y`);
    expect(htmlToText("x&#55296;y")).toBe(`x${REPLACEMENT}y`);
    expect(htmlToText("x&#x110000;y")).toBe(`x${REPLACEMENT}y`);
  });

  it("leaves unknown or malformed entities literal", () => {
    expect(htmlToText("&foo; &#xZZ; &amp")).toContain("&foo;");
    expect(htmlToText("Tom & Jerry")).toBe("Tom & Jerry");
    expect(htmlToText("&#xZZ;")).toBe("&#xZZ;");
  });

  it("decodes once and never re-parses the result as markup", () => {
    expect(htmlToText("&amp;lt;")).toBe("&lt;");
    expect(htmlToText("&lt;script&gt;alert(1)&lt;/script&gt;")).toBe("<script>alert(1)</script>");
  });
});

describe("htmlToText: output hygiene", () => {
  it("leaves no tag markup behind for a realistic page", () => {
    const out = htmlToText(
      '<!DOCTYPE html><html lang="de"><head><meta charset="utf-8"><title>T</title><link rel="stylesheet" href="a.css"></head>' +
        '<body class="x"><nav><a href="/">Home</a></nav><main><h1>Title</h1><p>Some <em>emphasis</em> and <a href="/x">a link</a>.</p>' +
        '<img src="x.png" alt="pic"><form><input type="text" value="v"><button>Go</button></form></main>' +
        "<footer>Footer</footer><script>run()</script></body></html>",
    );
    expect(out).toContain("Title");
    expect(out).toContain("Some emphasis and a link.");
    expect(out).not.toContain("<");
    expect(out).not.toContain(">");
  });
});

describe("htmlToText: linear time on hostile input (5 MB)", () => {
  const FIVE_MB = 5 * 1024 * 1024;

  function timed(input: string): number {
    const start = performance.now();
    htmlToText(input);
    return performance.now() - start;
  }

  it("runs a 5 MB run of '<' in linear time", { timeout: 15_000 }, () => {
    expect(timed("<".repeat(FIVE_MB))).toBeLessThan(2000);
  });

  it("runs 5 MB of '<<<<' in linear time", { timeout: 15_000 }, () => {
    expect(timed("<<<<".repeat(Math.ceil(FIVE_MB / 4)))).toBeLessThan(2000);
  });

  it("runs 5 MB of '<!--' in linear time", { timeout: 15_000 }, () => {
    expect(timed("<!--".repeat(Math.ceil(FIVE_MB / 4)))).toBeLessThan(2000);
  });

  it("runs 5 MB of unterminated '<script' openers in linear time", { timeout: 15_000 }, () => {
    expect(timed("<script>".repeat(Math.ceil(FIVE_MB / 8)))).toBeLessThan(2000);
  });

  it("runs 5 MB of unterminated attributes and entities in linear time", { timeout: 15_000 }, () => {
    expect(timed('<a b="'.repeat(Math.ceil(FIVE_MB / 6)))).toBeLessThan(2000);
    expect(timed("&#x".repeat(Math.ceil(FIVE_MB / 3)))).toBeLessThan(2000);
    expect(timed("&".repeat(FIVE_MB))).toBeLessThan(2000);
  });
});
