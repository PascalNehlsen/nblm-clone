// /api/eval records the score after scoring, fail-soft. The logic lives in lib/server/eval/http.ts
// (the route stays a thin wrapper, tests/unit/eval/source-scan.test.ts), so the recording is an
// injected dependency, and http.ts never imports an admin module.
//
// Pinned contract: handleEvalRequest(request, { secret, run, record? }) where
//   record?: (result: EvalResult) => Promise<void> | void
//   - called once, after run succeeded (or fell back to the all-failed result), with the result
//   - awaited before the response is returned (a serverless function may be frozen right after
//     it responds), but any throw or rejection is swallowed: status, headers and body stay exactly
//     what they are without recording, and no error text reaches the response
//   - never called for 404, 405 or 401, nor when run returns null
//   - omitting record changes nothing (all existing tests in tests/unit/eval/http.test.ts)
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
const GOOD: EvalResult = {
  cases: Object.fromEntries(ALL_IDS.map((id) => [id, true])),
  errored: 0,
  reasons: Object.fromEntries(ALL_IDS.map((id) => [id, null])),
};

function req(headers: Record<string, string> = { "x-eval-secret": SECRET }, method = "POST"): Request {
  return new Request(URL_, { method, headers, ...(method === "GET" ? {} : { body: "{}" }) });
}

type Record_ = (result: EvalResult) => Promise<void> | void;

function deps(over: { run?: () => Promise<EvalResult> | null; record?: Record_; secret?: string | undefined } = {}) {
  const run = vi.fn<() => Promise<EvalResult> | null>(over.run ?? (async () => GOOD));
  const record = vi.fn<Record_>(over.record ?? (async () => undefined));
  return { d: { secret: "secret" in over ? over.secret : SECRET, run, record }, run, record };
}

async function snapshot(res: Response) {
  return { status: res.status, cache: res.headers.get("cache-control"), type: res.headers.get("content-type"), body: await res.text() };
}

describe("eval route recording: success path", () => {
  it("records the result once, after the run", async () => {
    const order: string[] = [];
    const { d, record } = deps({
      run: async () => {
        order.push("run");
        return GOOD;
      },
      record: async () => {
        order.push("record");
      },
    });
    const res = await handleEvalRequest(req(), d);
    expect(res.status).toBe(200);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ cases: GOOD.cases, errored: 0 }));
    expect(order).toEqual(["run", "record"]);
  });

  it("awaits the recording before it returns the response", async () => {
    let finished = false;
    const { d } = deps({
      record: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        finished = true;
      },
    });
    await handleEvalRequest(req(), d);
    expect(finished).toBe(true);
  });

  it("records the all-failed fallback when the run itself rejects", async () => {
    const { d, record } = deps({ run: () => Promise.reject(new Error("boom")) });
    const res = await handleEvalRequest(req(), d);
    expect(res.status).toBe(200);
    expect(record).toHaveBeenCalledTimes(1);
    const recorded = record.mock.calls[0]?.[0] as EvalResult;
    expect(Object.values(recorded.cases).every((v) => v === false)).toBe(true);
    expect(recorded.errored).toBe(ALL_IDS.length);
  });

  it("the response is the same with and without recording", async () => {
    const withRecord = await snapshot(await handleEvalRequest(req(), deps().d));
    const { secret, run } = deps().d;
    const without = await snapshot(await handleEvalRequest(req(), { secret, run }));
    expect(withRecord).toEqual(without);
  });
});

describe("eval route recording: fail-soft", () => {
  const failures: Array<[string, Record_]> = [
    ["rejects", () => Promise.reject(new Error("record exploded SENTINEL_REC"))],
    [
      "throws synchronously",
      () => {
        throw new Error("record exploded SENTINEL_REC");
      },
    ],
  ];

  it.each(failures)("when recording %s, the response is unchanged and carries no error text", async (_label, record) => {
    const baseline = await snapshot(await handleEvalRequest(req(), deps().d));
    const failing = deps({ record });
    const res = await handleEvalRequest(req(), failing.d);
    const got = await snapshot(res);
    expect(failing.record).toHaveBeenCalledTimes(1);
    expect(got).toEqual(baseline);
    expect(got.status).toBe(200);
    expect(got.body).not.toContain("SENTINEL_REC");
  });

  it.each(failures)("when recording %s, a failed run's fallback response is unchanged too", async (_label, record) => {
    const run = () => Promise.reject(new Error("boom SENTINEL_RUN"));
    const baseline = await snapshot(await handleEvalRequest(req(), deps({ run }).d));
    const got = await snapshot(await handleEvalRequest(req(), deps({ run, record }).d));
    expect(got).toEqual(baseline);
    expect(got.body).not.toContain("SENTINEL_RUN");
    expect(got.body).not.toContain("SENTINEL_REC");
  });
});

describe("eval route recording: never on a request that is not answered with a result", () => {
  it("not when the secret is unset (404)", async () => {
    const { d, record } = deps({ secret: undefined });
    expect((await handleEvalRequest(req(), d)).status).toBe(404);
    expect(record).not.toHaveBeenCalled();
  });

  it("not for a non-POST request (405)", async () => {
    const { d, record } = deps();
    expect((await handleEvalRequest(req({ "x-eval-secret": SECRET }, "GET"), d)).status).toBe(405);
    expect(record).not.toHaveBeenCalled();
  });

  it("not for a wrong or missing secret (401)", async () => {
    const badHeaders: Record<string, string>[] = [{ "x-eval-secret": "nope" }, {}];
    for (const headers of badHeaders) {
      const { d, record, run } = deps();
      expect((await handleEvalRequest(req(headers), d)).status).toBe(401);
      expect(run).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
    }
  });

  it("not when run returns null (404)", async () => {
    const { d, record } = deps({ run: () => null });
    expect((await handleEvalRequest(req(), d)).status).toBe(404);
    expect(record).not.toHaveBeenCalled();
  });
});
