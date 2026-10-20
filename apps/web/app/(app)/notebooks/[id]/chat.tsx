"use client";

import { useRouter } from "next/navigation";
import { useEffect, useReducer, useRef, useState, type FormEvent } from "react";
import type { HistoryCitation, HistoryEntry } from "@/lib/chat/history";
import { readChatEvents } from "@/lib/chat/ndjson";
import { highlight } from "@/lib/chat/passage";
import { CLIENT_DEADLINE_MS, INITIAL_TURN, turnReducer } from "@/lib/chat/turn-state";
import { hueFor, splitRefs } from "@/lib/ui/source-hue";
import { useMargin } from "@/components/margin";
import { readSourceAction } from "./sources/actions";

// The chat of one notebook (block D3). Everything the model wrote is rendered as plain React
// text: no markdown, no HTML, no links, no images (AGENTS.md, ADR 0011). Streamed text is a
// preview only; the checked message from the server replaces it, and a broken stream drops it.

const MAX_QUESTION_CHARS = 2000;

const KIND_LABELS = { text: "Text", pdf: "PDF", url: "Webseite" } as const;

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
  onToggle: (ordinal: number, chip: HTMLButtonElement) => void;
}) {
  const isUser = entry.role === "user";
  return (
    <li className={isUser ? "turn q" : "turn a"}>
      <span className="who sr-only">{isUser ? "Frage" : "Antwort"}</span>
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
              onClick={(e) => onToggle(c.ordinal, e.currentTarget)}
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
  hasReadySources = true,
  canAddSources = true,
}: {
  notebookId: string;
  initialHistory: HistoryEntry[];
  historyFailed?: boolean;
  hues?: Record<string, number>;
  hasReadySources?: boolean;
  canAddSources?: boolean;
}) {
  const router = useRouter();
  const margin = useMargin();
  const opened: Opened = margin.item?.kind === "cite" ? { entryId: margin.item.entryId, ordinal: margin.item.ordinal } : null;
  const reading = margin.item?.kind === "source" ? margin.item : null;
  const setOpened = (next: Opened) => margin.open(next ? { kind: "cite", ...next } : null);
  const openedEntry = opened ? initialHistory.find((e) => e.id === opened.entryId) : undefined;
  const openedCitation = openedEntry?.citations.find((c) => c.ordinal === opened?.ordinal) ?? null;

  // Focus follows the passage: into it when it opens, back to the chip that opened it when
  // it closes (on small screens it covers part of the page as a sheet).
  const opener = margin.opener;
  const region = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!margin.item) return;
    // Below 1280px the margin sits under the conversation: bring it into view.
    region.current?.focus({ preventScroll: true });
    region.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [margin.item]);

  // A whole source is loaded on demand with the user's own session (RLS decides).
  type Loaded = {
    id: string;
    kind: "text" | "pdf" | "url";
    url: string | null;
    sections: { page: number | null; text: string }[];
    truncated: boolean;
  };
  const [source, setSource] = useState<{ id: string; loaded: Loaded | null; failed: boolean } | null>(null);
  useEffect(() => {
    if (!reading) return;
    let live = true;
    readSourceAction({ notebookId, sourceId: reading.sourceId })
      .then((r) => {
        if (!live) return;
setSource(
          r.ok
            ? { id: reading.sourceId, loaded: { id: reading.sourceId, kind: r.kind, url: r.url, sections: r.sections, truncated: r.truncated }, failed: false }
            : { id: reading.sourceId, loaded: null, failed: true },
        );

      })
      .catch(() => live && setSource({ id: reading.sourceId, loaded: null, failed: true }));
    return () => {
      live = false;
    };
  }, [reading?.sourceId, notebookId]); // eslint-disable-line react-hooks/exhaustive-deps
  function closePassage() {
    setOpened(null);
    opener.current?.focus();
  }
  useEffect(() => {
    if (!margin.item) return;
    const onKey = (e: KeyboardEvent) => {
      // An open confirmation dialog handles its own Escape.
      if (e.key === "Escape" && !document.querySelector("dialog[open]")) {
        // Back to the chip only if focus was in the passage; never pull it out of the composer.
        const inPassage = region.current?.contains(document.activeElement) ?? false;
        setOpened(null);
        if (inPassage) opener.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [margin.item]); // eslint-disable-line react-hooks/exhaustive-deps
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
        {!hasReadySources && initialHistory.length === 0 ? (
          <p className="guide">
            {canAddSources
              ? "Noch keine Quellen bereit. Füge links eine Quelle hinzu; sobald sie bereit ist, kannst du hier Fragen stellen."
              : "Noch keine Quellen bereit. Sobald jemand mit Bearbeitungsrechten eine Quelle hinzufügt, kannst du hier Fragen stellen."}
          </p>
        ) : null}
        {hasReadySources && initialHistory.length === 0 && !turn.asked ? (
          <p className="guide">
            Stell eine Frage zu deinen Quellen. Jede Antwort zeigt ihre Belege; ein Klick darauf öffnet die
            Fundstelle im Original.
          </p>
        ) : null}
        <ol className="thread">
          {initialHistory.map((entry) => (
            <Entry
              key={entry.id}
              entry={entry}
              hues={hues}
              opened={opened}
              onToggle={(ordinal, chip) => {
                margin.opener.current = chip;
                setOpened(opened?.entryId === entry.id && opened.ordinal === ordinal ? null : { entryId: entry.id, ordinal });
              }}
            />
          ))}
          {turn.asked ? (
            <li className="turn q">
              <span className="who sr-only">Frage</span>
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
              <span className="who sr-only">Antwort</span>
              <p className="body">{turn.pending}</p>
            </div>
          ) : null}
          {turn.checked ? (
            <div className="turn a arrived">
              <span className="who sr-only">Antwort</span>
              <p className="body">{turn.checked.content}</p>
            </div>
          ) : null}
        </div>
        <form onSubmit={onSubmit} className="composer">
          <label>
            <span className="sr-label sr-only">Frage</span>
            <textarea
              name="question"
              rows={1}
              aria-describedby="frage-hinweis"
              maxLength={MAX_QUESTION_CHARS}
              value={question}
              placeholder="Frag deine Quellen …"
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  if (question.trim() !== "") e.currentTarget.form?.requestSubmit();
                }
              }}
            />
          </label>
          <button type="submit" className="primary" disabled={turn.busy || question.trim() === ""}>
            {turn.busy ? <span className="spin" aria-hidden="true" /> : null}
            Fragen
          </button>
        </form>
        <p id="frage-hinweis" className="hint-line">
          Enter sendet, Shift+Enter für einen Zeilenumbruch.
        </p>
        {turn.alert ? <p role="alert">{turn.alert}</p> : null}
      </div>
      <aside className="margin" aria-label="Fundstellen">
        {opened && openedCitation ? (
          <div
            id="fundstelle"
            ref={region}
            tabIndex={-1}
            role="region"
            aria-label={`Fundstelle [${openedCitation.ordinal}]`}
            className="passage"
            data-hue={citationHue(openedCitation, hues)}
            data-tilt="3"
            key={`${opened.entryId}-${opened.ordinal}`}
          >
            <div className="head">
              <p className="src">{citationLabel(openedCitation)}</p>
              <button type="button" className="quiet close" onClick={closePassage}>
                Schließen
              </button>
            </div>
            <Passage citation={openedCitation} />
          </div>
        ) : reading ? (
          <div
            id="fundstelle"
            ref={region}
            tabIndex={-1}
            role="region"
            aria-label={`Quelle: ${reading.title}`}
            className="passage reader"
            data-hue={hueFor(hues, reading.title)}
            key={`source-${reading.sourceId}`}
          >
            <div className="head">
              <p className="src">{reading.title}</p>
              <button type="button" className="quiet close" onClick={closePassage}>
                Schließen
              </button>
            </div>
            {source?.id === reading.sourceId && source.loaded ? (
              <>
                <p className="meta">
                  <span className="pill">{KIND_LABELS[source.loaded.kind]}</span>
                  {source.loaded.url && /^https?:\/\//i.test(source.loaded.url) ? (
                    <a href={source.loaded.url} target="_blank" rel="noopener noreferrer">
                      Original öffnen
                    </a>
                  ) : null}
                </p>
                <div className="text">
                  {source.loaded.sections.map((section, i) => (
                    <p key={i}>
                      {source.loaded!.kind === "pdf" && section.page !== null ? (
                        <span className="page">Seite {section.page}</span>
                      ) : null}
                      {section.text}
                    </p>
                  ))}
                </div>
                {source.loaded.truncated ? <p className="more">Der Text ist länger; hier stehen die ersten Abschnitte.</p> : null}
              </>
            ) : source?.id === reading.sourceId && source.failed ? (
              <p role="status">Die Quelle konnte nicht geladen werden.</p>
            ) : (
              <p className="loading" aria-busy="true">
                Wird geladen …
              </p>
            )}
          </div>
        ) : (
          <p className="hint" id="fundstelle">
            Klick auf einen Beleg unter einer Antwort oder auf eine Quelle, dann erscheint hier der Text im
            Original.
          </p>
        )}
      </aside>
    </section>
  );
}
