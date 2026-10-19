"use client";

import { useRouter } from "next/navigation";
import { useEffect, useReducer, useState, type FormEvent } from "react";
import type { HistoryCitation, HistoryEntry } from "@/lib/chat/history";
import { readChatEvents } from "@/lib/chat/ndjson";
import { highlight } from "@/lib/chat/passage";
import { CLIENT_DEADLINE_MS, INITIAL_TURN, turnReducer } from "@/lib/chat/turn-state";
import { hueFor, splitRefs } from "@/lib/ui/source-hue";

// The chat of one notebook (block D3). Everything the model wrote is rendered as plain React
// text: no markdown, no HTML, no links, no images (AGENTS.md, ADR 0011). Streamed text is a
// preview only; the checked message from the server replaces it, and a broken stream drops it.

const MAX_QUESTION_CHARS = 2000;

function citationLabel(c: HistoryCitation): string {
  if (!c.chunk) return `[${c.ordinal}] Quelle gelöscht`;
  return c.chunk.page === null ? `[${c.ordinal}] ${c.chunk.sourceTitle}` : `[${c.ordinal}] ${c.chunk.sourceTitle}, S. ${c.chunk.page}`;
}

function citationHue(c: HistoryCitation, hues: Record<string, number>): number | undefined {
  return c.chunk ? hueFor(hues, c.chunk.sourceTitle) : undefined;
}

function Passage({ citation }: { citation: HistoryCitation }) {
  if (!citation.chunk) return <p>Quelle gelöscht</p>;
  const parts = highlight(citation.chunk.content, citation.quote);
  return (
    <p>
      {parts ? (
        <>
          {parts.before}
          <mark>{parts.mark}</mark>
          {parts.after}
        </>
      ) : (
        citation.chunk.content
      )}
    </p>
  );
}

// The answer as text with its [n] markers shown in the color of the cited source.
function AnswerText({ entry, hues }: { entry: HistoryEntry; hues: Record<string, number> }) {
  return (
    <>
      {splitRefs(entry.content).map((part, i) => {
        if ("text" in part) return part.text;
        const c = entry.citations.find((x) => x.ordinal === part.ref);
        // A bare [n] without a checked citation stays plain text, so it never looks verified.
        if (!c) return `[${part.ref}]`;
        return (
          <span key={i} className="ref" data-hue={citationHue(c, hues)}>
            <span className="sr-only">[</span>
            {part.ref}
            <span className="sr-only">]</span>
          </span>
        );
      })}
    </>
  );
}

type Opened = { entryId: string; ordinal: number } | null;

function Entry({
  entry,
  hues,
  opened,
  onToggle,
}: {
  entry: HistoryEntry;
  hues: Record<string, number>;
  opened: Opened;
  onToggle: (ordinal: number) => void;
}) {
  const isUser = entry.role === "user";
  return (
    <li className={isUser ? "turn q" : "turn a"}>
      <span className="who">{isUser ? "Frage" : "Antwort"}</span>
      {isUser ? (
        <p>{entry.content}</p>
      ) : (
        <p className="body">
          <AnswerText entry={entry} hues={hues} />
        </p>
      )}
      {entry.citations.length > 0 ? (
        <div className="chips">
          {entry.citations.map((c) => (
            <button
              key={c.ordinal}
              type="button"
              className="chip"
              data-hue={citationHue(c, hues)}
              aria-expanded={opened?.entryId === entry.id && opened.ordinal === c.ordinal}
              aria-controls="fundstelle"
              onClick={() => onToggle(c.ordinal)}
            >
              <span className="num" aria-hidden="true">
                {c.ordinal}
              </span>
              <span className="sr-only">[{c.ordinal}]</span> {citationLabel(c).replace(/^\[\d+\] /, "")}
            </button>
          ))}
        </div>
      ) : null}
    </li>
  );
}

export function Chat({
  notebookId,
  initialHistory,
  historyFailed = false,
  hues = {},
}: {
  notebookId: string;
  initialHistory: HistoryEntry[];
  historyFailed?: boolean;
  hues?: Record<string, number>;
}) {
  const router = useRouter();
  const [opened, setOpened] = useState<Opened>(null);
  const openedEntry = opened ? initialHistory.find((e) => e.id === opened.entryId) : undefined;
  const openedCitation = openedEntry?.citations.find((c) => c.ordinal === opened?.ordinal) ?? null;

  // Escape closes the passage (on small screens it covers part of the page as a sheet).
  useEffect(() => {
    if (!opened) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpened(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [opened]);
  const [question, setQuestion] = useState("");
  const [turn, dispatch] = useReducer(turnReducer, INITIAL_TURN);

  // The checked answer stays until the server-rendered history contains it.
  useEffect(() => {
    dispatch({ type: "history", ids: initialHistory.map((e) => e.id) });
  }, [initialHistory]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = question.trim();
    if (!text || turn.busy) return;
    dispatch({ type: "submit", question: text });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CLIENT_DEADLINE_MS);
    try {
      const response = await fetch(`/notebooks/${notebookId}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: text }),
        signal: controller.signal,
      });
      if (response.status !== 200 || !response.body) {
        dispatch({ type: "failed" });
        return;
      }
      const outcome = await readChatEvents(response.body, (e) => {
        if (e.type === "delta") dispatch({ type: "delta", text: e.text });
        else if (e.type === "error") dispatch({ type: "error", label: e.label });
        else dispatch({ type: "done", message: e.message });
      });
      if (outcome === "done") {
        setQuestion("");
        // The server reloads the history with the citation passages from the database.
        router.refresh();
      } else if (outcome === "broken") {
        dispatch({ type: "broken" });
      }
    } catch {
      dispatch({ type: controller.signal.aborted ? "broken" : "failed" });
    } finally {
      clearTimeout(timer);
    }
  }

  return (
    <section className="chat">
      <div className="conversation">
        <h2>Fragen</h2>
        {historyFailed ? <p role="status">Der Verlauf konnte nicht geladen werden.</p> : null}
        <ol className="thread">
          {initialHistory.map((entry) => (
            <Entry
              key={entry.id}
              entry={entry}
              hues={hues}
              opened={opened}
              onToggle={(ordinal) =>
                setOpened(opened?.entryId === entry.id && opened.ordinal === ordinal ? null : { entryId: entry.id, ordinal })
              }
            />
          ))}
          {turn.asked ? (
            <li className="turn q">
              <span className="who">Frage</span>
              <p>{turn.asked}</p>
            </li>
          ) : null}
        </ol>
        {/* Always mounted, so screen readers announce the first streamed text too. */}
        <div aria-live="polite">
          {turn.busy && !turn.pending && !turn.checked ? (
            <div className="thinking">
              <span className="sr-only">Antwort wird geschrieben</span>
              <i />
              <i />
              <i />
            </div>
          ) : null}
          {turn.pending ? (
            <div className="turn a pending">
              <span className="who">Antwort</span>
              <p className="body">{turn.pending}</p>
            </div>
          ) : null}
          {turn.checked ? (
            <div className="turn a">
              <span className="who">Antwort</span>
              <p className="body">{turn.checked.content}</p>
            </div>
          ) : null}
        </div>
        <form onSubmit={onSubmit} className="composer">
          <label>
            <span className="sr-label sr-only">Frage</span>
            <textarea
              name="question"
              required
              maxLength={MAX_QUESTION_CHARS}
              value={question}
              placeholder="Frag deine Quellen …"
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  e.currentTarget.form?.requestSubmit();
                }
              }}
            />
          </label>
          <button type="submit" className="primary" disabled={turn.busy}>
            {turn.busy ? <span className="spin" aria-hidden="true" /> : null}
            Fragen
          </button>
        </form>
        {turn.alert ? <p role="alert">{turn.alert}</p> : null}
      </div>
      <aside className="margin" aria-label="Fundstellen">
        {opened && openedCitation ? (
          <div
            id="fundstelle"
            role="region"
            aria-label={`Fundstelle [${openedCitation.ordinal}]`}
            className="passage"
            data-hue={citationHue(openedCitation, hues)}
            key={`${opened.entryId}-${opened.ordinal}`}
          >
            <div className="head">
              <p className="src">{citationLabel(openedCitation)}</p>
              <button type="button" className="quiet close" onClick={() => setOpened(null)}>
                Schließen
              </button>
            </div>
            <Passage citation={openedCitation} />
          </div>
        ) : (
          <p className="hint" id="fundstelle">
            Klick auf einen Beleg unter einer Antwort, dann erscheint hier die Fundstelle im Original, farbig
            markiert.
          </p>
        )}
      </aside>
    </section>
  );
}
