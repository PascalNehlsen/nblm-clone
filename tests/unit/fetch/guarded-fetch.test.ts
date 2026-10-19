// C2 URL import: guardedFetch (redirect loop, pinning, limits, decoding) with a fake
// resolver and a fake transport only. No network, no real DNS. See
// .git/C2-API-SPEC.md ("guarded-fetch.ts") and ADR 0008.
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  guardedFetch,
  type GuardedFetchDeps,
  type TransportRequest,
  type TransportResponse,
} from "@/lib/server/fetch/guarded-fetch";

const PUBLIC_V4 = "93.184.215.14";
const PUBLIC_V6 = "2606:4700::1111";
const encoder = new TextEncoder();

async function* chunksOf(...chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const chunk of chunks) yield chunk;
}

function html(text: string, headers: Record<string, string> = {}): TransportResponse {
  return {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", ...headers },
    body: chunksOf(encoder.encode(text)),
  };
}

function redirect(location: string | undefined, status = 302): TransportResponse {
  return {
    status,
    headers: location === undefined ? {} : { location },
    body: chunksOf(),
  };
}

function bodyOf(bytes: Uint8Array, headers: Record<string, string>, size = 1000): TransportResponse {
  const parts: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length; offset += size) parts.push(bytes.subarray(offset, offset + size));
  return { status: 200, headers: { "content-type": "text/html", ...headers }, body: chunksOf(...parts) };
}

interface Harness {
  deps: GuardedFetchDeps;
  requests: TransportRequest[];
  resolved: string[];
}

function harness(
  respond: (req: TransportRequest, index: number) => TransportResponse | Promise<TransportResponse>,
  options: {
    resolve?: (host: string, index: number) => string[] | Promise<string[]>;
  } & Partial<Omit<GuardedFetchDeps, "resolve">> = {},
): Harness {
  const requests: TransportRequest[] = [];
  const resolved: string[] = [];
  const { resolve, ...rest } = options;
  const deps: GuardedFetchDeps = {
    resolve: async (host) => {
      const index = resolved.length;
      resolved.push(host);
      return resolve ? resolve(host, index) : [PUBLIC_V4];
    },
    transport: async (req) => {
      const index = requests.length;
      requests.push(req);
      return respond(req, index);
    },
    ...rest,
  };
  return { deps, requests, resolved };
}

describe("guardedFetch: success path and request shape", () => {
  it("returns the final URL, the raw content type and the body", async () => {
    const h = harness(() => html("<p>hello</p>"));
    const result = await guardedFetch("https://example.com/a#frag", h.deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.finalUrl.href).toBe("https://example.com/a");
      expect(result.contentType).toBe("text/html; charset=utf-8");
      expect(new TextDecoder().decode(result.body)).toBe("<p>hello</p>");
    }
  });

  it("sends exactly the three fixed request headers (no cookies, referer, auth)", async () => {
    const h = harness(() => html("x"));
    await guardedFetch("https://example.com/", h.deps);
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]!.headers).toEqual({
      "user-agent": "nblm-url-import/1",
      accept: "text/html, application/xhtml+xml, text/plain;q=0.9",
      "accept-encoding": "gzip, deflate, br",
    });
  });

  it("refuses an invalid URL before resolving or connecting", async () => {
    const h = harness(() => html("x"));
    expect(await guardedFetch("ftp://example.com/", h.deps)).toEqual({ ok: false, category: "url_invalid" });
    expect(await guardedFetch("http://localhost/", h.deps)).toEqual({ ok: false, category: "url_blocked" });
    expect(h.resolved).toEqual([]);
    expect(h.requests).toEqual([]);
  });

  it("accepts each allowed content type, case-insensitively and ignoring parameters", async () => {
    for (const contentType of ["text/plain", "TEXT/HTML", "application/xhtml+xml", "text/html; charset=iso-8859-1"]) {
      const h = harness(() => ({ status: 200, headers: { "content-type": contentType }, body: chunksOf(encoder.encode("x")) }));
      const result = await guardedFetch("https://example.com/", h.deps);
      expect(result.ok, contentType).toBe(true);
      if (result.ok) expect(result.contentType).toBe(contentType);
    }
  });
});

describe("guardedFetch: DNS and pinning", () => {
  it("fails closed when one of several records is private", async () => {
    const h = harness(() => html("x"), { resolve: () => [PUBLIC_V4, "10.0.0.5"] });
    expect(await guardedFetch("https://example.com/", h.deps)).toEqual({ ok: false, category: "url_blocked" });
    expect(h.requests).toEqual([]);
  });

  it("fails closed when an IPv6 record is blocked, whatever the order", async () => {
    const h = harness(() => html("x"), { resolve: () => ["fd00:ec2::254", PUBLIC_V4] });
    expect(await guardedFetch("https://example.com/", h.deps)).toEqual({ ok: false, category: "url_blocked" });
    expect(h.requests).toEqual([]);
  });

  it("hands the transport exactly the checked address and family, with the real host name in the URL", async () => {
    const h = harness(() => html("x"));
    await guardedFetch("https://example.com/p", h.deps);
    expect(h.resolved).toEqual(["example.com"]);
    expect(h.requests[0]!.address).toBe(PUBLIC_V4);
    expect(h.requests[0]!.family).toBe(4);
    expect(h.requests[0]!.url.hostname).toBe("example.com");
    expect(h.requests[0]!.signal).toBeInstanceOf(AbortSignal);
  });

  it("connects to the first address and reports family 6 for an IPv6 address", async () => {
    const h = harness(() => html("x"), { resolve: () => [PUBLIC_V6, PUBLIC_V4] });
    await guardedFetch("https://example.com/", h.deps);
    expect(h.requests[0]!.address).toBe(PUBLIC_V6);
    expect(h.requests[0]!.family).toBe(6);
  });

  it("skips the resolver for IP literals and connects to the literal", async () => {
    const h = harness(() => html("x"));
    await guardedFetch(`http://${PUBLIC_V4}/`, h.deps);
    await guardedFetch(`https://[${PUBLIC_V6}]/`, h.deps);
    expect(h.resolved).toEqual([]);
    expect(h.requests[0]!.address).toBe(PUBLIC_V4);
    expect(h.requests[0]!.family).toBe(4);
    expect(h.requests[1]!.address).toBe(PUBLIC_V6);
    expect(h.requests[1]!.family).toBe(6);
  });

  it("refuses a blocked IP literal in decimal notation without resolving", async () => {
    const h = harness(() => html("x"));
    expect(await guardedFetch("http://2130706433/", h.deps)).toEqual({ ok: false, category: "url_blocked" });
    expect(h.resolved).toEqual([]);
    expect(h.requests).toEqual([]);
  });

  it("resolves once per hop, each time with the hop's host", async () => {
    const h = harness((_req, index) => (index === 0 ? redirect("https://other.example.org/x") : html("done")));
    const result = await guardedFetch("https://example.com/", h.deps);
    expect(result.ok).toBe(true);
    expect(h.resolved).toEqual(["example.com", "other.example.org"]);
    expect(h.requests).toHaveLength(2);
  });

  it("a rebinding resolver (public first, then loopback) cannot change the connect target of a hop", async () => {
    const h = harness(() => html("x"), { resolve: (_host, index) => (index === 0 ? [PUBLIC_V4] : ["127.0.0.1"]) });
    const result = await guardedFetch("https://example.com/", h.deps);
    expect(result.ok).toBe(true);
    expect(h.resolved).toHaveLength(1);
    expect(h.requests.map((r) => r.address)).toEqual([PUBLIC_V4]);
  });

  it("a redirect back to the same host is resolved again, so a rebind to loopback is blocked", async () => {
    const h = harness(() => redirect("https://example.com/second"), {
      resolve: (_host, index) => (index === 0 ? [PUBLIC_V4] : ["127.0.0.1"]),
    });
    expect(await guardedFetch("https://example.com/", h.deps)).toEqual({ ok: false, category: "url_blocked" });
    expect(h.requests).toHaveLength(1);
  });

  it("gives url_dns_failed for no address and for a resolver error", async () => {
    const empty = harness(() => html("x"), { resolve: () => [] });
    expect(await guardedFetch("https://example.com/", empty.deps)).toEqual({ ok: false, category: "url_dns_failed" });
    expect(empty.requests).toEqual([]);

    const failing = harness(() => html("x"), {
      resolve: () => {
        throw new Error("getaddrinfo ENOTFOUND secret-host.example");
      },
    });
    const result = await guardedFetch("https://example.com/", failing.deps);
    expect(result).toEqual({ ok: false, category: "url_dns_failed" });
    expect(JSON.stringify(result)).not.toContain("secret-host");
  });
});

describe("guardedFetch: redirects", () => {
  it("blocks a redirect to the metadata address and never connects to it", async () => {
    const h = harness(() => redirect("http://169.254.169.254/latest/meta-data/"));
    expect(await guardedFetch("http://example.com/", h.deps)).toEqual({ ok: false, category: "url_blocked" });
    expect(h.requests).toHaveLength(1);
  });

  it("blocks a redirect to a host that resolves to a private address", async () => {
    const h = harness(() => redirect("https://internal.example.org/"), {
      resolve: (host) => (host === "internal.example.org" ? ["192.168.0.10"] : [PUBLIC_V4]),
    });
    expect(await guardedFetch("https://example.com/", h.deps)).toEqual({ ok: false, category: "url_blocked" });
    expect(h.requests).toHaveLength(1);
  });

  it("applies the URL rules to every redirect target", async () => {
    const ftp = harness(() => redirect("ftp://example.com/x"));
    expect(await guardedFetch("https://example.com/", ftp.deps)).toEqual({ ok: false, category: "url_invalid" });

    const port = harness(() => redirect("https://example.com:8443/x"));
    expect(await guardedFetch("https://example.com/", port.deps)).toEqual({ ok: false, category: "url_blocked" });

    const creds = harness(() => redirect("https://user:pw@example.org/x"));
    expect(await guardedFetch("https://example.com/", creds.deps)).toEqual({ ok: false, category: "url_blocked" });

    const localhost = harness(() => redirect("http://localhost/"));
    expect(await guardedFetch("https://example.com/", localhost.deps)).toEqual({ ok: false, category: "url_blocked" });
  });

  it("blocks a downgrade from https to http", async () => {
    const h = harness(() => redirect("http://example.org/"));
    expect(await guardedFetch("https://example.com/", h.deps)).toEqual({ ok: false, category: "url_blocked" });
    expect(h.requests).toHaveLength(1);
  });

  it("allows http to https and http to http", async () => {
    const up = harness((_req, index) => (index === 0 ? redirect("https://example.com/s") : html("ok")));
    expect((await guardedFetch("http://example.com/", up.deps)).ok).toBe(true);
    const same = harness((_req, index) => (index === 0 ? redirect("http://example.org/s") : html("ok")));
    expect((await guardedFetch("http://example.com/", same.deps)).ok).toBe(true);
  });

  it("resolves relative Location headers against the current URL", async () => {
    const rooted = harness((_req, index) => (index === 0 ? redirect("/b?x=1#f") : html("ok")));
    const a = await guardedFetch("https://example.com/a/x", rooted.deps);
    expect(a.ok).toBe(true);
    if (a.ok) expect(a.finalUrl.href).toBe("https://example.com/b?x=1");

    const relative = harness((_req, index) => (index === 0 ? redirect("y") : html("ok")));
    const b = await guardedFetch("https://example.com/a/x", relative.deps);
    expect(b.ok).toBe(true);
    if (b.ok) expect(b.finalUrl.href).toBe("https://example.com/a/y");
    expect(relative.requests[1]!.url.href).toBe("https://example.com/a/y");
  });

  it("follows 301, 302, 303, 307 and 308", async () => {
    for (const status of [301, 302, 303, 307, 308]) {
      const h = harness((_req, index) => (index === 0 ? redirect("https://example.com/next", status) : html("ok")));
      expect((await guardedFetch("https://example.com/", h.deps)).ok, String(status)).toBe(true);
    }
  });

  it("follows 5 redirects and gives url_too_many_redirects for 6", async () => {
    const chain = (count: number) =>
      harness((_req, index) => (index < count ? redirect(`https://example.com/hop${index + 1}`) : html("end")));
    const five = chain(5);
    expect((await guardedFetch("https://example.com/", five.deps)).ok).toBe(true);
    expect(five.requests).toHaveLength(6);

    const six = chain(6);
    expect(await guardedFetch("https://example.com/", six.deps)).toEqual({ ok: false, category: "url_too_many_redirects" });
    expect(six.requests.length).toBeLessThanOrEqual(6);
  });

  it("honours a smaller maxRedirects", async () => {
    const h = harness((_req, index) => redirect(`https://example.com/hop${index + 1}`), { maxRedirects: 1 });
    expect(await guardedFetch("https://example.com/", h.deps)).toEqual({ ok: false, category: "url_too_many_redirects" });
  });

  it("gives url_http_error for a redirect without Location", async () => {
    const h = harness(() => redirect(undefined));
    expect(await guardedFetch("https://example.com/", h.deps)).toEqual({ ok: false, category: "url_http_error" });
  });

  it("always sends the same GET headers on every hop", async () => {
    const h = harness((_req, index) => (index === 0 ? redirect("https://example.org/") : html("ok")));
    await guardedFetch("https://example.com/", h.deps);
    expect(h.requests[1]!.headers).toEqual(h.requests[0]!.headers);
  });
});

describe("guardedFetch: status", () => {
  it("gives url_http_error for every non-200, non-redirect status", async () => {
    for (const status of [204, 300, 304, 400, 403, 404, 429, 500, 503]) {
      const h = harness(() => ({ status, headers: { "content-type": "text/html" }, body: chunksOf(encoder.encode("x")) }));
      expect(await guardedFetch("https://example.com/", h.deps), String(status)).toEqual({
        ok: false,
        category: "url_http_error",
      });
    }
  });
});

describe("guardedFetch: content type", () => {
  it("gives url_unsupported_type for pdf, png, json, a lookalike and a missing type, without reading the body", async () => {
    const headersList: Array<Record<string, string>> = [
      { "content-type": "application/pdf" },
      { "content-type": "image/png" },
      { "content-type": "application/json" },
      { "content-type": "text/htmlx" },
      {},
    ];
    for (const headers of headersList) {
      let read = false;
      const h = harness(() => ({
        status: 200,
        headers,
        body: (async function* () {
          read = true;
          yield encoder.encode("x");
        })(),
      }));
      expect(await guardedFetch("https://example.com/", h.deps), JSON.stringify(headers)).toEqual({
        ok: false,
        category: "url_unsupported_type",
      });
      expect(read).toBe(false);
    }
  });
});

describe("guardedFetch: size limits", () => {
  it("fails a Content-Length above maxBytes without reading the body", async () => {
    let read = false;
    const h = harness(
      () => ({
        status: 200,
        headers: { "content-type": "text/html", "content-length": "1001" },
        body: (async function* () {
          read = true;
          yield encoder.encode("x");
        })(),
      }),
      { maxBytes: 1000 },
    );
    expect(await guardedFetch("https://example.com/", h.deps)).toEqual({ ok: false, category: "url_too_large" });
    expect(read).toBe(false);
  });

  it("uses 5 MiB as the default limit for Content-Length", async () => {
    const h = harness(() => ({
      status: 200,
      headers: { "content-type": "text/html", "content-length": String(5 * 1024 * 1024 + 1) },
      body: chunksOf(),
    }));
    expect(await guardedFetch("https://example.com/", h.deps)).toEqual({ ok: false, category: "url_too_large" });
  });

  it("accepts a body of exactly maxBytes", async () => {
    const h = harness(() => bodyOf(new Uint8Array(1000).fill(97), { "content-length": "1000" }), { maxBytes: 1000 });
    const result = await guardedFetch("https://example.com/", h.deps);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.body.length).toBe(1000);
  });

  it("aborts a streamed body that grows past maxBytes without a Content-Length", async () => {
    let pulled = 0;
    const h = harness(
      () => ({
        status: 200,
        headers: { "content-type": "text/html" },
        body: (async function* () {
          for (let i = 0; i < 50; i += 1) {
            pulled += 1;
            yield new Uint8Array(600).fill(97);
          }
        })(),
      }),
      { maxBytes: 1000 },
    );
    expect(await guardedFetch("https://example.com/", h.deps)).toEqual({ ok: false, category: "url_too_large" });
    expect(pulled).toBeLessThan(10);
  });

  it("caps a gzip bomb on the decoded bytes", async () => {
    const bomb = gzipSync(Buffer.alloc(2_000_000, 0x61));
    expect(bomb.length).toBeLessThan(5000);
    const h = harness(() => bodyOf(bomb, { "content-encoding": "gzip" }), { maxBytes: 10_000 });
    expect(await guardedFetch("https://example.com/", h.deps)).toEqual({ ok: false, category: "url_too_large" });
  });

  it("caps a deflate and a brotli bomb on the decoded bytes too", async () => {
    const plain = Buffer.alloc(2_000_000, 0x61);
    const deflate = harness(() => bodyOf(deflateSync(plain), { "content-encoding": "deflate" }), { maxBytes: 10_000 });
    expect(await guardedFetch("https://example.com/", deflate.deps)).toEqual({ ok: false, category: "url_too_large" });
    const br = harness(() => bodyOf(brotliCompressSync(plain), { "content-encoding": "br" }), { maxBytes: 10_000 });
    expect(await guardedFetch("https://example.com/", br.deps)).toEqual({ ok: false, category: "url_too_large" });
  });
});

describe("guardedFetch: content encoding", () => {
  const original = "Hello, encoded world. ".repeat(100);

  it("decodes gzip, deflate and br, also when split into small chunks", async () => {
    const plain = Buffer.from(original);
    const cases: Array<[string, Buffer]> = [
      ["gzip", gzipSync(plain)],
      ["deflate", deflateSync(plain)],
      ["br", brotliCompressSync(plain)],
    ];
    for (const [encoding, bytes] of cases) {
      const h = harness(() => bodyOf(bytes, { "content-encoding": encoding }, 7));
      const result = await guardedFetch("https://example.com/", h.deps);
      expect(result.ok, encoding).toBe(true);
      if (result.ok) expect(new TextDecoder().decode(result.body), encoding).toBe(original);
    }
  });

  it("passes identity and absent encodings through unchanged", async () => {
    const variants: Array<Record<string, string>> = [{ "content-encoding": "identity" }, {}];
    for (const headers of variants) {
      const h = harness(() => bodyOf(Buffer.from(original), headers));
      const result = await guardedFetch("https://example.com/", h.deps);
      expect(result.ok).toBe(true);
      if (result.ok) expect(new TextDecoder().decode(result.body)).toBe(original);
    }
  });

  it("refuses any other Content-Encoding with url_unsupported_type", async () => {
    for (const encoding of ["compress", "zstd", "gzip, br", "x-unknown"]) {
      const h = harness(() => bodyOf(Buffer.from(original), { "content-encoding": encoding }));
      expect(await guardedFetch("https://example.com/", h.deps), encoding).toEqual({
        ok: false,
        category: "url_unsupported_type",
      });
    }
  });
});

describe("guardedFetch: deadline", () => {
  it("gives url_timeout when the transport never answers, and aborts the signal", async () => {
    const h = harness(() => new Promise<TransportResponse>(() => {}), { deadlineMs: 50 });
    expect(await guardedFetch("https://example.com/", h.deps)).toEqual({ ok: false, category: "url_timeout" });
    expect(h.requests[0]!.signal.aborted).toBe(true);
  });

  it("gives url_timeout when the resolver never answers (during DNS)", async () => {
    const h = harness(() => html("x"), { resolve: () => new Promise<string[]>(() => {}), deadlineMs: 50 });
    expect(await guardedFetch("https://example.com/", h.deps)).toEqual({ ok: false, category: "url_timeout" });
    expect(h.requests).toEqual([]);
  });

  it("gives url_timeout when the body stalls after the first chunk", async () => {
    const h = harness(
      () => ({
        status: 200,
        headers: { "content-type": "text/html" },
        body: (async function* () {
          yield encoder.encode("first");
          await new Promise((resolve) => setTimeout(resolve, 400));
          yield encoder.encode("second");
        })(),
      }),
      { deadlineMs: 60 },
    );
    expect(await guardedFetch("https://example.com/", h.deps)).toEqual({ ok: false, category: "url_timeout" });
  });

  it("is one deadline for all hops, not one per hop", async () => {
    const h = harness(
      async (_req, index) => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        return index < 4 ? redirect(`https://example.com/hop${index + 1}`) : html("end");
      },
      { deadlineMs: 120 },
    );
    expect(await guardedFetch("https://example.com/", h.deps)).toEqual({ ok: false, category: "url_timeout" });
  });
});

describe("guardedFetch: error handling never leaks details", () => {
  it("maps a transport error to url_unreachable and drops its message", async () => {
    const h = harness(() => {
      throw new Error("connect ECONNREFUSED secret-host.example 10.9.8.7:443");
    });
    const result = await guardedFetch("https://example.com/", h.deps);
    expect(result).toEqual({ ok: false, category: "url_unreachable" });
    expect(JSON.stringify(result)).not.toContain("secret-host");
    expect(JSON.stringify(result)).not.toContain("10.9.8.7");
  });

  it("maps a body stream error to url_unreachable", async () => {
    const h = harness(() => ({
      status: 200,
      headers: { "content-type": "text/html" },
      body: (async function* () {
        yield encoder.encode("partial");
        throw new Error("socket hang up secret-host.example");
      })(),
    }));
    const result = await guardedFetch("https://example.com/", h.deps);
    expect(result).toEqual({ ok: false, category: "url_unreachable" });
    expect(JSON.stringify(result)).not.toContain("secret-host");
  });
});
