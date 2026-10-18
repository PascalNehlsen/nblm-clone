# 0005: Sessions live in cookies, refreshed in the proxy and checked again on the server

- Status: accepted
- Date: 2026-10-18

## Context

The app signs in with GitHub through Supabase Auth (PKCE) and keeps the session in cookies through `@supabase/ssr`. Next.js 16 runs `proxy.ts` (formerly middleware) before every matched request. Login carries a `next` path that an attacker controls, OAuth redirects depend on an allowlist in Supabase Auth, and a shared cache must never store one user's session cookie for another. End-to-end tests need a logged-in browser without a backdoor in the app.

## Decision

- **Clients:** `apps/web/lib/supabase/server.ts` and `proxy.ts` (both `import "server-only"`) are the only places that create Supabase clients, always with the publishable key and the user's cookies. `env.ts` accepts only a publishable key or an anon JWT. ESLint forbids every `@supabase/*` import elsewhere (type imports allowed) and any import of `lib/server/admin` in the app.
- **Proxy:** refreshes the session with `getClaims()` on every request except build assets and static images, and sends logged-out users from anything but `/login` and `/auth/callback` to `/login?next=...`. It is a fast first check only: with asymmetric signing keys `getClaims()` verifies locally and accepts a revoked but unexpired token. So on `/login` it confirms with `getUser()` before sending a visitor to `/`; otherwise the layout's `getUser()` would send them back and the two would loop (found by the first local e2e run). It forwards the requested path as `x-request-path`, always overwriting a client value, so the layout's redirect keeps `next`.
- **Server check:** pages, server actions and route handlers that touch data call `getUser()`, which asks the Auth server. A server action runs before any layout, and client-side navigation does not re-run the layout, so the layout's check never stands in for them. The protected route group is rendered per request.
- **Redirects:** built from `NEXT_PUBLIC_SITE_URL`, never the Host header. `next` passes `safeNextPath`, which checks the raw value and again after URL normalization (dot segments can turn `/.//x` into `//x`). Supabase Auth allows exactly `http://127.0.0.1:3000/auth/callback` locally; anything else falls back to the site URL.
- **Caching:** the proxy's responses and redirects carry the no-store headers `@supabase/ssr` provides with refreshed cookies, and the callback sets `no-store` explicitly. Server action responses (sign-in, sign-out) are POST responses without an explicit header.
- **Logout:** a POST server action with `scope: 'local'`, so other devices stay signed in.
- **End-to-end sessions:** tests sign up a fresh local email user through `@supabase/ssr` with an in-memory cookie jar and hand the cookies to the browser. No test-only route, no JWT secret, no service role. The GitHub step is checked up to the redirect to `/auth/v1/authorize`; requests to github.com are aborted.

## Consequences

The proxy keeps cookies fresh, and `getUser()` catches revoked sessions where data is read. Known gap: with asymmetric signing keys, `getClaims()` verifies the JWT locally and PostgREST checks only the signature, so an access token copied before logout stays valid until it expires (`jwt_expiry`, one hour). Paths that end like images skip the proxy, so every route handler and action checks auth itself. Revisit if sessions must end everywhere at once (shorter expiry or `scope: 'global'`).

## Alternatives considered

- **`getUser()` in the proxy on every request**: an Auth server round trip for every page and asset that is not excluded.
- **A test-only login route**: a backdoor that could ship.
- **Redirect origin from the Host header**: open to Host header poisoning behind a cache.
- **Wildcard redirect allowlist**: any path on the site could receive the OAuth code.
