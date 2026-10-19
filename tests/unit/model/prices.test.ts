// PR E2 (model call wrapper): pure pricing math and the token upper bound used to
// estimate cost before a call. PRICES shipped empty at first (approved decision
// 4a); C1 ingestion (plan approved by Pascal, 2026-10-19) adds the one verified
// Titan Text Embeddings V2 entry so embedding calls stop refusing with
// price_unknown. Every other, still-unpriced model id keeps failing closed --
// that is covered in call.test.ts, not here. This file only tests the math.
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  MESSAGE_OVERHEAD_TOKENS,
  PRICES,
  costUsd,
  estimateCostUsd,
  inputTokenUpperBound,
  priceFor,
} from "@/lib/server/model/prices";
import type { ModelPrice, PriceTable } from "@/lib/server/model/prices";
import type { ProviderUsage } from "@/lib/server/model/types";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const pricesFile = path.join(repoRoot, "apps/web/lib/server/model/prices.ts");

const TITAN_EMBED_MODEL_ID = "amazon.titan-embed-text-v2:0";

const NOVA_CHAT_MODEL_ID = "eu.amazon.nova-2-lite-v1:0";

describe("PRICES: the verified entries (Titan Text Embeddings V2, Nova 2 Lite)", () => {
  it("has exactly the Titan embedding id and the Nova 2 Lite EU profile id as keys", () => {
    expect([...Object.keys(PRICES)].sort()).toEqual([TITAN_EMBED_MODEL_ID, NOVA_CHAT_MODEL_ID].sort());
  });

  // D2: regional eu.* profile price, eu-central-1 (not the global profile).
  it("prices Nova 2 Lite at 0.429 USD / MTok input, 3.597 USD / MTok output", () => {
    expect(PRICES[NOVA_CHAT_MODEL_ID]).toEqual({ inputUsdPerMTok: 0.429, outputUsdPerMTok: 3.597 });
  });

  it("documents the Nova source: the AWS price list SKUs, usagetypes and retrieval date appear in prices.ts", () => {
    const content = fs.readFileSync(pricesFile, "utf8");
    expect(content).toContain("UVBGYBB2KWGTDYAS");
    expect(content).toContain("2Q2KMPM6X7WRKD55");
    expect(content).toContain("EUC1-Nova2.0Lite-input-tokens");
    expect(content).toContain("EUC1-Nova2.0Lite-output-tokens");
    expect(content).toContain("2026-10-19");
  });

  it("costUsd for 1,000,000 input and 1,000,000 output Nova tokens is exactly 4.026 USD", () => {
    const entry = PRICES[NOVA_CHAT_MODEL_ID] as ModelPrice;
    expect(costUsd(entry, { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBe(4.026);
  });

  it("prices it at 0.2 USD / MTok input, 0 USD / MTok output", () => {
    expect(PRICES[TITAN_EMBED_MODEL_ID]).toEqual({ inputUsdPerMTok: 0.2, outputUsdPerMTok: 0 });
  });

  it("every entry is finite with input > 0 and output >= 0", () => {
    for (const [modelId, price] of Object.entries(PRICES)) {
      expect(Number.isFinite(price.inputUsdPerMTok), `${modelId} input price`).toBe(true);
      expect(price.inputUsdPerMTok, `${modelId} input price`).toBeGreaterThan(0);
      expect(Number.isFinite(price.outputUsdPerMTok), `${modelId} output price`).toBe(true);
      expect(price.outputUsdPerMTok, `${modelId} output price`).toBeGreaterThanOrEqual(0);
    }
  });

  it("documents its source: the AWS price list SKU and publication date appear in prices.ts", () => {
    const content = fs.readFileSync(pricesFile, "utf8");
    expect(content).toContain("QRGS5WQKSZZ4QQKV");
    expect(content).toContain("2026-10-16");
  });

  it("costUsd for 1,000,000 input tokens is exactly 0.2 USD", () => {
    const entry = PRICES[TITAN_EMBED_MODEL_ID] as ModelPrice;
    expect(costUsd(entry, { inputTokens: 1_000_000, outputTokens: 0 })).toBe(0.2);
  });
});

describe("priceFor", () => {
  const table: PriceTable = { "known-model": { inputUsdPerMTok: 3, outputUsdPerMTok: 15 } };

  it("returns the price for a known model id", () => {
    expect(priceFor(table, "known-model")).toEqual({ inputUsdPerMTok: 3, outputUsdPerMTok: 15 });
  });

  it("returns null for an unknown model id", () => {
    expect(priceFor(table, "unknown-model")).toBeNull();
  });

  it("ignores inherited/prototype keys (Object.hasOwn only, not `in` or bracket access)", () => {
    expect(priceFor(table, "constructor")).toBeNull();
    expect(priceFor(table, "__proto__")).toBeNull();
    expect(priceFor(table, "toString")).toBeNull();
    expect(priceFor(table, "hasOwnProperty")).toBeNull();
  });
});

describe("costUsd", () => {
  it("computes (in*inPrice + out*outPrice)/1e6 for whole numbers", () => {
    const price: ModelPrice = { inputUsdPerMTok: 3, outputUsdPerMTok: 15 };
    const usage: ProviderUsage = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
    expect(costUsd(price, usage)).toBe(18);
  });

  it("is zero for zero usage", () => {
    const price: ModelPrice = { inputUsdPerMTok: 3, outputUsdPerMTok: 15 };
    expect(costUsd(price, { inputTokens: 0, outputTokens: 0 })).toBe(0);
  });

  it("rounds the result to 12 decimal places", () => {
    const price: ModelPrice = { inputUsdPerMTok: 1 / 3, outputUsdPerMTok: 0 };
    const usage: ProviderUsage = { inputTokens: 1, outputTokens: 0 };
    const raw = (usage.inputTokens * price.inputUsdPerMTok + usage.outputTokens * price.outputUsdPerMTok) / 1e6;
    const expected = Number(raw.toFixed(12));
    // Sanity: this value actually needs rounding to fit 12dp, otherwise the
    // assertion below would pass even without any rounding in the implementation.
    expect(expected).not.toBe(raw);
    expect(costUsd(price, usage)).toBe(expected);
  });
});

describe("estimateCostUsd", () => {
  it("is positive for a 1-byte input and a positive input price", () => {
    const price: ModelPrice = { inputUsdPerMTok: 2, outputUsdPerMTok: 0 };
    expect(estimateCostUsd(price, 1, 0)).toBeGreaterThan(0);
  });

  it("uses the same formula as costUsd, rounded to 12dp", () => {
    const price: ModelPrice = { inputUsdPerMTok: 1 / 3, outputUsdPerMTok: 2 };
    const inputTokensUpperBound = 1;
    const maxOutputTokens = 1;
    const raw = (inputTokensUpperBound * price.inputUsdPerMTok + maxOutputTokens * price.outputUsdPerMTok) / 1e6;
    const expected = Number(raw.toFixed(12));
    expect(estimateCostUsd(price, inputTokensUpperBound, maxOutputTokens)).toBe(expected);
  });
});

describe("MESSAGE_OVERHEAD_TOKENS", () => {
  it("is 8", () => {
    expect(MESSAGE_OVERHEAD_TOKENS).toBe(8);
  });
});

describe("inputTokenUpperBound", () => {
  it("chat: UTF-8 bytes of system + each message content, plus overhead per message and one more for system", () => {
    const tokens = inputTokenUpperBound("chat", {
      system: "ab", // 2 bytes
      messages: [{ role: "user", content: "cd" }], // 2 bytes
    });
    // 2 + 2 + 8 * (1 message + 1 for system) = 4 + 16 = 20
    expect(tokens).toBe(20);
  });

  it("chat: counts UTF-8 bytes, not UTF-16 code units or character count", () => {
    const ascii = inputTokenUpperBound("chat", { system: "", messages: [{ role: "user", content: "a" }] });
    // "ä" (U+00E4): 1 UTF-16 code unit / 1 JS .length, but 2 UTF-8 bytes.
    const umlaut = inputTokenUpperBound("chat", { system: "", messages: [{ role: "user", content: "ä" }] });
    expect(umlaut - ascii).toBe(1);

    // "\u{1F600}" (grinning face): 2 UTF-16 code units, but 4 UTF-8 bytes.
    const emoji = inputTokenUpperBound("chat", { system: "", messages: [{ role: "user", content: "\u{1F600}" }] });
    expect(emoji - ascii).toBe(3);
  });

  it("chat: multiple messages each get their own overhead, plus one more for system", () => {
    const one = inputTokenUpperBound("chat", { system: "", messages: [{ role: "user", content: "" }] });
    const two = inputTokenUpperBound("chat", {
      system: "",
      messages: [
        { role: "user", content: "" },
        { role: "assistant", content: "" },
      ],
    });
    expect(two - one).toBe(MESSAGE_OVERHEAD_TOKENS);
  });

  it("embedding: UTF-8 bytes per text plus overhead per text", () => {
    const tokens = inputTokenUpperBound("embedding", { texts: ["ab", "cde"] });
    // (2 + 3) + 8 * 2 texts = 5 + 16 = 21
    expect(tokens).toBe(21);
  });

  it("embedding: an empty texts array costs nothing", () => {
    expect(inputTokenUpperBound("embedding", { texts: [] })).toBe(0);
  });
});
