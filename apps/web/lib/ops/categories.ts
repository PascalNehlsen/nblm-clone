// Fixed error categories for model calls. They are stored in private.usage.error_category
// (check ^[a-z_]{1,40}$) and logged; the labels are for the ops page.
export const MODEL_ERROR_CATEGORIES = [
  "unauthenticated",
  "model_not_configured",
  "price_unknown",
  "kill_switch_on",
  "budget_exceeded",
  "global_budget_exceeded",
  "budget_unavailable",
  "provider_timeout",
  "provider_throttled",
  "provider_error",
  "provider_invalid_response",
  "message_link_failed",
  "settle_failed",
] as const;

export type ModelErrorCategory = (typeof MODEL_ERROR_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<ModelErrorCategory, string> = {
  unauthenticated: "Nicht angemeldet",
  model_not_configured: "Modell nicht konfiguriert",
  price_unknown: "Preis für das Modell unbekannt",
  kill_switch_on: "Modellfunktionen abgeschaltet",
  budget_exceeded: "Tagesbudget des Nutzers erreicht",
  global_budget_exceeded: "Globales Tagesbudget erreicht",
  budget_unavailable: "Budgetprüfung nicht erreichbar",
  provider_timeout: "Zeitüberschreitung beim Modellanbieter",
  provider_throttled: "Modellanbieter drosselt Anfragen",
  provider_error: "Fehler beim Modellanbieter",
  provider_invalid_response: "Ungültige Antwort des Modellanbieters",
  message_link_failed: "Nachricht konnte nicht verknüpft werden",
  settle_failed: "Verbrauch konnte nicht abgerechnet werden",
};
