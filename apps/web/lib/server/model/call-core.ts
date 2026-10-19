import "server-only";

import type { ModelErrorCategory } from "@/lib/ops/categories";
import type { VerifiedUser } from "./caller";
import type { ModelConfig } from "./config";
import { costUsd, estimateCostUsd, inputTokenUpperBound, priceFor, type PriceTable } from "./prices";
import {
  ProviderError,
  type InputFor,
  type ModelKind,
  type OutputFor,
  type ProviderCall,
  type ProviderUsage,
  type SettleArgs,
  type UsagePort,
} from "./types";

// The engine behind the one way to call a model (AGENTS.md, ADR 0006): verified user,
// server-side config and price, budget reservation (which also checks the kill switch), the
// provider call with a timeout, then settle. Every dependency is passed in. App code never
// sees this module: call.ts binds the real dependencies, testing.ts lets tests inject fakes,
// and eslint.config.mjs lets only those two import it. The request carries no user, model or
// token settings. Nothing here logs or returns prompt, source or answer text, except the
// output itself on success.

export interface ModelCallRequest<K extends ModelKind> {
  kind: K;
  notebookId: string | null;
  input: InputFor<K>;
  // Writes the message for this output and returns its id, so settle links the usage row
  // to the message the server just wrote (ADR 0006). Used by chat in PR D.
  linkMessage?: (output: OutputFor<K>) => Promise<string | null>;
  // Streamed chat text, forwarded only while the call is running (never after a timeout).
  onDelta?: (text: string) => void;
}

export type ModelCallResult<K extends ModelKind> =
  | {
      ok: true;
      output: OutputFor<K>;
      usageId: string;
      inputTokens: number;
      outputTokens: number;
      costUsd: number;
      latencyMs: number;
      settled: boolean;
    }
  | { ok: false; category: ModelErrorCategory; usageId: string | null };

export interface ModelCallLogEvent {
  event: "model_call";
  outcome: "ok" | "refused" | "failed";
  category: ModelErrorCategory | null;
  kind: ModelKind;
  modelId: string | null;
  usageId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  latencyMs: number | null;
  settleFailed: boolean;
}

export interface ModelCallDeps<K extends ModelKind> {
  provider: ProviderCall<K>;
  getVerifiedUser: () => Promise<VerifiedUser | null>;
  usage: UsagePort;
  config: (kind: ModelKind) => ModelConfig | null;
  prices: PriceTable;
  now: () => number;
  log: (e: ModelCallLogEvent) => void;
}

export function jsonLog(event: ModelCallLogEvent): void {
  console.info(JSON.stringify(event));
}

function isTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isValidUsage(usage: unknown): usage is ProviderUsage {
  if (!usage || typeof usage !== "object") return false;
  const { inputTokens, outputTokens } = usage as Record<string, unknown>;
  return isTokenCount(inputTokens) && isTokenCount(outputTokens);
}

function providerCategory(error: unknown): ModelErrorCategory {
  if (error instanceof ProviderError) {
    if (error.kind === "timeout") return "provider_timeout";
    if (error.kind === "throttled") return "provider_throttled";
  }
  return "provider_error";
}

export function buildModelCaller<K extends ModelKind>(
  deps: ModelCallDeps<K>,
): (req: ModelCallRequest<K>) => Promise<ModelCallResult<K>> {
  const { provider, usage, config, prices, now, log } = deps;
  const verifyUser = deps.getVerifiedUser;

  // Settle never throws into the caller: a failed settle leaves the row reserved at the
  // estimate, which is an upper bound, so the budget errs on the safe side.
  async function trySettle(args: SettleArgs): Promise<boolean> {
    try {
      return (await usage.settle(args)) === true;
    } catch {
      return false;
    }
  }

  return async (req) => {
    // Only these fields are read; anything else on the request is ignored.
    const { kind, notebookId, input, linkMessage, onDelta } = req;
    let modelId: string | null = null;

    const refuse = (category: ModelErrorCategory): ModelCallResult<K> => {
      log({
        event: "model_call",
        outcome: "refused",
        category,
        kind,
        modelId,
        usageId: null,
        inputTokens: null,
        outputTokens: null,
        costUsd: null,
        latencyMs: null,
        settleFailed: false,
      });
      return { ok: false, category, usageId: null };
    };

    let user: VerifiedUser | null;
    try {
      user = await verifyUser();
    } catch {
      user = null;
    }
    if (!user) return refuse("unauthenticated");

    const cfg = config(kind);
    if (!cfg) return refuse("model_not_configured");
    modelId = cfg.modelId;

    const price = priceFor(prices, cfg.modelId);
    if (!price) return refuse("price_unknown");
    const estimate = estimateCostUsd(price, inputTokenUpperBound(kind, input), cfg.maxOutputTokens);
    if (!Number.isFinite(estimate) || estimate <= 0) return refuse("price_unknown");

    let usageId: string;
    try {
      const reservation = await usage.reserve({
        userId: user.id,
        isAnonymous: user.isAnonymous,
        notebookId,
        kind,
        modelId: cfg.modelId,
        estimatedCostUsd: estimate,
        // One reservation per logical operation; an embedding call counts its texts (ADR 0006).
        callCount: kind === "embedding" ? Math.max(1, (input as InputFor<"embedding">).texts.length) : 1,
      });
      if (reservation.outcome === "ok") {
        if (typeof reservation.usageId !== "string" || !reservation.usageId) return refuse("budget_unavailable");
        usageId = reservation.usageId;
      } else if (
        reservation.outcome === "kill_switch_on" ||
        reservation.outcome === "budget_exceeded" ||
        reservation.outcome === "global_budget_exceeded"
      ) {
        return refuse(reservation.outcome);
      } else {
        return refuse("budget_unavailable");
      }
    } catch {
      return refuse("budget_unavailable");
    }

    const fail = async (
      category: ModelErrorCategory,
      tokens: ProviderUsage,
      cost: number,
      latencyMs: number,
    ): Promise<ModelCallResult<K>> => {
      const settled = await trySettle({
        usageId,
        status: "failed",
        inputTokens: tokens.inputTokens,
        outputTokens: tokens.outputTokens,
        costUsd: cost,
        latencyMs,
        messageId: null,
        errorCategory: category,
      });
      log({
        event: "model_call",
        outcome: "failed",
        category,
        kind,
        modelId,
        usageId,
        inputTokens: tokens.inputTokens,
        outputTokens: tokens.outputTokens,
        costUsd: cost,
        latencyMs,
        settleFailed: !settled,
      });
      return { ok: false, category, usageId };
    };

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new ProviderError("timeout"));
      }, cfg.timeoutMs);
    });

    // Deltas pass only while this call is active; a late provider cannot write after the
    // timeout or after the result was returned. Deltas are never logged.
    let streaming = true;
    const forwardDelta = onDelta
      ? (text: string) => {
          if (streaming && !controller.signal.aborted) onDelta(text);
        }
      : undefined;

    const start = now();
    let response: Awaited<ReturnType<ProviderCall<K>>>;
    try {
      // Race our own timer as well, in case the provider ignores the signal. A result that
      // arrives after the timeout is dropped and never settled.
      response = await Promise.race([
        Promise.resolve().then(() =>
          provider({
            modelId: cfg.modelId,
            maxOutputTokens: cfg.maxOutputTokens,
            temperature: cfg.temperature,
            input,
            signal: controller.signal,
            ...(forwardDelta ? { onDelta: forwardDelta } : {}),
          }),
        ),
        timeout,
      ]);
    } catch (error) {
      const latencyMs = Math.max(0, Math.round(now() - start));
      const reported = error instanceof ProviderError && isValidUsage(error.usage) ? error.usage : null;
      // Without reported usage the call is charged at the estimate (fail closed).
      return fail(
        providerCategory(error),
        reported ?? { inputTokens: 0, outputTokens: 0 },
        reported ? costUsd(price, reported) : estimate,
        latencyMs,
      );
    } finally {
      clearTimeout(timer);
      streaming = false;
    }
    const latencyMs = Math.max(0, Math.round(now() - start));

    if (!response || typeof response !== "object" || response.output == null || !isValidUsage(response.usage)) {
      return fail("provider_invalid_response", { inputTokens: 0, outputTokens: 0 }, estimate, latencyMs);
    }

    const { output } = response;
    const { inputTokens, outputTokens } = response.usage;
    const cost = costUsd(price, response.usage);

    let messageId: string | null = null;
    let linkFailed = false;
    if (linkMessage) {
      try {
        messageId = (await linkMessage(output)) ?? null;
      } catch {
        linkFailed = true;
      }
    }

    const settled = await trySettle({
      usageId,
      status: "settled",
      inputTokens,
      outputTokens,
      costUsd: cost,
      latencyMs,
      messageId,
      errorCategory: linkFailed ? "message_link_failed" : null,
    });

    const category: ModelErrorCategory | null = linkFailed ? "message_link_failed" : settled ? null : "settle_failed";
    log({
      event: "model_call",
      outcome: linkFailed ? "failed" : "ok",
      category,
      kind,
      modelId,
      usageId,
      inputTokens,
      outputTokens,
      costUsd: cost,
      latencyMs,
      settleFailed: !settled,
    });

    if (linkFailed) return { ok: false, category: "message_link_failed", usageId };
    return { ok: true, output, usageId, inputTokens, outputTokens, costUsd: cost, latencyMs, settled };
  };
}
