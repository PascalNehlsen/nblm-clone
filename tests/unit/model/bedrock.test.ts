// PR B (block C: Bedrock embeddings): the Titan V2 embedding adapter behind
// ProviderCall<"embedding"> (lib/server/model/types.ts). Exercised entirely through an
// injected `send` fake -- never a real AWS call -- so this file proves the adapter's own
// contract: EU-only region/role config checked before any send, the Titan request shape,
// ordering and usage accounting, bounded concurrency, response validation, SDK error
// mapping into ProviderError (AGENTS.md: "no prompt or provider text can travel with it"),
// an already-aborted signal, and that nothing is ever logged (model call text must never
// reach logs). The real-client wiring (OIDC credentials, BedrockRuntimeClient
// construction) is covered separately in bedrock-default.test.ts, since it needs to mock
// @aws-sdk/client-bedrock-runtime and @vercel/functions/oidc at the module level, which
// does not mix well with the injected-send tests here.
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { createBedrockEmbeddings, BEDROCK_EU_REGIONS } from "@/lib/server/model/bedrock";
import { ProviderError } from "@/lib/server/model/types";
import type { ProviderRequest } from "@/lib/server/model/types";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const bedrockFile = path.join(repoRoot, "apps/web/lib/server/model/bedrock.ts");

const MODEL_ID = "amazon.titan-embed-text-v2:0";
const ROLE_ARN = "arn:aws:iam::123456789012:role/test-role";
const VALID_ENV: Record<string, string | undefined> = { BEDROCK_REGION: "eu-central-1", AWS_ROLE_ARN: ROLE_ARN };

// A valid Titan V2 embedding: 1024 finite numbers.
const VALID_VECTOR: number[] = Array.from({ length: 1024 }, () => 0.1);

function vectorWith(overrides: Record<number, unknown> = {}): unknown[] {
  const vector: unknown[] = Array.from({ length: 1024 }, () => 0.1);
  for (const [index, value] of Object.entries(overrides)) vector[Number(index)] = value;
  return vector;
}

function bodyFor(vector: unknown[], inputTextTokenCount: number): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ embedding: vector, inputTextTokenCount }));
}

function rawBody(obj: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj));
}

function makeRequest(texts: string[], signal?: AbortSignal): ProviderRequest<"embedding"> {
  return {
    modelId: MODEL_ID,
    maxOutputTokens: 0,
    input: { texts },
    signal: signal ?? new AbortController().signal,
  };
}

// Flushes pending microtasks and the current macrotask queue, so promises started by the
// provider (sends dispatched, concurrency slots filled) have settled before we assert.
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject, but it resolved");
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  delete process.env.BEDROCK_REGION;
  delete process.env.AWS_ROLE_ARN;
  delete process.env.AWS_REGION;
});

describe("BEDROCK_EU_REGIONS", () => {
  it("is exactly the six approved EU regions", () => {
    expect([...BEDROCK_EU_REGIONS].sort()).toEqual(
      ["eu-central-1", "eu-north-1", "eu-south-1", "eu-south-2", "eu-west-1", "eu-west-3"].sort(),
    );
  });
});

describe("createBedrockEmbeddings: config is checked before any send", () => {
  const invalidEnvCases: Array<[string, Record<string, string | undefined>]> = [
    ["BEDROCK_REGION missing", { AWS_ROLE_ARN: ROLE_ARN }],
    ["BEDROCK_REGION empty", { ...VALID_ENV, BEDROCK_REGION: "" }],
    ["BEDROCK_REGION not in the EU allowlist (us-east-1)", { ...VALID_ENV, BEDROCK_REGION: "us-east-1" }],
    ["BEDROCK_REGION not in the EU allowlist (eu-central-2)", { ...VALID_ENV, BEDROCK_REGION: "eu-central-2" }],
    ["AWS_ROLE_ARN missing", { BEDROCK_REGION: "eu-central-1" }],
    ["AWS_ROLE_ARN empty", { ...VALID_ENV, AWS_ROLE_ARN: "" }],
    [
      "BEDROCK_REGION missing even though AWS_REGION is set (AWS_REGION is never used)",
      { AWS_REGION: "eu-central-1", AWS_ROLE_ARN: ROLE_ARN },
    ],
  ];

  it.each(invalidEnvCases)("%s -> ProviderError 'error', send is never called", async (_label, env) => {
    const send = vi.fn(async () => ({ body: bodyFor(VALID_VECTOR, 1) }));
    const provider = createBedrockEmbeddings({ send, env });
    const error = await captureError(provider(makeRequest(["a"])));
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).kind).toBe("error");
    expect(send).not.toHaveBeenCalled();
  });

  it("BEDROCK_REGION eu-central-1 with an unrelated AWS_REGION (us-east-1) works: AWS_REGION is never used", async () => {
    const send = vi.fn(async () => ({ body: bodyFor(VALID_VECTOR, 1) }));
    const provider = createBedrockEmbeddings({
      send,
      env: { BEDROCK_REGION: "eu-central-1", AWS_REGION: "us-east-1", AWS_ROLE_ARN: ROLE_ARN },
    });
    const result = await provider(makeRequest(["a"]));
    expect(result.output.vectors).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each(BEDROCK_EU_REGIONS)("BEDROCK_REGION %s is accepted", async (region) => {
    const send = vi.fn(async () => ({ body: bodyFor(VALID_VECTOR, 1) }));
    const provider = createBedrockEmbeddings({ send, env: { BEDROCK_REGION: region, AWS_ROLE_ARN: ROLE_ARN } });
    const result = await provider(makeRequest(["a"]));
    expect(result.output.vectors).toHaveLength(1);
  });

  it("env is read per call, not at factory-creation time", async () => {
    delete process.env.BEDROCK_REGION;
    delete process.env.AWS_ROLE_ARN;
    const send = vi.fn(async () => ({ body: bodyFor(VALID_VECTOR, 3) }));
    // deps.env omitted here on purpose: this instance must fall back to process.env,
    // read fresh on every call -- not captured once when createBedrockEmbeddings runs
    // (process.env has neither var set at this point).
    const provider = createBedrockEmbeddings({ send });
    vi.stubEnv("BEDROCK_REGION", "eu-central-1");
    vi.stubEnv("AWS_ROLE_ARN", ROLE_ARN);
    const result = await provider(makeRequest(["hello"]));
    expect(result.output.vectors).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe("createBedrockEmbeddings: request shape", () => {
  it("sends one InvokeModelCommand per text, with the Titan request body and the request's abortSignal", async () => {
    const calls: Array<{ command: InvokeModelCommand; options: { abortSignal: AbortSignal } }> = [];
    const send = vi.fn(async (command: InvokeModelCommand, options: { abortSignal: AbortSignal }) => {
      calls.push({ command, options });
      return { body: bodyFor(VALID_VECTOR, 1) };
    });
    const provider = createBedrockEmbeddings({ send, env: VALID_ENV });
    const controller = new AbortController();
    const request = makeRequest(["hello", "world"], controller.signal);

    await provider(request);

    expect(send).toHaveBeenCalledTimes(2);
    const texts = ["hello", "world"];
    calls.forEach((call, index) => {
      expect(call.command).toBeInstanceOf(InvokeModelCommand);
      const input = call.command.input as Record<string, unknown>;
      expect(input.modelId).toBe(request.modelId);
      expect(input.contentType).toBe("application/json");
      expect(input.accept).toBe("application/json");
      expect(typeof input.body).toBe("string");
      expect(JSON.parse(input.body as string)).toEqual({
        inputText: texts[index],
        dimensions: 1024,
        normalize: true,
      });
      expect(call.options).toEqual({ abortSignal: controller.signal });
    });
  });
});

describe("createBedrockEmbeddings: result ordering and usage", () => {
  it("returns vectors in input order even when the fake resolves out of order", async () => {
    const resolvers: Array<(v: { body: Uint8Array }) => void> = [];
    const send = vi.fn(() => new Promise<{ body: Uint8Array }>((resolve) => resolvers.push(resolve)));
    const provider = createBedrockEmbeddings({ send, env: VALID_ENV });

    const resultPromise = provider(makeRequest(["a", "b", "c"]));
    await flush();
    expect(resolvers).toHaveLength(3);

    const vectorFor = (n: number) => Array.from({ length: 1024 }, () => n);
    // Resolve out of order: index 2, then 0, then 1.
    resolvers[2]?.({ body: bodyFor(vectorFor(3), 3) });
    resolvers[0]?.({ body: bodyFor(vectorFor(1), 1) });
    resolvers[1]?.({ body: bodyFor(vectorFor(2), 2) });

    const result = await resultPromise;
    expect(result.output.vectors[0]).toEqual(vectorFor(1));
    expect(result.output.vectors[1]).toEqual(vectorFor(2));
    expect(result.output.vectors[2]).toEqual(vectorFor(3));
    expect(result.usage).toEqual({ inputTokens: 6, outputTokens: 0 });
  });

  it("an empty texts list resolves immediately without sending", async () => {
    const send = vi.fn(async () => ({ body: bodyFor(VALID_VECTOR, 1) }));
    const provider = createBedrockEmbeddings({ send, env: VALID_ENV });
    const result = await provider(makeRequest([]));
    expect(result).toEqual({ output: { vectors: [] }, usage: { inputTokens: 0, outputTokens: 0 } });
    expect(send).not.toHaveBeenCalled();
  });
});

describe("createBedrockEmbeddings: bounded concurrency", () => {
  it("never has more than 4 sends in flight, and reaches 4", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const pending: Array<() => void> = [];
    const send = vi.fn(() => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise<{ body: Uint8Array }>((resolve) => {
        pending.push(() => {
          inFlight -= 1;
          resolve({ body: bodyFor(VALID_VECTOR, 1) });
        });
      });
    });
    const provider = createBedrockEmbeddings({ send, env: VALID_ENV });
    const texts = Array.from({ length: 10 }, (_, i) => `text-${i}`);
    const resultPromise = provider(makeRequest(texts));

    await flush();
    expect(inFlight).toBe(4);

    while (send.mock.calls.length < 10) {
      expect(inFlight).toBeLessThanOrEqual(4);
      pending.shift()?.();
      await flush();
    }
    while (pending.length > 0) {
      pending.shift()?.();
      await flush();
    }

    await resultPromise;
    expect(send).toHaveBeenCalledTimes(10);
    expect(maxInFlight).toBe(4);
  });
});

describe("createBedrockEmbeddings: response validation", () => {
  const malformedBodies: Array<[string, Uint8Array]> = [
    ["embedding has 1023 entries", bodyFor(Array(1023).fill(0.1), 1)],
    ["embedding has 1025 entries", bodyFor(Array(1025).fill(0.1), 1)],
    ["embedding is not an array", rawBody({ embedding: "not-an-array", inputTextTokenCount: 1 })],
    // JSON cannot encode NaN/Infinity (JSON.stringify turns both into null), so this is the
    // closest runtime representation of "the SDK returned a non-finite entry" -- the
    // implementation must reject it as not-a-finite-number just the same.
    ["embedding contains a non-finite entry (NaN/Infinity round-trip to null over JSON)",
      bodyFor(vectorWith({ 5: Number.POSITIVE_INFINITY }), 1)],
    ["embedding contains a string entry", bodyFor(vectorWith({ 5: "0.5" }), 1)],
    ["inputTextTokenCount is missing", rawBody({ embedding: vectorWith() })],
    ["inputTextTokenCount is negative", bodyFor(vectorWith(), -1)],
    ["inputTextTokenCount is not an integer", bodyFor(vectorWith(), 1.5)],
    ["body is not JSON at all", new TextEncoder().encode("not-json-at-all")],
  ];

  it.each(malformedBodies)("%s -> ProviderError 'error'", async (_label, body) => {
    const send = vi.fn(async () => ({ body }));
    const provider = createBedrockEmbeddings({ send, env: VALID_ENV });
    const error = await captureError(provider(makeRequest(["x"])));
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).kind).toBe("error");
  });
});

describe("createBedrockEmbeddings: SDK error mapping", () => {
  function namedError(name: string, message = "sdk-secret-detail-xyz"): Error {
    const error = new Error(message);
    error.name = name;
    return error;
  }

  const cases: Array<[string, unknown, "throttled" | "timeout" | "error"]> = [
    ["ThrottlingException", namedError("ThrottlingException"), "throttled"],
    ["ServiceQuotaExceededException", namedError("ServiceQuotaExceededException"), "throttled"],
    ["ModelTimeoutException", namedError("ModelTimeoutException"), "timeout"],
    ["AbortError", namedError("AbortError"), "timeout"],
    ["TimeoutError", namedError("TimeoutError"), "timeout"],
    ["AccessDeniedException", namedError("AccessDeniedException"), "error"],
    ["ValidationException", namedError("ValidationException"), "error"],
    ["a plain Error", new Error("sdk-secret-detail-xyz"), "error"],
    ["a thrown non-Error value", "sdk-secret-detail-xyz", "error"],
  ];

  it.each(cases)("send rejecting/throwing with %s maps to kind %s, without the SDK message or a cause", async (_label, thrown, expectedKind) => {
    const send = vi.fn(async () => {
      throw thrown;
    });
    const provider = createBedrockEmbeddings({ send, env: VALID_ENV });
    const error = await captureError(provider(makeRequest(["x"])));
    expect(error).toBeInstanceOf(ProviderError);
    const providerError = error as ProviderError;
    expect(providerError.kind).toBe(expectedKind);
    expect(providerError.message).not.toContain("sdk-secret-detail-xyz");
    expect(Object.prototype.hasOwnProperty.call(providerError, "cause")).toBe(false);
  });
});

describe("createBedrockEmbeddings: partial failure carries usage so far", () => {
  it("two successes (tokens 5 and 7) before a third failure -> ProviderError usage 12/0", async () => {
    const resolvers: Array<{ resolve: (v: { body: Uint8Array }) => void; reject: (e: unknown) => void }> = [];
    const send = vi.fn(
      () =>
        new Promise<{ body: Uint8Array }>((resolve, reject) => {
          resolvers.push({ resolve, reject });
        }),
    );
    const provider = createBedrockEmbeddings({ send, env: VALID_ENV });

    const resultPromise = provider(makeRequest(["a", "b", "c"]));
    await flush();
    expect(resolvers).toHaveLength(3);

    resolvers[0]?.resolve({ body: bodyFor(VALID_VECTOR, 5) });
    resolvers[1]?.resolve({ body: bodyFor(VALID_VECTOR, 7) });
    await flush();
    resolvers[2]?.reject(new Error("boom"));

    const error = await captureError(resultPromise);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).usage).toEqual({ inputTokens: 12, outputTokens: 0 });
  });

  it("a failure before any success carries usage 0/0", async () => {
    const send = vi.fn(async () => {
      throw new Error("boom");
    });
    const provider = createBedrockEmbeddings({ send, env: VALID_ENV });
    const error = await captureError(provider(makeRequest(["a", "b", "c"])));
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});

describe("createBedrockEmbeddings: a failure stops new sends from starting", () => {
  it("10 texts, concurrency 4, first send fails immediately -> fewer than 10 sends total", async () => {
    const send = vi.fn(async () => {
      throw new Error("boom");
    });
    const provider = createBedrockEmbeddings({ send, env: VALID_ENV });
    const texts = Array.from({ length: 10 }, (_, i) => `text-${i}`);
    await captureError(provider(makeRequest(texts)));
    await flush();
    expect(send.mock.calls.length).toBeLessThan(10);
  });
});

describe("createBedrockEmbeddings: an already-aborted signal", () => {
  it("rejects with kind 'timeout' and sends nothing", async () => {
    const controller = new AbortController();
    controller.abort();
    const send = vi.fn(async () => ({ body: bodyFor(VALID_VECTOR, 1) }));
    const provider = createBedrockEmbeddings({ send, env: VALID_ENV });
    const error = await captureError(provider(makeRequest(["a"], controller.signal)));
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).kind).toBe("timeout");
    expect(send).not.toHaveBeenCalled();
  });
});

describe("createBedrockEmbeddings: no logging", () => {
  function spyOnConsole() {
    return (["log", "info", "warn", "error", "debug"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    );
  }

  it("success path: console is never called", async () => {
    const spies = spyOnConsole();
    const send = vi.fn(async () => ({ body: bodyFor(VALID_VECTOR, 1) }));
    const provider = createBedrockEmbeddings({ send, env: VALID_ENV });
    await provider(makeRequest(["a"]));
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it("failure path: console is never called", async () => {
    const spies = spyOnConsole();
    const send = vi.fn(async () => {
      throw new Error("boom");
    });
    const provider = createBedrockEmbeddings({ send, env: VALID_ENV });
    await captureError(provider(makeRequest(["a"])));
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});

describe("bedrockEmbeddings (default export)", () => {
  it("is a function: the default ProviderCall<'embedding'> instance (real client, process.env)", async () => {
    const mod = await import("@/lib/server/model/bedrock");
    expect(typeof mod.bedrockEmbeddings).toBe("function");
  });
});

describe("bedrock.ts: static checks", () => {
  it("the source file exists", () => {
    expect(fs.existsSync(bedrockFile), "apps/web/lib/server/model/bedrock.ts is missing").toBe(true);
  });

  it('imports "server-only"', () => {
    const content = fs.readFileSync(bedrockFile, "utf8");
    expect(content).toContain('import "server-only"');
  });

  it("never logs (no console. and no logger)", () => {
    const content = fs.readFileSync(bedrockFile, "utf8");
    expect(content).not.toContain("console.");
    expect(content).not.toContain("logger");
  });

  it("never reads AWS_REGION, only BEDROCK_REGION", () => {
    const content = fs.readFileSync(bedrockFile, "utf8");
    expect(content).not.toContain("AWS_REGION");
  });
});
