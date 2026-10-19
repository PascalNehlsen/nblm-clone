// C1 ingestion (plan approved by Pascal, 2026-10-19). See .git/C1-API-SPEC.md
// ("pdf.ts"). This file uses the real `unpdf` package (pinned in apps/web's
// package.json) against a hand-built, byte-accurate minimal PDF and against
// corrupt bytes. The mocked-dependency cases (call shape, page limit, password,
// other errors, empty text, deadline) live in pdf-mocked.test.ts so this file's
// import of "unpdf" is never intercepted by vi.mock.
import { describe, expect, it } from "vitest";
import { extractPdfText } from "@/lib/server/ingest/pdf";

// A minimal, valid 2-page PDF built as plain ASCII text, with a byte-accurate
// xref table (every offset computed from the actual bytes written so far), one
// Helvetica Type1 font, and one content stream per page that draws the given
// text with `Tj`. pdf.js should parse this directly; it does not need its
// xref-repair fallback, but would fall back to it if this were slightly off.
function buildTwoPagePdf(page1Text: string, page2Text: string): Uint8Array {
  const stream1 = `BT /F1 12 Tf 72 720 Td (${page1Text}) Tj ET`;
  const stream2 = `BT /F1 12 Tf 72 720 Td (${page2Text}) Tj ET`;

  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /MediaBox [0 0 612 792] /Contents 6 0 R >>\nendobj\n",
    "4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
    "5 0 obj\n<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /MediaBox [0 0 612 792] /Contents 7 0 R >>\nendobj\n",
    `6 0 obj\n<< /Length ${stream1.length} >>\nstream\n${stream1}\nendstream\nendobj\n`,
    `7 0 obj\n<< /Length ${stream2.length} >>\nstream\n${stream2}\nendstream\nendobj\n`,
  ];

  let body = "%PDF-1.4\n";
  const offsets: number[] = [0]; // object 0 ("free") is never referenced below
  for (const obj of objects) {
    offsets.push(body.length);
    body += obj;
  }

  const xrefStart = body.length;
  const count = objects.length + 1;
  let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let i = 1; i < count; i++) {
    xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  const trailer = `trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

  return new TextEncoder().encode(body + xref + trailer);
}

describe("extractPdfText: a real minimal 2-page PDF (real unpdf)", () => {
  it("returns 2 pages, 1-based, with the expected text", async () => {
    const bytes = buildTwoPagePdf("Seite eins Text", "Seite zwei Text");

    const result = await extractPdfText(bytes);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pages).toHaveLength(2);
    expect(result.pages[0]?.page).toBe(1);
    expect(result.pages[1]?.page).toBe(2);
    expect(result.pages[0]?.text).toContain("Seite eins Text");
    expect(result.pages[1]?.text).toContain("Seite zwei Text");
  });
});

describe("extractPdfText: corrupt bytes (real unpdf)", () => {
  it("never throws; resolves ok:false with pdf_unreadable or no_text", async () => {
    const bytes = new TextEncoder().encode("%PDF-1.4 garbage");

    const result = await extractPdfText(bytes);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(["pdf_unreadable", "no_text"]).toContain(result.category);
  });
});
