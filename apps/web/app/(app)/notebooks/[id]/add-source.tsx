"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { addTextSourceAction, createPdfUploadAction, ingestSourceAction } from "./sources/actions";
import { notebookErrorMessage } from "@/lib/notebooks/errors";
import { MAX_TEXT_CHARS } from "@/lib/sources/limits";

// The PDF goes from the browser straight to Storage with a signed upload URL (Vercel
// caps request bodies at 4.5 MB); the server then checks and ingests it.
function PdfUploadForm({ notebookId }: { notebookId: string }) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
      const upload = await fetch(created.signedUrl, {
        method: "PUT",
        headers: { "content-type": "application/pdf" },
        body: file,
      });
      if (!upload.ok) setMessage("Das Hochladen hat nicht geklappt.");
      await ingestSourceAction({ notebookId, sourceId: created.sourceId });
      form.reset();
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit}>
      <label>
        PDF-Datei <input type="file" name="file" accept="application/pdf" required />
      </label>{" "}
      <label>
        Titel <input type="text" name="title" required maxLength={200} />
      </label>{" "}
      <button type="submit" disabled={busy}>
        Hochladen
      </button>
      {message ? <p role="alert">{message}</p> : null}
    </form>
  );
}

export function AddSource({ notebookId }: { notebookId: string }) {
  return (
    <>
      <PdfUploadForm notebookId={notebookId} />
      <form action={addTextSourceAction}>
        <input type="hidden" name="notebookId" value={notebookId} />
        <label>
          Titel <input type="text" name="title" required maxLength={200} />
        </label>{" "}
        <label>
          Text <textarea name="text" required maxLength={MAX_TEXT_CHARS} />
        </label>{" "}
        <button type="submit">Text hinzufügen</button>
      </form>
    </>
  );
}
