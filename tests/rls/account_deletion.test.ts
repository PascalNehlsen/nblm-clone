// Account deletion against the real local stack: deleteAccount() driven with real signed-in
// users and their own JWT clients (owner, editor, viewer, stranger, anonymous demo user, no
// session). Never the admin credential: the admin call is a recording fake, so these tests
// prove what happens BEFORE it (which notebooks go, in what state the data is left, and that
// the admin call is never reached when something fails). That the auth user and its rows are
// removed by the cascade is proven in supabase/tests/database/080_account_deletion.test.sql.
//
// Contract: see tests/unit/account/delete-account.test.ts. deleteAccount(deps, form) returns
// { redirectTo }. It is imported by a RELATIVE path and its own imports must be relative too:
// the "rls" vitest project has no "@/" alias (tests/unit/account/boundary.test.ts pins this).
// "server-only" is stubbed here, the same way the "unit" project aliases it to an empty module.
//
// What a client can show after the run: once a notebook row is gone, the Storage policies find
// no source row and hide every object under it, so "no objects visible" alone would also hold
// for a leftover. The Storage-first order is therefore proven the other way round, with a
// client whose Storage removal fails: the notebook, its source and its object must all still be
// there afterwards, and the admin call must not happen.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { anonClient, signInAnonymousUser, signUpUser, type SignedInUser } from "./helpers/clients";
import { tryCreateNotebook, readCopy } from "./helpers/demo";
import { addMember, createNotebook } from "./helpers/notebooks";
import { createSourceWithChunks, insertCitation, insertMessage, storagePath } from "./helpers/sources";

vi.mock("server-only", () => ({}));

import { deleteAccount } from "../../apps/web/lib/server/account/delete-account";

const BUCKET = "sources";
const DONE = "/login?konto=geloescht";
const FAILED = "/profil?fehler=konto_loeschen";
const UNCONFIRMED = "/profil?fehler=bestaetigung";

// --- recording deps ---------------------------------------------------------------------

type ClientLike = SignedInUser["client"];

function recordingDeps(client: ClientLike, options: { adminConfigured?: boolean } = {}) {
  const adminCalls: string[] = [];
  const signOutCalls: unknown[] = [];
  return {
    adminCalls,
    signOutCalls,
    deps: {
      client,
      adminConfigured: () => options.adminConfigured ?? true,
      deleteAuthUser: async (userId: string) => {
        adminCalls.push(userId);
      },
      signOut: async (signOutOptions: unknown) => {
        signOutCalls.push(signOutOptions);
        return { error: null };
      },
    },
  };
}

function confirmed(): FormData {
  const form = new FormData();
  form.set("confirm", "on");
  return form;
}

/** Wraps a client so that storage.from(bucket).<method> is replaced; everything else is real. */
function withStorageOverride(
  client: ClientLike,
  overrides: Record<string, (...args: never[]) => Promise<unknown>>,
): ClientLike {
  const bind = (target: object, property: string | symbol) => {
    const value = Reflect.get(target, property, target) as unknown;
    return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
  };
  return new Proxy(client, {
    get(target, property) {
      if (property !== "storage") return bind(target, property);
      return {
        from: (bucket: string) => {
          const real = target.storage.from(bucket);
          return new Proxy(real, {
            get(inner, method) {
              if (typeof method === "string" && method in overrides) return overrides[method];
              return bind(inner, method);
            },
          });
        },
      };
    },
  });
}

// --- fixtures ---------------------------------------------------------------------------

interface Snapshot {
  notebooks: number;
  sources: number;
  chunks: number;
  messages: number;
  objects: number;
}

/** What `user` can see of one notebook, through their own client and RLS. */
async function snapshot(user: SignedInUser, notebookId: string): Promise<Snapshot> {
  const count = async (table: string, column: string): Promise<number> => {
    const { data, error } = await user.client.from(table).select("id").eq(column, notebookId);
    if (error) throw new Error(`snapshot ${table}: ${error.code} ${error.message}`);
    return data?.length ?? 0;
  };
  const listing = await user.client.storage.from(BUCKET).list(notebookId);
  if (listing.error) throw new Error(`snapshot storage: ${listing.error.message}`);
  return {
    notebooks: await count("notebooks", "id"),
    sources: await count("sources", "notebook_id"),
    chunks: await count("chunks", "notebook_id"),
    messages: await count("messages", "notebook_id"),
    objects: listing.data?.length ?? 0,
  };
}

const EMPTY: Snapshot = { notebooks: 0, sources: 0, chunks: 0, messages: 0, objects: 0 };

interface Content {
  notebookId: string;
  sourceId: string;
  chunkId: string;
  path: string;
}

/** A notebook owned by `owner` with a ready source, a chunk, an uploaded object and one message. */
async function notebookWithContent(owner: SignedInUser, label: string): Promise<Content> {
  const notebookId = await createNotebook(owner, label);
  const { sourceId, chunkIds } = await createSourceWithChunks(owner, notebookId, 1, 0.01);
  const chunkId = chunkIds[0];
  if (chunkId === undefined) throw new Error("expected one chunk id");
  const path = storagePath(notebookId, sourceId);
  const { error } = await owner.client.storage
    .from(BUCKET)
    .upload(path, Buffer.from(`content of ${label}\n`, "utf8"), { contentType: "text/plain" });
  if (error) throw new Error(`fixture upload failed: ${error.message}`);
  const messageId = await insertMessage(owner, notebookId, "assistant", `answer in ${label}`);
  await insertCitation(owner, notebookId, messageId, 1, { chunkId, quote: "chunk 0" });
  return { notebookId, sourceId, chunkId, path };
}

async function canDownload(user: SignedInUser, path: string): Promise<boolean> {
  const { data, error } = await user.client.storage.from(BUCKET).download(path);
  return !error && data !== null;
}

// --- 1) owner with a shared, sole-owned notebook ----------------------------------------

describe("an owner deletes their account: sole-owned notebooks go, everyone else's data stays", () => {
  let owner: SignedInUser;
  let editor: SignedInUser;
  let viewer: SignedInUser;
  let coOwner: SignedInUser;
  let stranger: SignedInUser;
  let sole: Content;
  let soleEditorMessageId: string;
  let co: Content;
  let editorOf: Content;
  let viewerOf: Content;
  let strangerOwn: Content;
  let result: { redirectTo: string };
  let admin: ReturnType<typeof recordingDeps>;

  beforeAll(async () => {
    owner = await signUpUser("acct-del-owner");
    editor = await signUpUser("acct-del-editor");
    viewer = await signUpUser("acct-del-viewer");
    coOwner = await signUpUser("acct-del-coowner");
    stranger = await signUpUser("acct-del-stranger");

    sole = await notebookWithContent(owner, "acct-del-sole");
    await addMember(owner, sole.notebookId, editor.userId, "editor");
    await addMember(owner, sole.notebookId, viewer.userId, "viewer");
    soleEditorMessageId = await insertMessage(editor, sole.notebookId, "user", "editor question in the sole notebook");

    co = await notebookWithContent(owner, "acct-del-co");
    await addMember(owner, co.notebookId, coOwner.userId, "owner");
    await insertMessage(coOwner, co.notebookId, "user", "co-owner question");

    editorOf = await notebookWithContent(coOwner, "acct-del-editor-of");
    await addMember(coOwner, editorOf.notebookId, owner.userId, "editor");
    viewerOf = await notebookWithContent(coOwner, "acct-del-viewer-of");
    await addMember(coOwner, viewerOf.notebookId, owner.userId, "viewer");

    strangerOwn = await notebookWithContent(stranger, "acct-del-stranger-own");
  });

  it("before: the fixture is really there (so the checks after the run are not vacuous)", async () => {
    expect(await snapshot(owner, sole.notebookId)).toMatchObject({ notebooks: 1, sources: 1, chunks: 1, objects: 1 });
    expect(await snapshot(editor, sole.notebookId)).toMatchObject({ notebooks: 1, sources: 1, chunks: 1, objects: 1 });
    expect(await snapshot(viewer, sole.notebookId)).toMatchObject({ notebooks: 1, sources: 1, chunks: 1, objects: 1 });
    expect((await snapshot(editor, sole.notebookId)).messages).toBeGreaterThanOrEqual(1);
    expect(await snapshot(owner, co.notebookId)).toMatchObject({ notebooks: 1, sources: 1, chunks: 1, objects: 1 });
    expect(await snapshot(coOwner, co.notebookId)).toMatchObject({ notebooks: 1, sources: 1, chunks: 1, objects: 1 });
    expect(await snapshot(stranger, sole.notebookId)).toEqual(EMPTY);
    expect(await canDownload(editor, sole.path)).toBe(true);
  });

  it("deleteAccount reports done and calls the admin API once, with the session user's id only", async () => {
    admin = recordingDeps(owner.client);
    const form = confirmed();
    // Forged fields must change nothing.
    form.set("userId", stranger.userId);
    form.set("notebookId", strangerOwn.notebookId);

    result = await deleteAccount(admin.deps as never, form);

    expect(result).toEqual({ redirectTo: DONE });
    expect(admin.adminCalls).toEqual([owner.userId]);
    expect(admin.signOutCalls).toEqual([{ scope: "local" }]);
  });

  it("the notebook the owner owned alone is gone for every client, with sources, chunks, messages and Storage objects", async () => {
    for (const user of [owner, editor, viewer, coOwner, stranger]) {
      expect(await snapshot(user, sole.notebookId)).toEqual(EMPTY);
    }
    expect(await canDownload(owner, sole.path)).toBe(false);
    expect(await canDownload(editor, sole.path)).toBe(false);
    const editorMessage = await editor.client.from("messages").select("id").eq("id", soleEditorMessageId);
    expect(editorMessage.error).toBeNull();
    expect(editorMessage.data).toEqual([]);
    const citations = await owner.client.from("message_citations").select("message_id").eq("notebook_id", sole.notebookId);
    expect(citations.data ?? []).toEqual([]);
  });

  it("the co-owned notebook stays, intact for the other owner (membership removal is the auth user delete's job)", async () => {
    expect(await snapshot(coOwner, co.notebookId)).toMatchObject({ notebooks: 1, sources: 1, chunks: 1, objects: 1 });
    expect(await canDownload(coOwner, co.path)).toBe(true);
    const messages = await coOwner.client.from("messages").select("id").eq("notebook_id", co.notebookId);
    expect(messages.data?.length).toBeGreaterThanOrEqual(1);
  });

  it("notebooks where the user was only editor or viewer are never deleted", async () => {
    expect(await snapshot(coOwner, editorOf.notebookId)).toMatchObject({ notebooks: 1, sources: 1, chunks: 1, objects: 1 });
    expect(await snapshot(coOwner, viewerOf.notebookId)).toMatchObject({ notebooks: 1, sources: 1, chunks: 1, objects: 1 });
    expect(await canDownload(coOwner, editorOf.path)).toBe(true);
    expect(await canDownload(coOwner, viewerOf.path)).toBe(true);
  });

  it("a stranger's notebook is untouched", async () => {
    expect(await snapshot(stranger, strangerOwn.notebookId)).toMatchObject({ notebooks: 1, sources: 1, chunks: 1, objects: 1 });
    expect(await canDownload(stranger, strangerOwn.path)).toBe(true);
  });
});

// --- 2) editor and viewer runs ----------------------------------------------------------

describe("editor and viewer runs delete only what they own alone", () => {
  let owner: SignedInUser;
  let editor: SignedInUser;
  let viewer: SignedInUser;
  let shared: Content;
  let editorOwn: Content;
  let viewerOwn: Content;

  beforeAll(async () => {
    owner = await signUpUser("acct-del-role-owner");
    editor = await signUpUser("acct-del-role-editor");
    viewer = await signUpUser("acct-del-role-viewer");
    shared = await notebookWithContent(owner, "acct-del-role-shared");
    await addMember(owner, shared.notebookId, editor.userId, "editor");
    await addMember(owner, shared.notebookId, viewer.userId, "viewer");
    editorOwn = await notebookWithContent(editor, "acct-del-role-editor-own");
    viewerOwn = await notebookWithContent(viewer, "acct-del-role-viewer-own");
  });

  it("an editor's run deletes their own notebook but never the shared one they only edit", async () => {
    const admin = recordingDeps(editor.client);

    const result = await deleteAccount(admin.deps as never, confirmed());

    expect(result).toEqual({ redirectTo: DONE });
    expect(admin.adminCalls).toEqual([editor.userId]);
    expect(await snapshot(editor, editorOwn.notebookId)).toEqual(EMPTY);
    expect(await snapshot(owner, shared.notebookId)).toMatchObject({ notebooks: 1, sources: 1, chunks: 1, objects: 1 });
    expect(await canDownload(owner, shared.path)).toBe(true);
  });

  it("a viewer's run deletes their own notebook but never the shared one they only read", async () => {
    const admin = recordingDeps(viewer.client);

    const result = await deleteAccount(admin.deps as never, confirmed());

    expect(result).toEqual({ redirectTo: DONE });
    expect(admin.adminCalls).toEqual([viewer.userId]);
    expect(await snapshot(viewer, viewerOwn.notebookId)).toEqual(EMPTY);
    expect(await snapshot(owner, shared.notebookId)).toMatchObject({ notebooks: 1, sources: 1, chunks: 1, objects: 1 });
    expect(await canDownload(owner, shared.path)).toBe(true);
  });
});

// --- 3) fail closed with real data ------------------------------------------------------

describe("the admin API is never reached while something is left to fail", () => {
  it("a Storage removal that errors leaves the notebook, its source and its object, and no admin call", async () => {
    const owner = await signUpUser("acct-del-storage-error");
    const content = await notebookWithContent(owner, "acct-del-storage-error");
    const broken = withStorageOverride(owner.client, {
      remove: async () => ({ data: null, error: { message: "storage is down" } }),
    });
    const admin = recordingDeps(broken);

    const result = await deleteAccount(admin.deps as never, confirmed());

    expect(result).toEqual({ redirectTo: FAILED });
    expect(admin.adminCalls).toEqual([]);
    expect(admin.signOutCalls).toEqual([]);
    expect(await snapshot(owner, content.notebookId)).toMatchObject({ notebooks: 1, sources: 1, chunks: 1, objects: 1 });
    expect(await canDownload(owner, content.path)).toBe(true);
  });

  it("a Storage removal that reports success but removes nothing is caught: files left, no admin call", async () => {
    const owner = await signUpUser("acct-del-storage-silent");
    const content = await notebookWithContent(owner, "acct-del-storage-silent");
    const silent = withStorageOverride(owner.client, { remove: async () => ({ data: [], error: null }) });
    const admin = recordingDeps(silent);

    const result = await deleteAccount(admin.deps as never, confirmed());

    expect(result).toEqual({ redirectTo: FAILED });
    expect(admin.adminCalls).toEqual([]);
    expect(await snapshot(owner, content.notebookId)).toMatchObject({ notebooks: 1, sources: 1, chunks: 1, objects: 1 });
  });

  it("a failing notebook does not stop the earlier ones from being gone, but still blocks the admin call", async () => {
    const owner = await signUpUser("acct-del-partial");
    const first = await notebookWithContent(owner, "acct-del-partial-1");
    const second = await notebookWithContent(owner, "acct-del-partial-2");
    // Fail Storage removal only for one of the two notebooks.
    const failingPrefix = second.notebookId;
    const real = owner.client.storage.from(BUCKET);
    const partial = withStorageOverride(owner.client, {
      remove: async (...args: never[]) => {
        const paths = (args as unknown as [string[]])[0];
        if (paths.some((p) => p.startsWith(failingPrefix))) return { data: null, error: { message: "storage is down" } };
        return real.remove(paths);
      },
    });
    const admin = recordingDeps(partial);

    const result = await deleteAccount(admin.deps as never, confirmed());

    expect(result).toEqual({ redirectTo: FAILED });
    expect(admin.adminCalls).toEqual([]);
    // The second notebook is whole, because Storage comes first and its removal failed.
    expect(await snapshot(owner, second.notebookId)).toMatchObject({ notebooks: 1, sources: 1, chunks: 1, objects: 1 });
    // Whatever happened to the first, it is either whole or completely gone, never half-deleted.
    const firstState = await snapshot(owner, first.notebookId);
    expect([EMPTY, { notebooks: 1, sources: 1, chunks: 1, messages: 1, objects: 1 }]).toContainEqual(firstState);
  });

  it("without the confirm field nothing is deleted and the admin API is not called", async () => {
    const owner = await signUpUser("acct-del-unconfirmed");
    const content = await notebookWithContent(owner, "acct-del-unconfirmed");
    const admin = recordingDeps(owner.client);

    const result = await deleteAccount(admin.deps as never, new FormData());

    expect(result).toEqual({ redirectTo: UNCONFIRMED });
    expect(admin.adminCalls).toEqual([]);
    expect(admin.signOutCalls).toEqual([]);
    expect(await snapshot(owner, content.notebookId)).toMatchObject({ notebooks: 1, sources: 1, chunks: 1, objects: 1 });
  });

  it("with the admin key not configured nothing is deleted at all", async () => {
    const owner = await signUpUser("acct-del-no-key");
    const content = await notebookWithContent(owner, "acct-del-no-key");
    const admin = recordingDeps(owner.client, { adminConfigured: false });

    const result = await deleteAccount(admin.deps as never, confirmed());

    expect(result).toEqual({ redirectTo: FAILED });
    expect(admin.adminCalls).toEqual([]);
    expect(admin.signOutCalls).toEqual([]);
    expect(await snapshot(owner, content.notebookId)).toMatchObject({ notebooks: 1, sources: 1, chunks: 1, objects: 1 });
    expect(await canDownload(owner, content.path)).toBe(true);
  });

  it("a client without a session is sent to /login and nothing is called", async () => {
    const admin = recordingDeps(anonClient());

    const result = await deleteAccount(admin.deps as never, confirmed());

    expect(result).toEqual({ redirectTo: "/login" });
    expect(admin.adminCalls).toEqual([]);
    expect(admin.signOutCalls).toEqual([]);
  });

  it("a stranger's session cannot delete someone else's notebook by sending its id", async () => {
    const owner = await signUpUser("acct-del-forged-owner");
    const stranger = await signUpUser("acct-del-forged-stranger");
    const content = await notebookWithContent(owner, "acct-del-forged");
    const admin = recordingDeps(stranger.client);
    const form = confirmed();
    form.set("notebookId", content.notebookId);
    form.set("userId", owner.userId);

    const result = await deleteAccount(admin.deps as never, form);

    expect(result).toEqual({ redirectTo: DONE });
    expect(admin.adminCalls).toEqual([stranger.userId]);
    expect(await snapshot(owner, content.notebookId)).toMatchObject({ notebooks: 1, sources: 1, chunks: 1, objects: 1 });
    expect(await canDownload(owner, content.path)).toBe(true);
  });
});

// --- 4) anonymous demo user -------------------------------------------------------------

describe("an anonymous demo user ends the demo", () => {
  it("their copy of the demo notebook is deleted, another demo user's copy and the template are not", async () => {
    const leaving = await signInAnonymousUser();
    const staying = await signInAnonymousUser();
    const mine = await tryCreateNotebook(leaving, `demo-leave ${randomUUID()}`);
    const theirs = await tryCreateNotebook(staying, `demo-stay ${randomUUID()}`);
    expect(mine.error).toBeNull();
    expect(theirs.error).toBeNull();
    expect((await readCopy(leaving, mine.notebookId)).sources.length).toBeGreaterThan(0);
    const stayingBefore = await readCopy(staying, theirs.notebookId);
    expect(stayingBefore.sources.length).toBeGreaterThan(0);

    const admin = recordingDeps(leaving.client);
    const result = await deleteAccount(admin.deps as never, confirmed());

    expect(result).toEqual({ redirectTo: DONE });
    expect(admin.adminCalls).toEqual([leaving.userId]);
    expect(admin.signOutCalls).toEqual([{ scope: "local" }]);
    expect((await snapshot(leaving, mine.notebookId)).notebooks).toBe(0);
    const gone = await readCopy(leaving, mine.notebookId);
    expect(gone.sources).toEqual([]);
    expect(gone.chunks).toEqual([]);

    const stayingAfter = await readCopy(staying, theirs.notebookId);
    expect(stayingAfter.sources.map((s) => s.id).sort()).toEqual(stayingBefore.sources.map((s) => s.id).sort());
    expect(stayingAfter.chunks.length).toBe(stayingBefore.chunks.length);
  });
});
