// D2 chat (plan approved by Pascal). See .git/D2-API-SPEC.md "Model layer / bedrock.ts":
// createBedrockChat is the Converse streaming adapter behind ProviderCall<"chat">. It is
// exercised entirely through an injected `sendStream` fake, never a real AWS call, same as
// bedrock.test.ts does for embeddings. This file proves: the exact ConverseStreamCommand
// input (no toolConfig: the chat model gets no tools, AGENTS.md), deltas reach onDelta in
// order and are concatenated, usage comes from the metadata event (missing or invalid
// usage is an error), throttling and abort map into ProviderError like the embeddings
// adapter, EU region and role are checked before any send, and nothing is ever logged.
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConverseStreamCommand } from "@aws-sdk/client-bedrock-runtime";
import { createBedrockChat } from "@/lib/server/model/bedrock";
import { ProviderError } from "@/lib/server/model/types";
import type { ChatInput, ProviderRequest } from "@/lib/server/model/types";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const bedrockFile = path.join(repoRoot, "apps/web/lib/server/model/bedrock.ts");

const MODEL_ID = "eu.amazon.nova-2-lite-v1:0";
const ROLE_ARN = "arn:aws:iam::123456789012:role/test-role";
const VALID_ENV: Record<string, string | undefined> = { BEDROCK_REGION: "eu-central-1", AWS_ROLE_ARN: ROLE_ARN };

type StreamEvent = Record<string, unknown>;
type SendStream = NonNullable<NonNullable<Parameters<typeof createBedrockChat>[0]>["sendStream"]>;

const INPUT: ChatInput = {
  system: "System prompt text.",
  messages: [
    { role: "user", content: "First question" },
    { role: "assistant", content: "First answer" },
    { role: "user", content: "Second question" },
  ],
};

function makeRequest(overrides: Partial<ProviderRequest<"chat">> = {}): ProviderRequest<"chat"> {
  return {
    modelId: MODEL_ID,
    maxOutputTokens: 1024,
    temperature: 0.2,
    input: INPUT,
    signal: new AbortController().signal,
    ...overrides,
  };
}

async function* eventsOf(events: StreamEvent[]): AsyncGenerator<StreamEvent> {
  for (const event of events) yield event;
}

function delta(text: string): StreamEvent {
  return { contentBlockDelta: { delta: { text } } };
}

function metadata(inputTokens: unknown, outputTokens: unknown): StreamEvent {
  return { metadata: { usage: { inputTokens, outputTokens } } };
}

// The fake is typed loosely on purpose: the production type is the SDK's event union, and
// the adapter only reads the subset named in the spec.
function fakeSend(events: StreamEvent[]): ReturnType<typeof vi.fn> & SendStream {
  return vi.fn(async () => ({ stream: eventsOf(events) })) as unknown as ReturnType<typeof vi.fn> & SendStream;
}

function namedError(name: string, message = "sdk-secret-detail-xyz"): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject, but it resolved");
}

function spyOnConsole() {
  return (["log", "info", "warn", "error", "debug"] as const).map((method) =>
    vi.spyOn(console, method).mockImplementation(() => {}),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  delete process.env.BEDROCK_REGION;
  delete process.env.AWS_ROLE_ARN;
  delete process.env.AWS_REGION;
});

describe("createBedrockChat: config is checked before any send", () => {
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

  it.each(invalidEnvCases)("%s -> ProviderError 'error', sendStream is never called", async (_label, env) => {
    const sendStream = fakeSend([delta("x"), metadata(1, 1)]);
    const provider = createBedrockChat({ sendStream, env });
    const error = await captureError(provider(makeRequest()));
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).kind).toBe("error");
    expect(sendStream).not.toHaveBeenCalled();
  });

  it("env is read per call, not at factory-creation time", async () => {
    delete process.env.BEDROCK_REGION;
    delete process.env.AWS_ROLE_ARN;
    const sendStream = fakeSend([delta("hi"), metadata(2, 1)]);
    const provider = createBedrockChat({ sendStream });
    vi.stubEnv("BEDROCK_REGION", "eu-central-1");
    vi.stubEnv("AWS_ROLE_ARN", ROLE_ARN);
    const result = await provider(makeRequest());
    expect(result.output.text).toBe("hi");
  });
});

describe("createBedrockChat: request shape", () => {
  it("sends one ConverseStreamCommand with exactly the spec input and the request's abortSignal", async () => {
    const sendStream = fakeSend([delta("x"), metadata(1, 1)]);
    const provider = createBedrockChat({ sendStream, env: VALID_ENV });
    const controller = new AbortController();

    await provider(makeRequest({ signal: controller.signal }));

    expect(sendStream).toHaveBeenCalledTimes(1);
    const [command, options] = sendStream.mock.calls[0] as unknown as [ConverseStreamCommand, { abortSignal: AbortSignal }];
    expect(command).toBeInstanceOf(ConverseStreamCommand);
    expect(command.input).toEqual({
      modelId: MODEL_ID,
      system: [{ text: "System prompt text." }],
      messages: [
        { role: "user", content: [{ text: "First question" }] },
        { role: "assistant", content: [{ text: "First answer" }] },
        { role: "user", content: [{ text: "Second question" }] },
      ],
      inferenceConfig: { maxTokens: 1024, temperature: 0.2 },
    });
    expect(options).toEqual({ abortSignal: controller.signal });
  });

  it("never sets toolConfig or any field beyond modelId, system, messages and inferenceConfig", async () => {
    const sendStream = fakeSend([delta("x"), metadata(1, 1)]);
    const provider = createBedrockChat({ sendStream, env: VALID_ENV });
    await provider(makeRequest());
    const [command] = sendStream.mock.calls[0] as unknown as [ConverseStreamCommand];
    const input = command.input as unknown as Record<string, unknown>;
    expect("toolConfig" in input).toBe(false);
    expect(Object.keys(input).sort()).toEqual(["inferenceConfig", "messages", "modelId", "system"]);
    expect(Object.keys(input.inferenceConfig as object).sort()).toEqual(["maxTokens", "temperature"]);
  });

  it("takes modelId, maxTokens and temperature from the provider request, not from anything else", async () => {
    const sendStream = fakeSend([delta("x"), metadata(1, 1)]);
    const provider = createBedrockChat({ sendStream, env: VALID_ENV });
    await provider(makeRequest({ modelId: "eu.other-model", maxOutputTokens: 77, temperature: 0 }));
    const [command] = sendStream.mock.calls[0] as unknown as [ConverseStreamCommand];
    expect(command.input.modelId).toBe("eu.other-model");
    expect(command.input.inferenceConfig).toEqual({ maxTokens: 77, temperature: 0 });
  });
});

describe("createBedrockChat: deltas, text and usage", () => {
  it("passes each delta to onDelta in order and returns the concatenated text with the metadata usage", async () => {
    const sendStream = fakeSend([
      { messageStart: { role: "assistant" } },
      delta("Hel"),
      delta("lo "),
      { contentBlockStop: {} },
      delta("world"),
      { messageStop: { stopReason: "end_turn" } },
      metadata(120, 34),
    ]);
    const provider = createBedrockChat({ sendStream, env: VALID_ENV });
    const onDelta = vi.fn();

    const result = await provider(makeRequest({ onDelta }));

    expect(onDelta.mock.calls).toEqual([["Hel"], ["lo "], ["world"]]);
    expect(result).toEqual({ output: { text: "Hello world" }, usage: { inputTokens: 120, outputTokens: 34 } });
  });

  it("works without onDelta", async () => {
    const sendStream = fakeSend([delta("a"), delta("b"), metadata(1, 2)]);
    const provider = createBedrockChat({ sendStream, env: VALID_ENV });
    const result = await provider(makeRequest());
    expect(result.output.text).toBe("ab");
  });

  it("ignores delta events without text", async () => {
    const sendStream = fakeSend([
      { contentBlockDelta: { delta: {} } },
      { contentBlockDelta: {} },
      delta("ok"),
      metadata(1, 1),
    ]);
    const provider = createBedrockChat({ sendStream, env: VALID_ENV });
    const onDelta = vi.fn();
    const result = await provider(makeRequest({ onDelta }));
    expect(onDelta.mock.calls).toEqual([["ok"]]);
    expect(result.output.text).toBe("ok");
  });

  const invalidUsage: Array<[string, StreamEvent[]]> = [
    ["no metadata event at all", [delta("x")]],
    ["metadata without usage", [delta("x"), { metadata: {} }]],
    ["usage without outputTokens", [delta("x"), { metadata: { usage: { inputTokens: 1 } } }]],
    ["usage without inputTokens", [delta("x"), { metadata: { usage: { outputTokens: 1 } } }]],
    ["negative inputTokens", [delta("x"), metadata(-1, 1)]],
    ["fractional outputTokens", [delta("x"), metadata(1, 1.5)]],
    ["NaN inputTokens", [delta("x"), metadata(Number.NaN, 1)]],
    ["string outputTokens", [delta("x"), metadata(1, "3")]],
  ];

  it.each(invalidUsage)("%s -> ProviderError 'error'", async (_label, events) => {
    const sendStream = fakeSend(events);
    const provider = createBedrockChat({ sendStream, env: VALID_ENV });
    const error = await captureError(provider(makeRequest()));
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).kind).toBe("error");
  });
});

describe("createBedrockChat: error mapping", () => {
  const exceptionEvents: Array<[string, StreamEvent, "throttled" | "error"]> = [
    ["throttlingException event", { throttlingException: { message: "sdk-secret-detail-xyz" } }, "throttled"],
    ["modelStreamErrorException event", { modelStreamErrorException: {} }, "error"],
    ["internalServerException event", { internalServerException: {} }, "error"],
    ["serviceUnavailableException event", { serviceUnavailableException: {} }, "error"],
    ["validationException event", { validationException: {} }, "error"],
  ];

  it.each(exceptionEvents)("%s in the stream maps to kind %s", async (_label, event, expectedKind) => {
    const sendStream = fakeSend([delta("partial"), event, metadata(1, 1)]);
    const provider = createBedrockChat({ sendStream, env: VALID_ENV });
    const error = await captureError(provider(makeRequest()));
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).kind).toBe(expectedKind);
    expect((error as ProviderError).message).not.toContain("sdk-secret-detail-xyz");
  });

  const thrownCases: Array<[string, unknown, "throttled" | "timeout" | "error"]> = [
    ["ThrottlingException", namedError("ThrottlingException"), "throttled"],
    ["ServiceQuotaExceededException", namedError("ServiceQuotaExceededException"), "throttled"],
    ["ModelTimeoutException", namedError("ModelTimeoutException"), "timeout"],
    ["AbortError", namedError("AbortError"), "timeout"],
    ["TimeoutError", namedError("TimeoutError"), "timeout"],
    ["AccessDeniedException", namedError("AccessDeniedException"), "error"],
    ["a plain Error", new Error("sdk-secret-detail-xyz"), "error"],
    ["a thrown non-Error value", "sdk-secret-detail-xyz", "error"],
  ];

  it.each(thrownCases)("sendStream throwing %s maps to kind %s, without the SDK message or a cause", async (_label, thrown, expectedKind) => {
    const sendStream = vi.fn(async () => {
      throw thrown;
    }) as unknown as SendStream;
    const provider = createBedrockChat({ sendStream, env: VALID_ENV });
    const error = await captureError(provider(makeRequest()));
    expect(error).toBeInstanceOf(ProviderError);
    const providerError = error as ProviderError;
    expect(providerError.kind).toBe(expectedKind);
    expect(providerError.message).not.toContain("sdk-secret-detail-xyz");
    expect(Object.prototype.hasOwnProperty.call(providerError, "cause")).toBe(false);
  });

  it.each(thrownCases)("the stream throwing %s mid-way maps to kind %s", async (_label, thrown, expectedKind) => {
    async function* failing(): AsyncGenerator<StreamEvent> {
      yield delta("partial");
      throw thrown;
    }
    const sendStream = vi.fn(async () => ({ stream: failing() })) as unknown as SendStream;
    const provider = createBedrockChat({ sendStream, env: VALID_ENV });
    const error = await captureError(provider(makeRequest()));
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).kind).toBe(expectedKind);
  });

  it("an already-aborted signal rejects with kind 'timeout' and sends nothing", async () => {
    const controller = new AbortController();
    controller.abort();
    const sendStream = fakeSend([delta("x"), metadata(1, 1)]);
    const provider = createBedrockChat({ sendStream, env: VALID_ENV });
    const error = await captureError(provider(makeRequest({ signal: controller.signal })));
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).kind).toBe("timeout");
    expect(sendStream).not.toHaveBeenCalled();
  });

  it("an abort during the stream (the SDK rejects with AbortError) maps to 'timeout'", async () => {
    const controller = new AbortController();
    async function* aborting(): AsyncGenerator<StreamEvent> {
      yield delta("partial");
      controller.abort();
      throw namedError("AbortError", "The operation was aborted");
    }
    const sendStream = vi.fn(async () => ({ stream: aborting() })) as unknown as SendStream;
    const provider = createBedrockChat({ sendStream, env: VALID_ENV });
    const error = await captureError(provider(makeRequest({ signal: controller.signal })));
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).kind).toBe("timeout");
  });
});

describe("createBedrockChat: no logging", () => {
  it("success path: console is never called", async () => {
    const spies = spyOnConsole();
    const sendStream = fakeSend([delta("sentinel-answer"), metadata(1, 1)]);
    const provider = createBedrockChat({ sendStream, env: VALID_ENV });
    await provider(makeRequest({ onDelta: () => {} }));
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it("failure path: console is never called", async () => {
    const spies = spyOnConsole();
    const sendStream = vi.fn(async () => {
      throw new Error("boom");
    }) as unknown as SendStream;
    const provider = createBedrockChat({ sendStream, env: VALID_ENV });
    await captureError(provider(makeRequest()));
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it("stream exception path: console is never called", async () => {
    const spies = spyOnConsole();
    const sendStream = fakeSend([delta("x"), { throttlingException: {} }]);
    const provider = createBedrockChat({ sendStream, env: VALID_ENV });
    await captureError(provider(makeRequest()));
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});

describe("bedrockChat (default export)", () => {
  it("is a function: the default ProviderCall<'chat'> instance (real client, process.env)", async () => {
    const mod = await import("@/lib/server/model/bedrock");
    expect(typeof mod.bedrockChat).toBe("function");
  });

  it("with no EU region configured it fails with kind 'error' before any network call", async () => {
    delete process.env.BEDROCK_REGION;
    delete process.env.AWS_ROLE_ARN;
    const mod = await import("@/lib/server/model/bedrock");
    const error = await captureError(mod.bedrockChat(makeRequest()));
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).kind).toBe("error");
  });
});

describe("bedrock.ts: static checks for the chat adapter", () => {
  it("still never logs and never reads AWS_REGION", () => {
    const content = fs.readFileSync(bedrockFile, "utf8");
    expect(content).not.toContain("console.");
    expect(content).not.toContain("AWS_REGION");
  });
});
