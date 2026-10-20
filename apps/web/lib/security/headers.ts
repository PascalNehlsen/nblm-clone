// Security headers for every response (ADR 0020). Pure, without a server-only import, so
// next.config.ts can build them. The CSP is static: Next's inline bootstrap scripts carry no
// nonce, so script-src needs 'unsafe-inline'; the XSS defence stays plain-text rendering.
// What the CSP adds: img-src 'self' (rendered output never loads a remote image), no framing,
// and requests only to this app, Supabase and Turnstile.

export interface SecurityHeader {
  key: string;
  value: string;
}

const TURNSTILE = "https://challenges.cloudflare.com";

// The origin of the Supabase URL. Refuses anything that could smuggle a directive into the
// policy. null means "no Supabase origin": only for a build without env (CI), which cannot
// serve the app anyway; the policy is then stricter, never looser.
function supabaseOrigin(url: string | null): string | null {
  if (url === null) return null;
  if (typeof url !== "string" || url === "" || /[;,\s]/.test(url)) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL must be an http(s) URL without ';', ',' or whitespace.");
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL must be an http(s) URL.");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL must be an http(s) URL.");
  }
  return parsed.origin;
}

export function securityHeaders(input: { supabaseUrl: string | null; siteUrl: string; isDev: boolean }): SecurityHeader[] {
  const supabase = supabaseOrigin(input.supabaseUrl);
  const https = input.siteUrl.startsWith("https://");
  const withSupabase = (...sources: string[]) => (supabase ? [...sources, supabase] : sources);

  const directives: [string, string[]][] = [
    ["default-src", ["'self'"]],
    ["script-src", ["'self'", "'unsafe-inline'", TURNSTILE, ...(input.isDev ? ["'unsafe-eval'"] : [])]],
    ["style-src", ["'self'", "'unsafe-inline'"]],
    ["img-src", ["'self'"]],
    ["font-src", ["'self'"]],
    ["connect-src", withSupabase("'self'")],
    ["frame-src", [TURNSTILE]],
    ["frame-ancestors", ["'none'"]],
    ["object-src", ["'none'"]],
    ["base-uri", ["'self'"]],
    // The GitHub sign-in posts a form before hydration; its redirects go to Supabase, then GitHub.
    ["form-action", [...withSupabase("'self'"), "https://github.com"]],
    ...(https ? ([["upgrade-insecure-requests", []]] as [string, string[]][]) : []),
  ];
  const csp = directives.map(([name, sources]) => [name, ...sources].join(" ")).join("; ");

  return [
    { key: "Content-Security-Policy", value: csp },
    ...(https ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" }] : []),
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), browsing-topics=()" },
    { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
    { key: "X-Frame-Options", value: "DENY" },
  ];
}
