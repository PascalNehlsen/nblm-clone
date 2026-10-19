"use client";

import { useId, useRef, type ReactNode } from "react";

// A button that asks in a modal dialog before it submits a destructive server action. The
// hidden confirm field is checked by the action, so a request without it is refused; the
// dialog is the confirmation, the field only proves the request came from this form.
export function ConfirmAction({
  action,
  fields,
  trigger,
  triggerClassName = "quiet",
  title,
  children,
  confirmLabel,
}: {
  action: (formData: FormData) => Promise<void>;
  fields: Record<string, string>;
  trigger: string;
  triggerClassName?: string;
  title: string;
  children: ReactNode;
  confirmLabel: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  return (
    <>
      <button type="button" className={triggerClassName} onClick={() => dialog.current?.showModal()}>
        {trigger}
      </button>
      <dialog ref={dialog} className="confirm" aria-labelledby={`${id}-t`} aria-describedby={`${id}-d`}>
        <h2 id={`${id}-t`}>{title}</h2>
        <p id={`${id}-d`}>{children}</p>
        <form action={action}>
          {Object.entries(fields).map(([name, value]) => (
            <input key={name} type="hidden" name={name} value={value} />
          ))}
          <input type="hidden" name="confirm" value="on" />
          <div className="actions">
            <button type="button" className="quiet" onClick={() => dialog.current?.close()}>
              Abbrechen
            </button>
            <button type="submit" className="danger solid">
              {confirmLabel}
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}
