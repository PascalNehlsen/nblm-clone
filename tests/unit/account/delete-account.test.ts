// Account deletion orchestration: apps/web/lib/server/account/delete-account.ts.
//
// Contract pinned here (communicated to the builder):
//
//   deleteAccount(deps, form: FormData): Promise<{ redirectTo: string }>
//
//   deps = {
//     client:          the signed-in user's own Supabase client (RLS applies); the module uses
//                      client.auth.getUser() (never getClaims()) and client.from("notebook_members")
//     adminConfigured: () => boolean   is the secret key usable? Asked BEFORE anything is deleted
//     deleteAuthUser:  (userId: string) => Promise<void>   the admin call, injected
//     signOut:         (options: { scope: "local" }) => Promise<unknown>
//   }
//
//   Steps: getUser -> require form "confirm" === "on" -> adminConfigured() -> list the user's
//   notebook_members rows -> for every notebook where the user is owner and no OTHER owner
//   exists: deleteNotebook(client, id, userId) from lib/notebooks/notebooks (stop at the first
//   failure) -> list again; anything sole-owned left (a notebook created meanwhile) gets one
//   more pass of the loop, else error -> deleteAuthUser(user.id) -> signOut({ scope: "local" }).
//
//   Results (redirect targets, fixed strings, never an error message):
//     done                      /login?konto=geloescht
//     not signed in             /login                      (nothing else happens)
//     confirm missing or not "on"  /profil?fehler=bestaetigung (nothing deleted)
//     anything else that fails  /profil?fehler=konto_loeschen
//   A failing signOut AFTER the auth user is gone does not turn the result into an error.
//
// deleteNotebook is replaced by a recorder that removes the notebook's membership rows from the
// fake, like a real delete would (the real one is covered by tests/rls/account_deletion.test.ts).
// The fake client only knows the notebook_members table and the common PostgREST filters
// (select, eq, neq, in, is, not, order, range, limit, returns, maybeSingle, single).
import { beforeEach, describe, expect, it, vi } from "vitest";

const deleteNotebookMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/notebooks/notebooks", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/notebooks/notebooks")>();
  return { ...original, deleteNotebook: deleteNotebookMock };
});

import { deleteAccount, deletionSummary } from "@/lib/server/account/delete-account";

type Role = "owner" | "editor" | "viewer";
interface MemberRow {
  notebook_id: string;
  user_id: string;
  role: Role;
}
interface FakeUser {
  id: string;
  is_anonymous?: boolean;
}

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

const ME = uuid(1);
const OTHER = uuid(2);
const VICTIM = uuid(3);
const EDITOR = uuid(4);
const NB_A = uuid(101); // me alone
const NB_B = uuid(102); // me alone, shared with an editor
const NB_C = uuid(103); // me and OTHER, both owners
const NB_D = uuid(104); // OTHER owns, I am editor
const NB_E = uuid(105); // OTHER owns, I am viewer
const NB_VICTIM = uuid(106); // VICTIM alone

interface State {
  user: FakeUser | null;
  members: MemberRow[];
  membersError: boolean;
  membersErrorOnIn: boolean;
  inCalls: number[];
  adminOk: boolean;
  log: string[];
  nextLate: number;
}

let state: State;

function baseMembers(): MemberRow[] {
  return [
    { notebook_id: NB_A, user_id: ME, role: "owner" },
    { notebook_id: NB_B, user_id: ME, role: "owner" },
    { notebook_id: NB_B, user_id: EDITOR, role: "editor" },
    { notebook_id: NB_C, user_id: ME, role: "owner" },
    { notebook_id: NB_C, user_id: OTHER, role: "owner" },
    { notebook_id: NB_D, user_id: OTHER, role: "owner" },
    { notebook_id: NB_D, user_id: ME, role: "editor" },
    { notebook_id: NB_E, user_id: OTHER, role: "owner" },
    { notebook_id: NB_E, user_id: ME, role: "viewer" },
    { notebook_id: NB_VICTIM, user_id: VICTIM, role: "owner" },
  ];
}

function column(row: MemberRow, name: string): unknown {
  return (row as unknown as Record<string, unknown>)[name];
}

function query() {
  const filters: Array<(row: MemberRow) => boolean> = [];
  let offset = 0;
  let limit = Number.POSITIVE_INFINITY;
  let head = false;
  let wantsCount = false;
  let usedIn = false;

  const run = () => {
    if (state.membersError || (state.membersErrorOnIn && usedIn)) return { data: null, count: null, error: { message: "boom", code: "XX000" } };
    const matching = state.members.filter((row) => filters.every((f) => f(row)));
    const page = matching.slice(offset, offset + limit).map((row) => ({
      ...row,
      notebooks: { id: row.notebook_id, title: `Notizbuch ${row.notebook_id}` },
    }));
    return { data: head ? null : page, count: wantsCount ? matching.length : null, error: null };
  };

  const api: Record<string, unknown> = {
    select: (_columns?: string, options?: { count?: string; head?: boolean }) => {
      head = options?.head === true;
      wantsCount = options?.count !== undefined;
      return api;
    },
    eq: (name: string, value: unknown) => (filters.push((r) => column(r, name) === value), api),
    neq: (name: string, value: unknown) => (filters.push((r) => column(r, name) !== value), api),
    in: (name: string, values: unknown[]) => {
      state.inCalls.push(values.length);
      usedIn = true;
      filters.push((r) => values.includes(column(r, name)));
      return api;
    },
    is: (name: string, value: unknown) => (filters.push((r) => column(r, name) === value), api),
    not: (name: string, operator: string, value: unknown) => {
      if (operator === "eq" || operator === "is") filters.push((r) => column(r, name) !== value);
      else if (operator === "in") {
        const list = String(value).replace(/^\(|\)$/g, "").split(",");
        filters.push((r) => !list.includes(String(column(r, name))));
      } else throw new Error(`fake client: unsupported not() operator ${operator}`);
      return api;
    },
    order: () => api,
    returns: () => api,
    limit: (n: number) => ((limit = n), api),
    range: (from: number, to: number) => ((offset = from), (limit = to - from + 1), api),
    maybeSingle: async () => {
      const result = run();
      return { ...result, data: Array.isArray(result.data) ? (result.data[0] ?? null) : null };
    },
    single: async () => {
      const result = run();
      return { ...result, data: Array.isArray(result.data) ? (result.data[0] ?? null) : null };
    },
    then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(run()).then(resolve, reject),
  };
  return api;
}

function fakeClient() {
  return {
    auth: {
      getUser: async () => {
        state.log.push("getUser");
        return { data: { user: state.user }, error: null };
      },
      getClaims: () => {
        throw new Error("getClaims() must not be used: it accepts a revoked token (ADR 0005)");
      },
    },
    from(table: string) {
      if (table !== "notebook_members") throw new Error(`fake client: unexpected table ${table}`);
      return query();
    },
  };
}

function makeDeps(overrides: Partial<{ deleteAuthUser: (id: string) => Promise<void>; signOut: (o: unknown) => Promise<unknown> }> = {}) {
  const client = fakeClient();
  const deleteAuthUser = vi.fn(
    overrides.deleteAuthUser ??
      (async (id: string) => {
        state.log.push(`admin:${id}`);
      }),
  );
  const signOut = vi.fn(
    overrides.signOut ??
      (async (options: unknown) => {
        state.log.push(`signOut:${JSON.stringify(options)}`);
        return { error: null };
      }),
  );
  const adminConfigured = vi.fn(() => {
    state.log.push("adminConfigured");
    return state.adminOk;
  });
  return { client, deleteAuthUser, signOut, adminConfigured, deps: { client, deleteAuthUser, signOut, adminConfigured } };
}

function form(fields: Record<string, string | string[]> = { confirm: "on" }): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    for (const v of Array.isArray(value) ? value : [value]) data.append(name, v);
  }
  return data;
}

function run(deps: ReturnType<typeof makeDeps>["deps"], data: FormData = form()) {
  // The deps object is typed by the implementation; the test only supplies the contract above.
  return deleteAccount(deps as never, data);
}

const deletedIds = () => state.log.filter((e) => e.startsWith("delete:")).map((e) => e.slice("delete:".length));
const nothingDestructiveHappened = () =>
  state.log.filter((e) => e.startsWith("delete:") || e.startsWith("admin:") || e.startsWith("signOut:"));

beforeEach(() => {
  state = {
    user: { id: ME, is_anonymous: false },
    members: baseMembers(),
    membersError: false,
    membersErrorOnIn: false,
    inCalls: [],
    adminOk: true,
    log: [],
    nextLate: 900,
  };
  deleteNotebookMock.mockReset();
  deleteNotebookMock.mockImplementation(async (_client: unknown, id: string) => {
    state.log.push(`delete:${id}`);
    state.members = state.members.filter((m) => m.notebook_id !== id);
    return { removedPaths: [] };
  });
});

describe("happy path", () => {
  it("deletes the notebooks the user owns alone (shared or not), then the auth user, then signs out, in that order", async () => {
    const { deps, deleteAuthUser, signOut } = makeDeps();

    const result = await run(deps);

    expect(result).toEqual({ redirectTo: "/login?konto=geloescht" });
    expect(new Set(deletedIds())).toEqual(new Set([NB_A, NB_B]));
    expect(deleteAuthUser).toHaveBeenCalledTimes(1);
    expect(deleteAuthUser).toHaveBeenCalledWith(ME);
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(signOut).toHaveBeenCalledWith({ scope: "local" });

    const lastDelete = state.log.map((e) => e.startsWith("delete:")).lastIndexOf(true);
    const admin = state.log.indexOf(`admin:${ME}`);
    const out = state.log.indexOf(`signOut:${JSON.stringify({ scope: "local" })}`);
    expect(lastDelete).toBeGreaterThanOrEqual(0);
    expect(admin).toBeGreaterThan(lastDelete);
    expect(out).toBeGreaterThan(admin);
  });

  it("checks the session with getUser() first, before any deletion", async () => {
    const { deps } = makeDeps();
    await run(deps);

    expect(state.log[0]).toBe("getUser");
    expect(state.log).not.toContain("getClaims");
  });

  it("asks adminConfigured() before the first notebook is deleted", async () => {
    const { deps, adminConfigured } = makeDeps();
    await run(deps);

    expect(adminConfigured).toHaveBeenCalled();
    expect(state.log.indexOf("adminConfigured")).toBeGreaterThanOrEqual(0);
    expect(state.log.indexOf("adminConfigured")).toBeLessThan(state.log.findIndex((e) => e.startsWith("delete:")));
  });

  it("deletes each notebook with the user's own client and id (RLS and the owner check decide)", async () => {
    const { deps, client } = makeDeps();
    await run(deps);

    expect(deleteNotebookMock).toHaveBeenCalledTimes(2);
    for (const call of deleteNotebookMock.mock.calls) {
      expect(call[0]).toBe(client);
      expect([NB_A, NB_B]).toContain(call[1]);
      if (call[2] !== undefined) expect(call[2]).toBe(ME);
    }
  });

  it("never deletes a notebook with another owner, nor one where the user is only editor or viewer", async () => {
    const { deps } = makeDeps();
    await run(deps);

    for (const id of [NB_C, NB_D, NB_E, NB_VICTIM]) {
      expect(deletedIds()).not.toContain(id);
    }
  });

  it("a user without any notebook still gets the auth user deleted and signed out", async () => {
    state.members = state.members.filter((m) => m.user_id !== ME);
    const { deps, deleteAuthUser, signOut } = makeDeps();

    const result = await run(deps);

    expect(result).toEqual({ redirectTo: "/login?konto=geloescht" });
    expect(deleteNotebookMock).not.toHaveBeenCalled();
    expect(deleteAuthUser).toHaveBeenCalledWith(ME);
    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
  });

  it("works the same for an anonymous demo user", async () => {
    state.user = { id: ME, is_anonymous: true };
    const { deps, deleteAuthUser } = makeDeps();

    const result = await run(deps);

    expect(result).toEqual({ redirectTo: "/login?konto=geloescht" });
    expect(new Set(deletedIds())).toEqual(new Set([NB_A, NB_B]));
    expect(deleteAuthUser).toHaveBeenCalledWith(ME);
  });

  it("a failing sign-out after the auth user is gone still ends on the done page", async () => {
    const { deps, deleteAuthUser } = makeDeps({
      signOut: async () => {
        throw new Error("session already gone");
      },
    });

    const result = await run(deps);

    expect(deleteAuthUser).toHaveBeenCalledWith(ME);
    expect(result).toEqual({ redirectTo: "/login?konto=geloescht" });
  });
});

describe("the form never decides who is deleted", () => {
  it("ignores userId, user_id and notebookId fields: only the session user and their own notebooks are touched", async () => {
    const { deps, deleteAuthUser } = makeDeps();

    await run(deps, form({ confirm: "on", userId: VICTIM, user_id: VICTIM, notebookId: NB_VICTIM, notebook_id: [NB_VICTIM, NB_C] }));

    expect(deleteAuthUser).toHaveBeenCalledTimes(1);
    expect(deleteAuthUser).toHaveBeenCalledWith(ME);
    expect(deletedIds()).not.toContain(NB_VICTIM);
    expect(deletedIds()).not.toContain(NB_C);
    expect(new Set(deletedIds())).toEqual(new Set([NB_A, NB_B]));
  });
});

describe("confirmation and session", () => {
  it.each([
    ["no confirm field", {}],
    ["confirm off", { confirm: "off" }],
    ["confirm true", { confirm: "true" }],
    ["confirm empty", { confirm: "" }],
    ["confirm ON in capitals", { confirm: "ON" }],
  ])("%s: nothing is deleted, signed out or sent to the admin API", async (_label, fields) => {
    const { deps, deleteAuthUser, signOut } = makeDeps();

    const result = await run(deps, form(fields));

    expect(result).toEqual({ redirectTo: "/profil?fehler=bestaetigung" });
    expect(deleteNotebookMock).not.toHaveBeenCalled();
    expect(deleteAuthUser).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
    expect(nothingDestructiveHappened()).toEqual([]);
  });

  it("not signed in: goes to /login and does nothing else", async () => {
    state.user = null;
    const { deps, deleteAuthUser, signOut } = makeDeps();

    const result = await run(deps);

    expect(result).toEqual({ redirectTo: "/login" });
    expect(deleteNotebookMock).not.toHaveBeenCalled();
    expect(deleteAuthUser).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
  });
});

describe("fails closed", () => {
  it("with the admin key not configured, nothing at all is deleted (notebooks included)", async () => {
    state.adminOk = false;
    const { deps, deleteAuthUser, signOut } = makeDeps();

    const result = await run(deps);

    expect(result).toEqual({ redirectTo: "/profil?fehler=konto_loeschen" });
    expect(deleteNotebookMock).not.toHaveBeenCalled();
    expect(deleteAuthUser).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
    expect(state.members.filter((m) => m.user_id === ME)).toHaveLength(baseMembers().filter((m) => m.user_id === ME).length);
  });

  it("stops at the first notebook that cannot be deleted: no further deletes, no admin call, no sign-out", async () => {
    deleteNotebookMock.mockReset();
    deleteNotebookMock.mockImplementation(async (_client: unknown, id: string) => {
      state.log.push(`delete:${id}`);
      throw Object.assign(new Error("deleteNotebook: files are left"), { code: "42501" });
    });
    const { deps, deleteAuthUser, signOut } = makeDeps();

    const result = await run(deps);

    expect(result).toEqual({ redirectTo: "/profil?fehler=konto_loeschen" });
    expect(deleteNotebookMock).toHaveBeenCalledTimes(1);
    expect(deleteAuthUser).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
  });

  it("the error redirect is a fixed string: it never carries the error message", async () => {
    deleteNotebookMock.mockReset();
    deleteNotebookMock.mockRejectedValue(new Error("secret-internal-detail-77"));
    const { deps } = makeDeps();

    const result = await run(deps);

    expect(result.redirectTo).toBe("/profil?fehler=konto_loeschen");
    expect(result.redirectTo).not.toContain("secret-internal-detail-77");
  });

  it("when the first notebook is deleted and the second fails, the admin call still does not happen", async () => {
    let calls = 0;
    deleteNotebookMock.mockReset();
    deleteNotebookMock.mockImplementation(async (_client: unknown, id: string) => {
      calls += 1;
      state.log.push(`delete:${id}`);
      if (calls === 2) throw new Error("second one fails");
      state.members = state.members.filter((m) => m.notebook_id !== id);
      return { removedPaths: [] };
    });
    const { deps, deleteAuthUser, signOut } = makeDeps();

    const result = await run(deps);

    expect(result).toEqual({ redirectTo: "/profil?fehler=konto_loeschen" });
    expect(deleteNotebookMock).toHaveBeenCalledTimes(2);
    expect(deleteAuthUser).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
  });

  it("a failing membership lookup deletes nothing and does not call the admin API", async () => {
    state.membersError = true;
    const { deps, deleteAuthUser, signOut } = makeDeps();

    const result = await run(deps);

    expect(result).toEqual({ redirectTo: "/profil?fehler=konto_loeschen" });
    expect(deleteNotebookMock).not.toHaveBeenCalled();
    expect(deleteAuthUser).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
  });

  it("a failing admin call ends on the error page and does not sign out", async () => {
    const { deps, signOut } = makeDeps({
      deleteAuthUser: async () => {
        throw new Error("admin api said no");
      },
    });

    const result = await run(deps);

    expect(result).toEqual({ redirectTo: "/profil?fehler=konto_loeschen" });
    expect(signOut).not.toHaveBeenCalled();
  });
});

// deletionSummary(client, userId): Promise<{ sole: number; shared: number } | null>
// sole = notebooks the user owns alone (same rule as soleOwnedNotebooks), shared = how many of
// those have at least one other member (any role). Membership lookups by notebook id come in
// batches of at most 100 ids. ANY lookup error returns null, never a partial count.
describe("deletionSummary", () => {
  it("counts sole and shared for the fixture (A sole, B sole and shared, C co-owned, D/E others')", async () => {
    const { client } = makeDeps();
    expect(await deletionSummary(client as never, ME)).toEqual({ sole: 2, shared: 1 });
  });

  it("a user without notebooks gets zero and zero", async () => {
    state.members = state.members.filter((m) => m.user_id !== ME);
    const { client } = makeDeps();
    expect(await deletionSummary(client as never, ME)).toEqual({ sole: 0, shared: 0 });
  });

  it("returns null when the members query errors", async () => {
    state.membersError = true;
    const { client } = makeDeps();
    expect(await deletionSummary(client as never, ME)).toBeNull();
  });

  it("returns null, not a partial count, when only the batched lookup errors", async () => {
    state.membersErrorOnIn = true;
    const { client } = makeDeps();
    expect(await deletionSummary(client as never, ME)).toBeNull();
  });

  it("with 150 sole-owned notebooks every .in() carries at most 100 ids and the counts are right", async () => {
    state.members = [];
    for (let i = 0; i < 150; i++) {
      const id = uuid(1000 + i);
      state.members.push({ notebook_id: id, user_id: ME, role: "owner" });
      if (i % 3 === 0) state.members.push({ notebook_id: id, user_id: EDITOR, role: "viewer" }); // 50 shared
    }
    const { client } = makeDeps();

    const result = await deletionSummary(client as never, ME);

    expect(result).toEqual({ sole: 150, shared: 50 });
    expect(state.inCalls.length).toBeGreaterThanOrEqual(2);
    for (const n of state.inCalls) expect(n).toBeLessThanOrEqual(100);
  });
});

describe("re-check before the admin call", () => {
  it("a sole-owned notebook that appeared meanwhile gets one more pass and is deleted before the admin call", async () => {
    const late = uuid(901);
    let added = false;
    deleteNotebookMock.mockReset();
    deleteNotebookMock.mockImplementation(async (_client: unknown, id: string) => {
      state.log.push(`delete:${id}`);
      state.members = state.members.filter((m) => m.notebook_id !== id);
      if (!added) {
        added = true;
        state.members.push({ notebook_id: late, user_id: ME, role: "owner" });
      }
      return { removedPaths: [] };
    });
    const { deps, deleteAuthUser } = makeDeps();

    const result = await run(deps);

    expect(result).toEqual({ redirectTo: "/login?konto=geloescht" });
    expect(new Set(deletedIds())).toEqual(new Set([NB_A, NB_B, late]));
    expect(state.log.indexOf(`admin:${ME}`)).toBeGreaterThan(state.log.lastIndexOf(`delete:${late}`));
    expect(deleteAuthUser).toHaveBeenCalledWith(ME);
  });

  it("when new sole-owned notebooks keep appearing, it gives up with an error and never calls the admin API", async () => {
    deleteNotebookMock.mockReset();
    deleteNotebookMock.mockImplementation(async (_client: unknown, id: string) => {
      state.log.push(`delete:${id}`);
      state.members = state.members.filter((m) => m.notebook_id !== id);
      state.nextLate += 1;
      state.members.push({ notebook_id: uuid(state.nextLate), user_id: ME, role: "owner" });
      return { removedPaths: [] };
    });
    // Only one notebook to start with keeps the number of passes visible.
    state.members = state.members.filter((m) => m.notebook_id !== NB_B);
    const { deps, deleteAuthUser, signOut } = makeDeps();

    const result = await run(deps);

    expect(result).toEqual({ redirectTo: "/profil?fehler=konto_loeschen" });
    expect(deleteAuthUser).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
    // One initial pass plus one retry, not an endless loop.
    expect(deleteNotebookMock.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it("a delete that reports success but leaves the notebook behind is caught: error, no admin call", async () => {
    deleteNotebookMock.mockReset();
    deleteNotebookMock.mockImplementation(async (_client: unknown, id: string) => {
      state.log.push(`delete:${id}`);
      return { removedPaths: [] }; // the membership rows stay
    });
    const { deps, deleteAuthUser, signOut } = makeDeps();

    const result = await run(deps);

    expect(result).toEqual({ redirectTo: "/profil?fehler=konto_loeschen" });
    expect(deleteAuthUser).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
    expect(deleteNotebookMock.mock.calls.length).toBeLessThanOrEqual(8);
  });
});
