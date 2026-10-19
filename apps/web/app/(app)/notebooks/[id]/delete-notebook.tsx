"use client";

import { useRef } from "react";
import { deleteNotebookAction } from "../actions";

// Deleting is irreversible, so it asks in a modal dialog first; the confirmation is this
// dialog. The hidden field keeps the server action's existing check satisfied (it refuses a
// request without it, which tests/e2e/notebooks.spec.ts covers); it is not proof of intent.
export function DeleteNotebook({ notebookId, title }: { notebookId: string; title: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  return (
    <div className="panel danger-zone">
      <button type="button" className="danger" onClick={() => dialog.current?.showModal()}>
        Notizbuch löschen
      </button>
      <dialog ref={dialog} className="confirm" aria-labelledby="loeschen-titel" aria-describedby="loeschen-text">
        <h2 id="loeschen-titel">Notizbuch löschen?</h2>
        <p id="loeschen-text">
          „{title}“ wird mit allen Quellen, Fragen und Antworten endgültig gelöscht. Das lässt sich nicht rückgängig
          machen.
        </p>
        <form action={deleteNotebookAction} onSubmit={() => dialog.current?.close()}>
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
