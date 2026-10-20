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

// The policy the app sends on every page (apps/web/lib/security/headers.ts), shortened.
const CSP_OK =
  "default-src 'self'; img-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'";

const htmlOk = () =>
  new Response("<html><body>login</body></html>", {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": CSP_OK },
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
      // F2 spec value change: anonymous sign-in must now be ON (demo login).
      external: { email: false, github: true, anonymous_users: true },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

// The captcha is enforced: a sign-up without a token is refused with captcha_failed.
const captchaEnforced = () =>
  new Response(JSON.stringify({ code: 400, error_code: "captcha_failed", msg: "captcha protection: request disallowed" }), {
    status: 400,
    headers: { "content-type": "application/json" },
  });

function happyResponses({ includeSupabase = true } = {}) {
  const map = {
    [`${BASE_URL}/login`]: [htmlOk],
    [`${BASE_URL}/`]: [rootRedirectOk],
    [`${BASE_URL}${PROTECTED_PATH}`]: [protectedRedirectOk],
    [`${BASE_URL}/auth/callback`]: [callbackOk],
  };
  if (includeSupabase) {
    map[`${SUPABASE_URL}/auth/v1/settings`] = [authSettingsOk];
    map[`${SUPABASE_URL}/auth/v1/signup`] = [captchaEnforced];
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

describe("runSmoke: Content-Security-Policy on /login", () => {
  async function runWithLoginHeaders(extra) {
    const responses = happyResponses();
    responses[`${BASE_URL}/login`] = [
      () =>
        new Response("<html><body>login</body></html>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8", ...extra },
        }),
    ];
    const result = await runSmoke(baseArgs({ fetch: makeFetch(responses), sleep: makeSleep() }));
    return result;
  }

  function cspFailure(result) {
    return result.results.find((r) => r.pass === false && /csp|content-security/i.test(`${r.name} ${r.reason}`));
  }

  it("passes when /login carries img-src 'self' and frame-ancestors 'none'", async () => {
    const result = await runWithLoginHeaders({ "content-security-policy": CSP_OK });
    assert.equal(result.ok, true);
  });

  it("fails when /login has no Content-Security-Policy header", async () => {
    const result = await runWithLoginHeaders({});
    assert.equal(result.ok, false);
    assert.ok(cspFailure(result), "expected a failing csp result");
  });

  it("fails when the policy has no img-src 'self'", async () => {
    const result = await runWithLoginHeaders({
      "content-security-policy": "default-src 'self'; frame-ancestors 'none'",
    });
    assert.equal(result.ok, false);
    assert.ok(cspFailure(result));
  });

  it("fails when img-src is widened beyond 'self'", async () => {
    const result = await runWithLoginHeaders({
      "content-security-policy": "default-src 'self'; img-src 'self' https:; frame-ancestors 'none'",
    });
    assert.equal(result.ok, false);
    assert.ok(cspFailure(result));
  });

  it("fails when the policy has no frame-ancestors 'none'", async () => {
    const result = await runWithLoginHeaders({
      "content-security-policy": "default-src 'self'; img-src 'self'",
    });
    assert.equal(result.ok, false);
    assert.ok(cspFailure(result));
  });

  it("fails when only a report-only policy is present", async () => {
    const result = await runWithLoginHeaders({
      "content-security-policy-report-only": CSP_OK,
    });
    assert.equal(result.ok, false);
    assert.ok(cspFailure(result));
  });

  // Browsers use the FIRST occurrence of a duplicated directive and ignore later ones.
  it("fails when a widened img-src comes first and a strict one follows", async () => {
    const result = await runWithLoginHeaders({
      "content-security-policy": "default-src 'self'; img-src *; img-src 'self'; frame-ancestors 'none'",
    });
    assert.equal(result.ok, false);
    assert.ok(cspFailure(result));
  });

  it("passes when a strict img-src comes first and a widened duplicate follows", async () => {
    const result = await runWithLoginHeaders({
      "content-security-policy": "default-src 'self'; img-src 'self'; img-src *; frame-ancestors 'none'",
    });
    assert.equal(result.ok, true);
  });

  it("fails when a widened frame-ancestors comes first and 'none' follows", async () => {
    const result = await runWithLoginHeaders({
      "content-security-policy": "default-src 'self'; img-src 'self'; frame-ancestors *; frame-ancestors 'none'",
    });
    assert.equal(result.ok, false);
    assert.ok(cspFailure(result));
  });

  it("does not print the policy value in the report", async () => {
    const marker = "CSP_VALUE_DO_NOT_PRINT";
    const result = await runWithLoginHeaders({
      "content-security-policy": `${CSP_OK}; report-uri https://${marker}.example/r`,
    });
    assert.ok(!JSON.stringify(result).includes(marker));
    assert.ok(!formatReport(result).includes(marker));
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
            "content-security-policy": CSP_OK,
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
            external: { email: true, github: true, anonymous_users: true },
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

  // Spec value change (F2): this used to be "anonymous_users: true fails".
  it("anonymous_users: false fails (the demo login needs it on)", async () => {
    const responses = happyResponses();
    responses[`${SUPABASE_URL}/auth/v1/settings`] = [
      () =>
        new Response(
          JSON.stringify({
            external: { email: false, github: true, anonymous_users: false },
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
            external: { email: false, github: false, anonymous_users: true },
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

describe("runSmoke: captcha probe (F2)", () => {
  async function runWithSignup(signup) {
    const responses = happyResponses();
    responses[`${SUPABASE_URL}/auth/v1/signup`] = [signup];
    const fetch = makeFetch(responses);
    const result = await runSmoke(
      baseArgs({
        bypassSecret: BYPASS_SECRET,
        supabaseUrl: SUPABASE_URL,
        publishableKey: PUBLISHABLE_KEY,
        fetch,
        sleep: makeSleep(),
      }),
    );
    return { result, fetch, check: result.results.find((x) => x.name === "captcha") };
  }

  const json = (status, body) => () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("passes on 400 with error_code captcha_failed", async () => {
    const { result, check } = await runWithSignup(captchaEnforced);
    assert.ok(check, 'expected a "captcha" result');
    assert.equal(check.pass, true);
    assert.equal(result.ok, true);
  });

  it("passes on 400 with the code field captcha_failed", async () => {
    const { check } = await runWithSignup(json(400, { code: "captcha_failed", msg: "x" }));
    assert.ok(check);
    assert.equal(check.pass, true);
  });

  it("fails on 200 (captcha off), and does not print the body", async () => {
    const marker = "ACCESS_TOKEN_DO_NOT_PRINT";
    const { result, check } = await runWithSignup(json(200, { access_token: marker, user: { id: "u" } }));
    assert.ok(check);
    assert.equal(check.pass, false);
    assert.equal(result.ok, false);
    assert.ok(!JSON.stringify(result).includes(marker));
    assert.ok(!formatReport(result).includes(marker));
  });

  for (const [status, body] of [
    [400, { code: 400, error_code: "validation_failed", msg: "x" }],
    [400, { code: 400, error_code: "anonymous_provider_disabled", msg: "x" }],
    [422, { code: 422, error_code: "captcha_failed", msg: "x" }],
    [429, { code: 429, error_code: "over_request_rate_limit", msg: "x" }],
  ]) {
    it(`fails on ${status} with ${body.error_code}`, async () => {
      const { check } = await runWithSignup(json(status, body));
      assert.ok(check);
      assert.equal(check.pass, false);
    });
  }

  it("fails on 400 with a body that is not JSON, and never prints it", async () => {
    const marker = "NOT_JSON_BODY_DO_NOT_PRINT";
    const { result, check } = await runWithSignup(() => new Response(marker, { status: 400 }));
    assert.ok(check);
    assert.equal(check.pass, false);
    assert.ok(!JSON.stringify(result).includes(marker));
    assert.ok(!formatReport(result).includes(marker));
  });

  it("never prints the captcha error body in the report on a pass either", async () => {
    const { result } = await runWithSignup(
      json(400, { error_code: "captcha_failed", msg: "BODY_MSG_DO_NOT_PRINT" }),
    );
    assert.ok(!JSON.stringify(result).includes("BODY_MSG_DO_NOT_PRINT"));
    assert.ok(!formatReport(result).includes("BODY_MSG_DO_NOT_PRINT"));
  });

  it("POSTs {} to /auth/v1/signup with the apikey header, no captcha token, redirect manual, an AbortSignal and no bypass header", async () => {
    const { fetch } = await runWithSignup(captchaEnforced);
    const call = fetch.calls.find((c) => c.key === `${SUPABASE_URL}/auth/v1/signup`);
    assert.ok(call, "expected a request to /auth/v1/signup");
    assert.equal(call.init?.method, "POST");
    assert.equal(call.init?.body, "{}");
    assert.equal(call.init?.redirect, "manual");
    assert.ok(call.init?.signal instanceof AbortSignal);
    const headers = new Headers(call.init?.headers ?? {});
    assert.equal(headers.get("apikey"), PUBLISHABLE_KEY);
    assert.equal(headers.get("x-vercel-protection-bypass"), null);
    assert.ok(!call.url.includes("captcha"));
    assert.ok(!String(call.init?.body).includes("captcha"));
    assert.equal(headers.get("x-captcha-token"), null);
  });

  it("is skipped, not failed, and never fetched without supabaseUrl and publishableKey", async () => {
    const fetch = makeFetch(happyResponses({ includeSupabase: false }));
    const result = await runSmoke(baseArgs({ fetch, sleep: makeSleep() }));
    assert.equal(result.ok, true);
    assert.ok(!fetch.calls.some((c) => c.url.includes("/auth/v1/signup")));
    const check = result.results.find((x) => x.name === "captcha");
    if (check) assert.notEqual(check.pass, false);
  });

  it("without supabaseUrl and publishableKey the result has a captcha row with reason skipped and pass true", async () => {
    const fetch = makeFetch(happyResponses({ includeSupabase: false }));
    const result = await runSmoke(baseArgs({ fetch, sleep: makeSleep() }));
    assert.equal(result.ok, true);
    const authSettings = result.results.find((x) => x.name === "auth-settings");
    assert.ok(authSettings, 'expected an "auth-settings" row');
    assert.equal(authSettings.reason, "skipped");
    const check = result.results.find((x) => x.name === "captcha");
    assert.ok(check, 'expected a "captcha" row');
    assert.equal(check.pass, true);
    assert.equal(check.reason, "skipped");
    assert.ok(!fetch.calls.some((c) => c.url.includes("/auth/v1/signup")));
  });

  it("a failing settings check (anonymous off) fails the run even when the captcha probe passes", async () => {
    const responses = happyResponses();
    responses[`${SUPABASE_URL}/auth/v1/settings`] = [
      json(200, { external: { email: false, github: true, anonymous_users: false } }),
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
    assert.equal(result.results.find((x) => x.name === "auth-settings").pass, false);
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

// Race after promote: the domain may briefly serve the previous deployment (no CSP).
describe("checkHtml: a 200 that fails only the CSP check is retried", () => {
  const htmlNoCsp = () =>
    new Response("<html><body>login</body></html>", {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });

  it("checkLive: no CSP first, CSP on the second response passes after one sleep", async () => {
    const fetch = makeFetch({ [`${SITE_URL}/login`]: [htmlNoCsp, htmlOk] });
    const sleep = makeSleep();
    const result = await checkLive({ siteUrl: SITE_URL, fetch, sleep });
    assert.equal(result.ok, true);
    assert.equal(sleep.calls.length, 1);
    assert.equal(fetch.calls.filter((c) => c.key === `${SITE_URL}/login`).length, 2);
  });

  it("checkLive: no CSP on all 5 attempts fails with reason csp after exactly 5 fetches", async () => {
    const fetch = makeFetch({
      [`${SITE_URL}/login`]: [htmlNoCsp, htmlNoCsp, htmlNoCsp, htmlNoCsp, htmlNoCsp],
    });
    const sleep = makeSleep();
    const result = await checkLive({ siteUrl: SITE_URL, fetch, sleep });
    assert.equal(result.ok, false);
    assert.equal(result.results[0].reason, "csp");
    assert.equal(fetch.calls.filter((c) => c.key === `${SITE_URL}/login`).length, 5);
  });

  it("runSmoke staged: no CSP first, CSP on the second response passes", async () => {
    const responses = happyResponses();
    responses[`${BASE_URL}/login`] = [htmlNoCsp, htmlOk];
    const fetch = makeFetch(responses);
    const sleep = makeSleep();
    const result = await runSmoke(baseArgs({ fetch, sleep }));
    assert.equal(result.ok, true);
    assert.equal(fetch.calls.filter((c) => c.key === `${BASE_URL}/login`).length, 2);
  });

  it("a wrong content-type is not retried", async () => {
    const fetch = makeFetch({
      [`${SITE_URL}/login`]: [
        () => new Response("{}", { status: 200, headers: { "content-type": "application/json", "content-security-policy": CSP_OK } }),
        htmlOk,
      ],
    });
    const sleep = makeSleep();
    const result = await checkLive({ siteUrl: SITE_URL, fetch, sleep });
    assert.equal(result.ok, false);
    assert.equal(result.results[0].reason, "content-type");
    assert.equal(fetch.calls.length, 1);
    assert.equal(sleep.calls.length, 0);
  });

  it("an x-powered-by header is not retried", async () => {
    const fetch = makeFetch({
      [`${SITE_URL}/login`]: [
        () =>
          new Response("<html></html>", {
            status: 200,
            headers: { "content-type": "text/html", "content-security-policy": CSP_OK, "x-powered-by": "Next.js" },
          }),
        htmlOk,
      ],
    });
    const sleep = makeSleep();
    const result = await checkLive({ siteUrl: SITE_URL, fetch, sleep });
    assert.equal(result.ok, false);
    assert.equal(result.results[0].reason, "x-powered-by");
    assert.equal(fetch.calls.length, 1);
    assert.equal(sleep.calls.length, 0);
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
