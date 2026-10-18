// RLS matrix for public.messages (PR A1 contract). Every client is built from
// a real sign-in and a real JWT -- owner, editor, viewer, stranger, anon, and
// an anonymous-signin member -- never the admin/service-role credential.
//
// Unlike sources/chunks, messages has no restrictive anonymous-block policy:
// "Anonymous users MAY insert messages (demo chat)" refers to a user who
// signed in anonymously through Supabase Auth (role authenticated, claim
// is_anonymous=true) -- not to PostgREST's unauthenticated `anon` role, which
// still has zero grants on this table like every other table here.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { anonClient, signInAnonymousUser, signUpUser, type SignedInUser } from "./helpers/clients";
import { addMember, createNotebook } from "./helpers/notebooks";
import { insertMessage } from "./helpers/sources";

describe("messages: insert", () => {
  let owner: SignedInUser;
  let editor: SignedInUser;
  let viewer: SignedInUser;
  let stranger: SignedInUser;
  let anonymousMember: SignedInUser;
  let notebookId: string;

  beforeAll(async () => {
    owner = await signUpUser("messages-insert-owner");
    editor = await signUpUser("messages-insert-editor");
    viewer = await signUpUser("messages-insert-viewer");
    stranger = await signUpUser("messages-insert-stranger");
    anonymousMember = await signInAnonymousUser();

    notebookId = await createNotebook(owner, "messages-insert");
    await addMember(owner, notebookId, editor.userId, "editor");
    await addMember(owner, notebookId, viewer.userId, "viewer");
    await addMember(owner, notebookId, anonymousMember.userId, "viewer");
  });

  it("lets the owner insert a message", async () => {
    const id = await insertMessage(owner, notebookId, "user", "hello from the owner");
    expect(id).toBeTruthy();
  });

  it("lets an editor insert a message", async () => {
    const id = await insertMessage(editor, notebookId, "user", "hello from the editor");
    expect(id).toBeTruthy();
  });

  it("lets a viewer insert a message (viewers may chat)", async () => {
    const id = await insertMessage(viewer, notebookId, "user", "hello from the viewer");
    expect(id).toBeTruthy();
  });

  it("lets an anonymous-signin member insert a message (demo chat)", async () => {
    const id = await insertMessage(anonymousMember, notebookId, "user", "hello from the demo user");
    expect(id).toBeTruthy();
  });

  it("rejects a stranger inserting a message with 42501", async () => {
    const { error } = await stranger.client
      .from("messages")
      .insert({ id: randomUUID(), notebook_id: notebookId, role: "user", content: "hi" });
    expect(error?.code).toBe("42501");
  });

  it("rejects an anon (no session) insert with 42501 (no grants for anon at all)", async () => {
    const { error } = await anonClient()
      .from("messages")
      .insert({ id: randomUUID(), notebook_id: notebookId, role: "user", content: "hi" });
    expect(error?.code).toBe("42501");
  });

  it("rejects setting user_id with 42501 (column grant does not include user_id)", async () => {
    const { error } = await viewer.client.from("messages").insert({
      id: randomUUID(),
      notebook_id: notebookId,
      role: "user",
      content: "forged user_id",
      user_id: owner.userId,
    });
    expect(error?.code).toBe("42501");
  });

  it("rejects an invalid role with 23514", async () => {
    const { error } = await owner.client.from("messages").insert({
      id: randomUUID(),
      notebook_id: notebookId,
      role: "system",
      content: "bad role",
    });
    expect(error?.code).toBe("23514");
  });

  it("rejects content over 20000 characters with 23514", async () => {
    const { error } = await owner.client.from("messages").insert({
      id: randomUUID(),
      notebook_id: notebookId,
      role: "user",
      content: "x".repeat(20001),
    });
    expect(error?.code).toBe("23514");
  });
});

describe("messages: select (per-user history)", () => {
  let owner: SignedInUser;
  let editor: SignedInUser;
  let viewer: SignedInUser;
  let stranger: SignedInUser;
  let anonymousMember: SignedInUser;
  let notebookId: string;
  let ownerMessageId: string;
  let editorMessageId: string;
  let viewerMessageId: string;
  let anonymousMemberMessageId: string;

  beforeAll(async () => {
    owner = await signUpUser("messages-select-owner");
    editor = await signUpUser("messages-select-editor");
    viewer = await signUpUser("messages-select-viewer");
    stranger = await signUpUser("messages-select-stranger");
    anonymousMember = await signInAnonymousUser();

    notebookId = await createNotebook(owner, "messages-select");
    await addMember(owner, notebookId, editor.userId, "editor");
    await addMember(owner, notebookId, viewer.userId, "viewer");
    await addMember(owner, notebookId, anonymousMember.userId, "viewer");

    ownerMessageId = await insertMessage(owner, notebookId, "user", "owner's own message");
    editorMessageId = await insertMessage(editor, notebookId, "user", "editor's own message");
    viewerMessageId = await insertMessage(viewer, notebookId, "user", "viewer's own message");
    anonymousMemberMessageId = await insertMessage(anonymousMember, notebookId, "user", "demo user's own message");
  });

  it("lets the owner see their own message but not the editor's", async () => {
    const { data, error } = await owner.client.from("messages").select("id").eq("notebook_id", notebookId);
    expect(error).toBeNull();
    expect(data).toEqual([{ id: ownerMessageId }]);
  });

  it("lets the editor see their own message but not the owner's", async () => {
    const { data, error } = await editor.client.from("messages").select("id").eq("notebook_id", notebookId);
    expect(error).toBeNull();
    expect(data).toEqual([{ id: editorMessageId }]);
  });

  it("lets a viewer see their own message but not another member's", async () => {
    const { data, error } = await viewer.client.from("messages").select("id").eq("notebook_id", notebookId);
    expect(error).toBeNull();
    expect(data).toEqual([{ id: viewerMessageId }]);
  });

  it("lets an anonymous-signin member see their own message but not another member's", async () => {
    const { data, error } = await anonymousMember.client
      .from("messages")
      .select("id")
      .eq("notebook_id", notebookId);
    expect(error).toBeNull();
    expect(data).toEqual([{ id: anonymousMemberMessageId }]);
  });

  it("shows a stranger nothing (0 rows, no error)", async () => {
    const { data, error } = await stranger.client.from("messages").select("id").eq("notebook_id", notebookId);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("rejects anon with 42501 (no grants for anon at all)", async () => {
    const { data, error } = await anonClient().from("messages").select("id").eq("notebook_id", notebookId);
    expect(data).toBeNull();
    expect(error?.code).toBe("42501");
  });
});

describe("messages: update (no grant, every role fails with 42501)", () => {
  let owner: SignedInUser;
  let editor: SignedInUser;
  let viewer: SignedInUser;
  let stranger: SignedInUser;
  let notebookId: string;
  let messageId: string;

  beforeAll(async () => {
    owner = await signUpUser("messages-update-owner");
    editor = await signUpUser("messages-update-editor");
    viewer = await signUpUser("messages-update-viewer");
    stranger = await signUpUser("messages-update-stranger");

    notebookId = await createNotebook(owner, "messages-update");
    await addMember(owner, notebookId, editor.userId, "editor");
    await addMember(owner, notebookId, viewer.userId, "viewer");

    messageId = await insertMessage(owner, notebookId, "user", "original content");
  });

  it("rejects the owner updating their own message with 42501", async () => {
    const { error } = await owner.client.from("messages").update({ content: "edited" }).eq("id", messageId);
    expect(error?.code).toBe("42501");
  });

  it("rejects an editor updating the owner's message with 42501", async () => {
    const { error } = await editor.client.from("messages").update({ content: "edited" }).eq("id", messageId);
    expect(error?.code).toBe("42501");
  });

  it("rejects a viewer updating the owner's message with 42501", async () => {
    const { error } = await viewer.client.from("messages").update({ content: "edited" }).eq("id", messageId);
    expect(error?.code).toBe("42501");
  });

  it("rejects a stranger updating the owner's message with 42501", async () => {
    const { error } = await stranger.client.from("messages").update({ content: "edited" }).eq("id", messageId);
    expect(error?.code).toBe("42501");
  });

  it("rejects an anon update with 42501", async () => {
    const { data, error } = await anonClient().from("messages").update({ content: "edited" }).eq("id", messageId);
    expect(data).toBeNull();
    expect(error?.code).toBe("42501");
  });
});

describe("messages: delete", () => {
  let owner: SignedInUser;
  let editor: SignedInUser;
  let viewer: SignedInUser;
  let stranger: SignedInUser;
  let notebookId: string;

  beforeAll(async () => {
    owner = await signUpUser("messages-delete-owner");
    editor = await signUpUser("messages-delete-editor");
    viewer = await signUpUser("messages-delete-viewer");
    stranger = await signUpUser("messages-delete-stranger");

    notebookId = await createNotebook(owner, "messages-delete");
    await addMember(owner, notebookId, editor.userId, "editor");
    await addMember(owner, notebookId, viewer.userId, "viewer");
  });

  it("lets a member delete their own message", async () => {
    const messageId = await insertMessage(owner, notebookId, "user", "to be deleted by its own author");
    const { data, error } = await owner.client.from("messages").delete().eq("id", messageId).select("id");
    expect(error).toBeNull();
    expect(data).toEqual([{ id: messageId }]);
  });

  it("another member cannot delete someone else's message (0 rows affected, no error)", async () => {
    const messageId = await insertMessage(owner, notebookId, "user", "owner's message, not editor's to delete");
    const { data, error } = await editor.client.from("messages").delete().eq("id", messageId).select("id");
    expect(error).toBeNull();
    expect(data).toEqual([]);

    const { data: reread } = await owner.client.from("messages").select("id").eq("id", messageId);
    expect(reread).toEqual([{ id: messageId }]);
  });

  it("a viewer can delete their own message", async () => {
    const messageId = await insertMessage(viewer, notebookId, "user", "to be deleted by the viewer who wrote it");
    const { data, error } = await viewer.client.from("messages").delete().eq("id", messageId).select("id");
    expect(error).toBeNull();
    expect(data).toEqual([{ id: messageId }]);
  });

  it("a viewer cannot delete another member's message (0 rows affected, no error)", async () => {
    const messageId = await insertMessage(owner, notebookId, "user", "owner's message, not the viewer's to delete");
    const { data, error } = await viewer.client.from("messages").delete().eq("id", messageId).select("id");
    expect(error).toBeNull();
    expect(data).toEqual([]);

    const { data: reread } = await owner.client.from("messages").select("id").eq("id", messageId);
    expect(reread).toEqual([{ id: messageId }]);
  });

  it("a stranger cannot delete someone else's message (0 rows affected, no error)", async () => {
    const messageId = await insertMessage(owner, notebookId, "user", "owner's message, stranger has no access");
    const { data, error } = await stranger.client.from("messages").delete().eq("id", messageId).select("id");
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("rejects an anon delete with 42501 (no grants for anon at all)", async () => {
    const messageId = await insertMessage(owner, notebookId, "user", "anon cannot touch this");
    const { data, error } = await anonClient().from("messages").delete().eq("id", messageId);
    expect(data).toBeNull();
    expect(error?.code).toBe("42501");
  });
});
