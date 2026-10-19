// Tests for the post-deploy smoke test used by `develop.yml` after
// `vercel deploy --prod --skip-domain` and before `vercel promote`.
//
// Run with: node --test 'tests/ci/*.test.mjs'
// (a bare directory does not work with node --test; it must be a glob or file list)
//
// Pure functions with an injected fake `fetch` and fake `sleep`: no real
// network, no child processes, no env, no timers.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { runSmoke, checkLive, formatReport } from "../../scripts/smoke.mjs";

const BASE_URL = "https://nblm-web-develop-abc123.vercel.app";
const SITE_URL = "https://nblm-web-develop.vercel.app";
const SUPABASE_URL = "https://abcdefghijklmnop.supabase.co";
const PUBLISHABLE_KEY = "sb_publishable_test_key_do_not_print";
const BYPASS_SECRET = "bypass-secret-do-not-print";
const PROTECTED_PATH =
  "/notebooks/00000000-0000-0000-0000-000000000000";

/** Records every (url, init) pair a fake fetch is called with. */
function makeFetch(responseMap) {
  const calls = [];
  const queues = new Map(
    Object.entries(responseMap).map(([k, v]) => [k, [...v]]),
  );
  async function fetch(url, init) {
    const u = new URL(String(url));
    const key = u.origin + u.pathname;
    calls.push({ url: String(url), key, init });
    const queue = queues.get(key);
    if (!queue || queue.length === 0) {
      throw new Error(`test fake fetch: no response queued for ${key}`);
    }
    const next = queue.shift();
    if (next instanceof Error) throw next;
    if (typeof next === "function") return next();
    return next;
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

const htmlOk = () =>
  new Response("<html><body>login</body></html>", {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });

const rootRedirectOk = () =>
  new Response(null, {
    status: 307,
    headers: { location: `${SITE_URL}/login?next=%2F` },
  });

const protectedRedirectOk = () =>
  new Response(null, {
    status: 307,
    headers: {
      location: `${SITE_URL}/login?next=%2Fnotebooks%2F00000000-0000-0000-0000-000000000000`,
    },
  });

const callbackOk = () =>
  new Response(null, {
    status: 307,
    headers: {
      location: `${SITE_URL}/login?fehler=anmeldung`,
      "cache-control": "no-store, max-age=0",
    },
  });

const authSettingsOk = () =>
  new Response(
    JSON.stringify({
      external: { email: false, github: true, anonymous_users: false },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

function happyResponses({ includeSupabase = true } = {}) {
  const map = {
    [`${BASE_URL}/login`]: [htmlOk],
    [`${BASE_URL}/`]: [rootRedirectOk],
    [`${BASE_URL}${PROTECTED_PATH}`]: [protectedRedirectOk],
    [`${BASE_URL}/auth/callback`]: [callbackOk],
  };
  if (includeSupabase) {
    map[`${SUPABASE_URL}/auth/v1/settings`] = [authSettingsOk];
  }
  return map;
}

function baseArgs(overrides = {}) {
  return {
    baseUrl: BASE_URL,
    siteUrl: SITE_URL,
    bypassSecret: undefined,
    supabaseUrl: undefined,
    publishableKey: undefined,
    ...overrides,
  };
}

describe("runSmoke: happy path", () => {
  it("all checks pass against a fake fetch returning the expected responses", async () => {
    const fetch = makeFetch(happyResponses());
    const sleep = makeSleep();
    const result = await runSmoke(
      baseArgs({
        supabaseUrl: SUPABASE_URL,
        publishableKey: PUBLISHABLE_KEY,
        fetch,
        sleep,
      }),
    );

    assert.equal(result.ok, true);
    assert.ok(Array.isArray(result.results));
    const names = result.results.map((r) => r.name);
    for (const expected of [
      "login",
      "root-redirect",
      "protected-redirect",
      "callback-no-code",
    ]) {
      assert.ok(names.includes(expected), `expected a "${expected}" result`);
    }
    for (const r of result.results) {
      assert.equal(r.pass, true, `expected ${r.name} to pass`);
    }
  });

  it("without supabaseUrl/publishableKey, auth-settings is skipped, not failed, and never fetched", async () => {
    const fetch = makeFetch(happyResponses({ includeSupabase: false }));
    const sleep = makeSleep();
    const result = await runSmoke(baseArgs({ fetch, sleep }));

    assert.equal(result.ok, true);
    assert.ok(
      !fetch.calls.some((c) => c.url.startsWith(SUPABASE_URL)),
      "auth-settings must not be fetched when supabaseUrl/publishableKey are absent",
    );
    const authSettings = result.results.find((r) => r.name === "auth-settings");
    if (authSettings) {
      assert.notEqual(authSettings.pass, false);
    }
  });
});

describe("runSmoke: individual check failures", () => {
  it('"/" returning 200 instead of a redirect fails', async () => {
    const responses = happyResponses();
    responses[`${BASE_URL}/`] = [
      () => new Response("<html>oops</html>", { status: 200, headers: { "content-type": "text/html" } }),
    ];
    const result = await runSmoke(
      baseArgs({ fetch: makeFetch(responses), sleep: makeSleep() }),
    );
    assert.equal(result.ok, false);
    const r = result.results.find((x) => x.name === "root-redirect");
    assert.ok(r);
    assert.equal(r.pass, false);
  });

  it("a Location on a different origin than siteUrl fails with reason mentioning origin", async () => {
    const responses = happyResponses();
    responses[`${BASE_URL}/`] = [
      () =>
        new Response(null, {
          status: 307,
          headers: { location: "https://evil.example.com/login?next=%2F" },
        }),
    ];
    const result = await runSmoke(
      baseArgs({ fetch: makeFetch(responses), sleep: makeSleep() }),
    );
    assert.equal(result.ok, false);
    const r = result.results.find((x) => x.name === "root-redirect");
    assert.ok(r);
    assert.equal(r.pass, false);
    assert.ok(r.reason && r.reason.toLowerCase().includes("origin"));
  });

  it("/login returning 500 persistently fails after 5 attempts, with increasing sleep delays", async () => {
    const responses = happyResponses();
    responses[`${BASE_URL}/login`] = [
      () => new Response(null, { status: 500 }),
      () => new Response(null, { status: 500 }),
      () => new Response(null, { status: 500 }),
      () => new Response(null, { status: 500 }),
      () => new Response(null, { status: 500 }),
    ];
    const fetch = makeFetch(responses);
    const sleep = makeSleep();
    const result = await runSmoke(baseArgs({ fetch, sleep }));

    assert.equal(result.ok, false);
    const r = result.results.find((x) => x.name === "login");
    assert.ok(r);
    assert.equal(r.pass, false);

    const loginCalls = fetch.calls.filter((c) => c.key === `${BASE_URL}/login`);
    assert.equal(loginCalls.length, 5);

    assert.ok(sleep.calls.length >= 1);
    for (let i = 1; i < sleep.calls.length; i += 1) {
      assert.ok(
        sleep.calls[i] > sleep.calls[i - 1],
        `expected increasing backoff, got ${JSON.stringify(sleep.calls)}`,
      );
    }
  });

  it("an x-powered-by header on /login fails", async () => {
    const responses = happyResponses();
    responses[`${BASE_URL}/login`] = [
      () =>
        new Response("<html>ok</html>", {
          status: 200,
          headers: {
            "content-type": "text/html",
            "x-powered-by": "Next.js",
          },
        }),
    ];
    const result = await runSmoke(
      baseArgs({ fetch: makeFetch(responses), sleep: makeSleep() }),
    );
    assert.equal(result.ok, false);
    const r = result.results.find((x) => x.name === "login");
    assert.equal(r.pass, false);
  });

  it("a callback response missing no-store fails", async () => {
    const responses = happyResponses();
    responses[`${BASE_URL}/auth/callback`] = [
      () =>
        new Response(null, {
          status: 307,
          headers: { location: `${SITE_URL}/login?fehler=anmeldung` },
        }),
    ];
    const result = await runSmoke(
      baseArgs({ fetch: makeFetch(responses), sleep: makeSleep() }),
    );
    assert.equal(result.ok, false);
    const r = result.results.find((x) => x.name === "callback-no-code");
    assert.equal(r.pass, false);
  });

  it("two 503 responses then success pass, with sleep called twice with increasing delays", async () => {
    const responses = happyResponses();
    responses[`${BASE_URL}/login`] = [
      () => new Response(null, { status: 503 }),
      () => new Response(null, { status: 503 }),
      htmlOk,
    ];
    const fetch = makeFetch(responses);
    const sleep = makeSleep();
    const result = await runSmoke(baseArgs({ fetch, sleep }));

    assert.equal(result.ok, true);
    const loginCalls = fetch.calls.filter((c) => c.key === `${BASE_URL}/login`);
    assert.equal(loginCalls.length, 3);
    assert.equal(sleep.calls.length, 2);
    assert.ok(sleep.calls[1] > sleep.calls[0]);
  });
});

describe("runSmoke: request shape", () => {
  it("every request uses redirect: manual and an AbortSignal", async () => {
    const fetch = makeFetch(happyResponses());
    const sleep = makeSleep();
    await runSmoke(
      baseArgs({
        supabaseUrl: SUPABASE_URL,
        publishableKey: PUBLISHABLE_KEY,
        fetch,
        sleep,
      }),
    );

    assert.ok(fetch.calls.length > 0);
    for (const call of fetch.calls) {
      assert.equal(call.init?.redirect, "manual");
      assert.ok(
        call.init?.signal instanceof AbortSignal,
        "expected an AbortSignal on every request",
      );
    }
  });

  it("the bypass header is sent only when configured, only to baseUrl, and never appears in the report", async () => {
    const fetch = makeFetch(happyResponses());
    const sleep = makeSleep();
    const result = await runSmoke(
      baseArgs({
        bypassSecret: BYPASS_SECRET,
        supabaseUrl: SUPABASE_URL,
        publishableKey: PUBLISHABLE_KEY,
        fetch,
        sleep,
      }),
    );

    assert.equal(result.ok, true);

    for (const call of fetch.calls) {
      const headers = new Headers(call.init?.headers ?? {});
      const value = headers.get("x-vercel-protection-bypass");
      if (call.url.startsWith(BASE_URL)) {
        assert.equal(value, BYPASS_SECRET);
      } else {
        assert.equal(value, null, "bypass header must not reach supabaseUrl");
      }
    }

    assert.ok(!JSON.stringify(result).includes(BYPASS_SECRET));
    assert.ok(!formatReport(result).includes(BYPASS_SECRET));
  });

  it("no bypass header is sent anywhere when bypassSecret is not configured", async () => {
    const fetch = makeFetch(happyResponses({ includeSupabase: false }));
    const sleep = makeSleep();
    await runSmoke(baseArgs({ fetch, sleep }));

    for (const call of fetch.calls) {
      const headers = new Headers(call.init?.headers ?? {});
      assert.equal(headers.get("x-vercel-protection-bypass"), null);
    }
  });

  it("a Set-Cookie value and a body marker never appear in the result or the report", async () => {
    const cookieMarker = "session=do-not-print-this-cookie";
    const bodyMarker = "BODY_MARKER_DO_NOT_PRINT";
    const responses = happyResponses();
    responses[`${BASE_URL}/login`] = [
      () =>
        new Response(`<html>${bodyMarker}</html>`, {
          status: 200,
          headers: {
            "content-type": "text/html",
            "set-cookie": cookieMarker,
          },
        }),
    ];
    const fetch = makeFetch(responses);
    const sleep = makeSleep();
    const result = await runSmoke(baseArgs({ fetch, sleep }));

    assert.equal(result.ok, true);
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes(cookieMarker));
    assert.ok(!serialized.includes(bodyMarker));
    const report = formatReport(result);
    assert.ok(!report.includes(cookieMarker));
    assert.ok(!report.includes(bodyMarker));
  });

  it("the publishable key never appears in the result or the report", async () => {
    const fetch = makeFetch(happyResponses());
    const sleep = makeSleep();
    const result = await runSmoke(
      baseArgs({
        supabaseUrl: SUPABASE_URL,
        publishableKey: PUBLISHABLE_KEY,
        fetch,
        sleep,
      }),
    );
    assert.ok(!JSON.stringify(result).includes(PUBLISHABLE_KEY));
    assert.ok(!formatReport(result).includes(PUBLISHABLE_KEY));
  });
});

describe("runSmoke: input validation happens before any fetch", () => {
  const invalidBaseUrls = [
    "http://nblm-web-develop-abc123.vercel.app",
    "https://nblm-web-develop-abc123.example.com",
    "https://nblm-web-develop-abc123.vercel.app/",
    "https://nblm-web-develop-abc123.vercel.app/login",
  ];

  for (const bad of invalidBaseUrls) {
    it(`rejects baseUrl ${JSON.stringify(bad)} without calling fetch`, async () => {
      let fetchCalled = false;
      const fetch = async () => {
        fetchCalled = true;
        return new Response(null, { status: 200 });
      };
      let result;
      try {
        result = await runSmoke(
          baseArgs({ baseUrl: bad, fetch, sleep: makeSleep() }),
        );
      } catch {
        result = { ok: false };
      }
      assert.equal(fetchCalled, false);
      assert.equal(result.ok, false);
    });
  }

  const invalidSiteUrls = [
    "http://nblm-web-develop.vercel.app",
    "https://nblm-web-develop.vercel.app/",
    "https://nblm-web-develop.vercel.app/login",
  ];

  for (const bad of invalidSiteUrls) {
    it(`rejects siteUrl ${JSON.stringify(bad)} without calling fetch`, async () => {
      let fetchCalled = false;
      const fetch = async () => {
        fetchCalled = true;
        return new Response(null, { status: 200 });
      };
      let result;
      try {
        result = await runSmoke(
          baseArgs({ siteUrl: bad, fetch, sleep: makeSleep() }),
        );
      } catch {
        result = { ok: false };
      }
      assert.equal(fetchCalled, false);
      assert.equal(result.ok, false);
    });
  }
});

describe("runSmoke: auth-settings checks", () => {
  it("email: true fails", async () => {
    const responses = happyResponses();
    responses[`${SUPABASE_URL}/auth/v1/settings`] = [
      () =>
        new Response(
          JSON.stringify({
            external: { email: true, github: true, anonymous_users: false },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ];
    const result = await runSmoke(
      baseArgs({
        supabaseUrl: SUPABASE_URL,
        publishableKey: PUBLISHABLE_KEY,
        fetch: makeFetch(responses),
        sleep: makeSleep(),
      }),
    );
    assert.equal(result.ok, false);
    const r = result.results.find((x) => x.name === "auth-settings");
    assert.ok(r);
    assert.equal(r.pass, false);
  });

  it("anonymous_users: true fails", async () => {
    const responses = happyResponses();
    responses[`${SUPABASE_URL}/auth/v1/settings`] = [
      () =>
        new Response(
          JSON.stringify({
            external: { email: false, github: true, anonymous_users: true },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ];
    const result = await runSmoke(
      baseArgs({
        supabaseUrl: SUPABASE_URL,
        publishableKey: PUBLISHABLE_KEY,
        fetch: makeFetch(responses),
        sleep: makeSleep(),
      }),
    );
    assert.equal(result.ok, false);
    const r = result.results.find((x) => x.name === "auth-settings");
    assert.ok(r);
    assert.equal(r.pass, false);
  });

  it("github: false fails", async () => {
    const responses = happyResponses();
    responses[`${SUPABASE_URL}/auth/v1/settings`] = [
      () =>
        new Response(
          JSON.stringify({
            external: { email: false, github: false, anonymous_users: false },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ];
    const result = await runSmoke(
      baseArgs({
        supabaseUrl: SUPABASE_URL,
        publishableKey: PUBLISHABLE_KEY,
        fetch: makeFetch(responses),
        sleep: makeSleep(),
      }),
    );
    assert.equal(result.ok, false);
    const r = result.results.find((x) => x.name === "auth-settings");
    assert.ok(r);
    assert.equal(r.pass, false);
  });

  it("the apikey header carries the publishable key only on the auth-settings request", async () => {
    const fetch = makeFetch(happyResponses());
    await runSmoke(
      baseArgs({
        supabaseUrl: SUPABASE_URL,
        publishableKey: PUBLISHABLE_KEY,
        fetch,
        sleep: makeSleep(),
      }),
    );
    const settingsCall = fetch.calls.find((c) =>
      c.url.startsWith(`${SUPABASE_URL}/auth/v1/settings`),
    );
    assert.ok(settingsCall);
    const headers = new Headers(settingsCall.init?.headers ?? {});
    assert.equal(headers.get("apikey"), PUBLISHABLE_KEY);
  });
});

describe("checkLive", () => {
  it("passes on a 200 html response", async () => {
    const fetch = makeFetch({
      [`${SITE_URL}/login`]: [htmlOk],
    });
    const result = await checkLive({
      siteUrl: SITE_URL,
      fetch,
      sleep: makeSleep(),
    });
    assert.equal(result.ok, true);
  });

  it("fails on a persistent 404 after retries", async () => {
    const fetch = makeFetch({
      [`${SITE_URL}/login`]: [
        () => new Response(null, { status: 404 }),
        () => new Response(null, { status: 404 }),
        () => new Response(null, { status: 404 }),
        () => new Response(null, { status: 404 }),
        () => new Response(null, { status: 404 }),
      ],
    });
    const sleep = makeSleep();
    const result = await checkLive({ siteUrl: SITE_URL, fetch, sleep });
    assert.equal(result.ok, false);
    const calls = fetch.calls.filter((c) => c.key === `${SITE_URL}/login`);
    assert.equal(calls.length, 5);
  });
});

describe("formatReport", () => {
  it("renders a non-empty report mentioning each check by name", async () => {
    const fetch = makeFetch(happyResponses());
    const result = await runSmoke(baseArgs({ fetch, sleep: makeSleep() }));
    const report = formatReport(result);
    assert.equal(typeof report, "string");
    assert.ok(report.length > 0);
    for (const r of result.results) {
      assert.ok(report.includes(r.name));
    }
  });
});
