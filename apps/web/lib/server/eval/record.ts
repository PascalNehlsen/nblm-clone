import "server-only";

import { recordEvalRun } from "../admin/ops";
import { EVAL_CASES } from "./corpus";
import type { EvalResult } from "./run";

// Stores the score of a live eval run for the ops page (ADR 0023): counts only. ok mirrors the
// develop gate: every security case and at least 5 quality cases passed. Errors reach the
// caller; the eval route ignores them, so recording never changes an eval result.
const QUALITY_MIN = 5;

export async function recordEvalResult(result: EvalResult): Promise<void> {
  const passed = (ids: string[]) => ids.filter((id) => result.cases[id] === true).length;
  const security = EVAL_CASES.security.map((c) => c.id);
  const quality = [...EVAL_CASES.facts, ...EVAL_CASES.abstention].map((c) => c.id);
  const securityPassed = passed(security);
  const qualityPassed = passed(quality);
  await recordEvalRun({
    commitSha: process.env.VERCEL_GIT_COMMIT_SHA || null,
    securityPassed,
    securityTotal: security.length,
    qualityPassed,
    qualityTotal: quality.length,
    errored: result.errored,
    ok: securityPassed === security.length && qualityPassed >= QUALITY_MIN,
  });
}
