import "server-only";

import { readOpsSummary } from "../admin/ops";
import { isOperator } from "./access";
import { parseOpsSummary, type OpsSummary } from "./summary";

// The ops page's data: one aggregate call, checked against the contract before rendering. It
// takes the verified user and refuses anyone but an operator before the admin module is touched,
// so no caller can reach the aggregates without the check (ADR 0005: a layout check alone is not
// enough, ADR 0023).
export async function loadOpsSummary(
  user: Parameters<typeof isOperator>[0],
  days: 7 | 30,
  now: Date = new Date(),
): Promise<OpsSummary> {
  if (!isOperator(user)) throw new Error("ops: not an operator");
  return parseOpsSummary(await readOpsSummary(days), now);
}
