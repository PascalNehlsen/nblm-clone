import { signInWithGitHub } from "@/app/auth/actions";
import { DemoButton } from "./demo-button";
import { GitHubButton } from "./github-button";
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
      <div className="constellation" aria-hidden="true">
        {[0, 1, 2, 3, 5, 6].map((hue, i) => (
          <span key={hue} className={`floater f${i}`} data-hue={hue}>
            <i />
            <i />
            <i />
          </span>
        ))}
      </div>
      <div className="login-hero">
        <p className="statement">
          Frag deine Quellen. <em>Jede Antwort zeigt, wo es steht.</em>
        </p>
        <p className="lede">
          Lade Texte, PDFs oder Webseiten hoch und stell Fragen dazu. Jede Aussage trägt die Farbe ihrer
          Quelle, ein Klick zeigt die markierte Fundstelle im Original.
        </p>
        <p className="sr-only">Beispiel: eine Aussage mit Beleg und der markierten Fundstelle aus der Quelle.</p>
        <div className="specimen" data-hue="0" data-tilt="5" aria-hidden="true">
          <p className="q">Womit lockte die Hexe Hänsel und Gretel an?</p>
          <p className="a">
            Mit einem Häuschen aus Brot
            <span className="ref">1</span>.
          </p>
          <p className="passage-line">
            … sahen sie, daß <mark>das Häuslein aus Brot gebaut war</mark> und mit Kuchen gedeckt …
          </p>
        </div>
      </div>
      <div className="login-card" data-tilt="3">
        <h1>Anmelden</h1>
        {message ? <p role="status">{message}</p> : null}
        <form action={signInWithGitHub}>
          <input type="hidden" name="next" value={next} />
          <GitHubButton />
        </form>
        <p className="divider">oder ohne Konto</p>
        <DemoButton siteKey={process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? null} />
      </div>
    </main>
  );
}
