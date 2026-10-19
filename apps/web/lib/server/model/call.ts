import "server-only";

import { reserve, settle } from "@/lib/server/admin/usage";
import { buildModelCaller, jsonLog, type ModelCallRequest, type ModelCallResult } from "./call-core";
import { getVerifiedUser } from "./caller";
import { modelConfig } from "./config";
import { PRICES } from "./prices";
import type { ModelKind, ProviderCall } from "./types";

export type { ModelCallLogEvent, ModelCallRequest, ModelCallResult } from "./call-core";

// The one way app code calls a model (AGENTS.md, ADR 0006). Only the provider is passed
// in; the user (getUser()), the budget store, config, prices, clock and logger are bound
// here, so no caller can skip the reservation or choose its own anonymous flag. Any other
// field on deps is ignored. Tests inject fakes through testing.ts instead.
export function createModelCaller<K extends ModelKind>(deps: {
  provider: ProviderCall<K>;
}): (req: ModelCallRequest<K>) => Promise<ModelCallResult<K>> {
  return buildModelCaller<K>({
    provider: deps.provider,
    getVerifiedUser,
    usage: { reserve, settle },
    config: modelConfig,
    prices: PRICES,
    now: () => performance.now(),
    log: jsonLog,
  });
}
