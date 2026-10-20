// Streaming echo filter (ADR 0018). Same rules as
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

// Amendment 1 (ADR 0018) from here on.
const P = NONCE.slice(0, 8);
const S = NONCE.slice(8);
const I = "İ";
const A100 = "a".repeat(100);
const PAD100 = " ".repeat(100);

describe("createEchoFilter: İ (U+0130) never shifts indexes", () => {
  const cases: [string, string, string][] = [
    ["before a block", `${I}${I}${I} <quelle-${NONCE} nr="1">geheim</quelle-${NONCE}> Antwort`, `${I}${I}${I}  Antwort`],
    ["inside a block", `<quelle-${NONCE} nr="1">${I.repeat(40)} geheim</quelle-${NONCE}> Antwort`, "Antwort"],
    ["before a bare nonce", `${I.repeat(20)}${NONCE} Antwort`, `${I.repeat(20)} Antwort`],
  ];
  for (const [name, text, expected] of cases) {
    for (const size of [1, 3, text.length]) {
      it(`${name}, ${size}-character deltas`, () => {
        const out = run(chop(text, size)).out;
        expect(out.trim()).toBe(expected);
        expect(out.toLowerCase()).not.toContain(NONCE);
        expect(out).not.toContain("geheim");
      });
    }
  }
});

describe("createEchoFilter: nested nonce and rebuilt tags", () => {
  it("p + NONCE + s with 1-character deltas: the stream never contains the nonce", () => {
    const text = `Anfang ${P}${NONCE}${S} Ende`;
    const { out, emits } = run(chop(text, 1));
    expect(out.toLowerCase()).not.toContain(NONCE);
    for (const e of emits) expect(e.toLowerCase()).not.toContain(NONCE);
    expect(out).toBe("Anfang  Ende");
  });

  it("p + a whole echoed block + s with 1-character deltas", () => {
    const text = `Anfang ${P}<quelle-${NONCE} nr="1">x</quelle-${NONCE}>${S} Ende`;
    const { out, emits } = run(chop(text, 1));
    expect(out.toLowerCase()).not.toContain(NONCE);
    for (const e of emits) expect(e.toLowerCase()).not.toContain(NONCE);
    expect(out).toBe("Anfang  Ende");
  });

  it("a nonce built from text on both sides of the stream is never emitted, at any chop size", () => {
    const text = `Anfang ${P}${NONCE}${S} Mitte ${P}<quelle-${NONCE} nr="2">y</quelle-${NONCE}>${S} Ende`;
    for (const size of [1, 2, 3, 7, text.length]) {
      const { out, emits } = run(chop(text, size));
      expect(out.toLowerCase(), `size ${size}`).not.toContain(NONCE);
      for (const e of emits) expect(e.toLowerCase()).not.toContain(NONCE);
      expect(out.trim()).toBe(stripEcho(text, NONCE).text);
    }
  });

  it("a tag rebuilt by removing the nonce: the stream never contains the nonce (the tag itself may show)", () => {
    for (const text of [`Antwort <quel${NONCE}le-1>x</quelle-1>`, `Eins </quel${NONCE}le-1> zwei`]) {
      for (const size of [1, 3, text.length]) {
        const { out, emits } = run(chop(text, size));
        expect(out.toLowerCase()).not.toContain(NONCE);
        for (const e of emits) expect(e.toLowerCase()).not.toContain(NONCE);
      }
    }
  });
});

describe("createEchoFilter: tag bounds agree with stripEcho", () => {
  it("a long open tag and a padded close tag stay as text", () => {
    const texts = [
      `<quelle-abc nr="1" ${A100}>x</quelle-abc> Antwort`,
      `Vorher ${NONCE} <quelle-abc ${A100}>x Nachher`,
      `Vorher </quelle-abc${PAD100}> Nachher`,
      `Vorher </quelle-${NONCE}${PAD100}> Nachher`,
    ];
    for (const text of texts) {
      for (const size of [1, 2, 7, text.length]) {
        expect(run(chop(text, size)).out.trim()).toBe(stripEcho(text, NONCE).text);
      }
    }
    expect(run(chop(texts[0]!, 1)).out.trim()).toBe(`<quelle-abc nr="1" ${A100}>x Antwort`);
    expect(run(chop(texts[2]!, 1)).out.trim()).toBe(texts[2]);
  });

  it("a close tag with up to 8 spaces before > ends a block, 9 do not", () => {
    for (const n of [1, 8]) {
      const text = `<quelle-${NONCE} nr="1">geheim</quelle-${NONCE}${" ".repeat(n)}> Antwort`;
      for (const size of [1, 3, text.length]) expect(run(chop(text, size)).out.trim()).toBe("Antwort");
    }
    const nine = `<quelle-${NONCE} nr="1">geheim</quelle-${NONCE}${" ".repeat(9)}> Antwort`;
    for (const size of [1, 3, nine.length]) expect(run(chop(nine, size)).out.trim()).toBe("");
  });
});

describe("createEchoFilter: equals stripEcho for every case, at every chop size", () => {
  const FIXTURE =
    `<quelle-${NONCE} nr="1"> Entscheidend ist Konsistenz in deiner eigenen Methode, nicht Perfektion. </quelle-${NONCE}> ` +
    `<quelle-${NONCE} nr="2"> Behandle jeden Level als Zone. </quelle-${NONCE}> ` +
    `Die Price Action funktioniert durch eine Top-Down-Methode [1: "Konsistenz in deiner eigenen Methode"].`;
  const UP = NONCE.toUpperCase();
  const table: [string, string][] = [
    ["real echo", FIXTURE],
    ["plain", 'Antwort [1: "x"].'],
    ["less-than", "Es gilt a < b und c <d> e."],
    ["quelle without dash", "Die <quelle ist gut und <quelle> auch."],
    ["uppercase", `<QUELLE-${UP} NR="1">geheim</QUELLE-${UP}> Antwort`],
    ["frage block", `<frage-${NONCE}>\nWas ist das?\n</frage-${NONCE}>\nAntwort [1: "x"].`],
    ["no attributes", `<quelle-${NONCE}>a</quelle-${NONCE}>Antwort`],
    ["several attributes", `<quelle-${NONCE} nr="3" x="y">a</quelle-${NONCE}>Antwort`],
    ["forged close other id", `<quelle-${NONCE} nr="1">Quelltext </quelle-deadbeef> LEAK </quelle-${NONCE}> Antwort`],
    ["forged close other kind", `<quelle-${NONCE} nr="1">Quelltext </frage-${NONCE}> LEAK </quelle-${NONCE}> Antwort`],
    ["no close", `Antwort davor <quelle-${NONCE} nr="1"> Quelltext [1: "x"] und mehr Text`],
    ["frage no close", `Vorher <frage-${NONCE}> Rest der Frage`],
    ["only echo", `<quelle-${NONCE} nr="1">a [1: "a"]</quelle-${NONCE}>`],
    ["stray closes", "Eins </quelle-abc123> zwei </frage-q> drei </QUELLE-ZZ9> vier."],
    ["open tag other id", 'Vorher <quelle-ff nr="2"> Rest'],
    ["unfinished open tag", 'Vorher <quelle-ff nr="2" Rest'],
    ["bare nonce", `Die ${NONCE} Antwort ${UP} ist ${NONCE}.`],
    ["stray close with nonce", `Antwort </quelle-${NONCE}> Ende`],
    ["nested nonce", `Anfang ${P}${NONCE}${S} Ende`],
    ["nested nonce three deep", `A ${P}${P}${NONCE}${S}${S} E`],
    ["nested around block", `Anfang ${P}<quelle-${NONCE} nr="1">x</quelle-${NONCE}>${S} Ende`],
    // Tags rebuilt by nonce removal are left out on purpose: the server strips them in a second
    // pass, the stream may show them (documented gap, ADR 0018); see the dedicated test above.
    ["İ before block", `${I}${I}${I} <quelle-${NONCE} nr="1">geheim</quelle-${NONCE}> Antwort`],
    ["İ inside block", `<quelle-${NONCE} nr="1">${I.repeat(40)} geheim</quelle-${NONCE}> Antwort`],
    ["İ before nonce", `${I.repeat(20)}${NONCE} Antwort`],
    ["long open tag", `<quelle-abc nr="1" ${A100}>x</quelle-abc> Antwort`],
    ["long open tag and nonce", `Vorher ${NONCE} <quelle-abc ${A100}>x Nachher`],
    ["padded close", `Vorher </quelle-abc${PAD100}> Nachher`],
    ["padded close with nonce", `Vorher </quelle-${NONCE}${PAD100}> Nachher`],
    ["close with 8 spaces", `<quelle-${NONCE} nr="1">geheim</quelle-${NONCE}${" ".repeat(8)}> Antwort`],
    ["close with 9 spaces", `<quelle-${NONCE} nr="1">geheim</quelle-${NONCE}${" ".repeat(9)}> Antwort`],
    ["24 attribute characters", `<quelle-abc ${"a".repeat(24)}>x</quelle-abc> Antwort`],
    ["id of 33 characters", `Vor <quelle-${"a".repeat(33)}>x Nach`],
    ["hold cap", `x <quelle-${"y".repeat(300)}`],
    ["hex run before a tag", `abcdef0123 <quelle-${NONCE} nr="1">x</quelle-${NONCE}> Antwort`],
    ["empty", ""],
  ];
  for (const [name, text] of table) {
    for (const size of [1, 2, 3, 7, Math.max(1, text.length)]) {
      it(`${name}, ${size === text.length ? "whole" : `${size}-character deltas`}`, () => {
        const out = run(chop(text, size)).out;
        expect(out.trim()).toBe(stripEcho(text, NONCE).text);
        expect(out.toLowerCase()).not.toContain(NONCE);
      });
    }
  }
});

describe("createEchoFilter: linear time", () => {
  const LIMIT_MS = 2000; // generous, like citations-fold
  const inputs: [string, string][] = [
    ["200k less-than signs", "<".repeat(200_000)],
    ["200k of unfinished open-tag prefixes", "<quelle-abc ".repeat(17_000)],
    ["a 200k body inside an open block", `<quelle-${NONCE} nr="1">${"x".repeat(200_000)}`],
    ["a 200k body inside a closed block", `<quelle-${NONCE} nr="1">${"x".repeat(200_000)}</quelle-${NONCE}> Antwort`],
    ["a 200k run of hex characters", "a".repeat(200_000)],
    ["200k of the nonce prefix", P.repeat(25_000)],
  ];
  for (const [name, text] of inputs) {
    for (const size of [1, 1000]) {
      it(`${name}, ${size}-character deltas`, () => {
        const deltas = chop(text, size);
        const t0 = performance.now();
        run(deltas);
        expect(performance.now() - t0).toBeLessThan(LIMIT_MS);
      });
    }
  }
});
