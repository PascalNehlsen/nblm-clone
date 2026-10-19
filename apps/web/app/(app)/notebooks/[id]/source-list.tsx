import { deleteSourceAction, retrySourceAction } from "./sources/actions";
import { sourceErrorLabel } from "@/lib/ops/categories";
import type { SourceStatus, SourceSummary } from "@/lib/sources/sources";
import { hueFor } from "@/lib/ui/source-hue";

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
  if (sources.length === 0) return <p>Noch keine Quellen.</p>;
  return (
    <ul>
      {sources.map((source) => (
        <li key={source.id} data-hue={hueFor(hues, source.title)}>
          <span className="title">{source.title}</span>{" "}
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
              <form action={deleteSourceAction}>
                <input type="hidden" name="notebookId" value={notebookId} />
                <input type="hidden" name="sourceId" value={source.id} />
                <button type="submit" className="quiet">
                  Entfernen
                </button>
              </form>
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
