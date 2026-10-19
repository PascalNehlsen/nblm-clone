export const metadata = { title: "Datenschutzerklärung" };

// Based on docs/privacy.md (processors, data, retention). Keep both in sync.
export default function DatenschutzPage() {
  return (
    <main id="inhalt" className="page legal">
      <h1>Datenschutzerklärung</h1>
      <p>Stand: 20. Oktober 2026</p>

      <h2>1. Verantwortlicher</h2>
      <p>
        Pascal Nehlsen, Am Stadtwald 18, 42897 Remscheid, E-Mail:{" "}
        <a href="mailto:mail@software-mit-pascal.de">mail@software-mit-pascal.de</a>. Diese Anwendung ist ein nicht
        kommerzielles Demonstrationsprojekt im Rahmen einer Bewerbung.
      </p>

      <h2>2. Welche Daten wir verarbeiten und warum</h2>
      <h3>Aufruf der Website</h3>
      <p>
        Beim Aufruf verarbeitet unser Hosting-Anbieter technisch notwendige Daten wie IP-Adresse, Zeitpunkt und
        angefragte Adresse, um die Seiten auszuliefern und die Sicherheit zu gewährleisten (Art. 6 Abs. 1 lit. f DSGVO).
        Wir setzen keine Analyse- oder Tracking-Werkzeuge ein und binden keine externen Schriften, Bilder oder
        Werbung ein.
      </p>
      <h3>Anmeldung mit GitHub</h3>
      <p>
        Wenn du dich mit GitHub anmeldest, erhalten wir von GitHub deine GitHub-Nutzerkennung, deinen Namen, die Adresse
        deines Profilbilds und deine E-Mail-Adresse. Wir nutzen sie, um dein Konto zu führen (Art. 6 Abs. 1 lit. b
        DSGVO). Für die Sitzung setzen wir ein technisch notwendiges Anmelde-Cookie; weitere Cookies verwenden wir nicht.
      </p>
      <h3>Demo ohne Anmeldung</h3>
      <p>
        Beim Klick auf „Demo starten“ legen wir ein anonymes Demo-Konto mit einer Kopie der Beispielquellen an. Demo-Konten
        und alles, was darin entsteht, löschen wir automatisch nach 24 Stunden. Vor dem Start prüft Cloudflare Turnstile,
        ob ein Mensch die Demo startet (Art. 6 Abs. 1 lit. f DSGVO, Schutz vor Missbrauch). Das Turnstile-Skript wird erst
        nach dem Klick geladen; Cloudflare erhält dabei IP-Adresse und technische Browsermerkmale.
      </p>
      <h3>Quellen, Fragen und Antworten</h3>
      <p>
        Wir speichern die Quellen, die du hinzufügst (Texte, PDF-Dateien, von dir genannte Webseiten), daraus gebildete
        Textabschnitte samt Vektoren für die Suche, deine Fragen, die Antworten und die Zitate (Art. 6 Abs. 1 lit. b
        DSGVO). Zum Beantworten werden Frage und passende Textabschnitte an ein Sprachmodell in der EU gesendet. Pro
        Anfrage speichern wir Verbrauchsdaten (Modell, Anzahl der Token, Kosten, Dauer, Status), aber keine Texte, um
        Kosten zu begrenzen und Missbrauch zu verhindern (Art. 6 Abs. 1 lit. f DSGVO). Inhalte von Fragen, Quellen und
        Antworten schreiben wir nicht in Protokolle.
      </p>
      <h3>Freigaben</h3>
      <p>
        Wenn du ein Notizbuch teilst, protokollieren wir, wer wessen Rolle wann geändert hat (Art. 6 Abs. 1 lit. f DSGVO,
        Nachvollziehbarkeit).
      </p>

      <h2>3. Empfänger und Auftragsverarbeiter</h2>
      <ul>
        <li>
          <strong>Supabase</strong> (Datenbank, Anmeldung, Dateiablage), Rechenzentrum in Frankfurt am Main.
        </li>
        <li>
          <strong>Amazon Web Services</strong> (Amazon Bedrock, Sprachmodell und Vektoren), ausschließlich in
          EU-Regionen.
        </li>
        <li>
          <strong>Vercel</strong> (Hosting der Anwendung), Server-Funktionen in Frankfurt am Main; Auslieferung über ein
          weltweites Netzwerk.
        </li>
        <li>
          <strong>GitHub</strong> (Anmeldung), nur wenn du dich mit GitHub anmeldest; Sitz in den USA.
        </li>
        <li>
          <strong>Cloudflare Turnstile</strong> (Schutz der Demo), nur wenn du die Demo startest; Sitz in den USA.
        </li>
      </ul>
      <p>
        Für Übermittlungen in die USA stützen sich die Anbieter auf den Angemessenheitsbeschluss der EU-Kommission zum
        EU-US Data Privacy Framework beziehungsweise auf Standardvertragsklauseln. Webseiten, die du als Quelle angibst,
        rufen wir von unserem Server aus ab; sie erhalten dabei keine Daten über dich.
      </p>

      <h2>4. Speicherdauer</h2>
      <ul>
        <li>Demo-Konten mit allen Inhalten: 24 Stunden.</li>
        <li>Quellen, Abschnitte, Fragen und Antworten: bis du sie, das Notizbuch oder dein Konto löschst.</li>
        <li>Protokoll der Rollenänderungen: 90 Tage.</li>
        <li>Verbrauchsdaten: 90 Tage mit Bezug zu Konto und Notizbuch, danach ohne diesen Bezug.</li>
        <li>Datenbanksicherungen können gelöschte Inhalte bis zum Ende ihrer Aufbewahrungsfrist enthalten.</li>
      </ul>

      <h2>5. Deine Rechte</h2>
      <p>
        Du hast das Recht auf Auskunft, Berichtigung, Löschung, Einschränkung der Verarbeitung, Datenübertragbarkeit und
        Widerspruch gegen Verarbeitungen auf Grundlage berechtigter Interessen (Art. 15 bis 21 DSGVO). Quellen,
        Notizbücher und Freigaben kannst du in der Anwendung selbst löschen. Um dein Konto vollständig löschen zu lassen,
        schreib eine E-Mail an <a href="mailto:mail@software-mit-pascal.de">mail@software-mit-pascal.de</a>.
      </p>
      <p>
        Du kannst dich bei einer Datenschutz-Aufsichtsbehörde beschweren. Für uns zuständig ist: Landesbeauftragte für
        Datenschutz und Informationsfreiheit Nordrhein-Westfalen, Kavalleriestraße 2 bis 4, 40213 Düsseldorf.
      </p>

      <h2>6. Pflicht zur Bereitstellung</h2>
      <p>
        Die Nutzung ist freiwillig. Ohne Anmeldung oder Demo-Start kannst du die Anwendung nicht nutzen. Eine
        automatisierte Entscheidungsfindung im Sinne von Art. 22 DSGVO findet nicht statt.
      </p>
    </main>
  );
}
