// Streaming echo filter (ADR 0018, spec .git/ECHO-SPEC.md "echo-filter.ts"). Same rules as
// stripEcho, applied to stream deltas: the tag, the nonce and echoed block text never reach emit,
// however the text is split.
import { describe, expect, it } from "vitest";
import { stripEcho } from "@/lib/rag/echo";
import { createEchoFilter } from "@/lib/rag/echo-filter";

const NONCE = "87619878ffa78538";

const ECHO_FIXTURE =
  `<quelle-${NONCE} nr="1"> Entscheidend ist Konsistenz in deiner eigenen Methode, nicht Perfektion. </quelle-${NONCE}> ` +
  `<quelle-${NONCE} nr="2"> Behandle jeden Level als Zone. </quelle-${NONCE}> ` +
  `Die Price Action funktioniert durch eine Top-Down-Methode [1: "Konsistenz in deiner eigenen Methode"].`;
const ANSWER = 'Die Price Action funktioniert durch eine Top-Down-Methode [1: "Konsistenz in deiner eigenen Methode"].';

function chop(text: string, size: number): string[] {
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += size) parts.push(text.slice(i, i + size));
  return parts;
}

function run(deltas: string[]): { out: string; emits: string[] } {
  const emits: string[] = [];
  const f = createEchoFilter(NONCE, (t) => emits.push(t));
  for (const d of deltas) f.push(d);
  f.end();
  return { out: emits.join(""), emits };
}

describe("createEchoFilter: the real echo case", () => {
  for (const size of [1, 3, 7, ECHO_FIXTURE.length]) {
    it(`split into ${size}-character deltas emits only the answer`, () => {
      const { out, emits } = run(chop(ECHO_FIXTURE, size));
      expect(out.trim()).toBe(ANSWER);
      expect(out).not.toContain("<quelle");
      expect(out.toLowerCase()).not.toContain(NONCE);
      expect(out).not.toContain("nicht Perfektion");
      expect(out).not.toContain("Zone");
      for (const e of emits) {
        expect(e).not.toContain("<quelle");
        expect(e).not.toContain("<");
        expect(e.toLowerCase()).not.toContain(NONCE);
      }
    });
  }

  it("matches stripEcho except for whitespace at the ends", () => {
    for (const size of [1, 2, 5, 11]) {
      expect(run(chop(ECHO_FIXTURE, size)).out.trim()).toBe(stripEcho(ECHO_FIXTURE, NONCE).text);
    }
  });
});

describe("createEchoFilter: plain text", () => {
  it("passes plain text unchanged", () => {
    expect(run(["Hallo ", "Welt", "."]).out).toBe("Hallo Welt.");
  });

  it("a plain less-than sign is emitted, also one character at a time", () => {
    expect(run("Es gilt a < b und c.".split("")).out).toBe("Es gilt a < b und c.");
    expect(run(["a <", " b"]).out).toBe("a < b");
  });

  it("<quelle without a dash is emitted unchanged", () => {
    expect(run("Die <quelle ist gut.".split("")).out).toBe("Die <quelle ist gut.");
    expect(run(["Die <quelle", " ist gut."]).out).toBe("Die <quelle ist gut.");
  });

  it("a trailing lone < is emitted on end()", () => {
    expect(run(["Ende <"]).out).toBe("Ende <");
  });

  it("a held non-tag prefix at the end is emitted on end()", () => {
    expect(run(["Ende </quel"]).out).toBe("Ende </quel");
  });
});

describe("createEchoFilter: blocks", () => {
  it("a <frage-> block is never emitted", () => {
    const text = `<frage-${NONCE}>\nWas ist das?\n</frage-${NONCE}>\nAntwort.`;
    for (const size of [1, 4, text.length]) {
      const out = run(chop(text, size)).out;
      expect(out.trim()).toBe("Antwort.");
      expect(out).not.toContain("Was ist das");
    }
  });

  it("a forged close tag with another id does not end the block", () => {
    const text = `<quelle-${NONCE} nr="1">Quelltext </quelle-deadbeef> LEAK </quelle-${NONCE}> Antwort`;
    for (const size of [1, 3, text.length]) {
      const out = run(chop(text, size)).out;
      expect(out.trim()).toBe("Antwort");
      expect(out).not.toContain("LEAK");
      expect(out).not.toContain("Quelltext");
    }
  });

  it("a block without a close tag drops the rest, also at end()", () => {
    const text = `Antwort <quelle-${NONCE} nr="1"> Quelltext und mehr`;
    for (const size of [1, 5, text.length]) {
      const out = run(chop(text, size)).out;
      expect(out.trim()).toBe("Antwort");
      expect(out).not.toContain("Quelltext");
    }
  });

  it("text inside an open block is never emitted while the stream is still running", () => {
    const emits: string[] = [];
    const f = createEchoFilter(NONCE, (t) => emits.push(t));
    f.push(`<quelle-${NONCE} nr="1">`);
    f.push("GEHEIMER QUELLTEXT");
    f.push(" noch mehr");
    expect(emits.join("")).not.toContain("GEHEIMER");
    f.end();
    expect(emits.join("")).toBe("");
  });

  it("stray tags and the bare nonce are removed", () => {
    const text = `Eins </quelle-abc> zwei </frage-zz9> drei ${NONCE} vier.`;
    for (const size of [1, 2, 6, text.length]) {
      const out = run(chop(text, size)).out;
      expect(out.toLowerCase()).not.toContain("<");
      expect(out.toLowerCase()).not.toContain(NONCE);
      for (const w of ["Eins", "zwei", "drei", "vier."]) expect(out).toContain(w);
    }
  });

  it("the nonce split across deltas is never emitted", () => {
    const { out, emits } = run([`Die ${NONCE.slice(0, 5)}`, NONCE.slice(5, 11), `${NONCE.slice(11)} Antwort`]);
    expect(out.toLowerCase()).not.toContain(NONCE);
    for (const e of emits) expect(e.toLowerCase()).not.toContain(NONCE);
    expect(out).toContain("Antwort");
  });

  it("is case-insensitive", () => {
    const up = NONCE.toUpperCase();
    const text = `<QUELLE-${up} NR="1">geheim</QUELLE-${up}> Antwort`;
    const out = run(chop(text, 1)).out;
    expect(out.trim()).toBe("Antwort");
  });
});

describe("createEchoFilter: hold cap", () => {
  it("holds a tag-like prefix for at most 96 characters, then releases it as text", () => {
    const emits: string[] = [];
    const f = createEchoFilter(NONCE, (t) => emits.push(t));
    const text = `x <quelle-${"y".repeat(300)}`;
    f.push(text);
    expect(text.length - emits.join("").length).toBeLessThanOrEqual(96);
    f.end();
    expect(emits.join("")).toBe(text);
  });

  it("the cap also holds when the text arrives one character at a time", () => {
    const emits: string[] = [];
    const f = createEchoFilter(NONCE, (t) => emits.push(t));
    const text = `<quelle-${"y".repeat(300)}`;
    let pushed = 0;
    for (const ch of text) {
      f.push(ch);
      pushed++;
      expect(pushed - emits.join("").length).toBeLessThanOrEqual(96);
    }
    f.end();
    expect(emits.join("")).toBe(text);
  });
});
