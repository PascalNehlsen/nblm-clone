// Tests for scripts/eval.mjs, the live eval client (spec .git/EVAL-SPEC.md).
//
// Run with: node --test 'tests/ci/*.test.mjs'
//
// Contract assumed for runEvalCheck({ baseUrl, secret, bypassSecret, fetch, sleep, cases }):
// `cases` is the parsed tests/eval/cases.json ({ facts, abstention, security }, each an array of
// objects with an id). It resolves to
// { ok, status, security: { passed, total }, quality: { passed, total }, errored, report }.
// Security is the 9 security cases, quality the 4 fact plus 2 abstention cases. ok is true only
// for HTTP 200 with every security case true and quality passed >= QUALITY_MIN.
// No real network, env, timers or processes.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { QUALITY_MIN, runEvalCheck, TIMEOUT_MS } from "../../scripts/eval.mjs";

const BASE_URL = "https://nblm-web-abc123.vercel.app";
const SECRET = "eval-secret-do-not-print";
const BYPASS = "bypass-secret-do-not-print";
const ENDPOINT = `${BASE_URL}/api/eval`;

const CASES = JSON.parse(readFileSync(new URL("../eval/cases.json", import.meta.url), "utf8"));
const SECURITY_IDS = CASES.security.map((c) => c.id);
const QUALITY_IDS = [...CASES.facts, ...CASES.abstention].map((c) => c.id);
const ALL_IDS = [...QUALITY_IDS, ...SECURITY_IDS];

const allTrue = () => Object.fromEntries(ALL_IDS.map((id) => [id, true]));
const GOOD = { cases: allTrue(), errored: 0 };
const withCases = (patch, errored = 0) => ({ cases: { ...allTrue(), ...patch }, errored });

const json = (status, body) => () =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function makeFetch(queue) {
  const items = [...queue];
  const calls = [];
  async function fetch(url, init) {
    calls.push({ url: String(url), init });
    const next = items.shift();
    if (next === undefined) throw new Error("test fake fetch: no response queued");
    if (next instanceof Error) throw next;
    return next();
  }
  fetch.calls = calls;
  return fetch;
}

function makeSleep() {
  const calls = [];
  async function sleep(ms) {
    calls.push(ms);
  }
  sleep.calls = calls;
  return sleep;
}

function args(overrides = {}) {
  return { baseUrl: BASE_URL, secret: SECRET, bypassSecret: undefined, sleep: makeSleep(), cases: CASES, ...overrides };
}

describe("eval script constants", () => {
  it("QUALITY_MIN is 5 and the corpus has 9 security and 6 quality cases", () => {
    assert.equal(QUALITY_MIN, 5);
    assert.equal(SECURITY_IDS.length, 9);
    assert.equal(QUALITY_IDS.length, 6);
  });

  it("the request timeout is 310 s, above the route's maxDuration of 300 s", () => {
    assert.equal(TIMEOUT_MS, 310_000);
  });
});

describe("runEvalCheck: result", () => {
  it("everything true passes with 9/9 and 6/6 in the report", async () => {
    const fetch = makeFetch([json(200, GOOD)]);
    const result = await runEvalCheck(args({ fetch }));
    assert.equal(result.ok, true);
    assert.equal(result.status, 200);
    assert.deepEqual(result.security, { passed: 9, total: 9 });
    assert.deepEqual(result.quality, { passed: 6, total: 6 });
    assert.equal(result.errored, 0);
    assert.ok(result.report.includes("security 9/9"), result.report);
    assert.ok(result.report.includes("quality 6/6"), result.report);
    assert.ok(result.report.includes("errored 0"), result.report);
  });

  it("the report is a Markdown table with every case id, its category and pass or fail", async () => {
    const fetch = makeFetch([json(200, withCases({ dauer: false }))]);
    const result = await runEvalCheck(args({ fetch }));
    assert.ok(result.report.includes("|"), "expected a Markdown table");
    for (const id of ALL_IDS) assert.ok(result.report.includes(id), `report must mention ${id}`);
    const row = result.report.split("\n").find((l) => l.includes("dauer"));
    assert.ok(row && /fail/i.test(row), `dauer row must say fail: ${row}`);
    const okRow = result.report.split("\n").find((l) => l.includes("gruendung"));
    assert.ok(okRow && /pass/i.test(okRow), `gruendung row must say pass: ${okRow}`);
    assert.ok(/security/i.test(result.report) && /quality/i.test(result.report));
  });

  it("one failed security case fails the check and is not retried", async () => {
    const fetch = makeFetch([json(200, withCases({ "html-tags": false })), json(200, GOOD)]);
    const result = await runEvalCheck(args({ fetch }));
    assert.equal(result.ok, false);
    assert.deepEqual(result.security, { passed: 8, total: 9 });
    assert.equal(fetch.calls.length, 1);
  });

  it("quality 5 of 6 passes", async () => {
    const fetch = makeFetch([json(200, withCases({ dauer: false }))]);
    const result = await runEvalCheck(args({ fetch }));
    assert.equal(result.ok, true);
    assert.deepEqual(result.quality, { passed: 5, total: 6 });
  });

  it("quality 4 of 6 fails", async () => {
    const fetch = makeFetch([json(200, withCases({ dauer: false, charge: false }))]);
    const result = await runEvalCheck(args({ fetch }));
    assert.equal(result.ok, false);
    assert.deepEqual(result.quality, { passed: 4, total: 6 });
  });

  it("a missing security id counts as false", async () => {
    const body = allTrue();
    delete body[SECURITY_IDS[0]];
    const result = await runEvalCheck(args({ fetch: makeFetch([json(200, { cases: body, errored: 0 })]) }));
    assert.equal(result.ok, false);
    assert.deepEqual(result.security, { passed: 8, total: 9 });
  });

  it("missing quality ids count as false", async () => {
    const body = allTrue();
    delete body[QUALITY_IDS[0]];
    delete body[QUALITY_IDS[1]];
    const result = await runEvalCheck(args({ fetch: makeFetch([json(200, { cases: body, errored: 0 })]) }));
    assert.equal(result.ok, false);
    assert.deepEqual(result.quality, { passed: 4, total: 6 });
  });

  it("only the boolean true counts: truthy strings and numbers are false", async () => {
    const result = await runEvalCheck(
      args({ fetch: makeFetch([json(200, withCases({ [SECURITY_IDS[0]]: "true", [SECURITY_IDS[1]]: 1 }))]) }),
    );
    assert.equal(result.ok, false);
    assert.deepEqual(result.security, { passed: 7, total: 9 });
  });

  it("unknown keys in the body are ignored and do not change totals or the report", async () => {
    const marker = "UNKNOWN_CASE_DO_NOT_PRINT";
    const fetch = makeFetch([json(200, { cases: { ...allTrue(), [marker]: false }, errored: 0 })]);
    const result = await runEvalCheck(args({ fetch }));
    assert.equal(result.ok, true);
    assert.deepEqual(result.security, { passed: 9, total: 9 });
    assert.deepEqual(result.quality, { passed: 6, total: 6 });
    assert.ok(!result.report.includes(marker));
  });

  it("errored is taken from the body and shown in the report", async () => {
    const fetch = makeFetch([json(200, withCases({ dauer: false }, 2))]);
    const result = await runEvalCheck(args({ fetch }));
    assert.equal(result.errored, 2);
    assert.ok(result.report.includes("errored 2"), result.report);
  });

  it("200 with a body that is not JSON fails", async () => {
    const fetch = makeFetch([() => new Response("<html>oops</html>", { status: 200 })]);
    const result = await runEvalCheck(args({ fetch }));
    assert.equal(result.ok, false);
  });

  it("200 with a body without cases fails", async () => {
    for (const body of [{}, { errored: 0 }, null, [], { cases: null }]) {
      const result = await runEvalCheck(args({ fetch: makeFetch([json(200, body)]) }));
      assert.equal(result.ok, false, JSON.stringify(body));
    }
  });

  for (const status of [401, 403, 404, 405]) {
    it(`${status} fails and is never retried`, async () => {
      const fetch = makeFetch([() => new Response(null, { status }), json(200, GOOD)]);
      const sleep = makeSleep();
      const result = await runEvalCheck(args({ fetch, sleep }));
      assert.equal(result.ok, false);
      assert.equal(result.status, status);
      assert.equal(fetch.calls.length, 1);
      assert.equal(sleep.calls.length, 0);
      assert.equal(result.security.total, 9);
      assert.equal(result.quality.total, 6);
    });
  }

  it("a redirect (3xx) fails and is not followed", async () => {
    const fetch = makeFetch([
      () => new Response(null, { status: 307, headers: { location: "https://evil.example.com/api/eval" } }),
      json(200, GOOD),
    ]);
    const result = await runEvalCheck(args({ fetch }));
    assert.equal(result.ok, false);
    assert.equal(fetch.calls.length, 1);
  });
});

describe("runEvalCheck: retry rules", () => {
  it("one retry after a 5xx, then success passes", async () => {
    const fetch = makeFetch([() => new Response(null, { status: 503 }), json(200, GOOD)]);
    const sleep = makeSleep();
    const result = await runEvalCheck(args({ fetch, sleep }));
    assert.equal(result.ok, true);
    assert.equal(fetch.calls.length, 2);
    assert.equal(sleep.calls.length, 1);
  });

  it("5xx twice fails after exactly two requests", async () => {
    const fetch = makeFetch([
      () => new Response(null, { status: 502 }),
      () => new Response(null, { status: 502 }),
      json(200, GOOD),
    ]);
    const result = await runEvalCheck(args({ fetch }));
    assert.equal(result.ok, false);
    assert.equal(fetch.calls.length, 2);
  });

  it("one retry after a network error, then success passes", async () => {
    const fetch = makeFetch([new TypeError("fetch failed"), json(200, GOOD)]);
    const result = await runEvalCheck(args({ fetch }));
    assert.equal(result.ok, true);
    assert.equal(fetch.calls.length, 2);
  });

  it("one retry after a timeout, then success passes", async () => {
    const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    const fetch = makeFetch([timeout, json(200, GOOD)]);
    const result = await runEvalCheck(args({ fetch }));
    assert.equal(result.ok, true);
    assert.equal(fetch.calls.length, 2);
  });

  it("network errors twice fail after exactly two requests", async () => {
    const fetch = makeFetch([new TypeError("fetch failed"), new TypeError("fetch failed"), json(200, GOOD)]);
    const result = await runEvalCheck(args({ fetch }));
    assert.equal(result.ok, false);
    assert.equal(result.status, null);
    assert.equal(fetch.calls.length, 2);
  });

  it("a 200 with failed cases is final: no retry", async () => {
    const fetch = makeFetch([json(200, withCases({ "html-tags": false })), json(200, GOOD)]);
    await runEvalCheck(args({ fetch }));
    assert.equal(fetch.calls.length, 1);
  });
});

describe("runEvalCheck: request shape", () => {
  it("POSTs to {base}/api/eval with the secret header, redirect manual and an AbortSignal", async () => {
    const fetch = makeFetch([json(200, GOOD)]);
    await runEvalCheck(args({ fetch }));
    const call = fetch.calls[0];
    assert.equal(call.url, ENDPOINT);
    assert.equal(call.init?.method, "POST");
    assert.equal(call.init?.redirect, "manual");
    assert.ok(call.init?.signal instanceof AbortSignal, "expected an AbortSignal");
    const headers = new Headers(call.init?.headers ?? {});
    assert.equal(headers.get("x-eval-secret"), SECRET);
    assert.equal(headers.get("x-canary-secret"), null);
    assert.equal(headers.get("x-vercel-protection-bypass"), null);
  });

  it("sends the bypass header only when configured", async () => {
    const fetch = makeFetch([json(200, GOOD)]);
    await runEvalCheck(args({ fetch, bypassSecret: BYPASS }));
    const headers = new Headers(fetch.calls[0].init?.headers ?? {});
    assert.equal(headers.get("x-vercel-protection-bypass"), BYPASS);
    assert.equal(headers.get("x-eval-secret"), SECRET);
  });

  it("sends the same headers on the retry", async () => {
    const fetch = makeFetch([() => new Response(null, { status: 500 }), json(200, GOOD)]);
    await runEvalCheck(args({ fetch, bypassSecret: BYPASS }));
    assert.equal(fetch.calls.length, 2);
    for (const call of fetch.calls) {
      const headers = new Headers(call.init?.headers ?? {});
      assert.equal(headers.get("x-eval-secret"), SECRET);
      assert.equal(headers.get("x-vercel-protection-bypass"), BYPASS);
    }
  });

  it("never puts a secret into the URL or a body", async () => {
    const fetch = makeFetch([json(200, GOOD)]);
    await runEvalCheck(args({ fetch, bypassSecret: BYPASS }));
    const call = fetch.calls[0];
    assert.ok(!call.url.includes(SECRET));
    assert.ok(!call.url.includes(BYPASS));
    assert.ok(!String(call.init?.body ?? "").includes(SECRET));
  });
});

describe("runEvalCheck: output never contains secrets or body text", () => {
  it("neither secret appears in the result or report on pass, fail and error", async () => {
    const scenarios = [
      [json(200, GOOD)],
      [json(200, withCases({ "html-tags": false }))],
      [() => new Response(null, { status: 401 })],
      [new Error(`boom ${SECRET} ${BYPASS}`), new Error(`boom ${SECRET} ${BYPASS}`)],
    ];
    for (const queue of scenarios) {
      const result = await runEvalCheck(args({ fetch: makeFetch(queue), bypassSecret: BYPASS }));
      const text = JSON.stringify(result) + result.report;
      assert.ok(!text.includes(SECRET), "eval secret leaked");
      assert.ok(!text.includes(BYPASS), "bypass secret leaked");
    }
  });

  it("body text beyond cases and errored is never printed", async () => {
    const marker = "BODY_MARKER_DO_NOT_PRINT";
    const fetch = makeFetch([json(200, { ...GOOD, answer: marker, message: marker })]);
    const result = await runEvalCheck(args({ fetch }));
    assert.ok(!(JSON.stringify(result) + result.report).includes(marker));

    const errFetch = makeFetch([() => new Response(marker, { status: 500 }), () => new Response(marker, { status: 500 })]);
    const errResult = await runEvalCheck(args({ fetch: errFetch }));
    assert.ok(!(JSON.stringify(errResult) + errResult.report).includes(marker));
  });
});

describe("eval script: entry and corpus source", () => {
  const source = readFileSync(new URL("../../scripts/eval.mjs", import.meta.url), "utf8");

  it("fails closed when import.meta.main is undefined: a branch sets a non-zero exit code", () => {
    assert.match(
      source,
      /import\.meta\.main\s*===\s*undefined[\s\S]{0,300}(?:process\.exitCode\s*=\s*[1-9]|process\.exit\(\s*[1-9]\s*\))/,
    );
  });

  it("reads the case ids from tests/eval/cases.json, resolved from the script's location", () => {
    assert.match(source, /cases\.json/);
    assert.match(source, /import\.meta\.(?:url|dirname)/);
  });

  it("takes its inputs from env, never from argv", () => {
    assert.ok(source.includes("EVAL_BASE_URL"));
    assert.ok(source.includes("EVAL_SECRET"));
    assert.ok(source.includes("VERCEL_AUTOMATION_BYPASS_SECRET"));
    assert.ok(!source.includes("process.argv"));
  });
});

describe("runEvalCheck: input validation happens before any fetch", () => {
  const invalidBaseUrls = [
    "http://nblm-web-abc123.vercel.app",
    "https://nblm-web-abc123.example.com",
    "https://nblm-web-abc123.vercel.app/",
    "https://nblm-web-abc123.vercel.app/api/eval",
    "https://nblm-web-abc123.vercel.app:8443",
    "https://evil.example.com/.vercel.app",
    "https://nblm-web-abc123.vercel.app.evil.com",
    "",
    undefined,
  ];

  for (const bad of invalidBaseUrls) {
    it(`rejects baseUrl ${JSON.stringify(bad)} without calling fetch`, async () => {
      let called = false;
      const fetch = async () => {
        called = true;
        return new Response(JSON.stringify(GOOD), { status: 200 });
      };
      let result;
      try {
        result = await runEvalCheck(args({ baseUrl: bad, fetch }));
      } catch {
        result = { ok: false };
      }
      assert.equal(called, false);
      assert.equal(result.ok, false);
    });
  }

  for (const bad of [undefined, ""]) {
    it(`rejects a missing secret ${JSON.stringify(bad)} without calling fetch`, async () => {
      let called = false;
      const fetch = async () => {
        called = true;
        return new Response(JSON.stringify(GOOD), { status: 200 });
      };
      let result;
      try {
        result = await runEvalCheck(args({ secret: bad, fetch }));
      } catch {
        result = { ok: false };
      }
      assert.equal(called, false);
      assert.equal(result.ok, false);
    });
  }
});
