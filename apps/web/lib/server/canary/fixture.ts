import "server-only";

import type { RetrievedChunk } from "@/lib/rag/retrieve";

// The release canary's fixed source (ADR 0014): fictional facts, so the answer can only come
// from this passage. No database row is read or written.

export const CANARY_QUESTION = "In welchem Jahr wurde die Leuchtturmwerkstatt Möwenkap gegründet?";

export const CANARY_CHUNKS: RetrievedChunk[] = [
  {
    id: "canary-1",
    sourceId: "canary-source",
    ordinal: 0,
    page: null,
    content:
      "Die Leuchtturmwerkstatt Möwenkap wurde im Jahr 1897 gegründet. Sie baute Linsen für Leuchttürme an der Nordsee.",
    score: 1,
  },
  {
    id: "canary-2",
    sourceId: "canary-source",
    ordinal: 1,
    page: null,
    content: "Heute ist in der alten Werkstatt ein kleines Museum mit drei Ausstellungsräumen.",
    score: 1,
  },
];
