# 0016: Citations match after folding, the stored quote stays verbatim

- Status: accepted (plan approved by Pascal, 2026-10-19)
- Date: 2026-10-19

## Context

ADR 0011 accepts a citation only if the model's quote is an exact substring of the chunk after NFC. On production (v1.0.0) the demo notebook holds a Grimm fairy tale in old spelling ("daß", »…«, ’). The same question was asked twice with the same retrieval: once the model answered with 62 tokens and every citation was dropped, so the user saw the abstention; once it answered with valid citations. Models silently modernize spelling and typography, so exact matching turns correct answers into false abstentions. The model's text is not stored, so the exact mismatch is unknown.

## Decision

- **Folding** (`lib/rag/fold.ts`): both quote and chunk are compared after one linear pass that maps whitespace runs to one space, removes soft hyphens and zero-width characters, maps all quotation marks and apostrophes to `'`, dashes to `-`, `…` to `...`, `ß` to `ss`. Case and diacritics stay strict; no fuzzy or edit-distance matching.
- The exact NFC check runs first. Only if it fails is the folded text searched, and a match must start and end on source character bounds.
- **What is stored and shown is the verbatim chunk span**, never the model's text. So the AGENTS.md rule still holds for every stored citation: it is an exact substring of a chunk retrieved for this question. What changes is that the model's own text no longer has to be one. The UI highlight and the release canary keep working unchanged.
- A span over 2,000 characters is dropped (database limit). At most 32 misaligned matches are tried per quote, which bounds adversarial input; anything beyond that is dropped.
- The prompt asks for character-exact quotes, old spelling and typographic marks kept, no `"` inside a quote, short quotes.
- The `chat_turn` log counts drops per reason (`unknown_chunk`, `not_in_chunk`, `malformed`, `over_limit`) and folded citations, without text, so the next case can be diagnosed from logs.

## Consequences

- Fewer false abstentions on old or typographically rich texts. Grounding is unchanged: a fabricated quote, a quote from another chunk, a case change or a different letter still drops.
- A model quote with straight quotes inside still breaks the marker grammar; only the prompt addresses it.
- No migration; rolling back the app is enough, stored rows are verbatim spans the old check also accepts.
- No live eval runner yet: the effect is checked by asking the Grimm question about ten times on develop and reading the new log counts.

## Alternatives considered

- **Prompt only**: keeps the strict rule, but leaves false abstentions to chance.
- **Fuzzy matching** (edit distance): would accept quotes the source never contained.
- **Store the model's quote after a folded match**: the displayed quote would not be source text.
