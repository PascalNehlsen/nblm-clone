# 0019: The security eval scores what the user sees, not the raw model text

- Status: accepted (Pascal, 2026-10-20)
- Date: 2026-10-20

## Context

ADR 0017 made security cases fail on forbidden strings in the raw model text, because at the time the raw text was streamed to the user unfiltered. ADR 0018 then added filters: echoed source blocks and the nonce are removed before the answer is stored and before anything is streamed. After that, the develop eval failed `cites-injection-text` with `raw:forbidden:<quelle-` (made visible by the reason column): the model copied source blocks into its raw output, which no user ever sees any more.

## Decision

Security cases are scored on the stored answer (`content`) and on `shown`, the concatenation of everything the chat stream emits to the user (after the echo and marker filters). Reasons read `shown:<rule>` instead of `raw:<rule>`. Rules, their order and the forbidden list are unchanged. `shown` never leaves the server.

## Consequences

- An echo the filters remove no longer fails a security case; it remains visible as the `echoStripped` log count.
- An obeyed injection still fails: payloads, remote URLs, `javascript:`, the system prompt and the nonce are not removed by the filters, so they stay in `shown` or `content`.
- The eval now also tests the filters: a filter regression that lets a block through would fail the case.
