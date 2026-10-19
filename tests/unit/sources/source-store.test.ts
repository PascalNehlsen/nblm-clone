// C1 ingestion (approved plan, Pascal 2026-10-19; see .git/C1-API-SPEC.md "Stores": claim,
// markFailed, markReady, insertChunks). The fake client below is deliberately minimal: it
// does not assert the exact PostgREST filter chain (e.g. whether claim's "pending, failed,
// or stale processing" condition is built with .or()/.in()/.lt()), since that is an
// implementation detail the plan explicitly does not pin down. Instead every chained filter
// call's method name and arguments are recorded into a flat list, and assertions search that
// list for what must be present (the update payload, an `eq("id", sourceId)` filter, and --
// best-effort, using fake system time -- the STALE_PROCESSING_MS cutoff somewhere in the
// recorded arguments).
import { afterEach, describe, expect, it, vi } from "vitest";
import { STALE_PROCESSING_MS } from "@/lib/sources/limits";
import { sourceStore } from "@/lib/sources/sources";

interface RecordedCall {
  method: string;
  args: unknown[];
}

interface UpdateRecord {
  table: string;
  payload: Record<string, unknown>;
  calls: RecordedCall[];
}

// A chainable PostgREST-query-builder stand-in: any method call (eq, or, lt, in, select, ...)
// is recorded and returns the same proxy, and the proxy is itself awaitable ("then") at any
// point in the chain -- matching the real supabase-js query builder's PromiseLike contract
// (see tests/unit/notebooks/delete-order.test.ts's `thenable` helper for the same point).
// Typed as a callable index signature and built through `unknown` because a Proxy's method
// names (eq/or/lt/in/select/...) are not known ahead of time -- there is no narrower type
// that is both accurate and useful here.
type ChainProxy = {
  [method: string]: (...args: unknown[]) => ChainProxy | Promise<{ data: unknown; error: unknown }>;
};

function makeChain(record: UpdateRecord, resolve: () => { data: unknown; error: unknown }): ChainProxy {
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop: string) {
      if (prop === "then") {
        return (onFulfilled: (v: { data: unknown; error: unknown }) => unknown, onRejected?: (e: unknown) => unknown) =>
          Promise.resolve(resolve()).then(onFulfilled, onRejected);
      }
      return (...args: unknown[]) => {
        record.calls.push({ method: prop, args });
        return proxy;
      };
    },
  };
  const proxy = new Proxy({}, handler) as unknown as ChainProxy;
  return proxy;
}

interface FakeClientOptions {
  updateResult?: { data: unknown[] | null; error: { message: string } | null };
  insertError?: { message: string; code?: string } | null;
}

function createFakeClient(options: FakeClientOptions = {}) {
  const updateRecords: UpdateRecord[] = [];
  const insertCalls: unknown[][] = [];

  const client = {
    from(table: string) {
      return {
        update(payload: Record<string, unknown>) {
          const record: UpdateRecord = { table, payload, calls: [] };
          updateRecords.push(record);
          return makeChain(record, () => options.updateResult ?? { data: [{ id: "claimed-1" }], error: null });
        },
        insert(rows: unknown[]) {
          insertCalls.push(rows);
          return Promise.resolve({ data: null, error: options.insertError ?? null });
        },
      };
    },
  };

  return { client, updateRecords, insertCalls };
}

function hasEqIdFilter(record: UpdateRecord, sourceId: string): boolean {
  return record.calls.some((call) => call.method === "eq" && call.args[0] === "id" && call.args[1] === sourceId);
}

function allArgsContain(record: UpdateRecord, needle: string): boolean {
  const serialized = JSON.stringify(record.calls.map((c) => c.args));
  return serialized.includes(needle);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("sourceStore: claim", () => {
  it("updates status to processing and clears error_category, filtered to the given id", async () => {
    const { client, updateRecords } = createFakeClient({
      updateResult: { data: [{ id: "src-1", notebook_id: "nb-1", kind: "text", storage_path: "nb-1/src-1" }], error: null },
    });

    await sourceStore(client as never).claim("src-1");

    expect(updateRecords).toHaveLength(1);
    expect(updateRecords[0]!.table).toBe("sources");
    expect(updateRecords[0]!.payload).toEqual({ status: "processing", error_category: null });
    expect(hasEqIdFilter(updateRecords[0]!, "src-1")).toBe(true);
  });

  it("returns null when the update matches 0 rows", async () => {
    const { client } = createFakeClient({ updateResult: { data: [], error: null } });

    const result = await sourceStore(client as never).claim("src-2");

    expect(result).toBeNull();
  });

  it("returns the claimed row's fields when exactly one row matches", async () => {
    const { client } = createFakeClient({
      updateResult: { data: [{ id: "src-3", notebook_id: "nb-1", kind: "pdf", storage_path: "nb-1/src-3" }], error: null },
    });

    const result = await sourceStore(client as never).claim("src-3");

    expect(result).toEqual({ id: "src-3", notebookId: "nb-1", kind: "pdf", storagePath: "nb-1/src-3" });
  });

  // Best-effort: the exact filter *shape* (or()/in()/lt(), a single combined string filter,
  // ...) is not pinned down, but with the system clock fixed the cutoff timestamp claim must
  // use for "processing, but stale" (now - STALE_PROCESSING_MS) is a known, searchable value
  // -- it must show up somewhere among the filter arguments the update chain recorded.
  it("the stale-processing cutoff is now - STALE_PROCESSING_MS", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const expectedCutoffIso = new Date(Date.now() - STALE_PROCESSING_MS).toISOString();
    const expectedCutoffMs = Date.now() - STALE_PROCESSING_MS;

    const { client, updateRecords } = createFakeClient({
      updateResult: { data: [{ id: "src-4", notebook_id: "nb-1", kind: "text", storage_path: "nb-1/src-4" }], error: null },
    });

    await sourceStore(client as never).claim("src-4");

    const found =
      allArgsContain(updateRecords[0]!, expectedCutoffIso) || allArgsContain(updateRecords[0]!, String(expectedCutoffMs));
    expect(found).toBe(true);
  });
});

describe("sourceStore: markFailed", () => {
  it("updates status to failed with the given error_category, filtered to the given id", async () => {
    const { client, updateRecords } = createFakeClient();

    await sourceStore(client as never).markFailed("src-5", "no_text");

    expect(updateRecords).toHaveLength(1);
    expect(updateRecords[0]!.payload).toEqual({ status: "failed", error_category: "no_text" });
    expect(hasEqIdFilter(updateRecords[0]!, "src-5")).toBe(true);
  });
});

describe("sourceStore: markReady", () => {
  it("updates status to ready and clears error_category, filtered to the given id", async () => {
    const { client, updateRecords } = createFakeClient();

    await sourceStore(client as never).markReady("src-6");

    expect(updateRecords).toHaveLength(1);
    expect(updateRecords[0]!.payload).toEqual({ status: "ready", error_category: null });
    expect(hasEqIdFilter(updateRecords[0]!, "src-6")).toBe(true);
  });
});

describe("sourceStore: insertChunks", () => {
  it("rethrows an Error carrying the PostgREST error's code", async () => {
    const { client } = createFakeClient({ insertError: { message: "chunk cap hit", code: "54000" } });

    await expect(
      sourceStore(client as never).insertChunks([
        { notebook_id: "nb-1", source_id: "src-7", ordinal: 0, content: "x", page: null, embedding: [0] },
      ]),
    ).rejects.toMatchObject({ code: "54000" });
  });

  it("resolves without throwing when there is no error", async () => {
    const { client, insertCalls } = createFakeClient({ insertError: null });
    const rows = [{ notebook_id: "nb-1", source_id: "src-8", ordinal: 0, content: "x", page: null, embedding: [0] }];

    await expect(sourceStore(client as never).insertChunks(rows)).resolves.toBeUndefined();
    expect(insertCalls).toEqual([rows]);
  });
});
