# 0018: Echoed source blocks are stripped before the citation check and from the stream

- Status: accepted (plan approved by Pascal, 2026-10-20)
- Date: 2026-10-20

## Context

The prompt puts every retrieved chunk in a block `<quelle-NONCE nr="n"> ... </quelle-NONCE>` with a fresh nonce per turn, so source text cannot forge block boundaries (ADR 0011). On develop the model (Nova 2 Lite) answered by first copying three of those blocks verbatim, nonce included, and then giving a correct answer with valid citations. The citation check accepted the answer because its citations were valid; the live stream showed the blocks; the stored answer contained the nonce. The live eval (ADR 0017) would flag `<quelle-` but only runs fixed cases.

## Decision

- **Strip, do not reject**: `lib/rag/echo.ts` removes every block from an open tag `<quelle-X ...>` or `<frage-X>` to its matching close tag (a close tag with another X, e.g. a forged one in the source text, does not end it; no close tag: drop to the end, fail closed), then stray close tags and every occurrence of the turn's nonce, also occurrences that only form once an inner one is removed. Tags are bounded (X up to 32 characters, attributes up to 24, up to 8 spaces before `>`). Matching lowercases ASCII only, so indexes never shift (Unicode lowercasing changes the length of e.g. "İ"). The whole strip repeats until stable, at most three passes, so a tag rebuilt by removing the nonce goes too. Linear per pass.
- **Before the citation check**: `runTurn` strips first, then validates. Markers inside an echoed block are source text, not claims, so they never count; if nothing citable is left, the existing rule abstains.
- **Stream**: `lib/rag/echo-filter.ts` applies the same rules to the live deltas before the marker filter. It holds a `<` while it can still become a tag (at most 96 characters, more than the longest accepted tag) and a trailing run of hex characters (the nonce is hex, at most 512), so neither the blocks nor the nonce are ever shown, also when the nonce is split across deltas or rebuilt around an inner one or a block.
- **Prompt**: one line asks the model never to repeat the blocks, their tags or the question. Cheap, not a guarantee.
- **Eval**: fact and abstention cases fail when the stored answer still contains the nonce or a forbidden tag, i.e. when stripping missed something; `<frage-` joins the forbidden list. How often the model echoes is visible only as the log count.
- **Log**: `chat_turn.echoStripped` counts the removed parts (no text).

## Consequences

- An echoing answer is repaired instead of shown broken; an answer that is only echo becomes the abstention.
- How often the model echoes is visible only as a log count.
- Not covered: paraphrased or retagged echoes (`<Quelle 1>`, `[Quelle 1]`); tags longer than the bounds stay as text (nonce still removed).
- An answer that legitimately contains a literal open tag such as `<quelle-1>` loses everything after it, so it usually becomes the abstention (fail closed).
- The stream cannot see a tag that only forms once the nonce is removed (`<quel` + nonce + `le-1>`): it may show it as plain text; the stored answer is clean.

## Alternatives considered

- **Reject the whole answer**: loses good answers like the one observed.
- **Prompt only**: no guarantee, and the stream would still show the echo.
