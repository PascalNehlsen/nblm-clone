// Chat scroll spacer: the pure helper behind "while the answer streams nothing moves".
// The spacer fills what the content leaves below the anchored question so the scroll
// position stays valid until the answer outgrows the region.
import { describe, expect, it } from "vitest";
import { spacerHeight } from "@/lib/chat/scroll";

describe("spacerHeight(anchorTop, clientHeight, contentBottom)", () => {
  it("is 0 when the content already overflows the region", () => {
    expect(spacerHeight(1000, 600, 2000)).toBe(0);
  });

  it("is 0 when the content ends exactly where the region ends", () => {
    expect(spacerHeight(1000, 600, 1600)).toBe(0);
  });

  it("fills the gap when the content is short", () => {
    expect(spacerHeight(1000, 600, 1200)).toBe(400);
    expect(spacerHeight(0, 500, 120)).toBe(380);
  });

  it("is the whole region when nothing follows the anchor", () => {
    expect(spacerHeight(800, 600, 800)).toBe(600);
  });

  it("is never negative, also for odd inputs", () => {
    expect(spacerHeight(0, 0, 100)).toBe(0);
    expect(spacerHeight(10, 20, 5000)).toBe(0);
    expect(Object.is(spacerHeight(10, 20, 5000), -0)).toBe(false);
  });

  it("handles fractional pixels", () => {
    expect(spacerHeight(100.5, 300.25, 200.75)).toBeCloseTo(200, 5);
  });
});
