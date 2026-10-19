import { runEval } from "@/lib/server/eval/run";
import { handleEvalRequest } from "@/lib/server/eval/http";
import { createCanaryCallers } from "@/lib/server/model/canary-callers";

// Live eval (ADR 0017), develop only: EVAL_SECRET is never set on production. All logic is in
// lib/server/eval/.
export const maxDuration = 300;

export async function POST(request: Request): Promise<Response> {
  return handleEvalRequest(request, {
    secret: process.env.EVAL_SECRET,
    run: () => {
      const callers = createCanaryCallers();
      if (!callers) return null;
      return runEval({ callChat: callers.callChat, log: (e) => console.info(JSON.stringify(e)), now: () => performance.now() });
    },
  });
}
