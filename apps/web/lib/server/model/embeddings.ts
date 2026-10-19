import "server-only";

import { bedrockEmbeddings } from "./bedrock";
import { createModelCaller, type ModelCallRequest, type ModelCallResult } from "./call";

// The embedding caller for ingestion: the Bedrock provider behind the budgeted wrapper.
// Code outside lib/server/model/ may not import the provider itself (eslint.config.mjs).
export function createEmbeddingCaller(): (
  req: ModelCallRequest<"embedding">,
) => Promise<ModelCallResult<"embedding">> {
  return createModelCaller<"embedding">({ provider: bedrockEmbeddings });
}
