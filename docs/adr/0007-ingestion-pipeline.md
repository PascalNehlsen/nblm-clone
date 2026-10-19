# 0007: Ingest each source inline, with one budgeted embedding call

- Status: accepted
- Date: 2026-10-19

## Context

Block C turns uploaded PDFs and pasted text into chunks with embeddings. It has to:
- check untrusted bytes;
- keep chunks as exact substrings of the source text, which the citation check in D relies on;
- pass every embedding call through the per-user budget (ADR 0006);
- run on Vercel, where a request body is capped at 4.5 MB and a function at `maxDuration`.

There is no queue yet.

## Decision

- **Upload.** The server action inserts the `sources` row with the user's login, then asks Storage for a signed upload URL for its `storage_path`. The browser PUTs the PDF straight to the private bucket. Pasted text (at most 100,000 characters) is uploaded by the server as a `text/plain` object.
- **Pipeline** (`lib/server/ingest/`), inline in the server action, with `maxDuration = 300`:
  1. Claim the source (`pending`/`failed`, or `processing` older than 10 minutes, which becomes `processing`) and delete old chunks.
  2. Download the object and check it by magic bytes and size.
  3. Extract the text: PDF via `unpdf`, at most 500 pages in 60 s; text as UTF-8. Normalize it (NFC, no NUL or control characters).
  4. Chunk it: 1,500 characters at most, at most 200 characters of overlap, never across pages; each chunk is an exact substring of its page.
  5. Make one embedding call for all chunks through `createModelCaller`, with `callCount = n` and a 120 s timeout.
  6. Check the vectors (count, 1024 dimensions, finite), insert them in batches of 100, and set the source `ready`.
- **Failures.** Any failure sets the source `failed` with a fixed category (`lib/ops/categories.ts`). The log carries counts and the category only.
- **Limits in the database.** Two invoker triggers: at most 50 sources and 20,000 chunks per notebook, serialized by advisory locks. `status_changed_at` is set only by a trigger.
- **Deletion.** The file first, then the row (ADR 0004); chunks go with the cascade. Leftover files are the C4 sweep's job.
- **Access.** Only `lib/server/model/` may import the Bedrock provider or SDK (`eslint.config.mjs`). Ingestion gets its caller from `lib/server/model/embeddings.ts`.

## Consequences

- No worker to run or monitor, and all writes use the user's login, so RLS applies throughout.
- A function killed at 300 s leaves the source `processing`; it becomes retryable after 10 minutes ("Erneut versuchen").
- One reservation per source holds the upper-bound estimate until settle.
- Revisit when sources regularly exceed the function time, or when ingestion needs retries without a user: that is the v1.1 queue.

## Alternatives considered

- **Background queue or worker**: more moving parts before there is load (v1.1).
- **Upload through the server**: blocked by Vercel's 4.5 MB body limit.
- **Embedding batches of 64 with one usage row each**: needs an ADR 0006 change for no gain at this size.
- **pdf-parse**: ships a pdf.js from 2018 that is affected by CVE-2024-4367.
