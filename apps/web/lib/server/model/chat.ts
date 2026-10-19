import "server-only";

import { bedrockChat } from "./bedrock";
import { createModelCaller, type ModelCallRequest, type ModelCallResult } from "./call";

// The chat caller for block D: the Bedrock ConverseStream provider behind the budgeted
// wrapper. Code outside lib/server/model/ may not import the provider itself (eslint.config.mjs).
export function createChatCaller(): (req: ModelCallRequest<"chat">) => Promise<ModelCallResult<"chat">> {
  return createModelCaller<"chat">({ provider: bedrockChat });
}
