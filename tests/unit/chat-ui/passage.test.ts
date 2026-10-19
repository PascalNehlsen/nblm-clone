// D3 passage highlight (spec .git/D3-API-SPEC.md "passage.ts").
import { describe, expect, it } from "vitest";
import { highlight } from "@/lib/chat/passage";

describe("highlight", () => {
  it("splits the content around a found quote", () => {
    expect(highlight("Die Fiktiva GmbH wurde 1999 gegründet.", "Fiktiva GmbH")).toEqual({
      before: "Die ",
      mark: "Fiktiva GmbH",
      after: " wurde 1999 gegründet.",
    });
  });

  it("returns null for a quote that is not a substring (forged quote)", () => {
    expect(highlight("Die Fiktiva GmbH wurde 1999 gegründet.", "Fiktiva AG")).toBeNull();
  });

  it("is case sensitive", () => {
    expect(highlight("Hallo Welt", "hallo")).toBeNull();
  });

  it("returns null for a null or empty quote", () => {
    expect(highlight("Hallo Welt", null)).toBeNull();
    expect(highlight("Hallo Welt", "")).toBeNull();
  });

  it("marks the first occurrence only", () => {
    expect(highlight("ab ab ab", "ab")).toEqual({ before: "", mark: "ab", after: " ab ab" });
  });

  it("handles a quote at the very end and the whole content", () => {
    expect(highlight("Ende", "Ende")).toEqual({ before: "", mark: "Ende", after: "" });
    expect(highlight("Vor dem Ende", "Ende")).toEqual({ before: "Vor dem ", mark: "Ende", after: "" });
  });
});
