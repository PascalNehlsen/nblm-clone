import { signInWithGitHub } from "@/app/auth/actions";
import { DemoButton } from "./demo-button";
import { loginErrorMessage } from "@/lib/auth/errors";
import { safeNextPath } from "@/lib/auth/redirect";

export const metadata = { title: "Anmelden" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const message = loginErrorMessage(params.fehler);
  const next = safeNextPath(params.next);

  return (
    <main id="inhalt" className="login">
      <div className="login-hero">
        <p className="eyebrow">Dein Lesesaal für Quellen</p>
        <p className="statement">
          Frag deine Quellen. <em>Jede Antwort zeigt, wo es steht.</em>
        </p>
        <p className="lede">
          Lade Texte, PDFs oder Webseiten hoch und stell Fragen dazu. Jede Aussage trägt die Farbe ihrer
          Quelle, ein Klick zeigt die markierte Fundstelle im Original.
        </p>
        <p className="sr-only">Beispiel: eine Aussage mit Beleg und der markierten Fundstelle aus der Quelle.</p>
        <div className="specimen" data-hue="0" aria-hidden="true">
          <p>
            Die Hexe lockte die Kinder mit einem Häuschen aus Brot
            <span className="ref">1</span>.
          </p>
          <p className="passage-line">… sahen sie, daß das Häuslein aus Brot gebaut war und mit Kuchen gedeckt …</p>
        </div>
      </div>
      <div className="login-card">
        <h1>Anmelden</h1>
        {message ? <p role="status">{message}</p> : null}
        <form action={signInWithGitHub}>
          <input type="hidden" name="next" value={next} />
          <button type="submit" className="primary">
            <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="currentColor">
              <path d="M12 2a10 10 0 0 0-3.2 19.5c.5.1.7-.2.7-.5v-1.7c-2.8.6-3.4-1.3-3.4-1.3-.4-1.2-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 .1 1.5 1 1.5 1 .9 1.5 2.3 1.1 2.9.8.1-.6.3-1.1.6-1.3-2.2-.3-4.6-1.1-4.6-5a3.9 3.9 0 0 1 1-2.7c-.1-.3-.4-1.3.1-2.7 0 0 .8-.3 2.7 1a9.4 9.4 0 0 1 5 0c1.9-1.3 2.7-1 2.7-1 .5 1.4.2 2.4.1 2.7a3.9 3.9 0 0 1 1 2.7c0 3.9-2.4 4.7-4.6 5 .4.3.7.9.7 1.9V21c0 .3.2.6.7.5A10 10 0 0 0 12 2z" />
            </svg>
            Mit GitHub anmelden
          </button>
        </form>
        <p className="divider">oder ohne Konto</p>
        <DemoButton siteKey={process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? null} />
      </div>
    </main>
  );
}
