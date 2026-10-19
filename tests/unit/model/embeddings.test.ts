// C1 ingestion (plan approved by Pascal, 2026-10-19). See the C1 target design for
// the three additions (PRICES entry, embeddings.ts, the Bedrock ESLint ban):
// lib/server/model/embeddings.ts wires the real Bedrock embedding provider behind
// createModelCaller, so every embedding call still passes the budget check
// (AGENTS.md). It must pass nothing else: no injectable deps, same as call.ts's
// own production wiring (call-production.test.ts).
//
// vi.mock factories are hoisted above regular `const` declarations, so the mocks
// (and the sentinel function createModelCaller is made to return) must be created
// inside vi.hoisted, which is hoisted together with them (same pattern as
// call-production.test.ts and tests/unit/sources/actions.test.ts).
import { afterEach, describe, expect, it, vi } from "vitest";

const { createModelCallerMock, callerResultSentinel, bedrockEmbeddingsSentinel } = vi.hoisted(() => {
  const callerResultSentinel = vi.fn();
  return {
    // Typed via the generic so mock.calls[0][0] below is `{ provider: unknown }`,
    // not an element of an inferred empty-tuple parameter list.
    createModelCallerMock: vi.fn<(deps: { provider: unknown }) => unknown>(() => callerResultSentinel),
    callerResultSentinel,
    bedrockEmbeddingsSentinel: vi.fn(),
  };
});

vi.mock("@/lib/server/model/call", () => ({
  createModelCaller: createModelCallerMock,
}));

vi.mock("@/lib/server/model/bedrock", () => ({
  bedrockEmbeddings: bedrockEmbeddingsSentinel,
}));

import { createEmbeddingCaller } from "@/lib/server/model/embeddings";

afterEach(() => {
  vi.clearAllMocks();
});

describe("createEmbeddingCaller", () => {
  it("calls createModelCaller exactly once with { provider: bedrockEmbeddings } and no other keys", () => {
    createEmbeddingCaller();

    expect(createModelCallerMock).toHaveBeenCalledTimes(1);
    const deps = createModelCallerMock.mock.calls[0]?.[0];
    expect(deps?.provider).toBe(bedrockEmbeddingsSentinel); // same reference, not a copy
    expect(Object.keys(deps ?? {})).toEqual(["provider"]);
  });

  it("returns createModelCaller's result", () => {
    const result = createEmbeddingCaller();
    expect(result).toBe(callerResultSentinel);
  });
});
