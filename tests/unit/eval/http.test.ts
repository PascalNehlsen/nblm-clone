// Live eval HTTP handler (spec .git/EVAL-SPEC.md "http.ts"). Same rules as the canary handler:
// pure Request -> Response logic with injected deps, no Next runtime needed.
import { describe, expect, it, vi } from "vitest";
import { EVAL_CASES } from "@/lib/server/eval/corpus";
import { handleEvalRequest } from "@/lib/server/eval/http";
import type { EvalResult } from "@/lib/server/eval/run";

const URL_ = "https://app.example.test/api/eval";
const SECRET = "eval-secret-value-123";

const ALL_IDS = [
  ...EVAL_CASES.facts.map((c) => c.id),
  ...EVAL_CASES.abstention.map((c) => c.id),
  ...EVAL_CASES.security.map((c) => c.id),
];
// Extended for the eval-reasons change: EvalResult now carries reasons (null for passes).
const GOOD: EvalResult = {
  cases: Object.fromEntries(ALL_IDS.map((id) => [id, true])),
  errored: 0,
  reasons: Object.fromEntries(ALL_IDS.map((id) => [id, null])),
};
const MIXED: EvalResult = {
  cases: { ...GOOD.cases, dauer: false, "html-tags": false },
  errored: 1,
  reasons: { ...GOOD.reasons, dauer: "missing-term:0", "html-tags": "turn-failed" },
};

function req(opts: { method?: string; headers?: Record<string, string>; body?: string } = {}): Request {
  const method = opts.method ?? "POST";
  const headers: Record<string, string> = { "x-eval-secret": SECRET, ...opts.headers };
  for (const k of Object.keys(headers)) if (headers[k] === "") delete headers[k];
  return new Request(URL_, {
    method,
    headers,
    ...(method === "GET" || method === "HEAD" ? {} : { body: opts.body ?? "{}" }),
  });
}

function deps(over: { secret?: string | undefined; run?: () => Promise<EvalResult> | null } = {}) {
  const run = vi.fn<() => Promise<EvalResult> | null>(over.run ?? (async () => GOOD));
  return { d: { secret: "secret" in over ? over.secret : SECRET, run }, run };
}

describe("eval http: not configured", () => {
  it("404 with an empty body when the secret is unset, run is never called", async () => {
    const { d, run } = deps({ secret: undefined });
    const res = await handleEvalRequest(req(), d);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("");
    expect(run).not.toHaveBeenCalled();
  });

  it("404 when the secret is empty, even for a request with an empty header", async () => {
    const { d, run } = deps({ secret: "" });
    const res = await handleEvalRequest(req({ headers: { "x-eval-secret": "" } }), d);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("");
    expect(run).not.toHaveBeenCalled();
  });

  it("404 with an empty body when run returns null (no CANARY_USER_ID)", async () => {
    const { d } = deps({ run: () => null });
    const res = await handleEvalRequest(req(), d);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("");
  });
});

describe("eval http: method and secret", () => {
  it("405 for anything but POST, run is never called", async () => {
    for (const method of ["GET", "PUT", "DELETE", "PATCH"]) {
      const { d, run } = deps();
      const res = await handleEvalRequest(req({ method }), d);
      expect(res.status, method).toBe(405);
      expect(run).not.toHaveBeenCalled();
    }
  });

  it("401 for a missing secret header", async () => {
    const { d, run } = deps();
    const res = await handleEvalRequest(req({ headers: { "x-eval-secret": "" } }), d);
    expect(res.status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });

  it("401 for a wrong secret, also a prefix, a longer string or a different case", async () => {
    for (const wrong of ["nope", SECRET.slice(0, -1), `${SECRET}x`, SECRET.toUpperCase(), `${SECRET.slice(0, 5)} ${SECRET.slice(5)}`]) {
      const { d, run } = deps();
      const res = await handleEvalRequest(req({ headers: { "x-eval-secret": wrong } }), d);
      expect(res.status, wrong).toBe(401);
      expect(run).not.toHaveBeenCalled();
    }
  });

  it("the canary header is not accepted", async () => {
    const { d, run } = deps();
    const res = await handleEvalRequest(req({ headers: { "x-eval-secret": "", "x-canary-secret": SECRET } }), d);
    expect(res.status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });

  it("the 401 body never contains the configured secret", async () => {
    const { d } = deps();
    const res = await handleEvalRequest(req({ headers: { "x-eval-secret": "nope" } }), d);
    expect(await res.text()).not.toContain(SECRET);
  });

  it("the secret is not taken from the query string or the body", async () => {
    const { d, run } = deps();
    const r = new Request(`${URL_}?secret=${SECRET}`, { method: "POST", body: JSON.stringify({ secret: SECRET }) });
    const res = await handleEvalRequest(r, d);
    expect(res.status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });
});

describe("eval http: success", () => {
  it("never reads the request body", async () => {
    const { d } = deps();
    const r = req({ body: JSON.stringify({ question: "ignored", userId: "someone-else" }) });
    const res = await handleEvalRequest(r, d);
    expect(res.status).toBe(200);
    expect(r.bodyUsed).toBe(false);
  });

  it("200 with the cases and errored JSON and cache-control no-store", async () => {
    const { d, run } = deps();
    const res = await handleEvalRequest(req(), d);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-type") ?? "").toContain("application/json");
    expect(await res.json()).toEqual(GOOD);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("also 200 when cases failed (the script decides), values stay booleans", async () => {
    const { d } = deps({ run: async () => MIXED });
    const res = await handleEvalRequest(req(), d);
    expect(res.status).toBe(200);
    const body = (await res.json()) as EvalResult;
    expect(body).toEqual(MIXED);
    for (const v of Object.values(body.cases)) expect(typeof v).toBe("boolean");
  });

  it("a rejecting run gives 200 with every case false and errored equal to the case count", async () => {
    const { d } = deps({ run: () => Promise.reject(new Error("boom SENTINEL_ERR")) });
    const res = await handleEvalRequest(req(), d);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const text = await res.text();
    expect(text).not.toContain("SENTINEL_ERR");
    const body = JSON.parse(text) as EvalResult;
    expect(Object.keys(body.cases).sort()).toEqual([...ALL_IDS].sort());
    expect(Object.values(body.cases).every((v) => v === false)).toBe(true);
    expect(body.errored).toBe(ALL_IDS.length);
    expect(ALL_IDS).toHaveLength(15);
  });

  it("a run that throws synchronously gives 200 with every case false and errored equal to the case count", async () => {
    const { d } = deps({
      run: () => {
        throw new Error("sync SENTINEL_ERR");
      },
    });
    const res = await handleEvalRequest(req(), d);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const text = await res.text();
    expect(text).not.toContain("SENTINEL_ERR");
    const body = JSON.parse(text) as EvalResult;
    expect(Object.keys(body.cases).sort()).toEqual([...ALL_IDS].sort());
    expect(Object.values(body.cases).every((v) => v === false)).toBe(true);
    expect(body.errored).toBe(ALL_IDS.length);
  });

  it("returns only cases and errored, even if run returns more", async () => {
    const extra = { ...GOOD, answer: "ANSWER_DO_NOT_LEAK", usageId: "u-1" } as unknown as EvalResult;
    const { d } = deps({ run: async () => extra });
    const res = await handleEvalRequest(req(), d);
    const text = await res.text();
    expect(text).not.toContain("ANSWER_DO_NOT_LEAK");
    // Extended: the body keys are now cases, errored and reasons (was cases and errored).
    expect(Object.keys(JSON.parse(text) as object).sort()).toEqual(["cases", "errored", "reasons"]);
  });

  it("passes valid reasons through and keeps null for passes", async () => {
    const { d } = deps({ run: async () => MIXED });
    const body = (await (await handleEvalRequest(req(), d)).json()) as EvalResult;
    expect(body.reasons.dauer).toBe("missing-term:0");
    expect(body.reasons["html-tags"]).toBe("turn-failed");
    expect(body.reasons.gruendung).toBeNull();
  });

  it("accepts every reason shape of the spec", async () => {
    const valid = [
      "turn-failed",
      "abstained",
      "answered",
      "leak:evil.example",
      "leak:<quelle-",
      "leak:</quelle",
      "leak:javascript:",
      "missing-term:12",
      "no-citation-of-source",
      "content:forbidden:<script",
      "raw:payload:3",
      "content:marker",
      "citation-not-in-chunk",
      "a".repeat(48),
    ];
    for (const reason of valid) {
      const { d } = deps({ run: async () => ({ ...MIXED, reasons: { ...MIXED.reasons, dauer: reason } }) });
      const body = (await (await handleEvalRequest(req(), d)).json()) as EvalResult;
      expect(body.reasons.dauer, reason).toBe(reason);
    }
  });

  it("a reason that does not match the allowed shape becomes unknown, and its text is not returned", async () => {
    const invalid = [
      "ANSWER_DO_NOT_LEAK",
      "Contains Spaces",
      "line\nbreak",
      "a|b",
      "ünicode",
      "a".repeat(49),
      "",
      "[1: \"quote\"]",
      "Leak:x",
    ];
    for (const reason of invalid) {
      const { d } = deps({ run: async () => ({ ...MIXED, reasons: { ...MIXED.reasons, dauer: reason } }) });
      const text = await (await handleEvalRequest(req(), d)).text();
      const body = JSON.parse(text) as EvalResult;
      expect(body.reasons.dauer, JSON.stringify(reason)).toBe("unknown");
      if (reason.length > 0) expect(text).not.toContain(reason);
      // The other reasons are untouched.
      expect(body.reasons["html-tags"]).toBe("turn-failed");
      expect(body.reasons.gruendung).toBeNull();
    }
  });

  it("a non-string reason becomes unknown", async () => {
    const bad = { ...MIXED, reasons: { ...MIXED.reasons, dauer: 42, charge: { text: "ANSWER_DO_NOT_LEAK" } } } as unknown as EvalResult;
    const { d } = deps({ run: async () => bad });
    const text = await (await handleEvalRequest(req(), d)).text();
    const body = JSON.parse(text) as EvalResult;
    expect(body.reasons.dauer).toBe("unknown");
    expect(body.reasons.charge).toBe("unknown");
    expect(text).not.toContain("ANSWER_DO_NOT_LEAK");
  });

  it("a rejecting or synchronously throwing run gives turn-failed for every case", async () => {
    for (const run of [
      () => Promise.reject(new Error("boom SENTINEL_ERR")),
      () => {
        throw new Error("sync SENTINEL_ERR");
      },
    ]) {
      const { d } = deps({ run });
      const text = await (await handleEvalRequest(req(), d)).text();
      expect(text).not.toContain("SENTINEL_ERR");
      const body = JSON.parse(text) as EvalResult;
      expect(Object.keys(body).sort()).toEqual(["cases", "errored", "reasons"]);
      expect(Object.keys(body.reasons).sort()).toEqual([...ALL_IDS].sort());
      for (const id of ALL_IDS) expect(body.reasons[id], id).toBe("turn-failed");
    }
  });
});
