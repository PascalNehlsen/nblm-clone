import "server-only";

import { isIP } from "node:net";
import { brotliDecompressSync, gunzipSync, inflateRawSync, inflateSync } from "node:zlib";
import type { UrlErrorCategory } from "@/lib/ops/categories";
import { MAX_URL_BYTES, MAX_URL_REDIRECTS, URL_DEADLINE_MS } from "@/lib/sources/limits";
import { isBlockedAddress } from "./address";
import { bareHostname, parseImportUrl } from "./url";

// The SSRF guard (ADR 0008): every hop is parsed, resolved and checked, then the transport
// connects to exactly the address that was checked. One deadline covers DNS, connects,
// every hop and the body. Errors become fixed categories; library messages (which contain
// the host) never leave this module.

export interface TransportRequest {
  url: URL;
  address: string;
  family: 4 | 6;
  headers: Record<string, string>;
  signal: AbortSignal;
}

export interface TransportResponse {
  status: number;
  headers: Record<string, string | undefined>;
  body: AsyncIterable<Uint8Array>;
}

export interface GuardedFetchDeps {
  resolve: (host: string) => Promise<string[]>;
  transport: (req: TransportRequest) => Promise<TransportResponse>;
  deadlineMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
}

export type GuardedFetchResult =
  | { ok: true; finalUrl: URL; contentType: string; body: Uint8Array }
  | { ok: false; category: UrlErrorCategory };

export const REQUEST_HEADERS: Readonly<Record<string, string>> = {
  "user-agent": "nblm-url-import/1",
  accept: "text/html, application/xhtml+xml, text/plain;q=0.9",
  "accept-encoding": "gzip, deflate, br",
};

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const ALLOWED_TYPES = new Set(["text/html", "application/xhtml+xml", "text/plain"]);
const ENCODINGS = new Set(["", "identity", "gzip", "x-gzip", "deflate", "br"]);

class FetchFailure extends Error {
  constructor(readonly category: UrlErrorCategory) {
    super(category);
  }
}

class Deadline extends Error {}

export function mediaType(contentType: string | undefined): string {
  return (contentType ?? "").split(";")[0]!.trim().toLowerCase();
}

function closeBody(body: AsyncIterable<Uint8Array>): void {
  const iterator = body[Symbol.asyncIterator]();
  void iterator.return?.()?.catch?.(() => undefined);
}

async function readCapped(body: AsyncIterable<Uint8Array>, maxBytes: number): Promise<Buffer> {
  const parts: Buffer[] = [];
  let total = 0;
  for await (const part of body) {
    total += part.byteLength;
    if (total > maxBytes) throw new FetchFailure("url_too_large");
    parts.push(Buffer.from(part.buffer, part.byteOffset, part.byteLength));
  }
  return Buffer.concat(parts, total);
}

function decode(raw: Buffer, encoding: string, maxBytes: number): Buffer {
  const opts = { maxOutputLength: maxBytes };
  try {
    if (encoding === "gzip" || encoding === "x-gzip") return gunzipSync(raw, opts);
    if (encoding === "br") return brotliDecompressSync(raw, opts);
    if (encoding === "deflate") {
      try {
        return inflateSync(raw, opts);
      } catch (error) {
        if ((error as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") throw error;
        return inflateRawSync(raw, opts); // servers that send raw deflate
      }
    }
    return raw;
  } catch (error) {
    if ((error as { code?: string }).code === "ERR_BUFFER_TOO_LARGE" || error instanceof RangeError) {
      throw new FetchFailure("url_too_large");
    }
    throw new FetchFailure("url_unreachable");
  }
}

async function pickAddress(url: URL, deps: GuardedFetchDeps): Promise<{ address: string; family: 4 | 6 }> {
  const host = bareHostname(url);
  const literal = isIP(host);
  if (literal !== 0) return { address: host, family: literal as 4 | 6 };
  let addresses: string[];
  try {
    addresses = await deps.resolve(host);
  } catch {
    throw new FetchFailure("url_dns_failed");
  }
  if (!Array.isArray(addresses) || addresses.length === 0) throw new FetchFailure("url_dns_failed");
  if (addresses.some((a) => isBlockedAddress(a))) throw new FetchFailure("url_blocked"); // mixed records fail closed
  const address = addresses[0]!;
  return { address, family: isIP(address) === 6 ? 6 : 4 };
}

async function run(rawUrl: string, deps: GuardedFetchDeps, signal: AbortSignal): Promise<GuardedFetchResult> {
  const maxBytes = deps.maxBytes ?? MAX_URL_BYTES;
  const maxRedirects = deps.maxRedirects ?? MAX_URL_REDIRECTS;
  const first = parseImportUrl(rawUrl);
  if (!first.ok) throw new FetchFailure(first.category);
  let url = first.url;

  for (let hop = 0; ; hop++) {
    const { address, family } = await pickAddress(url, deps);
    let response: TransportResponse;
    try {
      response = await deps.transport({ url, address, family, headers: { ...REQUEST_HEADERS }, signal });
    } catch {
      if (signal.aborted) throw new Deadline();
      throw new FetchFailure("url_unreachable");
    }

    if (REDIRECT_STATUSES.has(response.status)) {
      closeBody(response.body);
      const location = response.headers["location"];
      if (!location) throw new FetchFailure("url_http_error");
      if (hop >= maxRedirects) throw new FetchFailure("url_too_many_redirects");
      let target: string;
      try {
        target = new URL(location, url).href;
      } catch {
        throw new FetchFailure("url_invalid");
      }
      const next = parseImportUrl(target);
      if (!next.ok) throw new FetchFailure(next.category);
      if (url.protocol === "https:" && next.url.protocol === "http:") throw new FetchFailure("url_blocked");
      url = next.url;
      continue;
    }
    if (response.status !== 200) {
      closeBody(response.body);
      throw new FetchFailure("url_http_error");
    }

    const contentType = response.headers["content-type"] ?? "";
    if (!ALLOWED_TYPES.has(mediaType(contentType))) {
      closeBody(response.body);
      throw new FetchFailure("url_unsupported_type");
    }
    const encoding = (response.headers["content-encoding"] ?? "").trim().toLowerCase();
    if (!ENCODINGS.has(encoding)) {
      closeBody(response.body);
      throw new FetchFailure("url_unsupported_type");
    }
    const length = response.headers["content-length"];
    if (length !== undefined && Number(length) > maxBytes) {
      closeBody(response.body);
      throw new FetchFailure("url_too_large");
    }
    let raw: Buffer;
    try {
      raw = await readCapped(response.body, maxBytes);
    } catch (error) {
      if (error instanceof FetchFailure) throw error;
      if (signal.aborted) throw new Deadline();
      throw new FetchFailure("url_unreachable");
    }
    const body = decode(raw, encoding, maxBytes);
    return { ok: true, finalUrl: url, contentType, body: new Uint8Array(body.buffer, body.byteOffset, body.byteLength) };
  }
}

export async function guardedFetch(rawUrl: string, deps: GuardedFetchDeps): Promise<GuardedFetchResult> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Deadline());
    }, deps.deadlineMs ?? URL_DEADLINE_MS);
  });
  try {
    return await Promise.race([run(rawUrl, deps, controller.signal), deadline]);
  } catch (error) {
    if (error instanceof FetchFailure) return { ok: false, category: error.category };
    if (error instanceof Deadline) return { ok: false, category: "url_timeout" };
    return { ok: false, category: "url_unreachable" };
  } finally {
    clearTimeout(timer);
  }
}
