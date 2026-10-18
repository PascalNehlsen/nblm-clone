// RLS behaviour for PR B2's app-level library functions
// (apps/web/lib/notebooks/notebooks.ts and apps/web/lib/notebooks/members.ts),
// imported directly and driven with real signed-in users' own SupabaseClient
// instances (never the admin/service-role credential, per AGENTS.md). These functions are thin
// wrappers around PostgREST calls that run under the user's JWT, so RLS
// (supabase/migrations/20261017120000_notebooks_memberships.sql) is what
// actually enforces every rejection asserted below; the wrapper's job is only
// to turn "0 rows changed" / a specific Postgres error code into the
// { ok: true } | { ok: false, code } shape the server actions and UI use.
//
// Imported by relative path, not the "@/..." alias: the "rls" vitest project
// (vitest.config.ts) has no such alias configured, unlike "unit" -- see the
// "internal imports are relative" guard in tests/unit/notebooks/roles.test.ts
// for why that matters for files living under apps/web/lib/notebooks.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { signUpUser, type SignedInUser } from "./helpers/clients";
import { addMember as addMemberRow, createNotebook as createNotebookRow } from "./helpers/notebooks";
import { createSource, storagePath } from "./helpers/sources";
import {
  createNotebook,
  deleteNotebook,
  getNotebook,
  listNotebooks,
} from "../../apps/web/lib/notebooks/notebooks";
import { addMember, changeRole, listMembers, removeMember } from "../../apps/web/lib/notebooks/members";

describe("createNotebook (lib): creator becomes owner, no RETURNING on insert", () => {
  it("creates a notebook and the creator is its owner", async () => {
    // helpers/notebooks.ts's own createNotebook() (the raw-insert helper used
    // everywhere else in the RLS matrix) deliberately never calls .select()
    // after insert, because the owner membership row that the select policy
    // depends on is written by an AFTER INSERT trigger that has not run yet
    // when RETURNING would be evaluated (see that file's comment, and the
    // migration's "notebooks_insert" policy comment). The lib function under
    // test here must have the same shape: if it added .select() (or
    // .select().single()), this call would reject with PGRST116 ("no rows
    // returned") instead of resolving, since the exact same race applies.
    const user = await signUpUser("app-notebooks-create");
    const title = `app-notebooks-create ${randomUUID()}`;

    const id = await createNotebook(user.client, title);
    expect(typeof id).toBe("string");

    const notebooks = await listNotebooks(user.client);
    const own = notebooks.find((notebook) => notebook.id === id);
    expect(own).toBeDefined();
    expect(own?.title).toBe(title);
    expect(own?.role).toBe("owner");
  });
});

describe("listNotebooks / getNotebook (lib)", () => {
  it("listNotebooks only returns notebooks the user is a member of, with their own role", async () => {
    const owner = await signUpUser("app-notebooks-list-owner");
    const stranger = await signUpUser("app-notebooks-list-stranger");
    const notebookId = await createNotebookRow(owner, "app-notebooks-list");
    await addMemberRow(owner, notebookId, stranger.userId, "viewer");

    const ownerList = await listNotebooks(owner.client);
    expect(ownerList.find((n) => n.id === notebookId)?.role).toBe("owner");

    const strangerList = await listNotebooks(stranger.client);
    expect(strangerList.find((n) => n.id === notebookId)?.role).toBe("viewer");

    const outsider = await signUpUser("app-notebooks-list-outsider");
    const outsiderList = await listNotebooks(outsider.client);
    expect(outsiderList.find((n) => n.id === notebookId)).toBeUndefined();
  });

  it("getNotebook returns the notebook with the caller's role for a member, and null for a stranger", async () => {
    const owner = await signUpUser("app-notebooks-get-owner");
    const stranger = await signUpUser("app-notebooks-get-stranger");
    const notebookId = await createNotebookRow(owner, "app-notebooks-get");

    const asOwner = await getNotebook(owner.client, notebookId);
    expect(asOwner).toEqual({ id: notebookId, title: expect.any(String), role: "owner" });

    const asStranger = await getNotebook(stranger.client, notebookId);
    expect(asStranger).toBeNull();
  });

  it("getNotebook returns null for a notebook id that does not exist at all", async () => {
    const user = await signUpUser("app-notebooks-get-missing");
    expect(await getNotebook(user.client, randomUUID())).toBeNull();
  });
});

describe("addMember (lib)", () => {
  let owner: SignedInUser;
  let viewer: SignedInUser;
  let notebookId: string;

  beforeAll(async () => {
    owner = await signUpUser("app-notebooks-addmember-owner");
    viewer = await signUpUser("app-notebooks-addmember-viewer");
    notebookId = await createNotebookRow(owner, "app-notebooks-addmember");
    await addMemberRow(owner, notebookId, viewer.userId, "viewer");
  });

  it("lets the owner add a new member as viewer", async () => {
    const newUser = await signUpUser("app-notebooks-addmember-target");
    const result = await addMember(owner.client, notebookId, newUser.userId, "viewer");
    expect(result).toEqual({ ok: true });

    const members = await listMembers(owner.client, notebookId);
    expect(members.find((m) => m.userId === newUser.userId)?.role).toBe("viewer");
  });

  it("rejects a viewer adding someone else (0 rows changed under RLS -> ok: false, code: 42501)", async () => {
    const someone = await signUpUser("app-notebooks-addmember-by-viewer");
    const result = await addMember(viewer.client, notebookId, someone.userId, "viewer");
    expect(result).toEqual({ ok: false, code: "42501" });

    const members = await listMembers(owner.client, notebookId);
    expect(members.find((m) => m.userId === someone.userId)).toBeUndefined();
  });

  it("reports 23503 for an unknown user id (foreign key violation)", async () => {
    const result = await addMember(owner.client, notebookId, randomUUID(), "viewer");
    expect(result).toEqual({ ok: false, code: "23503" });
  });

  it("reports 23505 for a duplicate membership", async () => {
    const result = await addMember(owner.client, notebookId, viewer.userId, "viewer");
    expect(result).toEqual({ ok: false, code: "23505" });
  });
});

describe("changeRole (lib)", () => {
  it("an editor cannot promote themselves to owner; the role is unchanged on reread as the owner", async () => {
    const owner = await signUpUser("app-notebooks-changerole-owner");
    const editor = await signUpUser("app-notebooks-changerole-editor");
    const notebookId = await createNotebookRow(owner, "app-notebooks-changerole");
    await addMemberRow(owner, notebookId, editor.userId, "editor");

    const result = await changeRole(editor.client, notebookId, editor.userId, "owner");
    expect(result.ok).toBe(false);

    const members = await listMembers(owner.client, notebookId);
    expect(members.find((m) => m.userId === editor.userId)?.role).toBe("editor");
  });

  it("the owner demoting the sole owner (themselves) reports P0001, and the role is unchanged", async () => {
    const soleOwner = await signUpUser("app-notebooks-changerole-sole-owner");
    const notebookId = await createNotebookRow(soleOwner, "app-notebooks-changerole-sole");

    const result = await changeRole(soleOwner.client, notebookId, soleOwner.userId, "editor");
    expect(result).toEqual({ ok: false, code: "P0001" });

    const members = await listMembers(soleOwner.client, notebookId);
    expect(members.find((m) => m.userId === soleOwner.userId)?.role).toBe("owner");
  });

  it("the owner can change an editor's role to viewer", async () => {
    const owner = await signUpUser("app-notebooks-changerole-owner-success");
    const editor = await signUpUser("app-notebooks-changerole-editor-success");
    const notebookId = await createNotebookRow(owner, "app-notebooks-changerole-success");
    await addMemberRow(owner, notebookId, editor.userId, "editor");

    const result = await changeRole(owner.client, notebookId, editor.userId, "viewer");
    expect(result).toEqual({ ok: true });

    const members = await listMembers(owner.client, notebookId);
    expect(members.find((m) => m.userId === editor.userId)?.role).toBe("viewer");
  });
});

describe("removeMember (lib)", () => {
  it("a viewer cannot remove the owner; the owner is still a member afterwards", async () => {
    const owner = await signUpUser("app-notebooks-removemember-owner");
    const viewer = await signUpUser("app-notebooks-removemember-viewer");
    const notebookId = await createNotebookRow(owner, "app-notebooks-removemember");
    await addMemberRow(owner, notebookId, viewer.userId, "viewer");

    const result = await removeMember(viewer.client, notebookId, owner.userId);
    expect(result.ok).toBe(false);

    const members = await listMembers(owner.client, notebookId);
    expect(members.some((m) => m.userId === owner.userId)).toBe(true);
  });

  it("the owner can remove a viewer", async () => {
    const owner = await signUpUser("app-notebooks-removemember-owner-success");
    const viewer = await signUpUser("app-notebooks-removemember-viewer-success");
    const notebookId = await createNotebookRow(owner, "app-notebooks-removemember-success");
    await addMemberRow(owner, notebookId, viewer.userId, "viewer");

    const result = await removeMember(owner.client, notebookId, viewer.userId);
    expect(result).toEqual({ ok: true });

    const members = await listMembers(owner.client, notebookId);
    expect(members.some((m) => m.userId === viewer.userId)).toBe(false);
  });
});

describe("deleteNotebook (lib)", () => {
  it("rejects an editor: the notebook row and its source object remain afterwards", async () => {
    const owner = await signUpUser("app-notebooks-delete-editor-owner");
    const editor = await signUpUser("app-notebooks-delete-editor-editor");
    const notebookId = await createNotebookRow(owner, "app-notebooks-delete-editor");
    await addMemberRow(owner, notebookId, editor.userId, "editor");

    const sourceId = await createSource(owner, notebookId);
    const path = storagePath(notebookId, sourceId);
    const { error: uploadError } = await owner.client.storage
      .from("sources")
      .upload(path, Buffer.from("owned by the editor-delete test\n", "utf8"), { contentType: "text/plain" });
    if (uploadError) throw new Error(`fixture upload failed: ${uploadError.message}`);

    // Whether the lib function throws, resolves with removedPaths: [], or
    // something else is not pinned down here -- what matters is the real
    // invariant: an editor must not be able to delete the notebook or its
    // uploaded object. Swallow a possible throw and check the actual state.
    await deleteNotebook(editor.client, notebookId).catch(() => undefined);

    const stillThere = await getNotebook(owner.client, notebookId);
    expect(stillThere?.id).toBe(notebookId);

    const { error: downloadError } = await owner.client.storage.from("sources").download(path);
    expect(downloadError).toBeNull();
  });

  it("the owner deletes the notebook and its one uploaded object, returning that object's storage path", async () => {
    const owner = await signUpUser("app-notebooks-delete-owner-owner");
    const notebookId = await createNotebookRow(owner, "app-notebooks-delete-owner");
    const sourceId = await createSource(owner, notebookId);
    const path = storagePath(notebookId, sourceId);

    const { error: uploadError } = await owner.client.storage
      .from("sources")
      .upload(path, Buffer.from("owned by the owner-delete test\n", "utf8"), { contentType: "text/plain" });
    if (uploadError) throw new Error(`fixture upload failed: ${uploadError.message}`);

    const result = await deleteNotebook(owner.client, notebookId);
    expect(result.removedPaths).toEqual([path]);

    expect(await getNotebook(owner.client, notebookId)).toBeNull();
    // No download-after-delete check here (reviewer finding): once the
    // notebook (and its cascaded sources row) is gone, the Storage select
    // policy denies the download regardless of whether the object itself was
    // actually removed -- see tests/rls/storage.test.ts's "after the sources
    // row is deleted" section for the same caveat. That would make this
    // check pass vacuously even if deleteNotebook never called
    // storage.remove() at all. removedPaths above is the real proof the
    // object removal happened.
  });

  it("deleting a notebook with no sources at all still removes the notebook row (empty removedPaths)", async () => {
    const owner = await signUpUser("app-notebooks-delete-empty-owner");
    const notebookId = await createNotebookRow(owner, "app-notebooks-delete-empty");

    const result = await deleteNotebook(owner.client, notebookId);
    expect(result.removedPaths).toEqual([]);
    expect(await getNotebook(owner.client, notebookId)).toBeNull();
  });

  it("deletes a notebook whose source row was never actually uploaded to Storage (e.g. a failed/abandoned upload): the notebook is still gone, not stuck forever", async () => {
    // createSource() only inserts the sources row (storage_path is a
    // generated column, computed from notebook_id/id alone) -- it never
    // uploads anything. Storage's remove() only reports the paths it really
    // removed, so asking it to remove a path with no object behind it
    // reports back fewer names than were requested, with no error at all.
    // deleteNotebook must not treat that strict "fewer names back" case as a
    // failure here, or a single source whose upload never completed (a
    // crashed ingestion, a user who refreshed mid-upload) would make its
    // notebook undeletable forever.
    const owner = await signUpUser("app-notebooks-delete-no-upload-owner");
    const notebookId = await createNotebookRow(owner, "app-notebooks-delete-no-upload");
    await createSource(owner, notebookId); // row only, nothing uploaded

    const result = await deleteNotebook(owner.client, notebookId);
    expect(await getNotebook(owner.client, notebookId)).toBeNull();
    void result; // removedPaths' exact shape for a never-uploaded path is not pinned down here
  });
});
