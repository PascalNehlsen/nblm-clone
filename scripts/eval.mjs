// Live eval check (ADR 0017): asks a develop deployment's /api/eval to run every case of
// tests/eval/cases.json against the real model, and passes only if every security case passes
// and at least QUALITY_MIN of the fact and abstention cases do. Prints case ids and booleans,
// never the secrets or any other body text.
//
// Usage (inputs only through env):
//   EVAL_BASE_URL=https://<deployment>.vercel.app EVAL_SECRET=... \
//   [VERCEL_AUTOMATION_BYPASS_SECRET=...] node scripts/eval.mjs
// Exit 0 passes, exit 1 fails.

import { readFileSync } from "node:fs";

const DEPLOYMENT_URL = /^https:\/\/[a-z0-9-]+\.vercel\.app$/;
// Above the route's maxDuration (300 s): a client timeout means the server gave up too.
export const TIMEOUT_MS = 310_000;
export const QUALITY_MIN = 5;
const RETRY_DELAY_MS = 5_000;

export function loadCases() {
  return JSON.parse(readFileSync(new URL("../tests/eval/cases.json", import.meta.url), "utf8"));
}

async function post(fetch, url, headers) {
  try {
    return await fetch(url, { method: "POST", redirect: "manual", headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    return null;
  }
}

function categories(cases) {
  return {
    security: (cases.security ?? []).map((c) => c.id),
    quality: [...(cases.facts ?? []), ...(cases.abstention ?? [])].map((c) => c.id),
  };
}

async function check({ baseUrl, secret, bypassSecret, fetch, sleep, cases }) {
  const ids = categories(cases);
  const fail = (status, reason) => ({ ok: false, status, results: null, ids, errored: null, reason });
  if (typeof baseUrl !== "string" || !DEPLOYMENT_URL.test(baseUrl)) return fail(null, "baseUrl must be https://<name>.vercel.app");
  if (typeof secret !== "string" || secret === "") return fail(null, "secret missing");

  const headers = { "x-eval-secret": secret };
  if (typeof bypassSecret === "string" && bypassSecret !== "") headers["x-vercel-protection-bypass"] = bypassSecret;
  const url = `${baseUrl}/api/eval`;

  let response = await post(fetch, url, headers);
  // One retry, only when the server or the network failed; a 2xx or 4xx is final.
  if (response === null || response.status >= 500) {
    await sleep(RETRY_DELAY_MS);
    response = await post(fetch, url, headers);
  }
  if (response === null) return fail(null, "no response");
  if (response.status !== 200) return fail(response.status, "status");

  let body;
  try {
    body = await response.json();
  } catch {
    return fail(200, "not json");
  }
  const results = {};
  for (const id of [...ids.security, ...ids.quality]) results[id] = body?.cases?.[id] === true;
  const errored = Number.isInteger(body?.errored) ? body.errored : null;
  const securityOk = ids.security.every((id) => results[id]);
  const qualityPassed = ids.quality.filter((id) => results[id]).length;
  const ok = securityOk && qualityPassed >= QUALITY_MIN;
  const reason = ok ? null : !securityOk ? "a security case failed" : "quality below threshold";
  return { ok, status: 200, results, ids, errored, reason };
}

export async function runEvalCheck(input) {
  const r = await check(input);
  const count = (list) => (r.results ? list.filter((id) => r.results[id]).length : 0);
  return {
    ok: r.ok,
    status: r.status,
    security: { passed: count(r.ids.security), total: r.ids.security.length },
    quality: { passed: count(r.ids.quality), total: r.ids.quality.length },
    errored: r.errored,
    report: summary(r, count),
  };
}

function summary(r, count) {
  const lines = ["### Eval", "", r.ok ? "**Passed.**" : `**Failed:** ${r.reason ?? "unknown"}.`, ""];
  lines.push(`HTTP status: ${r.status ?? "none"}`, "", "| Case | Category | Result |", "|---|---|---|");
  for (const [category, list] of [["security", r.ids.security], ["quality", r.ids.quality]]) {
    for (const id of list) lines.push(`| ${id} | ${category} | ${r.results ? (r.results[id] ? "pass" : "fail") : "-"} |`);
  }
  lines.push(
    "",
    `security ${count(r.ids.security)}/${r.ids.security.length}, quality ${count(r.ids.quality)}/${r.ids.quality.length} (minimum ${QUALITY_MIN}), errored ${r.errored ?? "-"}`,
  );
  return lines.join("\n") + "\n";
}

// Node before 24.2 has no import.meta.main: fail closed instead of passing silently.
if (import.meta.main === undefined) {
  process.stderr.write("eval: this Node version has no import.meta.main\n");
  process.exitCode = 1;
} else if (import.meta.main) {
  const env = process.env;
  const result = await runEvalCheck({
    baseUrl: env.EVAL_BASE_URL,
    secret: env.EVAL_SECRET,
    bypassSecret: env.VERCEL_AUTOMATION_BYPASS_SECRET,
    fetch: globalThis.fetch,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    cases: loadCases(),
  });
  process.stdout.write(result.report);
  if (!result.ok) process.exitCode = 1;
}
