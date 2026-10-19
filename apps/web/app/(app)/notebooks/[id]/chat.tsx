"use client";

import { useRouter } from "next/navigation";
import { useEffect, useReducer, useState, type FormEvent } from "react";
import type { HistoryCitation, HistoryEntry } from "@/lib/chat/history";
import { readChatEvents } from "@/lib/chat/ndjson";
import { highlight } from "@/lib/chat/passage";
import { CLIENT_DEADLINE_MS, INITIAL_TURN, turnReducer } from "@/lib/chat/turn-state";

// The chat of one notebook (block D3). Everything the model wrote is rendered as plain React
// text: no markdown, no HTML, no links, no images (AGENTS.md, ADR 0011). Streamed text is a
// preview only; the checked message from the server replaces it, and a broken stream drops it.

const MAX_QUESTION_CHARS = 2000;

function citationLabel(c: HistoryCitation): string {
  if (!c.chunk) return `[${c.ordinal}] Quelle gelöscht`;
  return c.chunk.page === null ? `[${c.ordinal}] ${c.chunk.sourceTitle}` : `[${c.ordinal}] ${c.chunk.sourceTitle}, S. ${c.chunk.page}`;
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

function Entry({ entry }: { entry: HistoryEntry }) {
  const [open, setOpen] = useState<number | null>(null);
  const opened = entry.citations.find((c) => c.ordinal === open) ?? null;
  return (
    <li>
      <p>
        <strong>{entry.role === "user" ? "Frage" : "Antwort"}:</strong> {entry.content}
      </p>
      {entry.citations.length > 0 ? (
        <div>
          {entry.citations.map((c) => (
            <button
              key={c.ordinal}
              type="button"
              aria-expanded={open === c.ordinal}
              aria-controls={`passage-${entry.id}`}
              onClick={() => setOpen(open === c.ordinal ? null : c.ordinal)}
            >
              {citationLabel(c)}
            </button>
          ))}
        </div>
      ) : null}
      {opened ? (
        <div id={`passage-${entry.id}`} role="region" aria-label={`Fundstelle [${opened.ordinal}]`}>
          <Passage citation={opened} />
        </div>
      ) : null}
    </li>
  );
}

export function Chat({
  notebookId,
  initialHistory,
  historyFailed = false,
}: {
  notebookId: string;
  initialHistory: HistoryEntry[];
  historyFailed?: boolean;
}) {
  const router = useRouter();
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
    <section>
      <h2>Fragen</h2>
      {historyFailed ? <p role="status">Der Verlauf konnte nicht geladen werden.</p> : null}
      <ol>
        {initialHistory.map((entry) => (
          <Entry key={entry.id} entry={entry} />
        ))}
        {turn.asked ? (
          <li>
            <p>
              <strong>Frage:</strong> {turn.asked}
            </p>
          </li>
        ) : null}
      </ol>
      {/* Always mounted, so screen readers announce the first streamed text too. */}
      <div aria-live="polite">
        {turn.pending ? (
          <p>
            <strong>Antwort:</strong> {turn.pending}
          </p>
        ) : null}
        {turn.checked ? (
          <p>
            <strong>Antwort:</strong> {turn.checked.content}
          </p>
        ) : null}
      </div>
      <form onSubmit={onSubmit}>
        <label>
          Frage{" "}
          <textarea
            name="question"
            required
            maxLength={MAX_QUESTION_CHARS}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
          />
        </label>{" "}
        <button type="submit" disabled={turn.busy}>
          Fragen
        </button>
      </form>
      {turn.alert ? <p role="alert">{turn.alert}</p> : null}
    </section>
  );
}
