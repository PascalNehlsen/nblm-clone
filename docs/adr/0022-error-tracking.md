# 0022: Errors go to Sentry in the EU, as technical data only

- Status: accepted (Pascal, 2026-10-20)
- Date: 2026-10-20

## Context

Unexpected errors in production were only visible when someone reported them. AGENTS.md names Sentry (EU) for errors, and its hard rules say logs never contain prompt, source or answer text and every processor needs an entry in `docs/privacy.md`. Error events are a log channel: an exception message from a provider or a parser can echo user text, and SDK defaults collect request bodies, headers, breadcrumbs and the user.

## Decision

- **What:** `@sentry/nextjs` (pinned exactly) captures errors on the server (`instrumentation.ts`, including `onRequestError`) and in the browser (`instrumentation-client.ts`, `error.tsx`, `global-error.tsx`). It sends events directly, with no tunnel. There is no `withSentryConfig`, no source map upload and no auth token, and `pnpm-workspace.yaml` keeps `@sentry/cli`'s install script off.
- **Off by default:** `lib/observability/sentry-options.ts` builds the options only for a DSN whose host is `o<id>.ingest.de.sentry.io` (https, no whitespace, `;` or `,`). Without such a DSN the SDK stays off: locally, in CI and on previews (the DSN is set only for Production in both Vercel projects).
- **Options:**
  - `sendDefaultPii: false` and `sendClientReports: false`.
  - `tracesSampleRate` is left unset, which is what turns tracing off in Sentry v10 (even 0 turns it on).
  - `tracePropagationTargets: []`, so no tracing headers go to Supabase or Bedrock.
  - Every breadcrumb is dropped.
  - The default integrations pass an **allowlist**: error handlers, linked errors, dedupe, filters and Next.js frame normalization. Sessions (sent per page view), tracing, request data, source lines, local variables, modules and console capture are off, and so is anything a future SDK version adds. A normal page view sends nothing.
- **Allowlist (`scrubEvent`):** an event keeps its id, time, level, platform, release and environment, the exception type and mechanism, the frame file, function, line and column, the request method and path without query or fragment, runtime, OS, browser and device name and version, and the `runtime` tag. The exception value becomes `redacted`; everything else is dropped.
- **CSP:** `connect-src` gets exactly the DSN's ingest origin and no wildcard (ADR 0020).
- **Project settings (Pascal):** IP storage off, the server-side data scrubber on, no spend above the free plan.

## Consequences

- Errors become visible with stack and route, but without the message. Debugging relies on the type, the frame and the path. Without source maps, browser frames point at minified chunks.
- A new browser origin: the visitor's IP reaches Sentry with each event, and is not stored, by configuration.
- Every Sentry SDK upgrade must keep the tests in `tests/unit/observability/` green. They plant a sentinel in every field and check that it never survives.
- An Edge-runtime route would not report (none exists; the proxy runs on Node). Revisit: source maps with a build token, a tunnel route, or tracing. Each needs its own plan, because each adds a secret or a data channel.

## Alternatives considered

- **Server only:** this needs no CSP entry and leaks no visitor IP, but the client-side errors (chat stream, uploads) would stay invisible.
- **Denylist scrubbing:** new SDK fields would pass by default. An allowlist fails closed.
- **Vercel logs only:** these are not aggregated and give no alerting.
