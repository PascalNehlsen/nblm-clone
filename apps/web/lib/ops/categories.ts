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

// Fixed categories for ingestion failures, stored in sources.error_category next to the
// model categories above (an embedding refusal keeps its model category).
export const INGEST_ERROR_CATEGORIES = [
  "unsupported_type",
  "file_too_large",
  "upload_missing",
  "pdf_encrypted",
  "pdf_unreadable",
  "no_text",
  "too_many_chunks",
  "notebook_chunk_limit",
  "storage_failed",
  "db_failed",
] as const;

export type IngestErrorCategory = (typeof INGEST_ERROR_CATEGORIES)[number];

export const INGEST_CATEGORY_LABELS: Record<IngestErrorCategory, string> = {
  unsupported_type: "Dateityp nicht unterstützt",
  file_too_large: "Datei zu groß",
  upload_missing: "Hochgeladene Datei fehlt",
  pdf_encrypted: "PDF ist verschlüsselt",
  pdf_unreadable: "PDF nicht lesbar",
  no_text: "Kein Text gefunden",
  too_many_chunks: "Quelle zu lang",
  notebook_chunk_limit: "Notizbuch ist voll",
  storage_failed: "Speicher nicht erreichbar",
  db_failed: "Datenbankfehler",
};

// Fixed categories for URL import failures (C2, ADR 0008), also stored in
// sources.error_category. Empty or too long page text reuses no_text and too_many_chunks.
export const URL_ERROR_CATEGORIES = [
  "url_invalid",
  "url_blocked",
  "url_dns_failed",
  "url_unreachable",
  "url_timeout",
  "url_http_error",
  "url_too_many_redirects",
  "url_too_large",
  "url_unsupported_type",
] as const;

export type UrlErrorCategory = (typeof URL_ERROR_CATEGORIES)[number];

export const URL_CATEGORY_LABELS: Record<UrlErrorCategory, string> = {
  url_invalid: "Ungültige Adresse",
  url_blocked: "Adresse nicht erlaubt",
  url_dns_failed: "Adresse nicht gefunden",
  url_unreachable: "Seite nicht erreichbar",
  url_timeout: "Zeitüberschreitung beim Abruf",
  url_http_error: "Seite antwortet mit Fehler",
  url_too_many_redirects: "Zu viele Weiterleitungen",
  url_too_large: "Seite zu groß",
  url_unsupported_type: "Seitentyp nicht unterstützt",
};

function hasLabel<K extends string>(labels: Record<K, string>, key: string): key is K {
  return Object.hasOwn(labels, key);
}

// Label for sources.error_category, which holds an ingest or a model category.
export function sourceErrorLabel(category: string | null): string {
  if (category === null) return "Unbekannter Fehler";
  if (hasLabel(INGEST_CATEGORY_LABELS, category)) return INGEST_CATEGORY_LABELS[category];
  if (hasLabel(URL_CATEGORY_LABELS, category)) return URL_CATEGORY_LABELS[category];
  if (hasLabel(CATEGORY_LABELS, category)) return CATEGORY_LABELS[category];
  return "Unbekannter Fehler";
}
