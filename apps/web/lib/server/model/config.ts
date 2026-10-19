import "server-only";

import type { ModelKind } from "./types";

export interface ModelConfig {
  modelId: string;
  maxOutputTokens: number;
  timeoutMs: number;
}

// Model ids come only from env and are read per call, so a missing id (Vercel Preview)
// fails closed with model_not_configured instead of breaking the build.
const SETTINGS: Record<ModelKind, { env: string; maxOutputTokens: number; timeoutMs: number }> = {
  chat: { env: "BEDROCK_CHAT_MODEL_ID", maxOutputTokens: 1024, timeoutMs: 30_000 },
  // One call embeds every chunk of a source, so it gets more time than a chat turn.
  embedding: { env: "BEDROCK_EMBEDDING_MODEL_ID", maxOutputTokens: 0, timeoutMs: 120_000 },
};

export function modelConfig(kind: ModelKind): ModelConfig | null {
  const settings = SETTINGS[kind];
  const modelId = process.env[settings.env]?.trim();
  if (!modelId) return null;
  return { modelId, maxOutputTokens: settings.maxOutputTokens, timeoutMs: settings.timeoutMs };
}
