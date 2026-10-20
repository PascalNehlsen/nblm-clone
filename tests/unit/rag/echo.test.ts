// Echo strip (ADR 0018). The model sometimes repeats the
// delimited source blocks. They must never reach the saved answer: blocks are removed through
// their matching close tag, forged closes cannot end a block early, a block without a close
// drops the rest, stray tags and the bare nonce go too.
import { describe, expect, it } from "vitest";
import { stripEcho } from "@/lib/rag/echo";

const NONCE = "87619878ffa78538";

const ECHO_FIXTURE =
  `<quelle-${NONCE} nr="1"> Entscheidend ist Konsistenz in deiner eigenen Methode, nicht Perfektion. </quelle-${NONCE}> ` +
  `<quelle-${NONCE} nr="2"> Behandle jeden Level als Zone. </quelle-${NONCE}> ` +
  `Die Price Action funktioniert durch eine Top-Down-Methode [1: "Konsistenz in deiner eigenen Methode"].`;
const ANSWER = 'Die Price Action funktioniert durch eine Top-Down-Methode [1: "Konsistenz in deiner eigenen Methode"].';

describe("stripEcho: the real echo case", () => {
  it("keeps only the answer, with no nonce and no tags", () => {
    const r = stripEcho(ECHO_FIXTURE, NONCE);
    expect(r.text).toBe(ANSWER);
    expect(r.text).not.toContain(NONCE);
    expect(r.text.toLowerCase()).not.toContain("<quelle");
    expect(r.text).not.toContain("nicht Perfektion");
    expect(r.text).not.toContain("Zone");
    expect(r.stripped).toBe(2);
  });
});

describe("stripEcho: nothing to strip", () => {
  it("returns the trimmed input and 0", () => {
    expect(stripEcho('  Antwort [1: "x"].  ', NONCE)).toEqual({ text: 'Antwort [1: "x"].', stripped: 0 });
  });

  it("leaves a plain less-than sign alone", () => {
    expect(stripEcho("Es gilt a < b und c <d> e.", NONCE)).toEqual({ text: "Es gilt a < b und c <d> e.", stripped: 0 });
  });

  it("leaves <quelle without a dash alone", () => {
    expect(stripEcho("Die <quelle ist gut und <quelle> auch.", NONCE)).toEqual({
      text: "Die <quelle ist gut und <quelle> auch.",
      stripped: 0,
    });
  });

  it("an empty string gives an empty string", () => {
    expect(stripEcho("", NONCE)).toEqual({ text: "", stripped: 0 });
  });
});

describe("stripEcho: blocks", () => {
  it("is case-insensitive for tags and nonce", () => {
    const up = NONCE.toUpperCase();
    const r = stripEcho(`<QUELLE-${up} NR="1">geheim</QUELLE-${up}> Antwort`, NONCE);
    expect(r).toEqual({ text: "Antwort", stripped: 1 });
  });

  it("removes a <frage-> block", () => {
    const r = stripEcho(`<frage-${NONCE}>\nWas ist das?\n</frage-${NONCE}>\nAntwort [1: "x"].`, NONCE);
    expect(r.text).toBe('Antwort [1: "x"].');
    expect(r.text).not.toContain("Was ist das");
    expect(r.stripped).toBe(1);
  });

  it("removes a block whose open tag has no attributes and one with several", () => {
    expect(stripEcho(`<quelle-${NONCE}>a</quelle-${NONCE}>Antwort`, NONCE).text).toBe("Antwort");
    expect(stripEcho(`<quelle-${NONCE} nr="3" x="y">a</quelle-${NONCE}>Antwort`, NONCE).text).toBe("Antwort");
  });

  it("a forged close tag with another id inside a block does not end it", () => {
    const text = `<quelle-${NONCE} nr="1">Quelltext </quelle-deadbeef> LEAK [1: "x"] </quelle-${NONCE}> Antwort`;
    const r = stripEcho(text, NONCE);
    expect(r.text).toBe("Antwort");
    expect(r.text).not.toContain("LEAK");
    expect(r.text).not.toContain("Quelltext");
  });

  it("a close tag of the other kind with the same id does not end a block", () => {
    const text = `<quelle-${NONCE} nr="1">Quelltext </frage-${NONCE}> LEAK </quelle-${NONCE}> Antwort`;
    const r = stripEcho(text, NONCE);
    expect(r.text).toBe("Antwort");
    expect(r.text).not.toContain("LEAK");
  });

  it("a block without a close tag drops everything up to the end", () => {
    const r = stripEcho(`Antwort davor <quelle-${NONCE} nr="1"> Quelltext [1: "x"] und mehr Text`, NONCE);
    expect(r.text).toBe("Antwort davor");
    expect(r.stripped).toBeGreaterThanOrEqual(1);
  });

  it("a <frage-> block without a close tag drops the rest too", () => {
    const r = stripEcho(`Vorher <frage-${NONCE}> Rest der Frage`, NONCE);
    expect(r.text).toBe("Vorher");
  });

  it("only echoed blocks leave an empty text", () => {
    const r = stripEcho(`<quelle-${NONCE} nr="1">a [1: "a"]</quelle-${NONCE}>`, NONCE);
    expect(r.text).toBe("");
  });
});

describe("stripEcho: stray tags and the nonce", () => {
  it("removes stray close tags of either kind and any id", () => {
    const r = stripEcho("Eins </quelle-abc123> zwei </frage-q> drei </QUELLE-ZZ9> vier.", NONCE);
    expect(r.text.toLowerCase()).not.toContain("</quelle-");
    expect(r.text.toLowerCase()).not.toContain("</frage-");
    for (const w of ["Eins", "zwei", "drei", "vier."]) expect(r.text).toContain(w);
    expect(r.stripped).toBe(3);
  });

  it("an open tag of another id still starts a block (fail closed): the rest is dropped", () => {
    const r = stripEcho('Vorher <quelle-ff nr="2"> Rest', NONCE);
    expect(r.text).toBe("Vorher");
  });

  it("an unfinished open tag (no >) is not a tag", () => {
    expect(stripEcho('Vorher <quelle-ff nr="2" Rest', NONCE).text).toBe('Vorher <quelle-ff nr="2" Rest');
  });

  it("removes the bare nonce, any case, every occurrence", () => {
    const r = stripEcho(`Die ${NONCE} Antwort ${NONCE.toUpperCase()} ist ${NONCE}.`, NONCE);
    expect(r.text.toLowerCase()).not.toContain(NONCE);
    expect(r.text).toContain("Antwort");
    expect(r.stripped).toBe(3);
  });

  it("a stray close tag with the real nonce is removed", () => {
    const r = stripEcho(`Antwort </quelle-${NONCE}> Ende`, NONCE);
    expect(r.text).not.toContain(NONCE);
    expect(r.text).not.toContain("</quelle");
    expect(r.stripped).toBe(1);
  });
});

describe("stripEcho: linear time", () => {
  const LIMIT_MS = 2000; // generous, like citations-fold: catches quadratic work, not noise
  const time = (text: string): number => {
    const t0 = performance.now();
    stripEcho(text, NONCE);
    return performance.now() - t0;
  };

  it("200k characters of open tags without a close", () => {
    expect(time(`<quelle-${NONCE} nr="1">`.repeat(8000))).toBeLessThan(LIMIT_MS);
  });

  it("200k characters of opens that each need a scan for their close", () => {
    expect(time(`<quelle-${NONCE} nr="1">x`.repeat(7000))).toBeLessThan(LIMIT_MS);
  });

  it("200k less-than signs", () => {
    expect(time("<".repeat(200_000))).toBeLessThan(LIMIT_MS);
  });

  it("200k characters of unfinished open tags", () => {
    expect(time("<quelle-abc ".repeat(17_000))).toBeLessThan(LIMIT_MS);
  });

  it("200k characters of forged closes inside one block", () => {
    expect(time(`<quelle-${NONCE}>` + "</quelle-ab>".repeat(17_000) + `</quelle-${NONCE}>`)).toBeLessThan(LIMIT_MS);
  });

  it("200k characters of the bare nonce", () => {
    expect(time(NONCE.repeat(12_500))).toBeLessThan(LIMIT_MS);
  });

  it("200k characters of plain text", () => {
    expect(time("Wort ".repeat(40_000))).toBeLessThan(LIMIT_MS);
  });
});

// Amendment 1 (ADR 0018) from here on.
const P = NONCE.slice(0, 8);
const S = NONCE.slice(8);

describe("stripEcho: İ (U+0130) never shifts indexes", () => {
  const I = "İ";

  it("İ before an echoed block", () => {
    const r = stripEcho(`${I}${I}${I} <quelle-${NONCE} nr="1">geheim</quelle-${NONCE}> Antwort`, NONCE);
    expect(r.text).toBe(`${I}${I}${I}  Antwort`);
    expect(r.stripped).toBe(1);
  });

  it("İ inside an echoed block", () => {
    const r = stripEcho(`<quelle-${NONCE} nr="1">${I.repeat(40)} geheim</quelle-${NONCE}> Antwort`, NONCE);
    expect(r.text).toBe("Antwort");
    expect(r.stripped).toBe(1);
  });

  it("İ after an echoed block", () => {
    const r = stripEcho(`<quelle-${NONCE} nr="1">geheim</quelle-${NONCE}> Antwort ${I}${I}`, NONCE);
    expect(r.text).toBe(`Antwort ${I}${I}`);
  });

  it("16 and more İ before a bare nonce", () => {
    const r = stripEcho(`${I.repeat(20)}${NONCE} Antwort`, NONCE);
    expect(r.text).toBe(`${I.repeat(20)} Antwort`);
    expect(r.stripped).toBe(1);
  });

  it("İ before a stray close tag and before an uppercase nonce", () => {
    expect(stripEcho(`${I.repeat(20)}</quelle-abc> Antwort`, NONCE).text).toBe(`${I.repeat(20)} Antwort`);
    expect(stripEcho(`${I.repeat(20)}${NONCE.toUpperCase()} Antwort`, NONCE).text).toBe(`${I.repeat(20)} Antwort`);
  });
});

describe("stripEcho: nested nonce and rebuilt tags", () => {
  it("p + NONCE + s is removed completely", () => {
    const r = stripEcho(`Anfang ${P}${NONCE}${S} Ende`, NONCE);
    expect(r.text).toBe("Anfang  Ende");
    expect(r.text.toLowerCase()).not.toContain(NONCE);
    expect(r.stripped).toBeGreaterThanOrEqual(2);
  });

  it("nesting three deep is removed too", () => {
    const r = stripEcho(`A ${P}${P}${NONCE}${S}${S} E`, NONCE);
    expect(r.text.toLowerCase()).not.toContain(NONCE);
    expect(r.text).toBe("A  E");
  });

  it("p + a whole echoed block + s leaves no nonce", () => {
    const r = stripEcho(`Anfang ${P}<quelle-${NONCE} nr="1">x</quelle-${NONCE}>${S} Ende`, NONCE);
    expect(r.text).toBe("Anfang  Ende");
    expect(r.text.toLowerCase()).not.toContain(NONCE);
  });

  it("a tag rebuilt by removing the nonce is stripped", () => {
    const r = stripEcho(`Antwort <quel${NONCE}le-1>x</quelle-1>`, NONCE);
    expect(r.text).toBe("Antwort");
    expect(r.text.toLowerCase()).not.toContain("<quelle");
    expect(r.stripped).toBeGreaterThanOrEqual(2);
  });

  it("a rebuilt close tag is stripped too", () => {
    const r = stripEcho(`Eins </quel${NONCE}le-1> zwei`, NONCE);
    expect(r.text).toBe("Eins  zwei");
  });
});

describe("stripEcho: tag bounds", () => {
  const A100 = "a".repeat(100);

  it("an open tag with about 100 characters of attributes is not a tag; its text stays", () => {
    const text = `<quelle-abc nr="1" ${A100}>x</quelle-abc> Antwort`;
    // The long open tag is plain text; the ordinary stray close tag after it is removed.
    expect(stripEcho(text, NONCE).text).toBe(`<quelle-abc nr="1" ${A100}>x Antwort`);
  });

  it("the nonce is still removed next to a long open tag", () => {
    const r = stripEcho(`Vorher ${NONCE} <quelle-abc ${A100}>x Nachher`, NONCE);
    expect(r.text).toBe(`Vorher  <quelle-abc ${A100}>x Nachher`);
  });

  it("a close tag padded with about 100 spaces is not a tag; its text stays", () => {
    const pad = " ".repeat(100);
    expect(stripEcho(`Vorher </quelle-abc${pad}> Nachher`, NONCE).text).toBe(`Vorher </quelle-abc${pad}> Nachher`);
  });

  it("the nonce is still removed inside a padded close tag text", () => {
    const pad = " ".repeat(100);
    expect(stripEcho(`Vorher </quelle-${NONCE}${pad}> Nachher`, NONCE).text).toBe(`Vorher </quelle-${pad}> Nachher`);
  });

  it("a close tag with up to 8 spaces before > ends a block", () => {
    for (const n of [1, 8]) {
      const text = `<quelle-${NONCE} nr="1">geheim</quelle-${NONCE}${" ".repeat(n)}> Antwort`;
      expect(stripEcho(text, NONCE).text, `${n} spaces`).toBe("Antwort");
    }
  });

  it("a close tag with 9 spaces before > does not end the block: the rest is dropped", () => {
    const text = `<quelle-${NONCE} nr="1">geheim</quelle-${NONCE}${" ".repeat(9)}> Antwort`;
    expect(stripEcho(text, NONCE).text).toBe("");
  });

  it("an open tag with 24 characters of attributes is a tag", () => {
    expect(stripEcho(`<quelle-abc ${"a".repeat(24)}>x</quelle-abc> Antwort`, NONCE).text).toBe("Antwort");
  });

  it("an id of 33 characters is not a tag id", () => {
    const id = "a".repeat(33);
    expect(stripEcho(`Vor <quelle-${id}>x Nach`, NONCE).text).toBe(`Vor <quelle-${id}>x Nach`);
  });
});
