// C2 URL import: parseImportUrl is the syntactic half of the SSRF guard (no DNS).
// See .git/C2-API-SPEC.md ("url.ts") and ADR 0008. Categories: url_invalid for an
// unparsable URL, too long or a scheme other than http(s); url_blocked for
// credentials, an explicit non-default port, single-label hosts and blocked IP literals.
import { describe, expect, it } from "vitest";
import { parseImportUrl } from "@/lib/server/fetch/url";

const U_UMLAUT = String.fromCharCode(0x00fc);

function category(raw: string): string {
  const result = parseImportUrl(raw);
  return result.ok ? "ok" : result.category;
}

describe("parseImportUrl: accepted URLs", () => {
  it("accepts a plain https URL and returns the parsed URL", () => {
    const result = parseImportUrl("https://example.com/path?q=1");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.url.href).toBe("https://example.com/path?q=1");
    }
  });

  it("accepts the default ports spelled out (they canonicalize away)", () => {
    expect(category("https://example.com:443/")).toBe("ok");
    expect(category("http://example.com:80/")).toBe("ok");
  });

  it("accepts a trailing dot on a multi-label host", () => {
    expect(category("https://example.com./")).toBe("ok");
  });

  it("accepts a public IPv4 and a public IPv6 literal", () => {
    expect(category("http://93.184.215.14/x")).toBe("ok");
    expect(category("https://[2606:4700::1111]/x")).toBe("ok");
  });

  it("strips the fragment", () => {
    const result = parseImportUrl("https://example.com/a#frag");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.url.hash).toBe("");
      expect(result.url.href).not.toContain("#");
    }
  });

  it("returns an IDN host punycoded", () => {
    const result = parseImportUrl(`https://b${U_UMLAUT}cher.example/`);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.url.hostname).toBe("xn--bcher-kva.example");
    }
  });
});

describe("parseImportUrl: scheme and syntax give url_invalid", () => {
  it("refuses ftp, file, javascript and data", () => {
    for (const raw of [
      "ftp://example.com/file",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/html,<p>x</p>",
      "gopher://example.com/",
      "ws://example.com/",
    ]) {
      expect(category(raw), raw).toBe("url_invalid");
    }
  });

  it("refuses strings that are not absolute URLs", () => {
    for (const raw of ["", "   ", "not a url", "//example.com/", "/path", "http://", "http://exa mple.com/"]) {
      expect(category(raw), JSON.stringify(raw)).toBe("url_invalid");
    }
  });

  it("refuses an IPv6 zone id and malformed numeric hosts", () => {
    expect(category("http://[fe80::1%25eth0]/")).toBe("url_invalid");
    expect(category("http://256.256.256.256/")).toBe("url_invalid");
    expect(category("http://1.2.3.4.5/")).not.toBe("ok");
  });
});

describe("parseImportUrl: length limit (2048 characters)", () => {
  const prefix = "https://example.com/";

  it("accepts exactly 2048 characters", () => {
    expect(category(prefix + "a".repeat(2048 - prefix.length))).toBe("ok");
  });

  it("refuses 2049 characters", () => {
    expect(category(prefix + "a".repeat(2049 - prefix.length))).toBe("url_invalid");
  });

  it("refuses a URL that is short raw but longer than 2048 after parsing", () => {
    const raw = prefix + U_UMLAUT.repeat(400); // each one becomes %C3%BC (6 characters)
    expect(raw.length).toBeLessThan(2048);
    expect(category(raw)).toBe("url_invalid");
  });
});

describe("parseImportUrl: url_blocked rules", () => {
  it("refuses credentials", () => {
    expect(category("https://user@example.com/")).toBe("url_blocked");
    expect(category("https://user:pw@example.com/")).toBe("url_blocked");
    expect(category("http://:pw@example.com/")).toBe("url_blocked");
  });

  it("refuses explicit non-default ports", () => {
    for (const raw of [
      "http://example.com:8080/",
      "https://example.com:22/",
      "http://example.com:0/",
      "https://example.com:80/",
      "http://example.com:443/",
      "https://example.com:8443/",
    ]) {
      expect(category(raw), raw).toBe("url_blocked");
    }
  });

  it("refuses single-label hosts and localhost in every spelling", () => {
    for (const raw of [
      "http://intranet/",
      "http://intranet./",
      "http://localhost/",
      "http://LOCALHOST/",
      "http://localhost./",
      "http://foo.localhost/",
      "http://a.b.localhost./",
    ]) {
      expect(category(raw), raw).toBe("url_blocked");
    }
  });

  it("refuses blocked IPv4 literals", () => {
    for (const raw of [
      "http://127.0.0.1/",
      "http://10.0.0.1/",
      "http://169.254.169.254/latest/meta-data/",
      "http://100.100.100.200/",
      "http://192.168.1.1/",
      "http://0.0.0.0/",
    ]) {
      expect(category(raw), raw).toBe("url_blocked");
    }
  });

  it("refuses alternative IPv4 notations (decimal, octal, hex, short, mixed)", () => {
    for (const raw of [
      "http://2130706433/", // 127.0.0.1 as one decimal
      "http://0177.0.0.1/", // octal
      "http://0x7f.0.0.1/",
      "http://0x7f000001/",
      "http://0x7f.1/",
      "http://127.1/",
      "http://127.0.1/",
      "http://2852039166/", // 169.254.169.254
      "http://0xa9fea9fe/",
      "http://0251.0376.0251.0376/",
    ]) {
      expect(category(raw), raw).toBe("url_blocked");
    }
  });

  it("refuses blocked IPv6 literals, including IPv4-mapped and metadata", () => {
    for (const raw of [
      "http://[::1]/",
      "http://[::]/",
      "http://[::ffff:127.0.0.1]/",
      "http://[::ffff:7f00:1]/",
      "http://[fd00:ec2::254]/",
      "http://[fe80::1]/",
      "http://[64:ff9b::a9fe:a9fe]/",
      "http://[2002:7f00:1::]/",
      "http://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/",
    ]) {
      expect(category(raw), raw).toBe("url_blocked");
    }
  });
});
