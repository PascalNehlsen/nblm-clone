// Helpers for the demo-login RLS matrix (F1). The constants mirror supabase/seed.sql
// (the local demo template); every call goes through a real signed-in client, never the
// admin/service-role credential (see helpers/clients.ts).
import { randomUUID } from "node:crypto";
import type { SignedInUser } from "./clients";
import { EMBEDDING_DIMENSIONS } from "./sources";

export const DEMO_TEMPLATE_NOTEBOOK_ID = "00000000-0000-4000-8000-0000000000d1";

export interface SeedChunk {
  ordinal: number;
  content: string;
  /** Index of the single 1.0 in the otherwise all-zero 1024-dim vector. */
  position: number;
}

export interface SeedSource {
  id: string;
  title: string;
  kind: "text";
  chunks: SeedChunk[];
}

export const SEED_READY_SOURCES: SeedSource[] = [
  {
    id: "00000000-0000-4000-8000-0000000000d2",
    title: "Beispiel: Der Wanderer.txt",
    kind: "text",
    chunks: [
      { ordinal: 0, content: "Der Wanderer ging am Morgen los und folgte dem Fluss nach Norden.", position: 0 },
      { ordinal: 1, content: "Am Mittag erreichte er eine alte Steinbruecke und rastete im Schatten.", position: 1 },
      { ordinal: 2, content: "Am Abend sah er die Lichter des Dorfes und beschleunigte seinen Schritt.", position: 2 },
    ],
  },
  {
    id: "00000000-0000-4000-8000-0000000000d3",
    title: "Beispiel: Die Bibliothek.txt",
    kind: "text",
    chunks: [
      {
        ordinal: 0,
        content: "Die Bibliothek besass tausend Baende, die nach Farben und nicht nach Titeln geordnet waren.",
        position: 3,
      },
      {
        ordinal: 1,
        content: "Die Bibliothekarin kannte jedes Buch und fand es im Dunkeln mit geschlossenen Augen.",
        position: 4,
      },
      {
        ordinal: 2,
        content: "Im Winter las sie vor dem Ofen, und die Kinder des Dorfes hoerten zu.",
        position: 5,
      },
    ],
  },
];

export const SEED_PENDING_SOURCE: SeedSource = {
  id: "00000000-0000-4000-8000-0000000000d4",
  title: "Beispiel: Noch in Arbeit.txt",
  kind: "text",
  chunks: [
    { ordinal: 0, content: "Dieser Text wird noch verarbeitet und darf nicht kopiert werden.", position: 6 },
  ],
};

export const SEED_READY_CHUNK_COUNT = SEED_READY_SOURCES.reduce((sum, source) => sum + source.chunks.length, 0);

/** The unit vector along `position`, exactly like the seed's chunk vectors. */
export function unitVector(position: number): number[] {
  const vector = new Array(EMBEDDING_DIMENSIONS).fill(0);
  vector[position] = 1;
  return vector;
}

/**
 * Inserts a notebook as `user` with a client-generated id and returns the raw error
 * instead of throwing, so tests can assert on `demo_notebook_exists` and friends.
 * No `.select()`: the owner row is written by a trigger after the insert.
 */
export async function tryCreateNotebook(
  user: SignedInUser,
  title = `demo-copy ${randomUUID()}`,
): Promise<{ notebookId: string; error: { code?: string; message: string } | null }> {
  const notebookId = randomUUID();
  const { error } = await user.client.from("notebooks").insert({ id: notebookId, title });
  return { notebookId, error };
}

export interface CopiedSource {
  id: string;
  kind: string;
  title: string;
  status: string;
}

export interface CopiedChunk {
  id: string;
  source_id: string;
  ordinal: number;
  content: string;
  page: number | null;
}

/** Reads the sources and chunks `user` can see in `notebookId`. Throws on error. */
export async function readCopy(
  user: SignedInUser,
  notebookId: string,
): Promise<{ sources: CopiedSource[]; chunks: CopiedChunk[] }> {
  const sources = await user.client
    .from("sources")
    .select("id, kind, title, status")
    .eq("notebook_id", notebookId)
    .order("title");
  if (sources.error) {
    throw new Error(`readCopy sources(${notebookId}): ${sources.error.code ?? "?"} ${sources.error.message}`);
  }
  const chunks = await user.client
    .from("chunks")
    .select("id, source_id, ordinal, content, page")
    .eq("notebook_id", notebookId)
    .order("ordinal");
  if (chunks.error) {
    throw new Error(`readCopy chunks(${notebookId}): ${chunks.error.code ?? "?"} ${chunks.error.message}`);
  }
  return { sources: (sources.data ?? []) as CopiedSource[], chunks: (chunks.data ?? []) as CopiedChunk[] };
}
