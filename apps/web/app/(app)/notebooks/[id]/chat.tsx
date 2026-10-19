"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import type { HistoryCitation, HistoryEntry } from "@/lib/chat/history";
import { readChatEvents } from "@/lib/chat/ndjson";
import { highlight } from "@/lib/chat/passage";

// The chat of one notebook (block D3). Everything the model wrote is rendered as plain React
// text: no markdown, no HTML, no links, no images (AGENTS.md, ADR 0011). Streamed text is a
// preview only; the checked message from the server replaces it, and a broken stream drops it.

const MAX_QUESTION_CHARS = 2000;
const GENERIC = "Das hat nicht geklappt. Bitte versuche es noch einmal.";
const BROKEN = "Die Antwort wurde unterbrochen. Bitte versuche es noch einmal.";

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
              onClick={() => setOpen(open === c.ordinal ? null : c.ordinal)}
            >
              {citationLabel(c)}
            </button>
          ))}
        </div>
      ) : null}
      {opened ? (
        <div role="region" aria-label={`Fundstelle [${opened.ordinal}]`}>
          <Passage citation={opened} />
        </div>
      ) : null}
    </li>
  );
}

export function Chat({ notebookId, initialHistory }: { notebookId: string; initialHistory: HistoryEntry[] }) {
  const router = useRouter();
  const [question, setQuestion] = useState("");
  const [asked, setAsked] = useState<string | null>(null);
  const [pending, setPending] = useState("");
  const [busy, setBusy] = useState(false);
  const [alert, setAlert] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = question.trim();
    if (!text || busy) return;
    setBusy(true);
    setAlert(null);
    setAsked(text);
    setPending("");
    try {
      const response = await fetch(`/notebooks/${notebookId}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: text }),
      });
      if (response.status !== 200 || !response.body) {
        setAlert(GENERIC);
        return;
      }
      const outcome = await readChatEvents(response.body, (e) => {
        if (e.type === "delta") setPending((p) => p + e.text);
        else if (e.type === "error") setAlert(e.label);
      });
      if (outcome === "done") {
        setQuestion("");
        // The server reloads the history, with the citation passages, from the database;
        // the question is part of it now.
        setAsked(null);
        router.refresh();
      } else if (outcome === "broken") {
        setAlert(BROKEN);
      }
    } catch {
      setAlert(GENERIC);
    } finally {
      // Unchecked streamed text never stays on screen; a failed question stays visible.
      setPending("");
      setBusy(false);
    }
  }

  return (
    <section>
      <h2>Fragen</h2>
      <ol>
        {initialHistory.map((entry) => (
          <Entry key={entry.id} entry={entry} />
        ))}
        {asked ? (
          <li>
            <p>
              <strong>Frage:</strong> {asked}
            </p>
            {pending ? (
              <p aria-live="polite">
                <strong>Antwort:</strong> {pending}
              </p>
            ) : null}
          </li>
        ) : null}
      </ol>
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
        <button type="submit" disabled={busy}>
          Fragen
        </button>
      </form>
      {alert ? <p role="alert">{alert}</p> : null}
    </section>
  );
}
