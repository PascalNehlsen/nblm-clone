// PR E2: server-side model config, read lazily from env so the lack of
// BEDROCK_*_MODEL_ID in Vercel Preview fails closed (model_not_configured) instead
// of throwing at import time.
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { modelConfig } from "@/lib/server/model/config";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const configFile = path.join(repoRoot, "apps/web/lib/server/model/config.ts");

afterEach(() => {
  vi.unstubAllEnvs();
  delete process.env.BEDROCK_CHAT_MODEL_ID;
  delete process.env.BEDROCK_EMBEDDING_MODEL_ID;
});

describe("modelConfig", () => {
  it('reads BEDROCK_CHAT_MODEL_ID for "chat"', () => {
    vi.stubEnv("BEDROCK_CHAT_MODEL_ID", "test-chat-model-id");
    const config = modelConfig("chat");
    expect(config?.modelId).toBe("test-chat-model-id");
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
    vi.stubEnv("BEDROCK_CHAT_MODEL_ID", "test-chat-model-id");
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
});

describe("config.ts never hardcodes a Bedrock model id (AGENTS.md: model ids only from env vars)", () => {
  it("the source file exists", () => {
    expect(fs.existsSync(configFile), "apps/web/lib/server/model/config.ts is missing").toBe(true);
  });

  it("contains no literal Bedrock model id prefix", () => {
    const content = fs.readFileSync(configFile, "utf8");
    for (const prefix of ['"anthropic.', '"amazon.', '"cohere.', '"eu.']) {
      expect(content).not.toContain(prefix);
    }
  });
});
