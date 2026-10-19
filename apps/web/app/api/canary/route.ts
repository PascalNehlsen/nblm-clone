import { runCanary } from "@/lib/server/canary/canary";
import { handleCanaryRequest } from "@/lib/server/canary/http";
import { createCanaryCallers } from "@/lib/server/model/canary-callers";

// Release canary (ADR 0014). All logic is in lib/server/canary/.
export const maxDuration = 180;

export async function POST(request: Request): Promise<Response> {
  return handleCanaryRequest(request, {
    secret: process.env.CANARY_SECRET,
    run: () => {
      const callers = createCanaryCallers();
      if (!callers) return null;
      return runCanary({ ...callers, log: (e) => console.info(JSON.stringify(e)), now: () => performance.now() });
    },
  });
}
