import "server-only";

import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { MessageStore } from "./turn";

// Saves one turn with the user's own client, so RLS checks every row (ADR 0004): the
// question, then the answer under the id the usage row links to, then the citations. If the
// citations cannot be saved, the turn is removed again, so no answer stays without them.

export function messageStore(client: SupabaseClient): MessageStore {
  return {
    async saveTurn({ notebookId, question, answerId, answer, citations }) {
      const questionId = randomUUID();
      const { error: questionError } = await client
        .from("messages")
        .insert({ id: questionId, notebook_id: notebookId, role: "user", content: question });
      if (questionError) throw new Error("saving the question failed");

      const { error: answerError } = await client
        .from("messages")
        .insert({ id: answerId, notebook_id: notebookId, role: "assistant", content: answer });
      if (answerError) throw new Error("saving the answer failed");

      if (citations.length === 0) return;
      const { error: citationError } = await client.from("message_citations").insert(
        citations.map((c) => ({
          message_id: answerId,
          notebook_id: notebookId,
          ordinal: c.ordinal,
          chunk_id: c.chunkId,
          quote: c.quote,
        })),
      );
      if (citationError) {
        await client.from("messages").delete().eq("id", answerId);
        await client.from("messages").delete().eq("id", questionId);
        throw new Error("saving the citations failed");
      }
    },
  };
}
