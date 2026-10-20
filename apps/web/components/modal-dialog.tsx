"use client";

import { useSearchParams } from "next/navigation";
import { createContext, useContext, useEffect, useId, useRef, type ReactNode } from "react";

// A button that opens a modal dialog with the given content. The native <dialog> traps focus,
// closes on Escape and stacks a nested dialog (a confirmation inside) on top, so Escape closes
// only the topmost one. Focus goes back to the opening button when the dialog closes.
//
// A server action that redirects can re-mount the notebook page (seen with ?fehler=), and with
// it the dialog, closed. With `reopenKey` (scoped to one notebook), a form sent from inside the
// dialog (also from a confirmation nested in it) leaves a short-lived note, so a re-mounted
// dialog opens again. The note is consumed on mount, cleared when the dialog closes, and
// expires after a minute, so it never opens a dialog later or elsewhere. An error answer
// (?fehler=) closes the dialog instead: the error is shown under the notebook title.
const REOPEN = "nblm-reopen-dialog";
const REOPEN_MS = 60_000;

function forget() {
  try {
    sessionStorage.removeItem(REOPEN);
  } catch {
    // No storage: nothing to forget.
  }
}

const DialogContext = createContext<{ close: () => void } | null>(null);

/** Lets content inside the dialog close it, e.g. after its form was sent. */
export function useDialog(): { close: () => void } | null {
  return useContext(DialogContext);
}

export function ModalDialog({
  trigger,
  triggerClassName = "quiet",
  title,
  wide = false,
  reopenKey,
  children,
}: {
  trigger: ReactNode;
  triggerClassName?: string;
  title: string;
  wide?: boolean;
  reopenKey?: string;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const id = useId();
  const close = () => dialog.current?.close();
  // Null outside the app router (unit tests render this without one).
  const failed = useSearchParams()?.has("fehler") ?? false;
  useEffect(() => {
    if (!reopenKey) return;
    let note: { key?: unknown; at?: unknown } | null = null;
    try {
      note = JSON.parse(sessionStorage.getItem(REOPEN) ?? "null");
    } catch {
      note = null;
    }
    if (!note) return;
    const fresh = typeof note.at === "number" && Date.now() - note.at < REOPEN_MS;
    if (note.key !== reopenKey && fresh) return;
    forget();
    if (note.key === reopenKey && fresh && !failed && !dialog.current?.open) dialog.current?.showModal();
  }, [reopenKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (reopenKey && failed && dialog.current?.open) dialog.current.close();
  }, [reopenKey, failed]);
  return (
    <>
      <button ref={opener} type="button" className={triggerClassName} onClick={() => dialog.current?.showModal()}>
        {trigger}
      </button>
      <dialog
        ref={dialog}
        className={wide ? "confirm wide" : "confirm"}
        aria-labelledby={`${id}-t`}
        onClose={(e) => {
          // A nested confirmation closing bubbles here too; only this dialog's own close counts.
          if (e.target !== e.currentTarget) return;
          if (reopenKey) forget();
          opener.current?.focus();
        }}
        onSubmit={() => {
          if (!reopenKey) return;
          try {
            sessionStorage.setItem(REOPEN, JSON.stringify({ key: reopenKey, at: Date.now() }));
          } catch {
            // No storage (private mode): the dialog just stays closed after the action.
          }
        }}
      >
        <div className="dialog-head">
          <h2 id={`${id}-t`}>{title}</h2>
          <button type="button" className="quiet close" onClick={close}>
            Schließen
          </button>
        </div>
        <DialogContext.Provider value={{ close }}>{children}</DialogContext.Provider>
      </dialog>
    </>
  );
}
