import "server-only";

import { readOpsSummary } from "../admin/ops";
import { parseOpsSummary, type OpsSummary } from "./summary";

// The ops page's data: one aggregate call, checked against the contract before rendering.
export async function loadOpsSummary(days: 7 | 30, now: Date = new Date()): Promise<OpsSummary> {
  return parseOpsSummary(await readOpsSummary(days), now);
}
