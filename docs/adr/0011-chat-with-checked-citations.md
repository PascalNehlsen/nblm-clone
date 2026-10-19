# 0011: Answer each question alone, from delimited sources, with citations checked on the server

- Status: accepted
- Date: 2026-10-19

## Context

Block D answers questions from a notebook's sources. AGENTS.md requires: no tools for the chat model, retrieved text treated as data, citations checked on the server (chunk retrieved for this question, quote an exact substring), abstention when the sources lack the answer, a budget check before every call, model config on the server only, and no prompt, source or answer text in logs. SECURITY.md left open whether chat history goes to the model. Anthropic models are not available for the account, so the model is Amazon Nova 2 Lite through the EU inference profile (PR #35).

## Decision

- **No history.** Each turn sends one question. Forged `assistant` rows (accepted risk, ADR 0004) never reach the model, and turns about deleted sources stay out.
- **Prompt** (`lib/rag/prompt.ts`): a constant German system prompt; each retrieved chunk in a block `<quelle-{nonce} nr="n">` with a random nonce per request, so source text cannot close its block; the model sees block numbers, never ids.
- **Citations** (`lib/rag/citations.ts`): the model writes `[n: "quote"]`. A marker counts only if n names a chunk retrieved for this turn and the quote is an exact substring of it after NFC, at most 2,000 characters; at most 20 per answer. Valid markers become `[k]`, all others are removed. An answer with no valid citation is replaced by the fixed abstention sentence. No retrieved chunk: the abstention sentence without a model call.
- **Streaming** (`lib/rag/stream-filter.ts`, `bedrock.ts`): ConverseStream with no `toolConfig`, `maxTokens` and `temperature` (0.2) from the server config. A server-side filter keeps markers out of the streamed text; the final event carries the checked message, which replaces it.
- **Saving** (`lib/server/chat/store.ts`): question, answer and citations are written with the user's login inside `linkMessage`, so the usage row links to the answer (ADR 0006). Refused or failed calls save nothing.
- **Route** (`app/(app)/notebooks/[id]/chat/route.ts`, logic in `lib/server/chat/http.ts`): POST, same-origin check, JSON body with `question` only, 16 KB, NDJSON response.
- **Residency**: the chat model id must start with `eu.`; the IAM policy allows only the EU profile (PR #35).
- **Eval**: a deterministic security gate in `pnpm test` replays hostile model outputs; a live eval against Bedrock follows in its own PR.

## Consequences

- Follow-up questions have no context of earlier turns.
- Over-abstention is possible for summary questions; the eval measures it.
- A quote the model paraphrases is dropped; the claim text stays, without its marker. If no valid citation is left, the whole answer becomes the abstention sentence.
- Plain-text rendering in the UI (block D3) is still needed: the gate checks markers and citations, not links or images in the answer text.

## Alternatives considered

- **History from rows the server wrote**: needs a server-only marker, so `service_role` or a definer function.
- **Citations as chunk ids from the model**: ids in the prompt can be copied into forged markers across notebooks; block numbers map only to this turn's chunks.
- **Tool or JSON-schema output for citations**: the chat model gets no tools (AGENTS.md).
