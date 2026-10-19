// The chat history of the signed-in user in one notebook (block D3), loaded with the user's
// own client: RLS shows only their own messages and the chunks of notebooks they are a
// member of. A citation whose chunk was deleted keeps its ordinal but has no passage.
import type { SupabaseClient } from "@supabase/supabase-js";

export interface HistoryCitation {
  ordinal: number;
  quote: string | null;
  chunk: { content: string; page: number | null; sourceTitle: string } | null;
}

export interface HistoryEntry {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  citations: HistoryCitation[];
}

type One<T> = T | T[] | null;

export interface HistoryRow {
  id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
  message_citations:
    | {
        ordinal: number;
        quote: string | null;
        chunk_id: string | null;
        chunks: One<{ content: string; page: number | null; sources: One<{ title: string }> }>;
      }[]
    | null;
}

function first<T>(value: One<T>): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

export function toHistory(rows: HistoryRow[]): HistoryEntry[] {
  return rows
    .map((row) => ({
      id: row.id,
      role: row.role,
      content: row.content,
      createdAt: row.created_at,
      citations: (row.message_citations ?? [])
        .map((c) => {
          const chunk = c.chunk_id === null ? null : first(c.chunks);
          const source = chunk ? first(chunk.sources) : null;
          return {
            ordinal: c.ordinal,
            quote: c.quote,
            chunk: chunk ? { content: chunk.content, page: chunk.page, sourceTitle: source?.title ?? "" } : null,
          };
        })
        .sort((a, b) => a.ordinal - b.ordinal),
    }))
    .sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
      if (a.role === b.role) return 0;
      return a.role === "user" ? -1 : 1;
    });
}

export async function listHistory(client: SupabaseClient, notebookId: string): Promise<HistoryEntry[]> {
  const { data, error } = await client
    .from("messages")
    .select("id, role, content, created_at, message_citations(ordinal, quote, chunk_id, chunks(content, page, sources(title)))")
    .eq("notebook_id", notebookId)
    .order("created_at", { ascending: true });
  if (error) throw new Error("listHistory failed");
  return toHistory((data ?? []) as HistoryRow[]);
}
