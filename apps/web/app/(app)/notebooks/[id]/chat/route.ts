import { randomUUID } from "node:crypto";
import { retrieve } from "@/lib/rag/retrieve";
import { newNonce } from "@/lib/rag/prompt";
import { handleChatRequest } from "@/lib/server/chat/http";
import { messageStore } from "@/lib/server/chat/store";
import { runTurn } from "@/lib/server/chat/turn";
import { createChatCaller } from "@/lib/server/model/chat";
import { createClient } from "@/lib/supabase/server";

// Chat turn for one notebook (block D, ADR 0011). All logic is in lib/server/chat/http.ts.
// Covers the question embedding (120 s timeout) plus the chat call (30 s), so a slow call
// ends in its own timeout and is settled, not cut off by the platform.
export const maxDuration = 180;

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const supabase = await createClient();
  return handleChatRequest(request, id, {
    getUserId: async () => {
      const { data } = await supabase.auth.getUser();
      return data.user?.id ?? null;
    },
    runTurn: (args) =>
      runTurn(
        {
          retrieve,
          callChat: createChatCaller(),
          store: messageStore(supabase),
          log: (e) => console.info(JSON.stringify(e)),
          now: () => performance.now(),
          nonce: newNonce,
          newId: randomUUID,
        },
        args,
      ),
  });
}
