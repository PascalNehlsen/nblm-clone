// RLS matrix for public.sources (PR A1 contract). Every client is built from
// a real sign-in and a real JWT -- owner, editor, viewer, stranger, anon, and
// an anonymous-signin user added as a real member -- never the admin/
// service-role credential. Users are created once per describe block
// (beforeAll), not per `it`, per the local Auth rate limits.
//
// The "anonymous member" insert case does not need request.jwt.claims
// trickery: a non-anonymous owner can legitimately add an anonymous-signin
// user as a real editor of their notebook (the notebook_members restrictive
// policy only blocks an *anonymous actor* from inserting a membership, not a
// membership whose target happens to be anonymous), so this harness exercises
// the real PostgREST/JWT path end to end.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { anonClient, signInAnonymousUser, signUpUser, type SignedInUser } from "./helpers/clients";
import { addMember, createNotebook } from "./helpers/notebooks";
import { createSource, storagePath } from "./helpers/sources";

describe("sources: select", () => {
  let owner: SignedInUser;
  let editor: SignedInUser;
  let viewer: SignedInUser;
  let stranger: SignedInUser;
  let notebookId: string;
  let sourceId: string;

  beforeAll(async () => {
    owner = await signUpUser("sources-select-owner");
    editor = await signUpUser("sources-select-editor");
    viewer = await signUpUser("sources-select-viewer");
    stranger = await signUpUser("sources-select-stranger");

    notebookId = await createNotebook(owner, "sources-select");
    await addMember(owner, notebookId, editor.userId, "editor");
    await addMember(owner, notebookId, viewer.userId, "viewer");
    sourceId = await createSource(owner, notebookId);
  });

  it("is visible to the owner", async () => {
    const { data, error } = await owner.client.from("sources").select("id").eq("id", sourceId);
    expect(error).toBeNull();
    expect(data).toEqual([{ id: sourceId }]);
  });

  it("is visible to an editor", async () => {
    const { data, error } = await editor.client.from("sources").select("id").eq("id", sourceId);
    expect(error).toBeNull();
    expect(data).toEqual([{ id: sourceId }]);
  });

  it("is visible to a viewer", async () => {
    const { data, error } = await viewer.client.from("sources").select("id").eq("id", sourceId);
    expect(error).toBeNull();
    expect(data).toEqual([{ id: sourceId }]);
  });

  it("is invisible to a stranger (0 rows, no error)", async () => {
    const { data, error } = await stranger.client.from("sources").select("id").eq("id", sourceId);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("rejects anon with 42501 (no grants for anon at all)", async () => {
    const { data, error } = await anonClient().from("sources").select("id").eq("id", sourceId);
    expect(data).toBeNull();
    expect(error?.code).toBe("42501");
  });
});

describe("sources: insert", () => {
  let owner: SignedInUser;
  let editor: SignedInUser;
  let viewer: SignedInUser;
  let stranger: SignedInUser;
  let anonymousMember: SignedInUser;
  let notebookId: string;

  beforeAll(async () => {
    owner = await signUpUser("sources-insert-owner");
    editor = await signUpUser("sources-insert-editor");
    viewer = await signUpUser("sources-insert-viewer");
    stranger = await signUpUser("sources-insert-stranger");
    anonymousMember = await signInAnonymousUser();

    notebookId = await createNotebook(owner, "sources-insert");
    await addMember(owner, notebookId, editor.userId, "editor");
    await addMember(owner, notebookId, viewer.userId, "viewer");
    // The owner (not anonymous) performs this insert, so the restrictive
    // "no anonymous actor" policy on notebook_members does not apply here.
    await addMember(owner, notebookId, anonymousMember.userId, "editor");
  });

  it("lets the owner insert a source", async () => {
    const id = randomUUID();
    const { error } = await owner.client.from("sources").insert({
      id,
      notebook_id: notebookId,
      kind: "text",
      title: "owner source",
      storage_path: storagePath(notebookId),
    });
    expect(error).toBeNull();
  });

  it("lets an editor insert a source", async () => {
    const id = randomUUID();
    const { error } = await editor.client.from("sources").insert({
      id,
      notebook_id: notebookId,
      kind: "text",
      title: "editor source",
      storage_path: storagePath(notebookId),
    });
    expect(error).toBeNull();
  });

  it("rejects a viewer inserting a source with 42501", async () => {
    const id = randomUUID();
    const { error } = await viewer.client.from("sources").insert({
      id,
      notebook_id: notebookId,
      kind: "text",
      title: "viewer source",
      storage_path: storagePath(notebookId),
    });
    expect(error?.code).toBe("42501");
  });

  it("rejects a stranger inserting a source with 42501", async () => {
    const id = randomUUID();
    const { error } = await stranger.client.from("sources").insert({
      id,
      notebook_id: notebookId,
      kind: "text",
      title: "stranger source",
      storage_path: storagePath(notebookId),
    });
    expect(error?.code).toBe("42501");
  });

  it("rejects an anon insert with 42501 (no grants for anon at all)", async () => {
    const id = randomUUID();
    const { error } = await anonClient().from("sources").insert({
      id,
      notebook_id: notebookId,
      kind: "text",
      title: "anon source",
      storage_path: storagePath(notebookId),
    });
    expect(error?.code).toBe("42501");
  });

  it("rejects setting created_by with 42501 (column grant does not include created_by)", async () => {
    const id = randomUUID();
    const { error } = await owner.client.from("sources").insert({
      id,
      notebook_id: notebookId,
      kind: "text",
      title: "created-by source",
      storage_path: storagePath(notebookId),
      created_by: stranger.userId,
    });
    expect(error?.code).toBe("42501");
  });

  it("rejects setting status at insert with 42501 (column grant does not include status)", async () => {
    const id = randomUUID();
    const { error } = await owner.client.from("sources").insert({
      id,
      notebook_id: notebookId,
      kind: "text",
      title: "status source",
      storage_path: storagePath(notebookId),
      status: "ready",
    });
    expect(error?.code).toBe("42501");
  });

  it("rejects an invalid kind with 23514", async () => {
    const id = randomUUID();
    const { error } = await owner.client.from("sources").insert({
      id,
      notebook_id: notebookId,
      kind: "video",
      title: "bad kind source",
      storage_path: storagePath(notebookId),
    });
    expect(error?.code).toBe("23514");
  });

  it("rejects an empty title with 23514", async () => {
    const id = randomUUID();
    const { error } = await owner.client.from("sources").insert({
      id,
      notebook_id: notebookId,
      kind: "text",
      title: "",
      storage_path: storagePath(notebookId),
    });
    expect(error?.code).toBe("23514");
  });

  it("rejects a storage_path outside the notebook's own prefix with 23514", async () => {
    const id = randomUUID();
    const { error } = await owner.client.from("sources").insert({
      id,
      notebook_id: notebookId,
      kind: "text",
      title: "wrong prefix source",
      storage_path: `${randomUUID()}/file.txt`,
    });
    expect(error?.code).toBe("23514");
  });

  it("rejects an anonymous-signin editor inserting a source with 42501 (restrictive policy)", async () => {
    const id = randomUUID();
    const { error } = await anonymousMember.client.from("sources").insert({
      id,
      notebook_id: notebookId,
      kind: "text",
      title: "anonymous editor source",
      storage_path: storagePath(notebookId),
    });
    expect(error?.code).toBe("42501");
  });
});

describe("sources: update", () => {
  let owner: SignedInUser;
  let editor: SignedInUser;
  let viewer: SignedInUser;
  let stranger: SignedInUser;
  let anonymousMember: SignedInUser;
  let notebookId: string;

  beforeAll(async () => {
    owner = await signUpUser("sources-update-owner");
    editor = await signUpUser("sources-update-editor");
    viewer = await signUpUser("sources-update-viewer");
    stranger = await signUpUser("sources-update-stranger");
    anonymousMember = await signInAnonymousUser();

    notebookId = await createNotebook(owner, "sources-update");
    await addMember(owner, notebookId, editor.userId, "editor");
    await addMember(owner, notebookId, viewer.userId, "viewer");
    // The owner (not anonymous) performs this insert, so the restrictive
    // "no anonymous actor" policy on notebook_members does not apply here.
    await addMember(owner, notebookId, anonymousMember.userId, "editor");
  });

  it("lets the owner update the title", async () => {
    const sourceId = await createSource(owner, notebookId);
    const newTitle = `updated by owner ${randomUUID()}`;

    const { data, error } = await owner.client
      .from("sources")
      .update({ title: newTitle })
      .eq("id", sourceId)
      .select("title");
    expect(error).toBeNull();
    expect(data).toEqual([{ title: newTitle }]);
  });

  it("lets an editor update the title", async () => {
    const sourceId = await createSource(owner, notebookId);
    const newTitle = `updated by editor ${randomUUID()}`;

    const { data, error } = await editor.client
      .from("sources")
      .update({ title: newTitle })
      .eq("id", sourceId)
      .select("title");
    expect(error).toBeNull();
    expect(data).toEqual([{ title: newTitle }]);
  });

  it("a viewer cannot update the title (0 rows affected, no error)", async () => {
    const sourceId = await createSource(owner, notebookId);
    const { data, error } = await viewer.client
      .from("sources")
      .update({ title: "viewer attempt" })
      .eq("id", sourceId)
      .select("title");
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("a stranger cannot update the title (0 rows affected, no error)", async () => {
    const sourceId = await createSource(owner, notebookId);
    const { data, error } = await stranger.client
      .from("sources")
      .update({ title: "stranger attempt" })
      .eq("id", sourceId)
      .select("title");
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("rejects changing notebook_id with 42501 (column grant is title, status only)", async () => {
    const sourceId = await createSource(owner, notebookId);
    const otherNotebookId = await createNotebook(owner, "sources-update-other");

    const { error } = await owner.client
      .from("sources")
      .update({ notebook_id: otherNotebookId })
      .eq("id", sourceId);
    expect(error?.code).toBe("42501");
  });

  it("rejects changing storage_path with 42501 (column grant is title, status only)", async () => {
    const sourceId = await createSource(owner, notebookId);

    const { error } = await owner.client
      .from("sources")
      .update({ storage_path: storagePath(notebookId, "new-name.txt") })
      .eq("id", sourceId);
    expect(error?.code).toBe("42501");
  });

  it("rejects an anon update with 42501 (no grants for anon at all)", async () => {
    const sourceId = await createSource(owner, notebookId);
    const { data, error } = await anonClient()
      .from("sources")
      .update({ title: "anon attempt" })
      .eq("id", sourceId);
    expect(data).toBeNull();
    expect(error?.code).toBe("42501");
  });

  it("lets the owner update status", async () => {
    const sourceId = await createSource(owner, notebookId);
    const { data, error } = await owner.client
      .from("sources")
      .update({ status: "ready" })
      .eq("id", sourceId)
      .select("status");
    expect(error).toBeNull();
    expect(data).toEqual([{ status: "ready" }]);
  });

  it("lets an editor update status", async () => {
    const sourceId = await createSource(owner, notebookId);
    const { data, error } = await editor.client
      .from("sources")
      .update({ status: "ready" })
      .eq("id", sourceId)
      .select("status");
    expect(error).toBeNull();
    expect(data).toEqual([{ status: "ready" }]);
  });

  it("a viewer cannot update status (0 rows affected, no error)", async () => {
    const sourceId = await createSource(owner, notebookId);
    const { data, error } = await viewer.client
      .from("sources")
      .update({ status: "ready" })
      .eq("id", sourceId)
      .select("status");
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("an anonymous-signin editor cannot update the title (0 rows affected, reread as owner)", async () => {
    const sourceId = await createSource(owner, notebookId);
    const originalTitle = `anonymous-member-update-attempt ${randomUUID()}`;
    await owner.client.from("sources").update({ title: originalTitle }).eq("id", sourceId);

    const { data, error } = await anonymousMember.client
      .from("sources")
      .update({ title: "anonymous editor attempt" })
      .eq("id", sourceId)
      .select("title");
    expect(error).toBeNull();
    expect(data).toEqual([]);

    const { data: reread, error: rereadError } = await owner.client
      .from("sources")
      .select("title")
      .eq("id", sourceId);
    expect(rereadError).toBeNull();
    expect(reread).toEqual([{ title: originalTitle }]);
  });

  it("an anonymous-signin editor cannot update status (0 rows affected, reread as owner)", async () => {
    const sourceId = await createSource(owner, notebookId);

    const { data, error } = await anonymousMember.client
      .from("sources")
      .update({ status: "ready" })
      .eq("id", sourceId)
      .select("status");
    expect(error).toBeNull();
    expect(data).toEqual([]);

    const { data: reread, error: rereadError } = await owner.client
      .from("sources")
      .select("status")
      .eq("id", sourceId);
    expect(rereadError).toBeNull();
    expect(reread).toEqual([{ status: "pending" }]);
  });
});

describe("sources: delete", () => {
  let owner: SignedInUser;
  let editor: SignedInUser;
  let viewer: SignedInUser;
  let stranger: SignedInUser;
  let anonymousMember: SignedInUser;
  let notebookId: string;

  beforeAll(async () => {
    owner = await signUpUser("sources-delete-owner");
    editor = await signUpUser("sources-delete-editor");
    viewer = await signUpUser("sources-delete-viewer");
    stranger = await signUpUser("sources-delete-stranger");
    anonymousMember = await signInAnonymousUser();

    notebookId = await createNotebook(owner, "sources-delete");
    await addMember(owner, notebookId, editor.userId, "editor");
    await addMember(owner, notebookId, viewer.userId, "viewer");
    await addMember(owner, notebookId, anonymousMember.userId, "editor");
  });

  it("lets the owner delete a source", async () => {
    const sourceId = await createSource(owner, notebookId);
    const { data, error } = await owner.client.from("sources").delete().eq("id", sourceId).select("id");
    expect(error).toBeNull();
    expect(data).toEqual([{ id: sourceId }]);
  });

  it("lets an editor delete a source", async () => {
    const sourceId = await createSource(owner, notebookId);
    const { data, error } = await editor.client.from("sources").delete().eq("id", sourceId).select("id");
    expect(error).toBeNull();
    expect(data).toEqual([{ id: sourceId }]);
  });

  it("a viewer cannot delete a source (0 rows affected, no error)", async () => {
    const sourceId = await createSource(owner, notebookId);
    const { data, error } = await viewer.client.from("sources").delete().eq("id", sourceId).select("id");
    expect(error).toBeNull();
    expect(data).toEqual([]);

    const { data: reread } = await owner.client.from("sources").select("id").eq("id", sourceId);
    expect(reread).toEqual([{ id: sourceId }]);
  });

  it("a stranger cannot delete a source (0 rows affected, no error)", async () => {
    const sourceId = await createSource(owner, notebookId);
    const { data, error } = await stranger.client.from("sources").delete().eq("id", sourceId).select("id");
    expect(error).toBeNull();
    expect(data).toEqual([]);

    const { data: reread } = await owner.client.from("sources").select("id").eq("id", sourceId);
    expect(reread).toEqual([{ id: sourceId }]);
  });

  it("rejects an anon delete with 42501 (no grants for anon at all)", async () => {
    const sourceId = await createSource(owner, notebookId);
    const { data, error } = await anonClient().from("sources").delete().eq("id", sourceId);
    expect(data).toBeNull();
    expect(error?.code).toBe("42501");
  });

  it("an anonymous-signin editor cannot delete a source (0 rows affected, reread as owner)", async () => {
    const sourceId = await createSource(owner, notebookId);
    const { data, error } = await anonymousMember.client
      .from("sources")
      .delete()
      .eq("id", sourceId)
      .select("id");
    expect(error).toBeNull();
    expect(data).toEqual([]);

    const { data: reread } = await owner.client.from("sources").select("id").eq("id", sourceId);
    expect(reread).toEqual([{ id: sourceId }]);
  });
});
