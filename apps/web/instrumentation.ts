import * as Sentry from "@sentry/nextjs";
import { buildSentryOptions } from "./lib/observability/sentry-options";

// Server-side error tracking (ADR 0022). Off without an EU DSN (local, CI, previews).
export function register(): void {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const options = buildSentryOptions({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    environment: process.env.NEXT_PUBLIC_VERCEL_ENV,
    release: process.env.VERCEL_GIT_COMMIT_SHA,
  });
  if (options) Sentry.init(options);
}

export const onRequestError = Sentry.captureRequestError;
