// R2 canary HTTP handler (spec .git/R2-SPEC.md "http.ts"). Pure Request -> Response logic with
// injected deps; no Next runtime needed.
import { describe, expect, it, vi } from "vitest";
import { handleCanaryRequest } from "@/lib/server/canary/http";
import type { CanaryResult } from "@/lib/server/canary/canary";

const URL_ = "https://app.example.test/api/canary";
const SECRET = "canary-secret-value-123";

const GOOD: CanaryResult = {
  ok: true,
  checks: { embedding: true, answered: true, citationValid: true, notAbstained: true },
};
const BAD: CanaryResult = {
  ok: false,
  checks: { embedding: true, answered: true, citationValid: false, notAbstained: false },
};

function req(opts: { method?: string; headers?: Record<string, string>; body?: string } = {}): Request {
  const method = opts.method ?? "POST";
  const headers: Record<string, string> = { "x-canary-secret": SECRET, ...opts.headers };
  for (const k of Object.keys(headers)) if (headers[k] === "") delete headers[k];
  return new Request(URL_, {
    method,
    headers,
    ...(method === "GET" || method === "HEAD" ? {} : { body: opts.body ?? "{}" }),
  });
}

function deps(over: { secret?: string | undefined; run?: () => Promise<CanaryResult> | null } = {}) {
  const run = vi.fn<() => Promise<CanaryResult> | null>(over.run ?? (async () => GOOD));
  return { d: { secret: "secret" in over ? over.secret : SECRET, run }, run };
}

describe("canary http: not configured", () => {
  it("404 with an empty body when the secret is unset, run is never called", async () => {
    const { d, run } = deps({ secret: undefined });
    const res = await handleCanaryRequest(req(), d);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("");
    expect(run).not.toHaveBeenCalled();
  });

  it("404 when the secret is empty, even for a request with an empty header", async () => {
    const { d, run } = deps({ secret: "" });
    const res = await handleCanaryRequest(req({ headers: { "x-canary-secret": "" } }), d);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("");
    expect(run).not.toHaveBeenCalled();
  });

  it("404 with an empty body when run returns null (no CANARY_USER_ID)", async () => {
    const { d } = deps({ run: () => null });
    const res = await handleCanaryRequest(req(), d);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("");
  });
});

describe("canary http: method and secret", () => {
  it("405 for anything but POST, run is never called", async () => {
    for (const method of ["GET", "PUT", "DELETE", "PATCH"]) {
      const { d, run } = deps();
      const res = await handleCanaryRequest(req({ method }), d);
      expect(res.status, method).toBe(405);
      expect(run).not.toHaveBeenCalled();
    }
  });

  it("401 for a missing secret header", async () => {
    const { d, run } = deps();
    const res = await handleCanaryRequest(req({ headers: { "x-canary-secret": "" } }), d);
    expect(res.status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });

  it("401 for a wrong secret, also one that is a prefix, a longer string or a different case", async () => {
    for (const wrong of ["nope", SECRET.slice(0, -1), `${SECRET}x`, SECRET.toUpperCase(), `${SECRET.slice(0, 5)} ${SECRET.slice(5)}`]) {
      const { d, run } = deps();
      const res = await handleCanaryRequest(req({ headers: { "x-canary-secret": wrong } }), d);
      expect(res.status, wrong).toBe(401);
      expect(run).not.toHaveBeenCalled();
    }
  });

  it("the 401 body never contains the configured secret", async () => {
    const { d } = deps();
    const res = await handleCanaryRequest(req({ headers: { "x-canary-secret": "nope" } }), d);
    expect(await res.text()).not.toContain(SECRET);
  });

  it("the secret is not taken from the query string or the body", async () => {
    const { d, run } = deps();
    const r = new Request(`${URL_}?secret=${SECRET}`, { method: "POST", body: JSON.stringify({ secret: SECRET }) });
    const res = await handleCanaryRequest(r, d);
    expect(res.status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });
});

describe("canary http: success", () => {
  it("never reads the request body", async () => {
    const { d } = deps();
    const r = req({ body: JSON.stringify({ question: "ignored", userId: "someone-else" }) });
    const res = await handleCanaryRequest(r, d);
    expect(res.status).toBe(200);
    expect(r.bodyUsed).toBe(false);
  });

  it("200 with the ok and checks JSON and cache-control no-store", async () => {
    const { d, run } = deps();
    const res = await handleCanaryRequest(req(), d);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-type") ?? "").toContain("application/json");
    expect(await res.json()).toEqual(GOOD);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("also 200 with ok false when a check failed (the script decides)", async () => {
    const { d } = deps({ run: async () => BAD });
    const res = await handleCanaryRequest(req(), d);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual(BAD);
  });

  it("a rejecting run gives 200 with ok false and all four checks false (no 500, so no retry)", async () => {
    const { d } = deps({ run: () => Promise.reject(new Error("boom SENTINEL_ERR")) });
    const res = await handleCanaryRequest(req(), d);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const text = await res.text();
    expect(text).not.toContain("SENTINEL_ERR");
    expect(JSON.parse(text)).toEqual({
      ok: false,
      checks: { embedding: false, answered: false, citationValid: false, notAbstained: false },
    });
  });

  it("returns only ok and the four booleans, even if run returns more", async () => {
    const extra = { ...GOOD, answer: "ANSWER_DO_NOT_LEAK", usageId: "u-1" } as unknown as CanaryResult;
    const { d } = deps({ run: async () => extra });
    const res = await handleCanaryRequest(req(), d);
    const text = await res.text();
    expect(text).not.toContain("ANSWER_DO_NOT_LEAK");
    expect(Object.keys(JSON.parse(text) as object).sort()).toEqual(["checks", "ok"]);
  });
});
