// ADR 0004 / 0005-session-handling-adjacent contract: deleteNotebook() must
// remove a notebook's Storage objects *before* it deletes the notebook row,
// and must never delete the row at all if removing an object failed (ADR
// 0004: "Storage objects first, then rows -- afterwards the Storage policies
// find no source row"; if the row went first, a failed object removal would
// leave an orphaned, now-unreachable-by-policy object behind forever).
//
// It must also check ownership *before* touching Storage at all: the Storage
// delete policy allows owners and editors (supabase/migrations/
// 20261018180000_sources_storage.sql: sources_objects_delete), but only
// owners may delete the notebooks row (notebooks_delete policy) -- so an
// editor calling deleteNotebook without this check would successfully
// destroy every source's object while the notebook (and its now-orphaned
// sources rows) survives. tests/rls/app-notebooks.test.ts's "editor
// rejected: the notebook row and its source object remain afterwards" pins
// the real-policy version of this; this file pins the lib function's own
// explicit pre-check, which is what makes that real-policy test pass instead
// of merely "happening to" pass because Storage denies the editor's remove()
// too (it would not -- editors are allowed to remove() under the real
// policy).
//
// It must also page through a notebook's sources (PostgREST caps a single
// select at 1000 rows by default) and remove storage objects in batches of
// at most 1000 paths -- a notebook near the 20,000-chunk cap can plausibly
// have more than 1000 sources. storage.remove() only reports the paths it
// actually removed, so it can legitimately report fewer names than asked for
// with no error at all (e.g. a source row whose upload never completed --
// there was never an object at that path to remove). Rather than treating
// that as an automatic failure (which would make such a notebook
// undeletable forever, see tests/rls/app-notebooks.test.ts), deleteNotebook
// follows up with storage.from("sources").list(id, { limit: 1000, offset })
// -- paged the same way -- and only proceeds to the row delete once a page
// comes back empty, i.e. nothing is actually left behind under that
// notebook's prefix. If list() ever finds something, that is a real orphan
// and deleteNotebook must throw instead of deleting the row.
//
// This is a pure unit test against a hand-built fake SupabaseClient (no real
// network, no real database) so the *ordering* and *fail-closed* behaviour
// can be pinned down deterministically, independent of what the RLS matrix
// proves about the real policies.
import { describe, expect, it, vi } from "vitest";
import { deleteNotebook } from "@/lib/notebooks/notebooks";

interface FakeResult {
  data: unknown;
  error: { message: string; code?: string } | null;
}

interface FakeCountResult {
  count: number | null;
  error: { message: string; code?: string } | null;
}

function thenable<T>(result: T) {
  // supabase-js query builders are PromiseLike, not Promise instances -- the
  // real contract callers rely on (`await client.from(...).select(...)`)
  // is "has a .then", not "is a Promise", so this intentionally mirrors
  // that shape rather than just returning Promise.resolve(result).
  return { then: (resolve: (value: T) => unknown) => Promise.resolve(result).then(resolve) };
}

const DEFAULT_USER_ID = "11111111-1111-4111-8111-111111111111";
const PAGE_SIZE = 1000;

/** A fixed remove() outcome, or a function of the paths actually passed in
 * (for the pagination test, where each batch must echo back exactly the
 * paths it was given, the way the real Storage API's `remove()` does). */
type RemoveResultOption = FakeResult | ((paths: string[]) => FakeResult);

interface MockClientOptions {
  userId?: string;
  /** The caller's role on the notebook, as returned by the
   * notebook_members lookup; null means "no membership row" (maybeSingle()
   * resolving to { data: null }). */
  role: "owner" | "editor" | "viewer" | null;
  sources: { storage_path: string }[];
  removeResult: RemoveResultOption;
  deleteResult?: FakeCountResult;
  /** What storage.from("sources").list(id, { limit, offset }) reports is
   * still there, paged the same way sources are. Defaults to [] (nothing
   * left behind), the common case where remove() genuinely removed
   * everything it was asked to. */
  remainingObjects?: { name: string }[];
}

function createMockClient(options: MockClientOptions) {
  const calls: string[] = [];
  const userId = options.userId ?? DEFAULT_USER_ID;

  const getUserMock = vi.fn(async () => {
    calls.push("get-user");
    return { data: { user: { id: userId } }, error: null };
  });

  const removeMock = vi.fn(async (paths: string[]) => {
    calls.push(`remove:${[...paths].sort().join(",")}`);
    return typeof options.removeResult === "function" ? options.removeResult(paths) : options.removeResult;
  });

  const deleteEqMock = vi.fn(async () => {
    calls.push("delete-notebook-row");
    return options.deleteResult ?? { count: 1, error: null };
  });

  const listMock = vi.fn(async (prefix: string, listOptions: { limit: number; offset: number }) => {
    const page = (options.remainingObjects ?? []).slice(
      listOptions.offset,
      listOptions.offset + listOptions.limit,
    );
    calls.push(`list:${prefix}:${listOptions.offset}-${listOptions.offset + listOptions.limit - 1}`);
    return { data: page, error: null };
  });

  // Tracks what deleteNotebook actually passes to .delete(...): the
  // implementation relies on { count: "exact" } to get a real affected-row
  // count back (used to tell "0 rows, RLS filtered" apart from "1 row,
  // deleted"), so this is asserted on below rather than just accepted.
  const deleteMock = vi.fn(() => ({ eq: deleteEqMock }));

  const client = {
    auth: { getUser: getUserMock },
    from(table: string) {
      if (table === "notebook_members") {
        return {
          select() {
            return {
              eq() {
                return {
                  eq() {
                    return {
                      async maybeSingle() {
                        calls.push("select-role");
                        return { data: options.role ? { role: options.role } : null, error: null };
                      },
                    };
                  },
                };
              },
            };
          },
        };
      }
      if (table === "sources") {
        return {
          select() {
            return {
              eq() {
                return {
                  order() {
                    return {
                      // Mirrors real Supabase/PostgREST range() semantics:
                      // inclusive of both ends, so range(0, 999) is a page of
                      // 1000 rows. Pages are sliced from the full fixture
                      // list, so a fixture of more than PAGE_SIZE sources
                      // genuinely requires more than one range() call to see
                      // every row -- there is no way for the implementation
                      // to get them all from a single page.
                      range(from: number, to: number) {
                        calls.push(`select-sources:${from}-${to}`);
                        const page = options.sources.slice(from, to + 1);
                        return thenable<FakeResult>({ data: page, error: null });
                      },
                    };
                  },
                };
              },
            };
          },
        };
      }
      if (table === "notebooks") {
        return { delete: deleteMock };
      }
      throw new Error(`createMockClient: unexpected table "${table}"`);
    },
    storage: {
      from(bucket: string) {
        if (bucket !== "sources") throw new Error(`createMockClient: unexpected bucket "${bucket}"`);
        return { remove: removeMock, list: listMock };
      },
    },
  };

  return { client, calls, getUserMock, removeMock, deleteMock, deleteEqMock, listMock };
}

describe("deleteNotebook: order and fail-closed behaviour", () => {
  it("removes exactly the notebook's source storage paths, then deletes the row, in that order", async () => {
    const { client, calls, removeMock, deleteMock, deleteEqMock } = createMockClient({
      role: "owner",
      sources: [{ storage_path: "nb-1/a" }, { storage_path: "nb-1/b" }],
      removeResult: { data: [{ name: "nb-1/a" }, { name: "nb-1/b" }], error: null },
    });

    const result = await deleteNotebook(client as never, "nb-1");

    expect(removeMock).toHaveBeenCalledTimes(1);
    expect([...removeMock.mock.calls[0]![0]].sort()).toEqual(["nb-1/a", "nb-1/b"]);
    // { count: "exact" } is what makes the returned count usable at all (a
    // real PostgrestResponse's `count` is otherwise null) -- deleteNotebook
    // depends on it to tell "0 rows, RLS filtered" apart from "1 row, really
    // deleted" in the test below.
    expect(deleteMock).toHaveBeenCalledWith({ count: "exact" });
    expect(deleteEqMock).toHaveBeenCalledTimes(1);
    // The object removal call must be recorded strictly before the row
    // delete, not merely both having happened.
    expect(calls.indexOf("remove:nb-1/a,nb-1/b")).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf("remove:nb-1/a,nb-1/b")).toBeLessThan(calls.indexOf("delete-notebook-row"));
    expect(result.removedPaths.slice().sort()).toEqual(["nb-1/a", "nb-1/b"]);
  });

  it("never deletes the notebook row, and throws, when removing a storage object fails", async () => {
    const { client, deleteEqMock } = createMockClient({
      role: "owner",
      sources: [{ storage_path: "nb-2/a" }],
      removeResult: { data: null, error: { message: "storage is down" } },
    });

    await expect(deleteNotebook(client as never, "nb-2")).rejects.toThrow();
    expect(deleteEqMock).not.toHaveBeenCalled();
  });

  it('an editor is rejected before Storage is ever touched: throws code "42501", and neither remove nor the row delete is called', async () => {
    const { client, removeMock, deleteEqMock } = createMockClient({
      role: "editor",
      sources: [{ storage_path: "nb-3/a" }],
      removeResult: { data: [{ name: "nb-3/a" }], error: null },
    });

    await expect(deleteNotebook(client as never, "nb-3")).rejects.toMatchObject({ code: "42501" });
    expect(removeMock).not.toHaveBeenCalled();
    expect(deleteEqMock).not.toHaveBeenCalled();
  });

  it('a non-member (no membership row at all) is rejected the same way as an editor: throws code "42501", nothing touched', async () => {
    const { client, removeMock, deleteEqMock } = createMockClient({
      role: null,
      sources: [{ storage_path: "nb-4/a" }],
      removeResult: { data: [{ name: "nb-4/a" }], error: null },
    });

    await expect(deleteNotebook(client as never, "nb-4")).rejects.toMatchObject({ code: "42501" });
    expect(removeMock).not.toHaveBeenCalled();
    expect(deleteEqMock).not.toHaveBeenCalled();
  });

  it('the row delete matching 0 rows (RLS silently filtered, or already gone) throws code "42501", even though the owner check passed and objects were already removed', async () => {
    const { client, removeMock, deleteMock, deleteEqMock } = createMockClient({
      role: "owner",
      sources: [{ storage_path: "nb-5/a" }],
      removeResult: { data: [{ name: "nb-5/a" }], error: null },
      deleteResult: { count: 0, error: null },
    });

    await expect(deleteNotebook(client as never, "nb-5")).rejects.toMatchObject({ code: "42501" });
    expect(removeMock).toHaveBeenCalledTimes(1);
    expect(deleteMock).toHaveBeenCalledWith({ count: "exact" });
    expect(deleteEqMock).toHaveBeenCalledTimes(1);
  });

  it('storage.remove() reporting fewer removed names than requested is fine once the follow-up list() confirms nothing is actually left: the row delete proceeds', async () => {
    const { client, listMock, deleteEqMock } = createMockClient({
      role: "owner",
      sources: [{ storage_path: "nb-6/a" }, { storage_path: "nb-6/b" }],
      // Only 1 of the 2 requested paths came back as removed, with no error
      // at all -- the real Storage API can do this (e.g. "nb-6/b" was a
      // source row whose upload never completed, so there was never an
      // object there to remove). On its own this used to be treated as a
      // failure; now it is only a failure if the follow-up list() below
      // still finds something.
      removeResult: { data: [{ name: "nb-6/a" }], error: null },
      remainingObjects: [], // list() confirms the notebook's prefix is actually empty
    });

    await deleteNotebook(client as never, "nb-6");

    expect(listMock).toHaveBeenCalled();
    expect(deleteEqMock).toHaveBeenCalledTimes(1);
  });

  it('if the follow-up list() still finds an object after all remove batches, deleteNotebook throws and the row delete is never called', async () => {
    const { client, listMock, deleteEqMock } = createMockClient({
      role: "owner",
      sources: [{ storage_path: "nb-6b/a" }],
      // remove() reports it as removed...
      removeResult: { data: [{ name: "nb-6b/a" }], error: null },
      // ...but list() still finds an object under this notebook's prefix: a
      // real, unexplained orphan, not a never-uploaded source. Deleting the
      // row now would make that object permanently unreachable (ADR 0004).
      remainingObjects: [{ name: "nb-6b/a" }],
    });

    await expect(deleteNotebook(client as never, "nb-6b")).rejects.toThrow();
    expect(listMock).toHaveBeenCalled();
    expect(deleteEqMock).not.toHaveBeenCalled();
  });

  it("pages sources in batches of at most 1000 and removes storage objects in batches of at most 1000, all before the row delete", async () => {
    const sourceCount = 2500;
    const sources = Array.from({ length: sourceCount }, (_, i) => ({ storage_path: `nb-paged/${i}` }));

    const { client, calls, removeMock, deleteEqMock } = createMockClient({
      role: "owner",
      sources,
      // Echoes back exactly the paths it was asked to remove, the way the
      // real Storage API's remove() does on success.
      removeResult: (paths) => ({ data: paths.map((name) => ({ name })), error: null }),
    });

    const result = await deleteNotebook(client as never, "nb-paged");

    // The mock's sources select only ever returns up to PAGE_SIZE rows per
    // range() call (sliced straight from the 2500-row fixture), so getting
    // all 2500 genuinely required more than one page -- this is not just
    // checking a call count, it is the only way all 2500 paths could have
    // reached remove() at all.
    const sourcePageCalls = calls.filter((call) => call.startsWith("select-sources:"));
    expect(sourcePageCalls.length).toBeGreaterThanOrEqual(Math.ceil(sourceCount / PAGE_SIZE));

    expect(removeMock).toHaveBeenCalled();
    const removeCalls = removeMock.mock.calls as unknown as [string[]][];
    for (const [paths] of removeCalls) {
      expect(paths.length).toBeGreaterThan(0);
      expect(paths.length).toBeLessThanOrEqual(PAGE_SIZE);
    }
    expect(removeCalls.length).toBeGreaterThanOrEqual(Math.ceil(sourceCount / PAGE_SIZE));

    const removedPaths = removeCalls.flatMap(([paths]) => paths);
    const expectedPaths = sources.map((s) => s.storage_path);
    expect(removedPaths.slice().sort()).toEqual(expectedPaths.slice().sort());
    expect(new Set(removedPaths).size).toBe(sourceCount); // nothing duplicated, nothing skipped

    // Every remove() call happened before the one row delete.
    const deleteCallIndex = calls.indexOf("delete-notebook-row");
    expect(deleteCallIndex).toBeGreaterThanOrEqual(0);
    for (let i = 0; i < calls.length; i += 1) {
      if (calls[i]?.startsWith("remove:")) expect(i).toBeLessThan(deleteCallIndex);
    }
    expect(deleteEqMock).toHaveBeenCalledTimes(1);

    expect(result.removedPaths.slice().sort()).toEqual(expectedPaths.slice().sort());
  });
});

describe("deleteNotebook: optional 3rd argument (userId) bypasses client.auth.getUser()", () => {
  it("skips client.auth.getUser() when a userId is passed explicitly", async () => {
    const { client, getUserMock } = createMockClient({
      role: "owner",
      sources: [],
      removeResult: { data: [], error: null },
    });

    await deleteNotebook(client as never, "nb-explicit-user", DEFAULT_USER_ID);

    expect(getUserMock).not.toHaveBeenCalled();
  });

  it("without a 3rd argument, falls back to client.auth.getUser() as before", async () => {
    const { client, getUserMock } = createMockClient({
      role: "owner",
      sources: [],
      removeResult: { data: [], error: null },
    });

    await deleteNotebook(client as never, "nb-implicit-user");

    expect(getUserMock).toHaveBeenCalledTimes(1);
  });
});
