// C2 URL import: fetchUrlText turns a guarded-fetch result into text: charset
// detection (BOM, header, meta, UTF-8), text/plain bypass, normalization and the
// 300,000 character cap. See .git/C2-API-SPEC.md ("url-source.ts"). Pure ASCII
// source: non-ASCII characters are built from code points.
import { describe, expect, it, vi } from "vitest";
import type { GuardedFetchResult } from "@/lib/server/fetch/guarded-fetch";
import { fetchUrlText } from "@/lib/server/ingest/url-source";

const A_UMLAUT = String.fromCharCode(0x00e4);
const REPLACEMENT = String.fromCharCode(0xfffd);
const BOM_CHAR = String.fromCharCode(0xfeff);
const URL_TEXT = "https://example.com/page";

function bytes(...parts: Array<string | number[]>): Uint8Array {
  const out: number[] = [];
  for (const part of parts) {
    if (typeof part === "string") for (const ch of part) out.push(ch.charCodeAt(0));
    else out.push(...part);
  }
  return Uint8Array.from(out);
}

function ok(contentType: string, body: Uint8Array): GuardedFetchResult {
  return { ok: true, finalUrl: new URL(URL_TEXT), contentType, body };
}

async function run(result: GuardedFetchResult) {
  return fetchUrlText(URL_TEXT, { fetch: async () => result });
}

describe("fetchUrlText: passes the fetch through", () => {
  it("calls fetch once with the URL and returns its failure category unchanged", async () => {
    const fetch = vi.fn(async () => ({ ok: false, category: "url_blocked" }) as GuardedFetchResult);
    const result = await fetchUrlText(URL_TEXT, { fetch });
    expect(result).toEqual({ ok: false, category: "url_blocked" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(URL_TEXT);
  });
});

describe("fetchUrlText: HTML versus plain text", () => {
  it("runs HTML through the extractor", async () => {
    const result = await run(ok("text/html; charset=utf-8", bytes("<p>a <b>bold</b> &amp; c</p><script>SECRETJS</script>")));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toContain("a bold & c");
      expect(result.text).not.toContain("<");
      expect(result.text).not.toContain("SECRETJS");
    }
  });

  it("runs application/xhtml+xml through the extractor", async () => {
    const result = await run(ok("application/xhtml+xml", bytes("<p>xhtml text</p>")));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toContain("xhtml text");
      expect(result.text).not.toContain("<p>");
    }
  });

  it("text/plain bypasses the extractor", async () => {
    const result = await run(ok("text/plain", bytes("a <b>bold</b> &amp; c\r\n<script>kept</script>")));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toContain("a <b>bold</b> &amp; c\n<script>kept</script>");
    }
  });

  it("normalizes the text (CRLF to LF, 3+ newlines to 2)", async () => {
    const result = await run(ok("text/plain", bytes("a\r\n\r\n\r\n\r\nb")));
    expect(result).toEqual({ ok: true, text: "a\n\nb" });
  });
});

describe("fetchUrlText: charset priority (BOM, header, meta, UTF-8)", () => {
  it("defaults to UTF-8", async () => {
    const result = await run(ok("text/html", bytes("<p>h", [0xc3, 0xa4], "llo</p>")));
    expect(result.ok && result.text).toContain(`h${A_UMLAUT}llo`);
  });

  it("decodes windows-1252 from the Content-Type header", async () => {
    const result = await run(ok("text/html; charset=windows-1252", bytes("<p>h", [0xe4], "llo</p>")));
    expect(result.ok && result.text).toContain(`h${A_UMLAUT}llo`);
  });

  it("accepts a quoted charset parameter and mixed case", async () => {
    const result = await run(ok('text/html; Charset="ISO-8859-1"', bytes("<p>h", [0xe4], "</p>")));
    expect(result.ok && result.text).toContain(`h${A_UMLAUT}`);
  });

  it("a UTF-8 BOM wins over the header and is not part of the text", async () => {
    const result = await run(ok("text/plain; charset=iso-8859-1", bytes([0xef, 0xbb, 0xbf], "h", [0xc3, 0xa4])));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toContain(`h${A_UMLAUT}`);
      expect(result.text).not.toContain(BOM_CHAR);
      expect(result.text).not.toContain(String.fromCharCode(0x00c3));
    }
  });

  it("a UTF-16LE BOM wins over a UTF-8 header", async () => {
    const result = await run(ok("text/plain; charset=utf-8", bytes([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00])));
    expect(result.ok && result.text).toBe("hi");
  });

  it("the header wins over a conflicting meta charset", async () => {
    const result = await run(
      ok("text/html; charset=windows-1252", bytes('<meta charset="utf-8"><p>h', [0xe4], "</p>")),
    );
    const text = result.ok ? result.text : "";
    expect(text).toContain(`h${A_UMLAUT}`);
    expect(text).not.toContain(REPLACEMENT);
  });

  it("uses <meta charset> when the header has no charset", async () => {
    const result = await run(ok("text/html", bytes('<meta charset="windows-1252"><p>h', [0xe4], "</p>")));
    expect(result.ok && result.text).toContain(`h${A_UMLAUT}`);
  });

  it("uses meta http-equiv Content-Type when the header has no charset", async () => {
    const result = await run(
      ok(
        "text/html",
        bytes('<meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1"><p>h', [0xe4], "</p>"),
      ),
    );
    expect(result.ok && result.text).toContain(`h${A_UMLAUT}`);
  });

  it("ignores a meta charset after the first 1024 bytes", async () => {
    const padding = "<!-- " + "x".repeat(1100) + " -->";
    const result = await run(ok("text/html", bytes(padding, '<meta charset="windows-1252"><p>h', [0xe4], "</p>")));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toContain(REPLACEMENT);
      expect(result.text).not.toContain(A_UMLAUT);
    }
  });

  it("ignores meta for text/plain, which also keeps the markup literal", async () => {
    const result = await run(ok("text/plain", bytes('<meta charset="windows-1252">h', [0xe4])));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toContain('<meta charset="windows-1252">');
      expect(result.text).toContain(REPLACEMENT);
    }
  });

  it("gives url_unsupported_type for an unknown charset label in the header or in meta", async () => {
    const header = await run(ok("text/html; charset=x-no-such-charset", bytes("<p>x</p>")));
    expect(header).toEqual({ ok: false, category: "url_unsupported_type" });
    const meta = await run(ok("text/html", bytes('<meta charset="x-no-such-charset"><p>x</p>')));
    expect(meta).toEqual({ ok: false, category: "url_unsupported_type" });
  });
});

describe("fetchUrlText: text limits", () => {
  it("accepts exactly 300,000 characters", async () => {
    const result = await run(ok("text/plain", bytes("a".repeat(300_000))));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.text.length).toBe(300_000);
  });

  it("gives too_many_chunks above 300,000 characters", async () => {
    const result = await run(ok("text/plain", bytes("a".repeat(300_001))));
    expect(result).toEqual({ ok: false, category: "too_many_chunks" });
  });

  it("measures the cap on the extracted text, not on the raw HTML", async () => {
    const markup = "<p>" + "<b></b>".repeat(60_000) + "short</p>"; // over 300,000 raw characters
    const result = await run(ok("text/html", bytes(markup)));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.text).toContain("short");
  });

  // Bug fix: normalizeText backtracked quadratically on long whitespace runs. The cap
  // on the text length must apply before normalizing.
  it("rejects 5 MB of spaces followed by x as too_many_chunks in under 1 s", async () => {
    const body = new Uint8Array(5 * 1024 * 1024 + 1).fill(0x20);
    body[body.length - 1] = 0x78;
    const start = performance.now();
    const result = await run(ok("text/plain", body));
    const elapsed = performance.now() - start;
    expect(result).toEqual({ ok: false, category: "too_many_chunks" });
    expect(elapsed).toBeLessThan(1000);
  }, 10_000);

  it("returns quickly for HTML made of 2,500,000 space and vertical tab pairs", async () => {
    const body = bytes("<p>" + " \v".repeat(2_500_000) + "x");
    const start = performance.now();
    await run(ok("text/html", body));
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(2000);
  }, 10_000);

  it("gives no_text for an empty body and for HTML without visible text", async () => {
    expect(await run(ok("text/plain", bytes("")))).toEqual({ ok: false, category: "no_text" });
    expect(await run(ok("text/html", bytes("<script>SECRETJS</script><style>a{}</style><!-- c -->")))).toEqual({
      ok: false,
      category: "no_text",
    });
  });
});
