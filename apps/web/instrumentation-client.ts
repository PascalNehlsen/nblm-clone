import * as Sentry from "@sentry/nextjs";
import { buildSentryOptions } from "./lib/observability/sentry-options";

// Browser-side error tracking (ADR 0022). Off without an EU DSN; same scrubbed options.
const options = buildSentryOptions({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: process.env.NEXT_PUBLIC_VERCEL_ENV,
});
if (options) Sentry.init(options);
