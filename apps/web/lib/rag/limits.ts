import "server-only";

// Retrieval limits (C3). MIN_SCORE stays 0 until the eval gives a measured floor: a guessed
// floor would silently hide passages the answer needs.
export const RETRIEVAL_K = 8;
export const MAX_QUESTION_CHARS = 2000;
export const MIN_SCORE = 0;
