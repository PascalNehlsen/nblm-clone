"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

// Errors in the root layout replace the whole document, so this page brings its own html and
// body. German text, no error details; the error goes to Sentry (scrubbed, ADR 0022).
export default function GlobalError({ error, reset }: { error: Error; reset: () => void }) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);
  return (
    <html lang="de">
      <body>
        <main id="inhalt">
          <h1>Da ist etwas schiefgelaufen</h1>
          <p>Bitte lade die Seite neu.</p>
          <button type="button" onClick={reset}>
            Erneut versuchen
          </button>
        </main>
      </body>
    </html>
  );
}
