// readSourceAction: loads a source's full text on demand with the signed-in user's client
// (RLS decides). Same mocking technique as tests/unit/sources/actions.test.ts; createClient
// returns a recording query builder so the test can assert what was queried.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getUserMock, fromMock, tables, calls } = vi.hoisted(() => {
  const calls: { table: string; method: string; args: unknown[] }[] = [];
  const tables: Record<string, { single: unknown; many: unknown }> = {};
  const fromMock = vi.fn((table: string) => {
    const result = () => tables[table] ?? { single: { data: null, error: null }, many: { data: [], error: null } };
    const builder: Record<string, unknown> = {};
    const chain = (method: string) =>
      (...args: unknown[]) => {
        calls.push({ table, method, args });
        if (method === "single" || method === "maybeSingle") return Promise.resolve(result().single);
        return builder;
      };
    for (const method of ["select", "eq", "order", "limit", "range", "single", "maybeSingle"]) {
      builder[method] = chain(method);
    }
    builder.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(result().many).then(resolve, reject);
    return builder;
  });
  return { getUserMock: vi.fn(), fromMock, tables, calls };
});

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: getUserMock }, from: fromMock })),
}));
vi.mock("@/lib/notebooks/notebooks", () => ({ getNotebook: vi.fn() }));
vi.mock("@/lib/sources/sources", () => ({
  createSource: vi.fn(),
  createUrlSource: vi.fn(),
  createSignedUpload: vi.fn(),
  uploadTextObject: vi.fn(),
  deleteSource: vi.fn(),
}));
vi.mock("@/lib/server/ingest/run", () => ({ runIngestion: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string): never => {
    throw new Error(`REDIRECT:${url}`);
  }),
  notFound: vi.fn((): never => {
    throw new Error("NOT_FOUND");
  }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { readSourceAction } from "@/app/(app)/notebooks/[id]/sources/actions";

const NOTEBOOK_ID = "11111111-1111-4111-8111-111111111111";
const SOURCE_ID = "22222222-2222-4222-8222-222222222222";
const FIRST = "Erster Abschnitt";
const SECOND = "Zweiter Abschnitt";

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  for (const key of Object.keys(tables)) delete tables[key];
  getUserMock.mockResolvedValue({ data: { user: { id: "user-1", is_anonymous: false } } });
  tables.sources = {
    single: { data: { id: SOURCE_ID, title: "Bericht.txt", status: "ready" }, error: null },
    many: { data: [{ id: SOURCE_ID, title: "Bericht.txt", status: "ready" }], error: null },
  };
  tables.chunks = {
    single: { data: null, error: null },
    many: {
      data: [
        { ordinal: 0, content: FIRST },
        { ordinal: 1, content: SECOND },
      ],
      error: null,
    },
  };
});

describe("readSourceAction", () => {
  it("queries chunks filtered by notebook_id and source_id, ordered by ordinal", async () => {
    await readSourceAction({ notebookId: NOTEBOOK_ID, sourceId: SOURCE_ID });

    const chunkCalls = calls.filter((c) => c.table === "chunks");
    const eqs = chunkCalls.filter((c) => c.method === "eq").map((c) => c.args);
    expect(eqs).toContainEqual(["notebook_id", NOTEBOOK_ID]);
    expect(eqs).toContainEqual(["source_id", SOURCE_ID]);
    const order = chunkCalls.find((c) => c.method === "order");
    expect(order?.args[0]).toBe("ordinal");
    expect((order?.args[1] as { ascending?: boolean } | undefined)?.ascending).not.toBe(false);
  });

  it("returns the title and the chunk texts in ordinal order", async () => {
    const result = await readSourceAction({ notebookId: NOTEBOOK_ID, sourceId: SOURCE_ID });

    expect(result).toMatchObject({ ok: true, title: "Bericht.txt", truncated: false });
    if (!result.ok) throw new Error("expected ok");
    expect(result.text.indexOf(FIRST)).toBeGreaterThanOrEqual(0);
    expect(result.text.indexOf(FIRST)).toBeLessThan(result.text.indexOf(SECOND));
  });

  it.each([
    ["a non-uuid sourceId", { notebookId: NOTEBOOK_ID, sourceId: "not-a-uuid" }],
    ["a non-uuid notebookId", { notebookId: "not-a-uuid", sourceId: SOURCE_ID }],
  ])("%s returns ok false without any query", async (_name, input) => {
    const result = await readSourceAction(input);

    expect(result).toEqual({ ok: false });
    expect(fromMock).not.toHaveBeenCalled();
  });

  it("a source that is not visible in this notebook (no row) returns ok false", async () => {
    tables.sources = { single: { data: null, error: null }, many: { data: [], error: null } };
    tables.chunks = { single: { data: null, error: null }, many: { data: [], error: null } };

    expect(await readSourceAction({ notebookId: NOTEBOOK_ID, sourceId: SOURCE_ID })).toEqual({ ok: false });
  });

  it("a query error returns ok false", async () => {
    tables.chunks = { single: { data: null, error: null }, many: { data: null, error: { message: "boom" } } };

    expect(await readSourceAction({ notebookId: NOTEBOOK_ID, sourceId: SOURCE_ID })).toEqual({ ok: false });
  });
});
