import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { guardedFetch } from "@/lib/server/fetch/guarded-fetch";
import { createNodeTransport, resolveHost } from "@/lib/server/fetch/node-transport";
import { createEmbeddingCaller } from "@/lib/server/model/embeddings";
import { objectStore, sourceStore } from "@/lib/sources/sources";
import { extractPdfText } from "./pdf";
import { ingestSource, type IngestLogEvent, type IngestOutcome } from "./pipeline";
import { fetchUrlText } from "./url-source";

export function jsonIngestLog(event: IngestLogEvent): void {
  console.info(JSON.stringify(event));
}

// The real wiring: the user's own client (RLS decides, viewers cannot claim) and the
// Bedrock embeddings behind the budgeted model wrapper, and the SSRF-guarded fetch for
// url sources (ADR 0008).
export async function runIngestion(client: SupabaseClient, sourceId: string): Promise<IngestOutcome> {
  return ingestSource(
    {
      sources: sourceStore(client),
      objects: objectStore(client),
      extractPdf: (bytes) => extractPdfText(bytes),
      fetchUrl: (url) =>
        fetchUrlText(url, {
          fetch: (u) => guardedFetch(u, { resolve: resolveHost, transport: createNodeTransport() }),
        }),
      callModel: createEmbeddingCaller(),
      log: jsonIngestLog,
      now: () => performance.now(),
    },
    sourceId,
  );
}
