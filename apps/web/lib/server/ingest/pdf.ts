import "server-only";

import { extractText, getDocumentProxy } from "unpdf";
import { MAX_PDF_PAGES, PDF_DEADLINE_MS } from "@/lib/sources/limits";
import type { PageText } from "./chunk";
import { normalizeText } from "./normalize";

export type PdfResult =
  | { ok: true; pages: PageText[] }
  | { ok: false; category: "pdf_encrypted" | "pdf_unreadable" | "file_too_large" | "no_text" };

type DocumentInitOptions = NonNullable<Parameters<typeof getDocumentProxy>[1]>;

class Deadline extends Error {}

async function extract(bytes: Uint8Array, maxPages: number): Promise<PdfResult> {
  // Untrusted input, text only, no rendering. The bundled pdf.js 6 no longer has an eval
  // path (CVE-2024-4367 class) nor this option; it is passed anyway, so a swap back to an
  // older pdf.js through unpdf's resolver keeps eval off.
  const options: DocumentInitOptions & { isEvalSupported: boolean } = { isEvalSupported: false };
  const pdf = await getDocumentProxy(bytes, options);
  if (pdf.numPages > maxPages) return { ok: false, category: "file_too_large" };
  const { text } = await extractText(pdf, { mergePages: false });
  const pages = text.map((pageText, i) => ({ page: i + 1, text: normalizeText(pageText) }));
  if (pages.every((p) => p.text.trim() === "")) return { ok: false, category: "no_text" };
  return { ok: true, pages };
}

export async function extractPdfText(
  bytes: Uint8Array,
  opts: { deadlineMs?: number; maxPages?: number } = {},
): Promise<PdfResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Deadline()), opts.deadlineMs ?? PDF_DEADLINE_MS);
  });
  try {
    return await Promise.race([extract(bytes, opts.maxPages ?? MAX_PDF_PAGES), deadline]);
  } catch (error) {
    if (error instanceof Error && error.name === "PasswordException") {
      return { ok: false, category: "pdf_encrypted" };
    }
    return { ok: false, category: "pdf_unreadable" };
  } finally {
    clearTimeout(timer);
  }
}
