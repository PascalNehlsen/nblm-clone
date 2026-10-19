import "server-only";

import { bedrockChat, bedrockEmbeddings } from "./bedrock";
import { createCanaryCaller, type ModelCallRequest, type ModelCallResult } from "./call";

// The release canary's two callers (ADR 0014), bound to the Bedrock providers here because
// code outside lib/server/model/ may not import the provider (eslint.config.mjs). Null when
// CANARY_USER_ID is not configured.
export function createCanaryCallers(): {
  embed: (req: ModelCallRequest<"embedding">) => Promise<ModelCallResult<"embedding">>;
  callChat: (req: ModelCallRequest<"chat">) => Promise<ModelCallResult<"chat">>;
} | null {
  const embed = createCanaryCaller<"embedding">({ provider: bedrockEmbeddings });
  const callChat = createCanaryCaller<"chat">({ provider: bedrockChat });
  return embed && callChat ? { embed, callChat } : null;
}
