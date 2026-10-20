# 0026: An answer without a valid citation gets its own fixed sentence

- Status: accepted (Pascal, 2026-10-21)
- Date: 2026-10-21
- Amends: ADR 0011 ("an answer with no valid citation is replaced by the fixed abstention sentence"); ADR 0011 itself stays unedited

## Context

On production (2026-10-20, a URL source, question "Was macht die Developer Akademie"), Nova 2 Lite streamed a plain answer with no citation marker at all. The `chat_turn` log said `chunks 8, citations 0, dropped 0, abstained true`. The server replaced the answer with "Dazu finde ich in den Quellen keine Antwort.", as ADR 0011 says. That was safe, but the sentence was wrong: the sources were searched and the model did answer, it only did not back the answer with a quote. The user saw text appear and then switch to the abstention without a reason.

## Decision

- Two fixed sentences in `lib/chat/abstention.ts`: `ABSTENTION` (unchanged) and `UNGROUNDED` ("Ich konnte keine Antwort mit wörtlichen Zitaten aus den Quellen belegen.").
- `runTurn` classifies an answer with no valid citation (`abstention` on the message and in the log, an enum, never text): `no_sources` (nothing retrieved, no model call) and `model` (the model wrote the abstention sentence, or nothing after the echo strip) store `ABSTENTION`; `no_marker` (no marker at all) and `dropped` (every marker failed the check) store `UNGROUNDED`. `abstained` stays true for all four, so the canary and the client protocol are unchanged.
- The chat shows a short notice under an `UNGROUNDED` answer that the streamed text was discarded for lack of checked quotes, also after a reload (derived from the stored content).
- The prompt states the citation rule before the abstention rule, forbids knowledge from outside the sources, says that an answer without any marker is discarded, and gives one fictional example of a correct marker.
- The eval reports `ungrounded:no-marker` and `ungrounded:dropped` for fact cases apart from `abstained`.

## Consequences

- The model's ungrounded text is still never stored or shown after the check; only fixed sentences replace it (SECURITY.md, LLM09).
- The log and the eval show how often the model skips citing, which tells whether the prompt change is enough.
- About 60 more input tokens per turn.
- Revisit if the develop eval keeps failing fact cases with `ungrounded:no-marker`: then a different model or a constrained output format is the next step, not a weaker check.

## Alternatives considered

- **Retry the model once without markers**: doubles cost and latency for that turn, needs a second budget check, and with no new evidence the model mostly repeats itself.
- **Hold the stream until the first valid marker**: no false preview, but the answer would appear only at the end; streaming is the main latency win.
- **Show the ungrounded text with a warning**: shows model text that no check backs, which is what LLM09 and the injection defence rule out.
