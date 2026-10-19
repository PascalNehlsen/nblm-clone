// Shapes shared by the model-call wrapper, the usage store and the provider adapters.
import type { ModelErrorCategory } from "@/lib/ops/categories";

export type ModelKind = "chat" | "embedding";

export interface ChatInput {
  system: string;
  messages: { role: "user" | "assistant"; content: string }[];
}

export interface EmbeddingInput {
  texts: string[];
}

export type InputFor<K extends ModelKind> = K extends "chat" ? ChatInput : EmbeddingInput;
export type OutputFor<K extends ModelKind> = K extends "chat" ? { text: string } : { vectors: number[][] };

export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ProviderRequest<K extends ModelKind> {
  modelId: string;
  maxOutputTokens: number;
  temperature: number;
  input: InputFor<K>;
  signal: AbortSignal;
  // Streamed text for chat. Never logged; the wrapper stops forwarding after a timeout.
  onDelta?: (text: string) => void;
}

// The provider is injected, so the wrapper never depends on an SDK and tests use a fake.
export type ProviderCall<K extends ModelKind> = (
  req: ProviderRequest<K>,
) => Promise<{ output: OutputFor<K>; usage: ProviderUsage }>;

// Adapters translate SDK errors into this. The message is only the kind and there is
// no cause, so no prompt or provider text can travel with it.
export class ProviderError extends Error {
  constructor(
    readonly kind: "timeout" | "throttled" | "error",
    readonly usage?: ProviderUsage,
  ) {
    super(`provider ${kind}`);
    this.name = "ProviderError";
  }
}

// The usage store the wrapper reserves and settles through. Implemented by
// the usage module under lib/server; declared here so the engine never imports it.
export interface ReserveArgs {
  userId: string;
  isAnonymous: boolean;
  notebookId: string | null;
  kind: ModelKind;
  modelId: string;
  estimatedCostUsd: number;
  callCount: number;
}

export type ReserveOutcome =
  | { outcome: "ok"; usageId: string }
  | { outcome: "kill_switch_on" | "budget_exceeded" | "global_budget_exceeded" };

export interface SettleArgs {
  usageId: string;
  status: "settled" | "failed";
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
  messageId: string | null;
  errorCategory: ModelErrorCategory | null;
}

export interface UsagePort {
  reserve: (a: ReserveArgs) => Promise<ReserveOutcome>;
  settle: (a: SettleArgs) => Promise<boolean>;
}
