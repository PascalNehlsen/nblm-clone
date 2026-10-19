import { deleteSourceAction, retrySourceAction } from "./sources/actions";
import { sourceErrorLabel } from "@/lib/ops/categories";
import type { SourceStatus, SourceSummary } from "@/lib/sources/sources";

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
}: {
  sources: SourceSummary[];
  notebookId: string;
  canEdit: boolean;
}) {
  if (sources.length === 0) return <p>Noch keine Quellen.</p>;
  return (
    <ul>
      {sources.map((source) => (
        <li key={source.id}>
          <span>{source.title}</span> <span>{statusText(source)}</span>
          {canEdit ? (
            <>
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
                <button type="submit">Entfernen</button>
              </form>
            </>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
