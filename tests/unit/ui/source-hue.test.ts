// "Lesesaal" source colors: deterministic hue slots and [n] marker splitting.
import { describe, expect, it } from "vitest";
import { HUE_SLOTS, assignHues, hueFor, sourceHue, splitRefs, type TextPart } from "@/lib/ui/source-hue";

const PROTO_TITLES = ["constructor", "__proto__", "toString"];

describe("sourceHue", () => {
  it("is deterministic", () => {
    expect(sourceHue("Jahresbericht.pdf")).toBe(sourceHue("Jahresbericht.pdf"));
  });

  it("stays within 0..HUE_SLOTS-1 for varied titles", () => {
    const titles = ["", "a", "Jahresbericht.pdf", "ü".repeat(500), "https://example.com/x?y=1", ...PROTO_TITLES];
    for (let i = 0; i < 200; i++) titles.push(`Quelle ${i}`);
    for (const t of titles) {
      const h = sourceHue(t);
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(HUE_SLOTS - 1);
    }
  });
});

describe("assignHues", () => {
  it("gives distinct slots in list order for up to HUE_SLOTS titles", () => {
    const titles = Array.from({ length: HUE_SLOTS }, (_, i) => `t${i}`);
    const map = assignHues(titles);
    titles.forEach((t, i) => expect(map[t]).toBe(i));
    expect(new Set(Object.values(map)).size).toBe(HUE_SLOTS);
  });

  it("repeats slots after HUE_SLOTS titles", () => {
    const titles = Array.from({ length: HUE_SLOTS + 2 }, (_, i) => `t${i}`);
    const map = assignHues(titles);
    expect(map[`t${HUE_SLOTS}`]).toBe(0);
    expect(map[`t${HUE_SLOTS + 1}`]).toBe(1);
  });

  it("ignores duplicate titles without consuming a slot", () => {
    const map = assignHues(["a", "b", "a", "c"]);
    expect(map).toEqual({ a: 0, b: 1, c: 2 });
  });

  it("returns an empty map for no titles", () => {
    expect(assignHues([])).toEqual({});
  });

  it("is safe for prototype-like titles", () => {
    const map = assignHues(PROTO_TITLES);
    PROTO_TITLES.forEach((t, i) => {
      expect(Object.hasOwn(map, t)).toBe(true);
      expect(map[t]).toBe(i);
    });
    expect(Object.getPrototypeOf(map)).toBe(Object.prototype);
  });
});

describe("hueFor", () => {
  it("returns the mapped slot", () => {
    const map = assignHues(["a", "b", "c"]);
    expect(hueFor(map, "c")).toBe(2);
  });

  it("falls back to sourceHue for unknown titles", () => {
    const map = assignHues(["a"]);
    expect(hueFor(map, "deleted.pdf")).toBe(sourceHue("deleted.pdf"));
  });

  it("falls back to sourceHue for constructor when it is not in the map", () => {
    const map = assignHues(["a", "b"]);
    expect(hueFor(map, "constructor")).toBe(sourceHue("constructor"));
    expect(typeof hueFor(map, "constructor")).toBe("number");
  });

  it("uses the mapped slot for constructor when it is in the map", () => {
    const map = assignHues(["a", "constructor"]);
    expect(hueFor(map, "constructor")).toBe(1);
  });
});

describe("splitRefs", () => {
  it("splits text and [n] markers", () => {
    expect(splitRefs("a [1] b [12].")).toEqual([
      { text: "a " },
      { ref: 1 },
      { text: " b " },
      { ref: 12 },
      { text: "." },
    ]);
  });

  it("leaves three-digit and non-numeric markers as text", () => {
    expect(splitRefs("x [123] y")).toEqual([{ text: "x [123] y" }]);
    expect(splitRefs("x [x] y")).toEqual([{ text: "x [x] y" }]);
  });

  it("returns no parts for an empty string", () => {
    expect(splitRefs("")).toEqual([]);
  });

  it("returns one text part when there are no markers", () => {
    expect(splitRefs("nur Text")).toEqual([{ text: "nur Text" }]);
  });

  it("handles adjacent markers and markers at the edges", () => {
    expect(splitRefs("[1][2]")).toEqual([{ ref: 1 }, { ref: 2 }]);
  });

  it("concatenating text parts plus [n] reproduces the input", () => {
    const inputs = ["a [1] b [12].", "[1]", "x [123] y [x] z", "", "plain", "[3] start and end [4]", "[1][2] [10]"];
    for (const input of inputs) {
      const rebuilt = splitRefs(input)
        .map((p: TextPart) => ("text" in p ? p.text : `[${p.ref}]`))
        .join("");
      expect(rebuilt).toBe(input);
    }
  });
});
