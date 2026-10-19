// Release canary check (ADR 0014): asks a staged deployment's /api/canary to run one real
// embedding and chat answer with a fixed passage, and passes only if every check is true.
// Prints the HTTP status and four booleans, never the secrets or any other body text.
//
// Usage (inputs only through env):
//   CANARY_BASE_URL=https://<deployment>.vercel.app CANARY_SECRET=... \
//   [VERCEL_AUTOMATION_BYPASS_SECRET=...] node scripts/canary.mjs
// Exit 0 passes, exit 1 fails.


const DEPLOYMENT_URL = /^https:\/\/[a-z0-9-]+\.vercel\.app$/;
// Above the route's maxDuration (180 s): a client timeout means the server gave up too.
export const TIMEOUT_MS = 190_000;
const RETRY_DELAY_MS = 5_000;
const CHECKS = ["embedding", "answered", "citationValid", "notAbstained"];

async function post(fetch, url, headers) {
  try {
    return await fetch(url, { method: "POST", redirect: "manual", headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    return null;
  }
}

async function check({ baseUrl, secret, bypassSecret, fetch, sleep }) {
  if (typeof baseUrl !== "string" || !DEPLOYMENT_URL.test(baseUrl)) {
    return { ok: false, status: null, checks: null, reason: "baseUrl must be https://<name>.vercel.app" };
  }
  if (typeof secret !== "string" || secret === "") return { ok: false, status: null, checks: null, reason: "secret missing" };

  const headers = { "x-canary-secret": secret };
  if (typeof bypassSecret === "string" && bypassSecret !== "") headers["x-vercel-protection-bypass"] = bypassSecret;
  const url = `${baseUrl}/api/canary`;

  let response = await post(fetch, url, headers);
  // One retry, only when the server or the network failed; a 2xx or 4xx is final.
  if (response === null || response.status >= 500) {
    await sleep(RETRY_DELAY_MS);
    response = await post(fetch, url, headers);
  }
  if (response === null) return { ok: false, status: null, checks: null, reason: "no response" };
  if (response.status !== 200) return { ok: false, status: response.status, checks: null, reason: "status" };

  let body;
  try {
    body = await response.json();
  } catch {
    return { ok: false, status: 200, checks: null, reason: "not json" };
  }
  const checks = {};
  for (const name of CHECKS) checks[name] = body?.checks?.[name] === true;
  const ok = body?.ok === true && CHECKS.every((name) => checks[name]);
  return { ok, status: 200, checks, reason: ok ? null : "checks failed" };
}

export async function runCanaryCheck(input) {
  const result = await check(input);
  return { ...result, report: summary(result) };
}

export function summary(result) {
  const lines = ["### Canary", "", result.ok ? "**Passed.**" : `**Failed:** ${result.reason ?? "unknown"}.`, ""];
  lines.push(`HTTP status: ${result.status ?? "none"}`, "", "| Check | Result |", "|---|---|");
  for (const name of CHECKS) lines.push(`| ${name} | ${result.checks ? String(result.checks[name]) : "-"} |`);
  return lines.join("\n") + "\n";
}

// Node before 24.2 has no import.meta.main: fail closed instead of passing silently.
if (import.meta.main === undefined) {
  process.stderr.write("canary: this Node version has no import.meta.main\n");
  process.exitCode = 1;
} else if (import.meta.main) {
  const env = process.env;
  const result = await runCanaryCheck({
    baseUrl: env.CANARY_BASE_URL,
    secret: env.CANARY_SECRET,
    bypassSecret: env.VERCEL_AUTOMATION_BYPASS_SECRET,
    fetch: globalThis.fetch,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
  process.stdout.write(result.report);
  if (!result.ok) process.exitCode = 1;
}
