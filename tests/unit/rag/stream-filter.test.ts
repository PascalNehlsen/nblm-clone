// D2 stream filter (spec .git/D2-API-SPEC.md "stream-filter.ts").
import { describe, expect, it } from "vitest";
import { createMarkerFilter } from "@/lib/rag/stream-filter";

function run(deltas: string[]): { out: string; emits: string[] } {
  const emits: string[] = [];
  const f = createMarkerFilter((t) => emits.push(t));
  for (const d of deltas) f.push(d);
  f.end();
  return { out: emits.join(""), emits };
}

describe("createMarkerFilter", () => {
  it("passes plain text unchanged", () => {
    expect(run(["Hallo ", "Welt", "."]).out).toBe("Hallo Welt.");
  });

  it("drops a complete marker in one delta", () => {
    expect(run(['Bonn [1: "1999"] ist schön.']).out).toBe("Bonn  ist schön.");
  });

  it("a marker split across many deltas (one char each) never reaches emit", () => {
    const text = 'Satz eins [12: "Fiktiva GmbH"] und weiter.';
    const { out, emits } = run(text.split(""));
    expect(out).toBe("Satz eins  und weiter.");
    for (const e of emits) {
      expect(e).not.toContain("[1");
      expect(e).not.toContain('"Fiktiva');
    }
  });

  it("a marker split in the middle of the quote never leaks a fragment", () => {
    const { out } = run(["Text [1: \"Fikti", 'va Gm', 'bH"', "] Ende"]);
    expect(out).toBe("Text  Ende");
    expect(out).not.toContain("Fiktiva");
  });

  it("emits a [ that does not start a marker", () => {
    expect(run(["Liste [a] und [", "x] fertig"]).out).toBe("Liste [a] und [x] fertig");
  });

  it("emits [ followed by digits but no colon", () => {
    expect(run(["Siehe [12] und [1", "23] ok"]).out).toBe("Siehe [12] und [123] ok");
  });

  it("end() drops a held partial marker that starts [digits:", () => {
    const { out } = run(['Antwort [3: "abge']);
    expect(out).toBe("Antwort ");
  });

  it("end() emits a held partial that is not a marker", () => {
    expect(run(["Ende ["]).out).toBe("Ende [");
    expect(run(["Ende [1"]).out).toBe("Ende [1");
  });

  it("emits held text longer than 2100 characters as is", () => {
    const longTail = 'x'.repeat(2200);
    const { out } = run([`A [1: "${longTail}`, " weiter"]);
    expect(out.startsWith("A ")).toBe(true);
    expect(out).toContain(longTail.slice(0, 100));
    expect(out.endsWith(" weiter")).toBe(true);
  });

  it("a marker with 8 spaces before the quote, split into single chars, is dropped", () => {
    const text = "Text [1:" + " ".repeat(8) + '"Bonn"] Ende';
    const { out, emits } = run(text.split(""));
    expect(out).toBe("Text  Ende");
    for (const e of emits) expect(e).not.toContain("Bonn");
  });

  it("[n: followed by 9 or more spaces is not a marker and is emitted without waiting for 2100 chars", () => {
    const head = "Text [1:" + " ".repeat(9);
    const emits: string[] = [];
    const f = createMarkerFilter((t) => emits.push(t));
    for (const c of head) f.push(c);
    // Before end(): the "[1:" and the spaces must already have gone out.
    expect(emits.join("")).toBe(head);
    for (const c of '"Bonn"] Ende') f.push(c);
    f.end();
    expect(emits.join("")).toBe(head + '"Bonn"] Ende');
  });

  it("[n: followed by 3000 spaces and a quote is emitted as text, never held as a marker", () => {
    const text = "Text [1:" + " ".repeat(3000) + '"Bonn"] Ende';
    const { out, emits } = run(text.split(""));
    expect(out).toBe(text);
    // The first emit that contains the "[" must come long before 2100 chars were held.
    let seen = 0;
    for (const e of emits) {
      if (e.includes("[")) break;
      seen += e.length;
    }
    expect(seen).toBeLessThan(20);
    expect(emits.some((e) => e.length > 100)).toBe(false);
  });

  it("a three-digit marker split into single chars never reaches emit", () => {
    const text = 'Text [123: "Bonn"] Ende';
    const { out, emits } = run(text.split(""));
    expect(out).toBe("Text  Ende");
    for (const e of emits) {
      expect(e).not.toContain("[1");
      expect(e).not.toContain("Bonn");
    }
  });

  it("200,000 plain characters in one push take under 500 ms and pass unchanged", () => {
    const input = "a".repeat(200_000);
    const emits: string[] = [];
    const f = createMarkerFilter((t) => emits.push(t));
    const start = performance.now();
    f.push(input);
    f.end();
    expect(performance.now() - start).toBeLessThan(500);
    expect(emits.join("")).toBe(input);
  });

  it.each([
    ["[", 100_000],
    ["[1", 100_000],
  ])("%j repeated %i times in one push takes under 500 ms and passes unchanged", (unit, n) => {
    const input = unit.repeat(n);
    const emits: string[] = [];
    const f = createMarkerFilter((t) => emits.push(t));
    const start = performance.now();
    f.push(input);
    f.end();
    expect(performance.now() - start).toBeLessThan(500);
    expect(emits.join("")).toBe(input);
  });

  it("text after a dropped marker keeps flowing", () => {
    expect(run(['[1: "a"]', "[2: \"b\"]", "Rest"]).out).toBe("Rest");
  });
});
