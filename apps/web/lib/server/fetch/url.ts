import "server-only";

import { isIP } from "node:net";
import { MAX_URL_LENGTH } from "@/lib/sources/limits";
import { isBlockedAddress } from "./address";

// The syntactic rules of the SSRF guard (ADR 0008), for the URL the user entered and for
// every redirect target. No DNS here: names are resolved and checked in guarded-fetch.ts.

export type ParsedImportUrl = { ok: true; url: URL } | { ok: false; category: "url_invalid" | "url_blocked" };

// The hostname without IPv6 brackets.
export function bareHostname(url: URL): string {
  return url.hostname.startsWith("[") && url.hostname.endsWith("]") ? url.hostname.slice(1, -1) : url.hostname;
}

export function parseImportUrl(raw: string): ParsedImportUrl {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_URL_LENGTH) {
    return { ok: false, category: "url_invalid" };
  }
  let url: URL;
  try {
    url = new URL(raw); // WHATWG: canonicalizes decimal, octal, hex and short IPv4 forms
  } catch {
    return { ok: false, category: "url_invalid" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, category: "url_invalid" };
  url.hash = "";
  if (url.href.length > MAX_URL_LENGTH) return { ok: false, category: "url_invalid" };
  if (url.username !== "" || url.password !== "") return { ok: false, category: "url_blocked" };
  if (url.port !== "") return { ok: false, category: "url_blocked" }; // only the default port

  const host = bareHostname(url);
  if (host === "") return { ok: false, category: "url_invalid" };
  if (isIP(host) !== 0) {
    return isBlockedAddress(host) ? { ok: false, category: "url_blocked" } : { ok: true, url };
  }
  const name = host.endsWith(".") ? host.slice(0, -1) : host;
  if (!name.includes(".")) return { ok: false, category: "url_blocked" }; // single label, intranet names
  if (name === "localhost" || name.endsWith(".localhost")) return { ok: false, category: "url_blocked" };
  return { ok: true, url };
}
