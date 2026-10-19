"use client";

import { useRef } from "react";
import { deleteNotebookAction } from "../actions";

// Deleting is irreversible, so it asks in a modal dialog first. The server action still
// requires the confirmation field, so a crafted request without it is refused too.
export function DeleteNotebook({ notebookId, title }: { notebookId: string; title: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  return (
    <div className="panel danger-zone">
      <button type="button" className="danger" onClick={() => dialog.current?.showModal()}>
        Notizbuch löschen
      </button>
      <dialog ref={dialog} className="confirm" aria-labelledby="loeschen-titel">
        <h2 id="loeschen-titel">Notizbuch löschen?</h2>
        <p>
          „{title}“ wird mit allen Quellen, Fragen und Antworten endgültig gelöscht. Das lässt sich nicht rückgängig
          machen.
        </p>
        <form action={deleteNotebookAction}>
          <input type="hidden" name="notebookId" value={notebookId} />
          <input type="hidden" name="confirm" value="on" />
          <div className="actions">
            <button type="button" className="quiet" onClick={() => dialog.current?.close()}>
              Abbrechen
            </button>
            <button type="submit" className="danger solid">
              Endgültig löschen
            </button>
          </div>
        </form>
      </dialog>
    </div>
  );
}
