// Tests for scripts/canary.mjs, the release canary client (spec .git/R2-SPEC.md).
//
// Run with: node --test 'tests/ci/*.test.mjs'
//
// Contract assumed for runCanaryCheck({ baseUrl, secret, bypassSecret, fetch, sleep }):
// it resolves to { ok: boolean, status: number | null, checks: object | null, report: string }.
// ok is true only for HTTP 200 with a body whose ok is true (exit 0); everything else is
// ok false (exit 1). report is the Markdown table. No real network, env, timers or processes.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { runCanaryCheck } from "../../scripts/canary.mjs";

const BASE_URL = "https://nblm-web-abc123.vercel.app";
const SECRET = "canary-secret-do-not-print";
const BYPASS = "bypass-secret-do-not-print";
const ENDPOINT = `${BASE_URL}/api/canary`;

const GOOD = { ok: true, checks: { embedding: true, answered: true, citationValid: true, notAbstained: true } };
const BAD = { ok: false, checks: { embedding: true, answered: true, citationValid: false, notAbstained: false } };

const json = (status, body) => () =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// Fake fetch with a queue of responses (functions or Errors), recording every call.
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
  return { baseUrl: BASE_URL, secret: SECRET, bypassSecret: undefined, sleep: makeSleep(), ...overrides };
}

describe("runCanaryCheck: result", () => {
  it("200 with ok true passes and the report lists the four checks and the status", async () => {
    const fetch = makeFetch([json(200, GOOD)]);
    const result = await runCanaryCheck(args({ fetch }));
    assert.equal(result.ok, true);
    assert.equal(result.status, 200);
    for (const name of ["embedding", "answered", "citationValid", "notAbstained"]) {
      assert.ok(result.report.includes(name), `report must mention ${name}`);
    }
    assert.ok(result.report.includes("200"));
    assert.ok(result.report.includes("|"), "expected a Markdown table");
  });

  it("200 with ok false fails, shows false in the report, and is not retried", async () => {
    const fetch = makeFetch([json(200, BAD)]);
    const result = await runCanaryCheck(args({ fetch }));
    assert.equal(result.ok, false);
    assert.equal(fetch.calls.length, 1);
    assert.ok(result.report.includes("false"));
  });

  it("200 with a body that is not JSON fails", async () => {
    const fetch = makeFetch([() => new Response("<html>oops</html>", { status: 200 })]);
    const result = await runCanaryCheck(args({ fetch }));
    assert.equal(result.ok, false);
  });

  it("200 with ok true but no checks object fails", async () => {
    const fetch = makeFetch([json(200, { ok: true })]);
    const result = await runCanaryCheck(args({ fetch }));
    assert.equal(result.ok, false);
  });

  for (const status of [401, 403, 404, 405]) {
    it(`${status} fails and is never retried`, async () => {
      const fetch = makeFetch([() => new Response(null, { status }), json(200, GOOD)]);
      const sleep = makeSleep();
      const result = await runCanaryCheck(args({ fetch, sleep }));
      assert.equal(result.ok, false);
      assert.equal(result.status, status);
      assert.equal(fetch.calls.length, 1);
      assert.equal(sleep.calls.length, 0);
    });
  }

  it("a redirect (3xx) fails and is not followed", async () => {
    const fetch = makeFetch([
      () => new Response(null, { status: 307, headers: { location: "https://evil.example.com/api/canary" } }),
      json(200, GOOD),
    ]);
    const result = await runCanaryCheck(args({ fetch }));
    assert.equal(result.ok, false);
    assert.equal(fetch.calls.length, 1);
  });
});

describe("runCanaryCheck: retry rules", () => {
  it("one retry after a 5xx, then success passes", async () => {
    const fetch = makeFetch([() => new Response(null, { status: 503 }), json(200, GOOD)]);
    const sleep = makeSleep();
    const result = await runCanaryCheck(args({ fetch, sleep }));
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
    const result = await runCanaryCheck(args({ fetch }));
    assert.equal(result.ok, false);
    assert.equal(fetch.calls.length, 2);
  });

  it("one retry after a network error, then success passes", async () => {
    const fetch = makeFetch([new TypeError("fetch failed"), json(200, GOOD)]);
    const result = await runCanaryCheck(args({ fetch }));
    assert.equal(result.ok, true);
    assert.equal(fetch.calls.length, 2);
  });

  it("one retry after a timeout, then success passes", async () => {
    const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    const fetch = makeFetch([timeout, json(200, GOOD)]);
    const result = await runCanaryCheck(args({ fetch }));
    assert.equal(result.ok, true);
    assert.equal(fetch.calls.length, 2);
  });

  it("network errors twice fail after exactly two requests", async () => {
    const fetch = makeFetch([new TypeError("fetch failed"), new TypeError("fetch failed"), json(200, GOOD)]);
    const result = await runCanaryCheck(args({ fetch }));
    assert.equal(result.ok, false);
    assert.equal(result.status, null);
    assert.equal(fetch.calls.length, 2);
  });
});

describe("runCanaryCheck: request shape", () => {
  it("POSTs to {base}/api/canary with the secret header, redirect manual and an AbortSignal", async () => {
    const fetch = makeFetch([json(200, GOOD)]);
    await runCanaryCheck(args({ fetch }));
    const call = fetch.calls[0];
    assert.equal(call.url, ENDPOINT);
    assert.equal(call.init?.method, "POST");
    assert.equal(call.init?.redirect, "manual");
    assert.ok(call.init?.signal instanceof AbortSignal, "expected an AbortSignal");
    const headers = new Headers(call.init?.headers ?? {});
    assert.equal(headers.get("x-canary-secret"), SECRET);
    assert.equal(headers.get("x-vercel-protection-bypass"), null);
  });

  it("sends the bypass header only when configured", async () => {
    const fetch = makeFetch([json(200, GOOD)]);
    await runCanaryCheck(args({ fetch, bypassSecret: BYPASS }));
    const headers = new Headers(fetch.calls[0].init?.headers ?? {});
    assert.equal(headers.get("x-vercel-protection-bypass"), BYPASS);
    assert.equal(headers.get("x-canary-secret"), SECRET);
  });

  it("sends the same headers on the retry", async () => {
    const fetch = makeFetch([() => new Response(null, { status: 500 }), json(200, GOOD)]);
    await runCanaryCheck(args({ fetch, bypassSecret: BYPASS }));
    for (const call of fetch.calls) {
      const headers = new Headers(call.init?.headers ?? {});
      assert.equal(headers.get("x-canary-secret"), SECRET);
      assert.equal(headers.get("x-vercel-protection-bypass"), BYPASS);
    }
  });

  it("never puts a secret into the URL or a body", async () => {
    const fetch = makeFetch([json(200, GOOD)]);
    await runCanaryCheck(args({ fetch, bypassSecret: BYPASS }));
    const call = fetch.calls[0];
    assert.ok(!call.url.includes(SECRET));
    assert.ok(!call.url.includes(BYPASS));
    assert.ok(!String(call.init?.body ?? "").includes(SECRET));
  });
});

describe("runCanaryCheck: output never contains secrets or body text", () => {
  it("neither secret appears in the result or report on pass, fail and error", async () => {
    const scenarios = [
      [json(200, GOOD)],
      [json(200, BAD)],
      [() => new Response(null, { status: 401 })],
      [new Error(`boom ${SECRET} ${BYPASS}`), new Error(`boom ${SECRET} ${BYPASS}`)],
    ];
    for (const queue of scenarios) {
      const result = await runCanaryCheck(args({ fetch: makeFetch(queue), bypassSecret: BYPASS }));
      const text = JSON.stringify(result) + result.report;
      assert.ok(!text.includes(SECRET), "canary secret leaked");
      assert.ok(!text.includes(BYPASS), "bypass secret leaked");
    }
  });

  it("body text beyond the four booleans is never printed", async () => {
    const marker = "BODY_MARKER_DO_NOT_PRINT";
    const fetch = makeFetch([json(200, { ...GOOD, answer: marker, message: marker })]);
    const result = await runCanaryCheck(args({ fetch }));
    assert.ok(!(JSON.stringify(result) + result.report).includes(marker));

    const errFetch = makeFetch([() => new Response(marker, { status: 500 }), () => new Response(marker, { status: 500 })]);
    const errResult = await runCanaryCheck(args({ fetch: errFetch }));
    assert.ok(!(JSON.stringify(errResult) + errResult.report).includes(marker));
  });
});

describe("runCanaryCheck: input validation happens before any fetch", () => {
  const invalidBaseUrls = [
    "http://nblm-web-abc123.vercel.app",
    "https://nblm-web-abc123.example.com",
    "https://nblm-web-abc123.vercel.app/",
    "https://nblm-web-abc123.vercel.app/api/canary",
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
        result = await runCanaryCheck(args({ baseUrl: bad, fetch }));
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
        result = await runCanaryCheck(args({ secret: bad, fetch }));
      } catch {
        result = { ok: false };
      }
      assert.equal(called, false);
      assert.equal(result.ok, false);
    });
  }
});
