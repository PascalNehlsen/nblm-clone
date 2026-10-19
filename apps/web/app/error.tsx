"use client";

import Link from "next/link";

// Unexpected errors: a German page with a way to retry or go back. No error details are shown.
export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  return (
    <main id="inhalt" className="page notfound">
      <h1>Da ist etwas schiefgelaufen</h1>
      <p>Bitte versuch es noch einmal. Wenn es wieder passiert, lade die Seite neu oder geh zurück zu deinen Notizbüchern.</p>
      <p>
        <button type="button" className="primary" onClick={reset}>
          Erneut versuchen
        </button>{" "}
        <Link href="/" className="button quiet">
          Zu deinen Notizbüchern
        </Link>
      </p>
    </main>
  );
}
