# 0020: A static Content-Security-Policy and security headers on every response

- Status: accepted (Pascal, 2026-10-20)
- Date: 2026-10-20

## Context

AGENTS.md says rendered model output never loads remote content and that the CSP (`img-src 'self'`) backs this up, but the app sent no CSP and no security headers. Answers are rendered as plain text, so the CSP is a second line: it stops a remote image, a frame or a request to a foreign host if the first line ever breaks. Next.js injects inline bootstrap scripts; a nonce-based policy would need the proxy to set a nonce per request and would make every page dynamic, including the prerendered legal pages.

## Decision

`apps/web/lib/security/headers.ts` builds the headers and `next.config.ts` sends them on `/:path*`:

- **CSP, enforced:**
  - `default-src 'self'`.
  - `script-src 'self' 'unsafe-inline'` plus Turnstile; `'unsafe-eval'` only in development.
  - `style-src 'self' 'unsafe-inline'`.
  - `img-src 'self'` and `font-src 'self'`.
  - `connect-src 'self'` plus the Supabase origin.
  - `frame-src` Turnstile only.
  - `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`.
  - `form-action 'self'` plus Supabase and GitHub, for the GitHub sign-in before hydration.
  - `upgrade-insecure-requests` on https.
- **Other headers:**
  - HSTS for two years with `includeSubDomains` and without `preload`, on https.
  - `nosniff`, `strict-origin-when-cross-origin`, a minimal Permissions-Policy, COOP `same-origin` and `X-Frame-Options: DENY`.
- **Bad URL:** a Supabase URL that is not http(s) or contains `;`, `,` or whitespace fails the build.
- **Build without env:** the CI build job has no env, so its policy has no Supabase origin. The policy is never looser.
- **Release gate:** the release smoke fails if `/login` lacks `img-src 'self'` or `frame-ancestors 'none'`.

## Consequences

- An injected remote image, frame or fetch to a foreign host is blocked and reported by the browser. The e2e test proves enforcement with an injected `<img>`.
- `'unsafe-inline'` scripts mean the CSP is no XSS defence on its own; plain-text rendering stays the primary control (SECURITY.md LLM05).
- Every new browser-side origin needs a CSP change. Sentry (ingest host), for example, comes with its own PR.
- The Vercel toolbar on previews is blocked.
- HSTS without `preload` stays reversible.
- Revisit with a nonce policy once Next can nonce prerendered pages, or if any HTML rendering of model output is ever added.

## Alternatives considered

- **Nonce plus `'strict-dynamic'` via the proxy:** stronger against XSS, but it makes all pages dynamic and changes the auth path. It is a follow-up, not v1.
- **Report-only first:** there is no report collector yet, and the e2e suite already shows breakage before merge.
- **HSTS `preload`:** practically irreversible for the domain.
