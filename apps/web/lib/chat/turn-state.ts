// The state of one chat turn in the browser (block D3), as a pure reducer so the rules are
// tested without a DOM: unchecked streamed text never stays on screen, the checked answer
// stays until the server-rendered history contains it, and a running turn ignores a second
// submit. Client-safe: no secrets, no server imports.
import type { ChatCitation } from "./ndjson";

export interface CheckedAnswer {
  id: string;
  content: string;
  citations: ChatCitation[];
  abstained: boolean;
}

export interface TurnState {
  busy: boolean;
  asked: string | null;
  pending: string;
  checked: CheckedAnswer | null;
  alert: string | null;
}

export type TurnEvent =
  | { type: "submit"; question: string }
  | { type: "delta"; text: string }
  | { type: "done"; message: CheckedAnswer }
  | { type: "error"; label: string }
  | { type: "broken" }
  | { type: "failed" }
  | { type: "history"; ids: string[] };

export const INITIAL_TURN: TurnState = { busy: false, asked: null, pending: "", checked: null, alert: null };
export const BROKEN_LABEL = "Die Antwort wurde unterbrochen. Bitte versuche es noch einmal.";
export const FAILED_LABEL = "Das hat nicht geklappt. Bitte versuche es noch einmal.";
// Longer than the route's maxDuration (180 s), so the server always answers first.
export const CLIENT_DEADLINE_MS = 190_000;

function fail(state: TurnState, alert: string): TurnState {
  return { ...state, busy: false, pending: "", checked: null, alert };
}

export function turnReducer(state: TurnState, event: TurnEvent): TurnState {
  switch (event.type) {
    case "submit": {
      const question = event.question.trim();
      if (state.busy || question === "") return state;
      return { busy: true, asked: question, pending: "", checked: null, alert: null };
    }
    case "history":
      if (state.checked && event.ids.includes(state.checked.id)) {
        return { ...state, checked: null, asked: null };
      }
      return state;
    default:
      if (!state.busy) return state;
  }
  switch (event.type) {
    case "delta":
      return { ...state, pending: state.pending + event.text };
    case "done":
      return { ...state, busy: false, pending: "", checked: event.message, alert: null };
    case "error":
      return fail(state, event.label);
    case "broken":
      return fail(state, BROKEN_LABEL);
    case "failed":
      return fail(state, FAILED_LABEL);
  }
}
