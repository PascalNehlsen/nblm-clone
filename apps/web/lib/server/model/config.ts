import "server-only";

import type { ModelKind } from "./types";

export interface ModelConfig {
  modelId: string;
  maxOutputTokens: number;
  timeoutMs: number;
  temperature: number;
}

// Model ids come only from env and are read per call, so a missing id (Vercel Preview)
// fails closed with model_not_configured instead of breaking the build.
const SETTINGS: Record<ModelKind, { env: string; maxOutputTokens: number; timeoutMs: number; temperature: number }> = {
  // Low temperature: answers should stay close to the quoted sources.
  chat: { env: "BEDROCK_CHAT_MODEL_ID", maxOutputTokens: 1024, timeoutMs: 30_000, temperature: 0.2 },
  // One call embeds every chunk of a source, so it gets more time than a chat turn.
  embedding: { env: "BEDROCK_EMBEDDING_MODEL_ID", maxOutputTokens: 0, timeoutMs: 120_000, temperature: 0 },
};

// The chat model is called only through an EU inference profile (residency, ADR 0011): an id
// without the eu. prefix fails closed as model_not_configured.
const CHAT_PROFILE_PREFIX = "eu.";

export function modelConfig(kind: ModelKind): ModelConfig | null {
  const settings = SETTINGS[kind];
  const modelId = process.env[settings.env]?.trim();
  if (!modelId) return null;
  if (kind === "chat" && !modelId.startsWith(CHAT_PROFILE_PREFIX)) return null;
  return {
    modelId,
    maxOutputTokens: settings.maxOutputTokens,
    timeoutMs: settings.timeoutMs,
    temperature: settings.temperature,
  };
}
