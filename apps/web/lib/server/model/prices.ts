import "server-only";

import type { InputFor, ModelKind, ProviderUsage } from "./types";

export interface ModelPrice {
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
}

export type PriceTable = Readonly<Record<string, ModelPrice>>;

// USD per million tokens, keyed by the model id from env. Empty on purpose: a model
// without a verified price fails closed with price_unknown (PR C and D add entries).
export const PRICES: PriceTable = {};

// Upper bound on the per-message framing tokens a provider adds.
export const MESSAGE_OVERHEAD_TOKENS = 8;

export function priceFor(table: PriceTable, modelId: string): ModelPrice | null {
  return Object.hasOwn(table, modelId) ? (table[modelId] ?? null) : null;
}

// Same scale as private.usage.cost_usd, numeric(20,12).
function roundUsd(value: number): number {
  return Number(value.toFixed(12));
}

export function costUsd(price: ModelPrice, usage: ProviderUsage): number {
  return roundUsd(
    (usage.inputTokens * price.inputUsdPerMTok + usage.outputTokens * price.outputUsdPerMTok) / 1e6,
  );
}

export function estimateCostUsd(price: ModelPrice, inputTokensUpperBound: number, maxOutputTokens: number): number {
  return costUsd(price, { inputTokens: inputTokensUpperBound, outputTokens: maxOutputTokens });
}

const encoder = new TextEncoder();

function utf8Bytes(text: string): number {
  return encoder.encode(text).length;
}

// No tokenizer encodes more than one token per UTF-8 byte, so the byte count bounds
// the input tokens from above and the reservation never undercounts.
export function inputTokenUpperBound<K extends ModelKind>(kind: K, input: InputFor<K>): number {
  if (kind === "chat") {
    const chat = input as InputFor<"chat">;
    let total = utf8Bytes(chat.system) + MESSAGE_OVERHEAD_TOKENS;
    for (const message of chat.messages) total += utf8Bytes(message.content) + MESSAGE_OVERHEAD_TOKENS;
    return total;
  }
  const embedding = input as InputFor<"embedding">;
  let total = 0;
  for (const text of embedding.texts) total += utf8Bytes(text) + MESSAGE_OVERHEAD_TOKENS;
  return total;
}
