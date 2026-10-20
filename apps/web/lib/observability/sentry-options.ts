// Sentry options for both runtimes (ADR 0022). Errors only: no tracing, no replay, no
// breadcrumbs, no PII. Every event passes an allowlist that keeps the error type and the stack
// frames' locations; everything that could carry user text (exception messages, request
// bodies, headers, query strings, extra data, user) is dropped. Without a
// DSN whose host is Sentry's EU ingest (residency, AGENTS.md), the SDK stays off.

type Json = Record<string, unknown>;

const EU_INGEST = /^o\d+\.ingest\.de\.sentry\.io$/;

// The DSN's ingest origin when it is a Sentry EU DSN, else null. Used for the CSP too.
export function sentryDsnOrigin(dsn: string | null | undefined): string | null {
  if (typeof dsn !== "string" || dsn === "" || /[\s;,]/.test(dsn)) return null;
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username === "" || url.port !== "" || !EU_INGEST.test(url.hostname)) return null;
  return url.origin;
}

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

function pick(source: unknown, keys: readonly string[]): Json | undefined {
  if (!isObject(source)) return undefined;
  const out: Json = {};
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// Inline or eval code reports the page URL as its filename: keep it without query or fragment.
const withoutQuery = (value: string) => value.replace(/[?#].*$/s, "");

function frames(stacktrace: unknown): Json | undefined {
  if (!isObject(stacktrace) || !Array.isArray(stacktrace.frames)) return undefined;
  return {
    frames: stacktrace.frames
      .map((f) => {
        const frame = pick(f, ["filename", "function", "lineno", "colno", "in_app", "module"]);
        if (frame && typeof frame.filename === "string") frame.filename = withoutQuery(frame.filename);
        return frame;
      })
      .filter((f): f is Json => f !== undefined),
  };
}

// Allowlist: build a new event from known technical fields; never copy the input.
export function scrubEvent<E>(event: E): E {
  const e = (isObject(event) ? event : {}) as Json;
  const out: Json = {};
  for (const key of ["event_id", "timestamp", "level", "platform", "release", "environment"]) {
    const value = e[key];
    if (typeof value === "string" || typeof value === "number") out[key] = value;
  }
  if (isObject(e.exception) && Array.isArray(e.exception.values)) {
    out.exception = {
      values: e.exception.values.filter(isObject).map((v) => {
        const value: Json = { value: "redacted" };
        if (typeof v.type === "string") value.type = v.type;
        const mechanism = pick(v.mechanism, ["type", "handled"]);
        if (mechanism) value.mechanism = mechanism;
        const stack = frames(v.stacktrace);
        if (stack) value.stacktrace = stack;
        return value;
      }),
    };
  }
  if (isObject(e.contexts)) {
    const contexts: Json = {};
    for (const name of ["runtime", "os", "browser", "device"]) {
      const c = pick(e.contexts[name], ["name", "version"]);
      if (c) contexts[name] = c;
    }
    out.contexts = contexts;
  }
  if (isObject(e.tags) && typeof e.tags.runtime === "string") out.tags = { runtime: e.tags.runtime };
  const sdk = pick(e.sdk, ["name", "version"]);
  if (sdk) out.sdk = sdk;
  return out as E;
}

export function dropBreadcrumb(): null {
  return null;
}


// The only default integrations that stay: error capture, error chains, deduplication and
// Next.js frame normalization. Everything else, also anything a future SDK adds, is off:
// sessions (sent per page view), tracing, breadcrumbs, console, request data, source lines,
// local variables, modules. Those would send data on page views or carry user text.
const INTEGRATIONS = new Set([
  "EventFilters",
  "InboundFilters",
  "FunctionToString",
  "LinkedErrors",
  "Dedupe",
  "GlobalHandlers",
  "BrowserApiErrors",
  "OnUncaughtException",
  "OnUnhandledRejection",
  "Context",
  "NodeSystemError",
  // Next.js stack frame normalization: the client one is active; the server one (DistDir...)
  // stays inactive without the build plugin, which this app does not use.
  "NextjsClientStackFrameNormalization",
  "DistDirRewriteFrames",
]);

export function keepIntegration(name: string): boolean {
  return INTEGRATIONS.has(name);
}

export function buildSentryOptions(env: { dsn?: string; environment?: string; release?: string }) {
  if (!env.dsn || sentryDsnOrigin(env.dsn) === null) return null;
  return {
    dsn: env.dsn,
    environment: env.environment || "development",
    ...(env.release ? { release: env.release } : {}),
    sendDefaultPii: false,
    sampleRate: 1,
    // Tracing stays off by leaving the traces sample rate unset: in Sentry v10 even 0 turns it on.
    tracePropagationTargets: [],
    sendClientReports: false,
    integrations: (defaults: { name: string }[]) => defaults.filter((i) => keepIntegration(i.name)),
    beforeBreadcrumb: dropBreadcrumb,
    beforeSend: scrubEvent,
    beforeSendTransaction: () => null,
  };
}
