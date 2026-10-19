// The chat route must live long enough for its slowest path: the question embedding
// (timeout 120 s) followed by the chat call (timeout 30 s). The relation is enforced here,
// not only the number.
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { modelConfig } from "@/lib/server/model/config";

const route = path.resolve(import.meta.dirname, "../../../apps/web/app/(app)/notebooks/[id]/chat/route.ts");

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("chat route maxDuration", () => {
  it("covers the embedding timeout plus the chat timeout", () => {
    vi.stubEnv("BEDROCK_CHAT_MODEL_ID", "eu.test.chat-model");
    vi.stubEnv("BEDROCK_EMBEDDING_MODEL_ID", "test.embedding-model");
    const chat = modelConfig("chat");
    const embedding = modelConfig("embedding");
    expect(chat).not.toBeNull();
    expect(embedding).not.toBeNull();

    const match = /export const maxDuration = (\d+)/.exec(fs.readFileSync(route, "utf8"));
    expect(match, "route.ts must export a numeric maxDuration").not.toBeNull();
    const maxDuration = Number(match?.[1]);

    const needed = (embedding?.timeoutMs ?? Infinity) / 1000 + (chat?.timeoutMs ?? Infinity) / 1000;
    expect(maxDuration).toBeGreaterThanOrEqual(needed);
  });
});
