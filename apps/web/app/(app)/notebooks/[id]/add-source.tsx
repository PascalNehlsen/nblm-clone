"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { addTextSourceAction, addUrlSourceAction, createPdfUploadAction, ingestSourceAction } from "./sources/actions";
import { notebookErrorMessage } from "@/lib/notebooks/errors";
import { MAX_TEXT_CHARS, MAX_URL_LENGTH } from "@/lib/sources/limits";

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
      <label className="file">
        PDF-Datei <input type="file" name="file" accept="application/pdf" required />
      </label>{" "}
      <label>
        Titel <input type="text" name="title" required maxLength={200} />
      </label>{" "}
      <button type="submit" className="primary" disabled={busy}>
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
export function AddSource({ notebookId }: { notebookId: string }) {
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
      <h3>Quelle hinzufügen</h3>
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
          <button type="submit" className="primary">
            Text hinzufügen
          </button>
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
          <button type="submit" className="primary">
            Seite hinzufügen
          </button>
        </form>
      </div>
    </div>
  );
}
