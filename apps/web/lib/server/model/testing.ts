import "server-only";

import { buildModelCaller, jsonLog, type ModelCallDeps, type ModelCallRequest, type ModelCallResult } from "./call-core";
import { getVerifiedUser } from "./caller";
import { modelConfig } from "./config";
import { PRICES } from "./prices";
import type { ModelKind } from "./types";

// Test-only entry point: the model-call engine with every dependency injectable. Only
// files under tests/ may import it (eslint.config.mjs and tests/unit/auth-boundary.test.ts).
// The usage store has no default here, so this module never reaches the admin client.
export function createModelCallerForTests<K extends ModelKind>(
  deps: Pick<ModelCallDeps<K>, "provider" | "usage"> & Partial<ModelCallDeps<K>>,
): (req: ModelCallRequest<K>) => Promise<ModelCallResult<K>> {
  return buildModelCaller<K>({
    provider: deps.provider,
    usage: deps.usage,
    getVerifiedUser: deps.getVerifiedUser ?? getVerifiedUser,
    config: deps.config ?? modelConfig,
    prices: deps.prices ?? PRICES,
    now: deps.now ?? (() => performance.now()),
    log: deps.log ?? jsonLog,
  });
}
