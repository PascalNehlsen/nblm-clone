// PR E2: server-side model config, read lazily from env so the lack of
// BEDROCK_*_MODEL_ID in Vercel Preview fails closed (model_not_configured) instead
// of throwing at import time.
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { modelConfig } from "@/lib/server/model/config";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const configFile = path.join(repoRoot, "apps/web/lib/server/model/config.ts");

const CHAT_ID = "eu.test.chat-model-id";

afterEach(() => {
  vi.unstubAllEnvs();
  delete process.env.BEDROCK_CHAT_MODEL_ID;
  delete process.env.BEDROCK_EMBEDDING_MODEL_ID;
});

describe("modelConfig", () => {
  it('reads BEDROCK_CHAT_MODEL_ID for "chat"', () => {
    vi.stubEnv("BEDROCK_CHAT_MODEL_ID", CHAT_ID);
    const config = modelConfig("chat");
    expect(config?.modelId).toBe(CHAT_ID);
  });

  // D2: chat runs only on an EU inference profile; embeddings are unchanged.
  it("chat: temperature is 0.2, embedding: temperature is 0", () => {
    vi.stubEnv("BEDROCK_CHAT_MODEL_ID", CHAT_ID);
    vi.stubEnv("BEDROCK_EMBEDDING_MODEL_ID", "test-embedding-model-id");
    expect(modelConfig("chat")?.temperature).toBe(0.2);
    expect(modelConfig("embedding")?.temperature).toBe(0);
  });

  it("chat: eu.amazon.nova-2-lite-v1:0 is accepted", () => {
    vi.stubEnv("BEDROCK_CHAT_MODEL_ID", "eu.amazon.nova-2-lite-v1:0");
    expect(modelConfig("chat")?.modelId).toBe("eu.amazon.nova-2-lite-v1:0");
  });

  it.each([
    "us.amazon.nova-2-lite-v1:0",
    "apac.amazon.nova-2-lite-v1:0",
    "global.amazon.nova-2-lite-v1:0",
    "amazon.nova-2-lite-v1:0",
    "test-chat-model-id",
    "EU.amazon.nova-2-lite-v1:0",
    "europe.amazon.nova-2-lite-v1:0",
    "xeu.amazon.nova-2-lite-v1:0",
  ])("chat: model id %s is refused (null, so model_not_configured)", (id) => {
    vi.stubEnv("BEDROCK_CHAT_MODEL_ID", id);
    expect(modelConfig("chat")).toBeNull();
  });

  it("embedding: the id is not restricted to the eu. prefix", () => {
    vi.stubEnv("BEDROCK_EMBEDDING_MODEL_ID", "amazon.titan-embed-text-v2:0");
    expect(modelConfig("embedding")?.modelId).toBe("amazon.titan-embed-text-v2:0");
  });

  it('reads BEDROCK_EMBEDDING_MODEL_ID for "embedding" and fixes maxOutputTokens to 0', () => {
    vi.stubEnv("BEDROCK_EMBEDDING_MODEL_ID", "test-embedding-model-id");
    const config = modelConfig("embedding");
    expect(config?.modelId).toBe("test-embedding-model-id");
    expect(config?.maxOutputTokens).toBe(0);
  });

  it.each(["chat", "embedding"] as const)("%s: a missing env var is null", (kind) => {
    delete process.env.BEDROCK_CHAT_MODEL_ID;
    delete process.env.BEDROCK_EMBEDDING_MODEL_ID;
    expect(modelConfig(kind)).toBeNull();
  });

  it.each(["chat", "embedding"] as const)("%s: an empty env var is null", (kind) => {
    vi.stubEnv("BEDROCK_CHAT_MODEL_ID", "");
    vi.stubEnv("BEDROCK_EMBEDDING_MODEL_ID", "");
    expect(modelConfig(kind)).toBeNull();
  });

  it.each(["chat", "embedding"] as const)("%s: a whitespace-only env var is null", (kind) => {
    vi.stubEnv("BEDROCK_CHAT_MODEL_ID", "   ");
    vi.stubEnv("BEDROCK_EMBEDDING_MODEL_ID", "\t\n ");
    expect(modelConfig(kind)).toBeNull();
  });

  it("chat: maxOutputTokens is a positive integer and timeoutMs is positive", () => {
    vi.stubEnv("BEDROCK_CHAT_MODEL_ID", CHAT_ID);
    const config = modelConfig("chat");
    expect(config).not.toBeNull();
    expect(Number.isInteger(config?.maxOutputTokens)).toBe(true);
    expect(config?.maxOutputTokens).toBeGreaterThan(0);
    expect(config?.timeoutMs).toBeGreaterThan(0);
  });

  it("embedding: timeoutMs is positive", () => {
    vi.stubEnv("BEDROCK_EMBEDDING_MODEL_ID", "test-embedding-model-id");
    const config = modelConfig("embedding");
    expect(config?.timeoutMs).toBeGreaterThan(0);
  });

  // PR B (block C decision): batching embeddings over many chunks takes longer than a
  // chat reply, so the embedding timeout is 120s, not the original 15s placeholder.
  it("embedding: timeoutMs is 120_000 (block C: 120s, was 15s)", () => {
    vi.stubEnv("BEDROCK_EMBEDDING_MODEL_ID", "test-embedding-model-id");
    const config = modelConfig("embedding");
    expect(config?.timeoutMs).toBe(120_000);
  });

  it("chat: timeoutMs is unchanged at 30000", () => {
    vi.stubEnv("BEDROCK_CHAT_MODEL_ID", CHAT_ID);
    const config = modelConfig("chat");
    expect(config?.timeoutMs).toBe(30_000);
  });
});

describe("config.ts never hardcodes a Bedrock model id (AGENTS.md: model ids only from env vars)", () => {
  it("the source file exists", () => {
    expect(fs.existsSync(configFile), "apps/web/lib/server/model/config.ts is missing").toBe(true);
  });

  it("contains no literal Bedrock model id prefix", () => {
    const content = fs.readFileSync(configFile, "utf8");
    for (const prefix of ['"anthropic.', '"amazon.', '"cohere.']) {
      expect(content).not.toContain(prefix);
    }
    // D2: config.ts now checks the "eu." profile prefix, so the bare prefix is allowed;
    // a full inference-profile id (eu.<vendor>.<model>) is still not.
    expect(content).not.toMatch(/["'`]eu\.[a-z0-9-]+\.[a-z0-9]/);
  });

  it("the eu. prefix check is the only region-prefix literal (us., apac., global. are never named as allowed)", () => {
    const content = fs.readFileSync(configFile, "utf8");
    expect(content).toContain("eu.");
    expect(content).not.toMatch(/startsWith\(["'`](us|apac|global)\./);
  });
});
