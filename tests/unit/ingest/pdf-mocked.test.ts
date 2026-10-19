// C1 ingestion (plan approved by Pascal, 2026-10-19). See .git/C1-API-SPEC.md
// ("pdf.ts"). Mocks "unpdf" so each case exercises exactly one failure path
// without needing a real (possibly huge, possibly encrypted) PDF. Kept in its
// own file so pdf.test.ts, which checks real extraction, never sees this mock.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("unpdf", () => ({
  getDocumentProxy: vi.fn(),
  extractText: vi.fn(),
}));

import * as unpdf from "unpdf";
import { extractPdfText } from "@/lib/server/ingest/pdf";

const mockGetDocumentProxy = vi.mocked(unpdf.getDocumentProxy);
const mockExtractText = vi.mocked(unpdf.extractText);

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("extractPdfText: getDocumentProxy call shape (mocked unpdf)", () => {
  it("is called with a second argument that includes isEvalSupported: false", async () => {
    mockGetDocumentProxy.mockResolvedValue({ numPages: 1 } as never);
    mockExtractText.mockResolvedValue({ totalPages: 1, text: ["Hallo"] } as never);

    await extractPdfText(new Uint8Array([1, 2, 3]));

    expect(mockGetDocumentProxy).toHaveBeenCalledTimes(1);
    const call = mockGetDocumentProxy.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(call[1]).toMatchObject({ isEvalSupported: false });
  });
});

describe("extractPdfText: page limit, encryption, and other failures (mocked unpdf)", () => {
  it("numPages 501 -> file_too_large, without ever calling extractText", async () => {
    mockGetDocumentProxy.mockResolvedValue({ numPages: 501 } as never);

    const result = await extractPdfText(new Uint8Array([1]));

    expect(result).toEqual({ ok: false, category: "file_too_large" });
    expect(mockExtractText).not.toHaveBeenCalled();
  });

  it("an error named PasswordException -> pdf_encrypted", async () => {
    const error = new Error("needs a password");
    error.name = "PasswordException";
    mockGetDocumentProxy.mockRejectedValue(error);

    const result = await extractPdfText(new Uint8Array([1]));

    expect(result).toEqual({ ok: false, category: "pdf_encrypted" });
  });

  it("any other thrown error -> pdf_unreadable", async () => {
    mockGetDocumentProxy.mockRejectedValue(new Error("boom"));

    const result = await extractPdfText(new Uint8Array([1]));

    expect(result).toEqual({ ok: false, category: "pdf_unreadable" });
  });

  it("extractText returning only empty (or whitespace-only) strings -> no_text", async () => {
    mockGetDocumentProxy.mockResolvedValue({ numPages: 2 } as never);
    mockExtractText.mockResolvedValue({ totalPages: 2, text: ["   ", ""] } as never);

    const result = await extractPdfText(new Uint8Array([1]));

    expect(result).toEqual({ ok: false, category: "no_text" });
  });
});

describe("extractPdfText: deadline (mocked unpdf, fake timers)", () => {
  it("a never-resolving getDocumentProxy times out as pdf_unreadable after deadlineMs", async () => {
    vi.useFakeTimers();
    mockGetDocumentProxy.mockImplementation(() => new Promise(() => {}));

    const resultPromise = extractPdfText(new Uint8Array([1]), { deadlineMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    const result = await resultPromise;

    expect(result).toEqual({ ok: false, category: "pdf_unreadable" });
  });
});
