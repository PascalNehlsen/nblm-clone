// Fixed messages for database errors. The raw error text is never shown or logged.
const MESSAGES: Record<string, string> = {
  "42501": "Dafür hast du keine Berechtigung.",
  "23503": "Diese Nutzer-ID ist unbekannt.",
  "23505": "Diese Person ist schon Mitglied.",
  P0001: "Ein Notizbuch braucht mindestens einen Eigentümer.",
  titel: "Bitte gib einen Titel mit 1 bis 200 Zeichen ein.",
  eingabe: "Bitte gib eine gültige Nutzer-ID und eine Rolle an.",
  bestaetigung: "Bitte bestätige, dass du das Notizbuch endgültig löschen möchtest.",
};

const GENERIC = "Das hat nicht geklappt. Bitte versuche es noch einmal.";

export function notebookErrorMessage(code: unknown): string {
  if (typeof code !== "string") return GENERIC;
  return Object.hasOwn(MESSAGES, code) ? (MESSAGES[code] ?? GENERIC) : GENERIC;
}
