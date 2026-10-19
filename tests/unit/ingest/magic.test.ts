// C1 ingestion (plan approved by Pascal, 2026-10-19): magic-byte / decode checks that
// decide whether an uploaded source is even worth extracting. See
// .git/C1-API-SPEC.md ("magic.ts"): length 0 -> no_text; length > MAX_UPLOAD_BYTES ->
// file_too_large; for kind "pdf" the ASCII bytes "%PDF-" must start at an offset
// <= 1019 (signature fully inside the first 1024 bytes); for kind "text" the bytes
// must decode as UTF-8 (TextDecoder fatal) and contain no 0x00 byte.
import { describe, expect, it } from "vitest";
import { checkContent } from "@/lib/server/ingest/magic";
import { MAX_UPLOAD_BYTES } from "@/lib/sources/limits";

const PDF_SIGNATURE = new TextEncoder().encode("%PDF-");

function pdfBytesWithSignatureAt(offset: number, totalLength: number): Uint8Array {
  // Filler is plain ASCII 'A' (0x41), never part of a magic-byte signature itself.
  const bytes = new Uint8Array(totalLength).fill(0x41);
  bytes.set(PDF_SIGNATURE, offset);
  return bytes;
}

function nonPdfBytes(header: number[]): Uint8Array {
  const bytes = new Uint8Array(100).fill(0x20);
  bytes.set(Uint8Array.from(header), 0);
  return bytes;
}

describe("checkContent: kind pdf, signature offset", () => {
  it.each([0, 500, 1019])("%PDF- at offset %i (inside the first 1024 bytes) passes", (offset) => {
    const bytes = pdfBytesWithSignatureAt(offset, 1024);
    expect(checkContent("pdf", bytes)).toEqual({ ok: true });
  });

  it.each([1020, 2000])("%PDF- at offset %i (outside the first 1024 bytes) -> unsupported_type", (offset) => {
    const bytes = pdfBytesWithSignatureAt(offset, offset + 10);
    expect(checkContent("pdf", bytes)).toEqual({ ok: false, category: "unsupported_type" });
  });

  it("PNG header bytes -> unsupported_type", () => {
    const bytes = nonPdfBytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(checkContent("pdf", bytes)).toEqual({ ok: false, category: "unsupported_type" });
  });

  it("ZIP header bytes -> unsupported_type", () => {
    const bytes = nonPdfBytes([0x50, 0x4b, 0x03, 0x04]);
    expect(checkContent("pdf", bytes)).toEqual({ ok: false, category: "unsupported_type" });
  });

  it("HTML bytes -> unsupported_type", () => {
    const bytes = new TextEncoder().encode("<!DOCTYPE html><html><body>hi</body></html>");
    expect(checkContent("pdf", bytes)).toEqual({ ok: false, category: "unsupported_type" });
  });
});

describe("checkContent: kind text, UTF-8 decode and NUL check", () => {
  it("valid UTF-8 text, including umlauts, passes", () => {
    // Umlauts built from code points (pure ASCII source), not typed glyphs.
    const umlauts = [0x00e4, 0x00f6, 0x00fc, 0x00df].map((cp) => String.fromCharCode(cp)).join(" ");
    const bytes = new TextEncoder().encode(`Hallo Welt mit Umlauten: ${umlauts}`);
    expect(checkContent("text", bytes)).toEqual({ ok: true });
  });

  it("invalid UTF-8 (0xC3 0x28) -> unsupported_type", () => {
    const bytes = Uint8Array.from([0xc3, 0x28]);
    expect(checkContent("text", bytes)).toEqual({ ok: false, category: "unsupported_type" });
  });

  it("a NUL byte inside otherwise valid UTF-8 -> unsupported_type", () => {
    // "a\u0000bc" decodes fine under a fatal UTF-8 decoder (U+0000 is a valid single-byte
    // code point); it must still be rejected because of the explicit 0x00 byte check.
    const bytes = Uint8Array.from([0x61, 0x00, 0x62, 0x63]);
    expect(checkContent("text", bytes)).toEqual({ ok: false, category: "unsupported_type" });
  });
});

describe("checkContent: shared length checks", () => {
  it.each(["pdf", "text"] as const)("%s: empty bytes -> no_text", (kind) => {
    expect(checkContent(kind, new Uint8Array(0))).toEqual({ ok: false, category: "no_text" });
  });

  it("pdf: exactly MAX_UPLOAD_BYTES with a valid signature passes", () => {
    const bytes = pdfBytesWithSignatureAt(0, MAX_UPLOAD_BYTES);
    expect(checkContent("pdf", bytes)).toEqual({ ok: true });
  });

  it("pdf: MAX_UPLOAD_BYTES + 1 -> file_too_large, even with a valid signature", () => {
    const bytes = pdfBytesWithSignatureAt(0, MAX_UPLOAD_BYTES + 1);
    expect(checkContent("pdf", bytes)).toEqual({ ok: false, category: "file_too_large" });
  });
});
