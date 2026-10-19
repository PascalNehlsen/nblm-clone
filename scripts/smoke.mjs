#!/usr/bin/env node
// Smoke test for develop.yml (ADR 0010). `staged` checks a new deployment before it is
// promoted, through the Vercel protection bypass; `live` checks the domain after promote.
// Reports method, path, status, the redirect path and pass or fail: never bodies, cookies,
// request headers, the bypass secret or the publishable key.
//
// Usage (inputs only through env, never on the command line):
//   SMOKE_BASE_URL=https://<deployment>.vercel.app SMOKE_SITE_URL=https://<domain> \
//   [VERCEL_AUTOMATION_BYPASS_SECRET=...] [SMOKE_SUPABASE_URL=... SMOKE_SUPABASE_PUBLISHABLE_KEY=...] \
//   node scripts/smoke.mjs staged
//   SMOKE_SITE_URL=https://<domain> node scripts/smoke.mjs live
// Exit 0 passes, exit 1 fails.

import { pathToFileURL } from "node:url";

const DEPLOYMENT_URL = /^https:\/\/[a-z0-9-]+\.vercel\.app$/;
const ATTEMPTS = 5;
const TIMEOUT_MS = 10_000;
const BACKOFF_MS = [2_000, 5_000, 10_000, 20_000];
const PROTECTED_PATH = "/notebooks/00000000-0000-0000-0000-000000000000";

function isOrigin(value) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value;
  } catch {
    return false;
  }
}

function retryable(response) {
  return response.status === 404 || response.status >= 500;
}

// Fetches with retries on network errors, 404 and 5xx. Returns the last response or null.
async function fetchWithRetry(fetch, sleep, url, headers) {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    let response = null;
    try {
      response = await fetch(url, { method: "GET", redirect: "manual", headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      response = null;
    }
    if (response && !retryable(response)) return response;
    if (attempt === ATTEMPTS) return response;
    await sleep(BACKOFF_MS[attempt - 1] ?? BACKOFF_MS.at(-1));
  }
  return null;
}

function result(name, path, response, reason, location = null) {
  return {
    name,
    method: "GET",
    path,
    status: response ? response.status : null,
    location,
    pass: reason === null,
    ...(reason === null ? {} : { reason }),
  };
}

// The path and query of a Location on siteUrl's origin, or an error reason.
function redirectTarget(response, siteUrl) {
  const raw = response.headers.get("location");
  if (!raw) return { reason: "no location" };
  let url;
  try {
    url = new URL(raw, siteUrl);
  } catch {
    return { reason: "bad location" };
  }
  if (url.origin !== siteUrl) return { reason: "location origin" };
  return { location: url.pathname + url.search };
}

async function checkHtml(name, fetch, sleep, origin, path, headers) {
  const response = await fetchWithRetry(fetch, sleep, origin + path, headers);
  if (!response) return result(name, path, null, "no response");
  if (response.status !== 200) return result(name, path, response, "status");
  if (!(response.headers.get("content-type") ?? "").startsWith("text/html")) return result(name, path, response, "content-type");
  if (response.headers.has("x-powered-by")) return result(name, path, response, "x-powered-by");
  return result(name, path, response, null);
}

async function checkRedirect(name, fetch, sleep, { origin, path, headers, siteUrl, expect, prefix = false, noStore = false }) {
  const response = await fetchWithRetry(fetch, sleep, origin + path, headers);
  if (!response) return result(name, path, null, "no response");
  if (response.status !== 307) return result(name, path, response, "status");
  const target = redirectTarget(response, siteUrl);
  if (target.reason) return result(name, path, response, target.reason);
  const matches = prefix ? target.location.startsWith(expect) : target.location === expect;
  if (!matches) return result(name, path, response, "location", target.location);
  if (noStore && !(response.headers.get("cache-control") ?? "").includes("no-store")) {
    return result(name, path, response, "cache-control", target.location);
  }
  return result(name, path, response, null, target.location);
}

async function checkAuthSettings(fetch, sleep, supabaseUrl, publishableKey) {
  const path = "/auth/v1/settings";
  const response = await fetchWithRetry(fetch, sleep, supabaseUrl + path, { apikey: publishableKey });
  if (!response) return result("auth-settings", path, null, "no response");
  if (response.status !== 200) return result("auth-settings", path, response, "status");
  let external;
  try {
    external = (await response.json())?.external;
  } catch {
    return result("auth-settings", path, response, "not json");
  }
  // Field names verified against the local Supabase Auth server on 2026-10-19.
  if (!external || typeof external !== "object") return result("auth-settings", path, response, "no external");
  if (external.email !== false) return result("auth-settings", path, response, "email sign-in on");
  if (external.anonymous_users !== false) return result("auth-settings", path, response, "anonymous sign-in on");
  if (external.github !== true) return result("auth-settings", path, response, "github sign-in off");
  return result("auth-settings", path, response, null);
}

function invalid(reason) {
  return { ok: false, results: [{ name: "input", method: "-", path: "-", status: null, location: null, pass: false, reason }] };
}

export async function runSmoke({ baseUrl, siteUrl, bypassSecret, supabaseUrl, publishableKey, fetch, sleep }) {
  if (typeof baseUrl !== "string" || !DEPLOYMENT_URL.test(baseUrl)) return invalid("baseUrl must be https://<name>.vercel.app");
  if (!isOrigin(siteUrl)) return invalid("siteUrl must be an https origin");
  if (supabaseUrl !== undefined && supabaseUrl !== "" && !isOrigin(supabaseUrl)) return invalid("supabaseUrl must be an https origin");

  const headers = typeof bypassSecret === "string" && bypassSecret !== "" ? { "x-vercel-protection-bypass": bypassSecret } : {};
  const results = [];
  results.push(await checkHtml("login", fetch, sleep, baseUrl, "/login", headers));
  results.push(
    await checkRedirect("root-redirect", fetch, sleep, { origin: baseUrl, path: "/", headers, siteUrl, expect: "/login?next=%2F" }),
  );
  results.push(
    await checkRedirect("protected-redirect", fetch, sleep, {
      origin: baseUrl,
      path: PROTECTED_PATH,
      headers,
      siteUrl,
      expect: "/login?next=",
      prefix: true,
    }),
  );
  results.push(
    await checkRedirect("callback-no-code", fetch, sleep, {
      origin: baseUrl,
      path: "/auth/callback",
      headers,
      siteUrl,
      expect: "/login?fehler=anmeldung",
      noStore: true,
    }),
  );
  if (supabaseUrl && publishableKey) {
    results.push(await checkAuthSettings(fetch, sleep, supabaseUrl, publishableKey));
  } else {
    results.push({ name: "auth-settings", method: "GET", path: "/auth/v1/settings", status: null, location: null, pass: true, reason: "skipped" });
  }
  return { ok: results.every((r) => r.pass), results };
}

export async function checkLive({ siteUrl, fetch, sleep }) {
  if (!isOrigin(siteUrl)) return invalid("siteUrl must be an https origin");
  const results = [await checkHtml("live-login", fetch, sleep, siteUrl, "/login", {})];
  return { ok: results.every((r) => r.pass), results };
}

function cell(value) {
  return String(value ?? "").replace(/[|\\`<>]/g, (c) => `\\${c}`).replace(/[\r\n]/g, " ");
}

export function formatReport(outcome) {
  const lines = ["### Smoke test", "", outcome.ok ? "**Passed.**" : "**Failed.**", ""];
  lines.push("| Check | Request | Status | Redirect | Result |", "|---|---|---|---|---|");
  for (const r of outcome.results) {
    const verdict = r.pass ? (r.reason === "skipped" ? "skipped" : "pass") : `fail: ${cell(r.reason)}`;
    lines.push(`| ${cell(r.name)} | ${cell(r.method)} ${cell(r.path)} | ${cell(r.status ?? "-")} | ${cell(r.location ?? "")} | ${verdict} |`);
  }
  return lines.join("\n") + "\n";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.argv[2];
  const env = process.env;
  const deps = { fetch: globalThis.fetch, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };
  let outcome;
  if (mode === "staged") {
    outcome = await runSmoke({
      baseUrl: env.SMOKE_BASE_URL,
      siteUrl: env.SMOKE_SITE_URL,
      bypassSecret: env.VERCEL_AUTOMATION_BYPASS_SECRET,
      supabaseUrl: env.SMOKE_SUPABASE_URL,
      publishableKey: env.SMOKE_SUPABASE_PUBLISHABLE_KEY,
      ...deps,
    });
  } else if (mode === "live") {
    outcome = await checkLive({ siteUrl: env.SMOKE_SITE_URL, ...deps });
  } else {
    process.stderr.write("smoke: usage: node scripts/smoke.mjs staged|live\n");
    process.exit(1);
  }
  process.stdout.write(formatReport(outcome));
  if (!outcome.ok) process.exitCode = 1;
}
