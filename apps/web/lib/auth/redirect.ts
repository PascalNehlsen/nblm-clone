// Sanitizes the `next` parameter that login carries around, so a crafted link can never
// send a user to another origin after signing in. Anything doubtful becomes "/".

const BASE = "http://127.0.0.1";
const MAX_LENGTH = 512;

export function safeNextPath(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_LENGTH) return "/";
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  // Backslashes, whitespace and control characters are normalized differently by
  // browsers; encoded slashes and backslashes can turn into "//" after decoding.
  if (/[\\\s\u0000-\u001f\u007f]/.test(raw)) return "/";
  if (/%2f|%5c/i.test(raw)) return "/";

  let url: URL;
  try {
    url = new URL(raw, BASE);
  } catch {
    return "/";
  }
  if (url.origin !== BASE) return "/";
  // Check the normalized result again: dot segments ("/.//x", "/..//x") collapse into
  // a protocol-relative "//x" only after parsing.
  const result = url.pathname + url.search + url.hash;
  if (result.startsWith("//") || result.startsWith("/\\") || /%2f|%5c/i.test(result)) return "/";
  return result;
}
