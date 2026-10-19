import "server-only";

import type { InputFor, ModelKind, ProviderUsage } from "./types";

export interface ModelPrice {
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
}

export type PriceTable = Readonly<Record<string, ModelPrice>>;

// USD per million tokens, keyed by the model id from env. A model without a verified
// entry fails closed with price_unknown.
export const PRICES: PriceTable = {
  // Titan Text Embeddings V2: 0.0002 USD per 1K input tokens. Source: AWS public price list
  // AmazonBedrock, eu-central-1, publicationDate 2026-10-16, SKU QRGS5WQKSZZ4QQKV, usagetype
  // EUC1-TitanEmbeddingV2-Text-input-tokens (verified by Pascal on the host).
  "amazon.titan-embed-text-v2:0": { inputUsdPerMTok: 0.2, outputUsdPerMTok: 0 },
  // Amazon Nova 2 Lite through the EU inference profile (regional, not global): 0.000429 USD
  // per 1K input tokens (SKU UVBGYBB2KWGTDYAS, usagetype EUC1-Nova2.0Lite-input-tokens) and
  // 0.003597 USD per 1K output tokens (SKU 2Q2KMPM6X7WRKD55, usagetype
  // EUC1-Nova2.0Lite-output-tokens). Source: AWS public price list AmazonBedrock, eu-central-1,
  // retrieved 2026-10-19 by the host session.
  "eu.amazon.nova-2-lite-v1:0": { inputUsdPerMTok: 0.429, outputUsdPerMTok: 3.597 },
};

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
