// D3 turn reducer (spec .git/D3-FIX-SPEC.md "turn-state.ts").
import { describe, expect, it } from "vitest";
import {
  BROKEN_LABEL,
  CLIENT_DEADLINE_MS,
  FAILED_LABEL,
  INITIAL_TURN,
  turnReducer,
  type CheckedAnswer,
  type TurnEvent,
  type TurnState,
} from "@/lib/chat/turn-state";

const ANSWER: CheckedAnswer = {
  id: "m1",
  content: "Antwort",
  citations: [{ ordinal: 1, chunkId: "c1", quote: "q" }],
  abstained: false,
};

function apply(events: TurnEvent[], from: TurnState = INITIAL_TURN): TurnState {
  return events.reduce(turnReducer, from);
}

const busy = () => apply([{ type: "submit", question: "Was ist das?" }]);
const done = () => apply([{ type: "submit", question: "Was ist das?" }, { type: "delta", text: "Ant" }, { type: "done", message: ANSWER }]);

describe("constants", () => {
  it("has the fixed labels", () => {
    expect(BROKEN_LABEL).toBe("Die Antwort wurde unterbrochen. Bitte versuche es noch einmal.");
    expect(FAILED_LABEL).toBe("Das hat nicht geklappt. Bitte versuche es noch einmal.");
  });

  it("sets the client deadline to 190000 ms, above the server maxDuration of 180 s", () => {
    expect(CLIENT_DEADLINE_MS).toBe(190_000);
    expect(CLIENT_DEADLINE_MS).toBeGreaterThan(180 * 1000);
  });

  it("starts idle and empty", () => {
    expect(INITIAL_TURN).toEqual({ busy: false, asked: null, pending: "", checked: null, alert: null });
  });
});

describe("submit", () => {
  it("starts a turn with the trimmed question", () => {
    expect(busy()).toEqual({ busy: true, asked: "Was ist das?", pending: "", checked: null, alert: null });
    expect(apply([{ type: "submit", question: "  Hallo  " }]).asked).toBe("Hallo");
  });

  it("is ignored while busy and returns the same object", () => {
    const s = busy();
    expect(turnReducer(s, { type: "submit", question: "Andere Frage" })).toBe(s);
  });

  it("ignores an empty or whitespace question", () => {
    expect(turnReducer(INITIAL_TURN, { type: "submit", question: "" })).toBe(INITIAL_TURN);
    expect(turnReducer(INITIAL_TURN, { type: "submit", question: "   \n " })).toBe(INITIAL_TURN);
  });

  it("clears the previous checked answer, pending text and alert", () => {
    const failed = apply([{ type: "submit", question: "a" }, { type: "failed" }]);
    expect(failed.alert).toBe(FAILED_LABEL);
    const next = turnReducer(failed, { type: "submit", question: "b" });
    expect(next).toEqual({ busy: true, asked: "b", pending: "", checked: null, alert: null });
    const afterDone = turnReducer(done(), { type: "submit", question: "c" });
    expect(afterDone.checked).toBeNull();
    expect(afterDone.asked).toBe("c");
  });
});

describe("delta", () => {
  it("appends to pending while busy", () => {
    const s = apply([{ type: "submit", question: "q" }, { type: "delta", text: "Hal" }, { type: "delta", text: "lo" }]);
    expect(s.pending).toBe("Hallo");
    expect(s.busy).toBe(true);
  });

  it("is ignored when idle", () => {
    expect(turnReducer(INITIAL_TURN, { type: "delta", text: "x" })).toBe(INITIAL_TURN);
  });

  it("is ignored after an error", () => {
    const s = apply([{ type: "submit", question: "q" }, { type: "delta", text: "a" }, { type: "error", label: "Fehler" }]);
    expect(turnReducer(s, { type: "delta", text: "late" })).toBe(s);
    expect(s.pending).toBe("");
  });

  it("is ignored after done", () => {
    const s = done();
    expect(turnReducer(s, { type: "delta", text: "late" })).toBe(s);
  });
});

describe("done", () => {
  it("keeps the question, shows the checked answer and drops the preview", () => {
    expect(done()).toEqual({ busy: false, asked: "Was ist das?", pending: "", checked: ANSWER, alert: null });
  });

  it("is ignored when idle", () => {
    expect(turnReducer(INITIAL_TURN, { type: "done", message: ANSWER })).toBe(INITIAL_TURN);
  });
});

describe("error, broken and failed", () => {
  it("error clears pending, sets the label, keeps asked, no checked", () => {
    const s = apply([{ type: "submit", question: "q" }, { type: "delta", text: "ungeprueft" }, { type: "error", label: "Modell nicht konfiguriert" }]);
    expect(s).toEqual({ busy: false, asked: "q", pending: "", checked: null, alert: "Modell nicht konfiguriert" });
  });

  it("broken uses BROKEN_LABEL and drops unchecked text", () => {
    const s = apply([{ type: "submit", question: "q" }, { type: "delta", text: "halb" }, { type: "broken" }]);
    expect(s).toEqual({ busy: false, asked: "q", pending: "", checked: null, alert: BROKEN_LABEL });
  });

  it("failed uses FAILED_LABEL", () => {
    const s = apply([{ type: "submit", question: "q" }, { type: "failed" }]);
    expect(s).toEqual({ busy: false, asked: "q", pending: "", checked: null, alert: FAILED_LABEL });
  });

  it("are ignored when not busy", () => {
    expect(turnReducer(INITIAL_TURN, { type: "error", label: "x" })).toBe(INITIAL_TURN);
    expect(turnReducer(INITIAL_TURN, { type: "broken" })).toBe(INITIAL_TURN);
    expect(turnReducer(INITIAL_TURN, { type: "failed" })).toBe(INITIAL_TURN);
    const d = done();
    expect(turnReducer(d, { type: "broken" })).toBe(d);
    expect(turnReducer(d, { type: "failed" })).toBe(d);
    expect(turnReducer(d, { type: "error", label: "x" })).toBe(d);
  });

  it("a second broken after the first is ignored", () => {
    const s = apply([{ type: "submit", question: "q" }, { type: "broken" }]);
    expect(turnReducer(s, { type: "broken" })).toBe(s);
  });
});

describe("history", () => {
  it("clears checked and asked when the ids contain the checked id", () => {
    const s = turnReducer(done(), { type: "history", ids: ["m0", "m1"] });
    expect(s).toEqual({ busy: false, asked: null, pending: "", checked: null, alert: null });
  });

  it("changes nothing for other ids (same object)", () => {
    const s = done();
    expect(turnReducer(s, { type: "history", ids: ["m0", "m2"] })).toBe(s);
    expect(turnReducer(s, { type: "history", ids: [] })).toBe(s);
  });

  it("changes nothing without a checked answer (same object)", () => {
    expect(turnReducer(INITIAL_TURN, { type: "history", ids: ["m1"] })).toBe(INITIAL_TURN);
    const b = busy();
    expect(turnReducer(b, { type: "history", ids: ["m1"] })).toBe(b);
    const failed = apply([{ type: "submit", question: "q" }, { type: "failed" }]);
    expect(turnReducer(failed, { type: "history", ids: ["m1"] })).toBe(failed);
  });

  it("keeps the alert of an unfinished turn", () => {
    const failed = apply([{ type: "submit", question: "q" }, { type: "broken" }]);
    const s = turnReducer(failed, { type: "history", ids: ["x"] });
    expect(s.asked).toBe("q");
    expect(s.alert).toBe(BROKEN_LABEL);
  });

  it("applies while busy without disturbing the running turn", () => {
    const s = apply([{ type: "submit", question: "q" }, { type: "delta", text: "a" }]);
    expect(turnReducer(s, { type: "history", ids: ["m1"] })).toBe(s);
  });
});
