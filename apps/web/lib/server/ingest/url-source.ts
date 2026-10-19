import "server-only";

import type { GuardedFetchResult } from "@/lib/server/fetch/guarded-fetch";
import { mediaType } from "@/lib/server/fetch/guarded-fetch";
import { MAX_URL_TEXT_CHARS } from "@/lib/sources/limits";
import { htmlToText } from "./html";
import { normalizeText } from "./normalize";

// A web page as source text (ADR 0008): the guarded fetch, charset detection, the HTML
// extractor and the normalization every source goes through. Only categories leave here.

export type UrlTextResult = { ok: true; text: string } | { ok: false; category: string };

const META_WINDOW = 1024;

function bomCharset(bytes: Uint8Array): string | null {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "utf-8";
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
  return null;
}

function headerCharset(contentType: string): string | null {
  const match = /;\s*charset\s*=\s*"?([^;"\s]+)/i.exec(contentType);
  return match ? match[1]! : null;
}

function metaCharset(bytes: Uint8Array): string | null {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, META_WINDOW));
  const match = /<meta[^>]{0,512}?charset\s*=\s*["']?\s*([A-Za-z0-9_.:-]{1,40})/i.exec(head);
  return match ? match[1]! : null;
}

function decodeBody(bytes: Uint8Array, contentType: string, html: boolean): string | null {
  const label = bomCharset(bytes) ?? headerCharset(contentType) ?? (html ? metaCharset(bytes) : null) ?? "utf-8";
  try {
    return new TextDecoder(label.toLowerCase(), { fatal: false }).decode(bytes);
  } catch {
    return null; // unknown label
  }
}

export async function fetchUrlText(
  url: string,
  deps: { fetch: (url: string) => Promise<GuardedFetchResult> },
): Promise<UrlTextResult> {
  const result = await deps.fetch(url);
  if (!result.ok) return { ok: false, category: result.category };

  const type = mediaType(result.contentType);
  const html = type !== "text/plain";
  const decoded = decodeBody(result.body, result.contentType, html);
  if (decoded === null) return { ok: false, category: "url_unsupported_type" };

  // Refuse far-too-long text before normalizing, so no later step runs on megabytes.
  const raw = html ? htmlToText(decoded) : decoded;
  if (raw.length > 2 * MAX_URL_TEXT_CHARS) return { ok: false, category: "too_many_chunks" };
  const text = normalizeText(raw).trim();
  if (text === "") return { ok: false, category: "no_text" };
  if (text.length > MAX_URL_TEXT_CHARS) return { ok: false, category: "too_many_chunks" };
  return { ok: true, text };
}
