# 0004: Sources, chunks and messages are written with the user's login under membership RLS

- Status: accepted
- Date: 2026-10-18

## Context

Ingestion (PR C) and chat (PR D) write sources, chunks and messages from the server; `service_role` there would bypass RLS, so one bug could write into any notebook. Retrieval searches one notebook in a table shared by all. pgvector's approximate indexes filter by notebook only after the index scan: HNSW with `hnsw.iterative_scan = relaxed_order` (pgvector 0.8.2) returned 0 of 5 own chunks next to 300 nearer chunks of another notebook. Source text can be personal data, and Storage objects do not cascade from Postgres.

## Decision

- **Writes use the user's JWT**, never `service_role`. Every table has RLS with separate select, insert, update and delete policies through `private.notebook_role(notebook_id)`. Anonymous users cannot write sources or chunks (restrictive policies; PR F may loosen this for the demo copy).
- **Roles:** members read sources and chunks; owners and editors add and delete them. Viewers may ask: the asker's budget pays (PR E) and history is per user. Chunks and messages are immutable for API users; only the redaction trigger below rewrites an answer's text.
- **Integrity:** composite foreign keys keep a chunk in its source's notebook and a citation in its message's and chunk's notebook. `storage_path` is exactly `{notebook_id}/{flat name}`, without `..`.
- **Embeddings:** 1024 dimensions (about 99% of full retrieval quality against 97% at 512, per AWS); changing it later means embedding everything again.
- **Exact search, no approximate index:** `match_chunks` (`security invoker`, `search_path = ''`, `operator(extensions.<=>)`) filters through a btree on `chunks(notebook_id)` and sorts by exact cosine distance, ties by id, 1 to 50 rows. Measured: 32 to 53 ms at 10,000 chunks, about 170 ms at 50,000. PR C caps a notebook at 20,000 chunks, enforced in the database, reported with a fixed category from `lib/ops/categories.ts`.
- **Citations do not outlive their source:** `message_citations` references the chunk with `on delete set null (chunk_id)`; an invoker trigger empties the quote, and a check (chunk and quote both set or both empty) makes the deletion fail rather than keep a quote. A definer trigger (ADR 0001 exception) replaces the text of answers that cited the chunk with "Antwort entfernt, Quelle gelöscht"; as invoker it would run as the deleting user and fail with "permission denied" on other members' messages (measured). PR D renders "Quelle gelöscht" and keeps such turns out of the prompt.
- **Deletion order** (B2, C): Storage objects first through the Storage API, then rows; afterwards the Storage policy finds no membership. A cleanup job in `lib/server/admin/` (C) removes leftovers.
- **Uploads** (C): browser to Storage directly (Vercel bodies are limited to 4.5 MB); the server checks magic bytes after upload and deletes rejected files.

## Consequences

RLS guards server writes too, at the cost of a membership lookup per row; retrieval time grows linearly with a notebook's chunks. Users can forge assistant rows and citations in their own history, and editors can insert chunks that bypass ingestion's limits (SECURITY.md). Revisit if ingestion needs writes a user may not do, or if notebooks grow well past 50,000 chunks: then per-notebook partitions or partial indexes, with a recall test, in a new ADR.

## Alternatives considered

- **`service_role` for ingestion and chat**: one bug writes into any notebook.
- **Shared chat history**: viewers' questions visible to all members.
- **512 dimensions**: lower recall, and a full re-embedding to change later.
- **HNSW with `iterative_scan`, or IVFFlat**: no recall guarantee next to large notebooks (measured).
- **Citations as jsonb on the message**: quotes would outlive deleted sources.
- **Cascade-delete citations**: D could no longer show that a source was cited.
- **Queue table for Storage cleanup**: another definer function and still a draining job.
