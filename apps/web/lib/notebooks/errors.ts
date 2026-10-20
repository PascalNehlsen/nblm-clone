// Fixed messages for database errors. The raw error text is never shown or logged.
const MESSAGES: Record<string, string> = {
  "42501": "Dafür hast du keine Berechtigung.",
  "23503": "Diese Nutzer-ID ist unbekannt.",
  "23505": "Diese Person ist schon Mitglied.",
  P0001: "Ein Notizbuch braucht mindestens einen Eigentümer.",
  titel: "Bitte gib einen Titel mit 1 bis 200 Zeichen ein.",
  eingabe: "Bitte gib eine gültige Nutzer-ID und eine Rolle an.",
  bestaetigung: "Bitte bestätige, dass du das Notizbuch endgültig löschen möchtest.",
  bestaetigung_quelle: "Bitte bestätige, dass du die Quelle entfernen möchtest.",
  bestaetigung_mitglied: "Bitte bestätige, dass du das Mitglied entfernen möchtest.",
  nicht_erlaubt: "Dafür hast du keine Berechtigung.",
  text: "Bitte füge einen Text mit 1 bis 100.000 Zeichen ein.",
  limit: "Dieses Notizbuch hat schon 50 Quellen.",
  groesse: "Die Datei ist leer oder größer als 20 MB.",
  typ: "Bitte wähle eine PDF-Datei.",
  dateien_uebrig: "Die Datei der Quelle konnte nicht entfernt werden.",
  loeschen: "Die Quelle konnte nicht gelöscht werden.",
  url: "Bitte gib eine http- oder https-Adresse ohne Zugangsdaten und ohne Port an.",
  youtube: "YouTube-Videos werden noch nicht unterstützt. Füge stattdessen den Text oder ein Transkript ein.",
};

const GENERIC = "Das hat nicht geklappt. Bitte versuche es noch einmal.";

export function notebookErrorMessage(code: unknown): string {
  if (typeof code !== "string") return GENERIC;
  return Object.hasOwn(MESSAGES, code) ? (MESSAGES[code] ?? GENERIC) : GENERIC;
}
