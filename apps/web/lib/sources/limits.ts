// Ingestion limits, shared by the server pipeline and the upload form. No secrets here.

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // = file_size_limit of the sources bucket
export const MAX_PDF_PAGES = 500;
export const PDF_DEADLINE_MS = 60_000;
export const MAX_TEXT_CHARS = 100_000; // pasted text, after trim
export const CHUNK_MAX = 1500; // characters
export const CHUNK_OVERLAP = 200; // characters, upper bound
export const CHUNK_MIN_TAIL = 200;
export const MAX_CHUNKS_PER_SOURCE = 2000;
export const MAX_CHUNKS_PER_NOTEBOOK = 20_000; // enforced by a DB trigger
export const MAX_SOURCES_PER_NOTEBOOK = 50; // enforced by a DB trigger
export const CHUNK_INSERT_BATCH = 100;
export const STALE_PROCESSING_MS = 10 * 60_000;
export const EMBEDDING_DIMENSIONS = 1024; // Titan Text Embeddings V2 (ADR 0004)
