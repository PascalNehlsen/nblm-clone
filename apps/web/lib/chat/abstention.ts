// The two fixed sentences that replace an answer (ADR 0011, ADR 0026). Client-safe: the chat
// UI compares stored content against UNGROUNDED to explain why the streamed text went away.

export const ABSTENTION = "Dazu finde ich in den Quellen keine Antwort.";
export const UNGROUNDED = "Ich konnte keine Antwort mit wörtlichen Zitaten aus den Quellen belegen.";

/** Why an answer was replaced by a fixed sentence; null for a cited answer. */
export type Abstention = null | "no_sources" | "model" | "no_marker" | "dropped";
