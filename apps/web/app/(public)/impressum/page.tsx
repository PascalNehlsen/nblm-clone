export const metadata = { title: "Impressum" };

export default function ImpressumPage() {
  return (
    <main id="inhalt" className="page legal">
      <h1>Impressum</h1>
      <h2>Angaben gemäß § 5 DDG</h2>
      <p>
        Pascal Nehlsen
        <br />
        Am Stadtwald 18
        <br />
        42897 Remscheid
      </p>
      <h2>Kontakt</h2>
      <p>
        E-Mail: <a href="mailto:mail@software-mit-pascal.de">mail@software-mit-pascal.de</a>
      </p>
      <h2>Zweck dieser Website</h2>
      <p>
        Diese Anwendung ist ein nicht kommerzielles Demonstrationsprojekt im Rahmen einer Bewerbung. Sie zeigt, wie sich
        Fragen zu eigenen Quellen mit belegten Zitaten beantworten lassen.
      </p>
      <h2>Verantwortlich für den Inhalt</h2>
      <p>Pascal Nehlsen, Anschrift wie oben.</p>
      <h2>Haftung für Inhalte</h2>
      <p>
        Antworten in der Anwendung werden automatisch von einem Sprachmodell erzeugt und auf die hochgeladenen Quellen
        gestützt. Sie können Fehler enthalten und ersetzen keine fachliche Prüfung. Für Inhalte, die Nutzerinnen und
        Nutzer selbst hochladen, sind diese selbst verantwortlich.
      </p>
    </main>
  );
}
