"use client";

import { deleteSourceAction, retrySourceAction } from "./sources/actions";
import { sourceErrorLabel } from "@/lib/ops/categories";
import type { SourceStatus, SourceSummary } from "@/lib/sources/sources";
import { hueFor } from "@/lib/ui/source-hue";
import { ConfirmAction } from "@/components/confirm-action";
import { useMargin } from "@/components/margin";

const STATUS_LABELS: Record<Exclude<SourceStatus, "failed">, string> = {
  pending: "Wartet",
  processing: "Wird verarbeitet",
  ready: "Bereit",
};

function statusText(source: SourceSummary): string {
  return source.status === "failed"
    ? `Fehlgeschlagen: ${sourceErrorLabel(source.errorCategory)}`
    : STATUS_LABELS[source.status];
}

// Buttons only hide controls; the actions and RLS decide.
export function SourceList({
  sources,
  notebookId,
  canEdit,
  hues = {},
}: {
  sources: SourceSummary[];
  notebookId: string;
  canEdit: boolean;
  hues?: Record<string, number>;
}) {
  const margin = useMargin();
  if (sources.length === 0) return <p>Noch keine Quellen.</p>;
  const reading = margin.item?.kind === "source" ? margin.item.sourceId : null;
  return (
    <ul>
      {sources.map((source) => (
        <li key={source.id} data-hue={hueFor(hues, source.title)}>
          {source.status === "ready" ? (
            <button
              type="button"
              className="title"
              aria-expanded={reading === source.id}
              aria-controls="fundstelle"
              onClick={(e) =>
                margin.open(reading === source.id ? null : { kind: "source", sourceId: source.id, title: source.title }, e.currentTarget)
              }
            >
              {source.title}
            </button>
          ) : (
            <span className="title">{source.title}</span>
          )}{" "}
          <span className="pill status" data-state={source.status}>
            {statusText(source)}
          </span>
          {canEdit ? (
            <span className="actions">
              {source.status === "failed" ? (
                <form action={retrySourceAction}>
                  <input type="hidden" name="notebookId" value={notebookId} />
                  <input type="hidden" name="sourceId" value={source.id} />
                  <button type="submit">Erneut versuchen</button>
                </form>
              ) : null}
              <ConfirmAction
                action={deleteSourceAction}
                fields={{ notebookId, sourceId: source.id }}
                trigger="Entfernen"
                title="Quelle entfernen?"
                confirmLabel="Endgültig entfernen"
              >
                „{source.title}“ wird mit ihren Abschnitten aus dem Notizbuch entfernt. Antworten, die sie
                zitieren, zeigen danach „Quelle gelöscht“.
              </ConfirmAction>
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
