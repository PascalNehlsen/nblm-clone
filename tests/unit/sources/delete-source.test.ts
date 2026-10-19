// C1 ingestion (approved plan, Pascal 2026-10-19; see .git/C1-API-SPEC.md "Stores": deleteSource).
// Pure unit test against a hand-built fake SupabaseClient (no real network, no real database),
// pinning the *order* and *fail-closed* behaviour the spec requires: storage removal before
// the row delete, never deleting the row if a file is still left behind afterwards, and never
// touching storage for a row the caller cannot even see. Same fake-client-with-call-recording
// technique as tests/unit/notebooks/delete-order.test.ts.
import { describe, expect, it, vi } from "vitest";
import { deleteSource } from "@/lib/sources/sources";

interface SourceRow {
  id: string;
  notebook_id: string;
  storage_path: string;
}

interface RemoveResult {
  data: { name: string }[] | null;
  error: { message: string } | null;
}

interface ListResult {
  data: { name: string }[] | null;
  error: { message: string } | null;
}

interface DeleteResult {
  count: number | null;
  error: { message: string; code?: string } | null;
}

interface MockClientOptions {
  row: SourceRow | null;
  removeResult: RemoveResult;
  listResult: ListResult;
  deleteResult: DeleteResult;
}

function createMockClient(options: MockClientOptions) {
  const calls: string[] = [];

  const selectEqMock = vi.fn(() => ({
    async maybeSingle() {
      calls.push("select-row");
      return { data: options.row, error: null };
    },
  }));

  const removeMock = vi.fn(async (paths: string[]) => {
    calls.push(`remove:${[...paths].sort().join(",")}`);
    return options.removeResult;
  });

  const listMock = vi.fn(async (prefix: string, listOptions: { search?: string }) => {
    calls.push(`list:${prefix}:${listOptions.search ?? ""}`);
    return options.listResult;
  });

  const deleteEqMock = vi.fn(async () => {
    calls.push("delete-row");
    return options.deleteResult;
  });

  const deleteMock = vi.fn<(opts: { count: string }) => { eq: typeof deleteEqMock }>(() => ({ eq: deleteEqMock }));

  const client = {
    from(table: string) {
      if (table !== "sources") throw new Error(`createMockClient: unexpected table "${table}"`);
      return {
        select() {
          return { eq: selectEqMock };
        },
        delete: deleteMock,
      };
    },
    storage: {
      from(bucket: string) {
        if (bucket !== "sources") throw new Error(`createMockClient: unexpected bucket "${bucket}"`);
        return { remove: removeMock, list: listMock };
      },
    },
  };

  return { client, calls, selectEqMock, removeMock, listMock, deleteMock, deleteEqMock };
}

describe("deleteSource: order and fail-closed behaviour", () => {
  it("removes the storage object before deleting the row", async () => {
    const { client, calls } = createMockClient({
      row: { id: "src-1", notebook_id: "nb-1", storage_path: "nb-1/src-1" },
      removeResult: { data: [{ name: "nb-1/src-1" }], error: null },
      listResult: { data: [], error: null },
      deleteResult: { count: 1, error: null },
    });

    await deleteSource(client as never, "src-1");

    expect(calls.indexOf("remove:nb-1/src-1")).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf("remove:nb-1/src-1")).toBeLessThan(calls.indexOf("delete-row"));
  });

  it("a remaining object still named after the source blocks the row delete", async () => {
    const { client, deleteEqMock } = createMockClient({
      row: { id: "src-2", notebook_id: "nb-1", storage_path: "nb-1/src-2" },
      removeResult: { data: [{ name: "nb-1/src-2" }], error: null },
      listResult: { data: [{ name: "src-2" }], error: null },
      deleteResult: { count: 1, error: null },
    });

    await expect(deleteSource(client as never, "src-2")).rejects.toMatchObject({ code: "dateien_uebrig" });
    expect(deleteEqMock).not.toHaveBeenCalled();
  });

  it("a never-uploaded object (nothing removed, nothing left) still deletes the row", async () => {
    const { client, deleteEqMock } = createMockClient({
      row: { id: "src-3", notebook_id: "nb-1", storage_path: "nb-1/src-3" },
      removeResult: { data: [], error: null },
      listResult: { data: [], error: null },
      deleteResult: { count: 1, error: null },
    });

    await deleteSource(client as never, "src-3");

    expect(deleteEqMock).toHaveBeenCalledTimes(1);
  });

  it("a row delete matching 0 rows throws nicht_erlaubt", async () => {
    const { client } = createMockClient({
      row: { id: "src-4", notebook_id: "nb-1", storage_path: "nb-1/src-4" },
      removeResult: { data: [{ name: "nb-1/src-4" }], error: null },
      listResult: { data: [], error: null },
      deleteResult: { count: 0, error: null },
    });

    await expect(deleteSource(client as never, "src-4")).rejects.toMatchObject({ code: "nicht_erlaubt" });
  });

  it("a row that is not visible (missing, or filtered by RLS) throws nicht_erlaubt without touching storage", async () => {
    const { client, removeMock, listMock } = createMockClient({
      row: null,
      removeResult: { data: [], error: null },
      listResult: { data: [], error: null },
      deleteResult: { count: 1, error: null },
    });

    await expect(deleteSource(client as never, "src-missing")).rejects.toMatchObject({ code: "nicht_erlaubt" });
    expect(removeMock).not.toHaveBeenCalled();
    expect(listMock).not.toHaveBeenCalled();
  });
});
