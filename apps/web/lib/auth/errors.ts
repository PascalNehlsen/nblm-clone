// Fixed messages for the `fehler` parameter on /login. The parameter is never echoed:
// unknown values show nothing.
const MESSAGES: Record<string, string> = {
  anmeldung: "Die Anmeldung hat nicht geklappt. Bitte versuche es noch einmal.",
  abgemeldet: "Du bist abgemeldet.",
  demo_nicht_verfuegbar: "Die Demo ist gerade nicht verfügbar.",
  demo_voll: "Die Demo ist gerade ausgelastet. Bitte versuche es später noch einmal.",
  sicherheitspruefung: "Die Sicherheitsprüfung ist fehlgeschlagen. Bitte versuche es noch einmal.",
};

export function loginErrorMessage(code: unknown): string | null {
  if (typeof code !== "string") return null;
  return Object.hasOwn(MESSAGES, code) ? (MESSAGES[code] ?? null) : null;
}
