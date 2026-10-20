"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { addTextSourceAction, addUrlSourceAction, createPdfUploadAction, ingestSourceAction } from "./sources/actions";
import { notebookErrorMessage } from "@/lib/notebooks/errors";
import { MAX_TEXT_CHARS, MAX_URL_LENGTH } from "@/lib/sources/limits";
import { ModalDialog, useDialog } from "@/components/modal-dialog";

// Ingestion runs inline in the action, so sending takes seconds: the button shows it, and the
// dialog closes when the action is done. A refused input comes back as ?fehler= and is shown
// under the notebook title, outside the closed dialog.
function SubmitButton({ children }: { children: ReactNode }) {
  const { pending } = useFormStatus();
  const dialog = useDialog();
  const was = useRef(false);
  useEffect(() => {
    if (was.current && !pending) dialog?.close();
    was.current = pending;
  }, [pending, dialog]);
  return (
    <button type="submit" className="primary" disabled={pending} aria-busy={pending}>
      {pending ? <span className="spin" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}

// The PDF goes from the browser straight to Storage with a signed upload URL (Vercel
// caps request bodies at 4.5 MB); the server then checks and ingests it.
function PdfUploadForm({ notebookId }: { notebookId: string }) {
  const router = useRouter();
  const dialog = useDialog();
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The chosen file's name in full: the native field would cut a long name down to "…".
  const [fileName, setFileName] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const file = (form.elements.namedItem("file") as HTMLInputElement).files?.[0];
    const title = (form.elements.namedItem("title") as HTMLInputElement).value;
    if (!file) return;
    setBusy(true);
    setMessage(null);
    try {
      const created = await createPdfUploadAction({ notebookId, title, size: file.size, type: file.type });
      if (!created.ok) {
        setMessage(notebookErrorMessage(created.error));
        return;
      }
      // A network error rejects instead of answering; both count as a failed upload.
      const uploaded = await fetch(created.signedUrl, {
        method: "PUT",
        headers: { "content-type": "application/pdf" },
        body: file,
      }).then(
        (r) => r.ok,
        () => false,
      );
      // Nothing reached Storage. Ingestion still runs once: it finds no file and marks the
      // source failed (upload_missing), so the row does not keep waiting; only if that call
      // fails too does it stay pending. The dialog stays open with the message; the failed
      // row can be removed from the list.
      if (!uploaded) {
        setMessage("Das Hochladen hat nicht geklappt.");
        await ingestSourceAction({ notebookId, sourceId: created.sourceId }).catch(() => undefined);
        router.refresh();
        return;
      }
      await ingestSourceAction({ notebookId, sourceId: created.sourceId });
      form.reset();
      setFileName(null);
      dialog?.close();
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit}>
      <label className="file">
        PDF-Datei{" "}
        <input
          type="file"
          name="file"
          accept="application/pdf"
          required
          onChange={(e) => setFileName(e.currentTarget.files?.[0]?.name ?? null)}
        />
      </label>{" "}
      {fileName ? <p className="file-name">{fileName}</p> : null}
      <label>
        Titel <input type="text" name="title" required maxLength={200} />
      </label>{" "}
      <button type="submit" className="primary" disabled={busy} aria-busy={busy}>
        {busy ? <span className="spin" aria-hidden="true" /> : null}
        Hochladen
      </button>
      {message ? <p role="alert">{message}</p> : null}
    </form>
  );
}

const KINDS = [
  { id: "text", label: "Text" },
  { id: "pdf", label: "PDF" },
  { id: "url", label: "Webseite" },
] as const;
type Kind = (typeof KINDS)[number]["id"];

// One form at a time behind a tab switcher (WAI-ARIA tabs: arrow keys move between tabs).
function AddSourceForms({ notebookId }: { notebookId: string }) {
  const [kind, setKind] = useState<Kind>("text");
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>, index: number) {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = (index + step + KINDS.length) % KINDS.length;
    setKind(KINDS[next]!.id);
    tabs.current[next]?.focus();
  }

  return (
    <div className="add-source">
      <div role="tablist" aria-label="Art der Quelle" className="tabs">
        {KINDS.map((k, i) => (
          <button
            key={k.id}
            ref={(el) => {
              tabs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`tab-${k.id}`}
            aria-selected={kind === k.id}
            aria-controls={`panel-${k.id}`}
            tabIndex={kind === k.id ? 0 : -1}
            onClick={() => setKind(k.id)}
            onKeyDown={(e) => onKeyDown(e, i)}
          >
            {k.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id="panel-text" aria-labelledby="tab-text" hidden={kind !== "text"}>
        <form action={addTextSourceAction}>
          <input type="hidden" name="notebookId" value={notebookId} />
          <label>
            Titel <input type="text" name="title" required maxLength={200} />
          </label>{" "}
          <label>
            Text <textarea name="text" required maxLength={MAX_TEXT_CHARS} />
          </label>{" "}
          <SubmitButton>Text hinzufügen</SubmitButton>
        </form>
      </div>
      <div role="tabpanel" id="panel-pdf" aria-labelledby="tab-pdf" hidden={kind !== "pdf"}>
        <PdfUploadForm notebookId={notebookId} />
      </div>
      <div role="tabpanel" id="panel-url" aria-labelledby="tab-url" hidden={kind !== "url"}>
        <form action={addUrlSourceAction}>
          <input type="hidden" name="notebookId" value={notebookId} />
          <label>
            Titel <input type="text" name="title" required maxLength={200} />
          </label>{" "}
          <label>
            Webadresse <input type="url" name="url" required maxLength={MAX_URL_LENGTH} />
          </label>{" "}
          <SubmitButton>Seite hinzufügen</SubmitButton>
        </form>
      </div>
    </div>
  );
}

export function AddSource({ notebookId }: { notebookId: string }) {
  return (
    <ModalDialog trigger="Quelle hinzufügen" triggerClassName="small" title="Quelle hinzufügen" wide>
      <AddSourceForms notebookId={notebookId} />
    </ModalDialog>
  );
}
