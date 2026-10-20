"use client";

import { useFormStatus } from "react-dom";

// The GitHub sign-in can take a moment (redirects to GitHub and back): say so right away.
export function GitHubButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="primary" disabled={pending} aria-busy={pending}>
      {pending ? (
        <>
          <span className="spin" aria-hidden="true" />
          Anmeldung läuft …
        </>
      ) : (
        <>
          <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="currentColor">
            <path d="M12 2a10 10 0 0 0-3.2 19.5c.5.1.7-.2.7-.5v-1.7c-2.8.6-3.4-1.3-3.4-1.3-.4-1.2-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 .1 1.5 1 1.5 1 .9 1.5 2.3 1.1 2.9.8.1-.6.3-1.1.6-1.3-2.2-.3-4.6-1.1-4.6-5a3.9 3.9 0 0 1 1-2.7c-.1-.3-.4-1.3.1-2.7 0 0 .8-.3 2.7 1a9.4 9.4 0 0 1 5 0c1.9-1.3 2.7-1 2.7-1 .5 1.4.2 2.4.1 2.7a3.9 3.9 0 0 1 1 2.7c0 3.9-2.4 4.7-4.6 5 .4.3.7.9.7 1.9V21c0 .3.2.6.7.5A10 10 0 0 0 12 2z" />
          </svg>
          Mit GitHub anmelden
        </>
      )}
    </button>
  );
}
