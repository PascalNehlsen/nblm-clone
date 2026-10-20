import Link from "next/link";

export const metadata = { title: "Seite nicht gefunden" };

// Also shown for notebooks the user cannot see (RLS returns nothing, the page calls notFound()).
export default function NotFound() {
  return (
    <main id="inhalt" className="page notfound">
      <h1>Seite nicht gefunden</h1>
      <p>
        Diese Seite gibt es nicht, oder du hast keinen Zugriff darauf. Vielleicht wurde das Notizbuch gelöscht oder
        nicht mit dir geteilt.
      </p>
      <Link href="/" className="button primary">
        Zu deinen Notizbüchern
      </Link>
    </main>
  );
}
