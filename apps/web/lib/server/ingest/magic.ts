import "server-only";

import { MAX_UPLOAD_BYTES } from "@/lib/sources/limits";

export type ContentCheck =
  | { ok: true }
  | { ok: false; category: "unsupported_type" | "file_too_large" | "no_text" };

const PDF_SIGNATURE = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"
const PDF_SIGNATURE_WINDOW = 1024;

function hasPdfSignature(bytes: Uint8Array): boolean {
  const last = Math.min(bytes.length, PDF_SIGNATURE_WINDOW) - PDF_SIGNATURE.length;
  for (let offset = 0; offset <= last; offset++) {
    if (PDF_SIGNATURE.every((byte, i) => bytes[offset + i] === byte)) return true;
  }
  return false;
}

function isUtf8Text(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

// The type check by content, not by the name or the MIME type the client claimed.
export function checkContent(kind: "pdf" | "text", bytes: Uint8Array): ContentCheck {
  if (bytes.length === 0) return { ok: false, category: "no_text" };
  if (bytes.length > MAX_UPLOAD_BYTES) return { ok: false, category: "file_too_large" };
  const ok = kind === "pdf" ? hasPdfSignature(bytes) : isUtf8Text(bytes);
  return ok ? { ok: true } : { ok: false, category: "unsupported_type" };
}
