"use client";

import { useState } from "react";

// Copies the user's own id so they can send it to a notebook owner. Imports nothing
// from the server side.
export function CopyIdButton({ value }: { value: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <>
      <button
        type="button"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setState("copied");
          } catch {
            setState("failed");
          }
        }}
      >
        {state === "copied" ? "Kopiert" : "Kopieren"}
      </button>
      {state === "failed" ? (
        <span role="status"> Kopieren nicht möglich. Bitte markiere die ID und kopiere sie selbst.</span>
      ) : null}
    </>
  );
}
