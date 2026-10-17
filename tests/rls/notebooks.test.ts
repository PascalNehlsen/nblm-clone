// RLS matrix for public.notebooks (PR 3 contract). Every client is built from
// a real sign-in and a real JWT -- owner, editor, viewer, stranger, anon, and
// an anonymous-signin user -- never the admin/service-role credential. Users
// are created once per describe block (beforeAll), not per `it`, per the local Auth rate limits
// (raised for this harness, see supabase/config.toml).
//
// This migration does not exist yet, so every case here is expected to be
// RED: missing table/trigger/policy, not a harness bug.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { anonClient, signInAnonymousUser, signUpUser, type SignedInUser } from "./helpers/clients";
import { addMember, createNotebook } from "./helpers/notebooks";

describe("notebooks: select", () => {
  let owner: SignedInUser;
  let editor: SignedInUser;
  let viewer: SignedInUser;
  let stranger: SignedInUser;
  let notebookId: string;

  beforeAll(async () => {
    owner = await signUpUser("notebooks-select-owner");
    editor = await signUpUser("notebooks-select-editor");
    viewer = await signUpUser("notebooks-select-viewer");
    stranger = await signUpUser("notebooks-select-stranger");

    notebookId = await createNotebook(owner, "notebooks-select");
    await addMember(owner, notebookId, editor.userId, "editor");
    await addMember(owner, notebookId, viewer.userId, "viewer");
  });

  it("is visible to the owner", async () => {
    const { data, error } = await owner.client.from("notebooks").select("id").eq("id", notebookId);
    expect(error).toBeNull();
    expect(data).toEqual([{ id: notebookId }]);
  });

  it("is visible to an editor", async () => {
    const { data, error } = await editor.client.from("notebooks").select("id").eq("id", notebookId);
    expect(error).toBeNull();
    expect(data).toEqual([{ id: notebookId }]);
  });

  it("is visible to a viewer", async () => {
    const { data, error } = await viewer.client.from("notebooks").select("id").eq("id", notebookId);
    expect(error).toBeNull();
    expect(data).toEqual([{ id: notebookId }]);
  });

  it("is invisible to a stranger (0 rows, no error)", async () => {
    const { data, error } = await stranger.client.from("notebooks").select("id").eq("id", notebookId);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("rejects anon with 42501 (no grants for anon at all)", async () => {
    const { data, error } = await anonClient().from("notebooks").select("id").eq("id", notebookId);
    expect(data).toBeNull();
    expect(error?.code).toBe("42501");
  });
});

describe("notebooks: insert", () => {
  let otherUser: SignedInUser;
  let anonymousUser: SignedInUser;

  beforeAll(async () => {
    otherUser = await signUpUser("notebooks-insert-other");
    anonymousUser = await signInAnonymousUser();
  });

  it("lets a signed-up (email) user create a notebook and become its owner", async () => {
    const creator = await signUpUser("notebooks-insert-creator");
    const notebookId = randomUUID();
    const title = `notebooks-insert-email ${randomUUID()}`;

    const { error: insertError } = await creator.client.from("notebooks").insert({ id: notebookId, title });
    expect(insertError).toBeNull();

    const { data: notebookRows, error: selectError } = await creator.client
      .from("notebooks")
      .select("id, title")
      .eq("id", notebookId);
    expect(selectError).toBeNull();
    expect(notebookRows).toEqual([{ id: notebookId, title }]);

    const { data: memberRows, error: memberError } = await creator.client
      .from("notebook_members")
      .select("role")
      .eq("notebook_id", notebookId)
      .eq("user_id", creator.userId);
    expect(memberError).toBeNull();
    expect(memberRows).toEqual([{ role: "owner" }]);
  });

  it("lets an anonymous-signin user create a notebook and become its owner", async () => {
    const notebookId = randomUUID();
    const title = `notebooks-insert-anon-signin ${randomUUID()}`;

    const { error: insertError } = await anonymousUser.client.from("notebooks").insert({ id: notebookId, title });
    expect(insertError).toBeNull();

    const { data: memberRows, error: memberError } = await anonymousUser.client
      .from("notebook_members")
      .select("role")
      .eq("notebook_id", notebookId)
      .eq("user_id", anonymousUser.userId);
    expect(memberError).toBeNull();
    expect(memberRows).toEqual([{ role: "owner" }]);
  });

  it("rejects created_by set to another user's id with 42501 (column grant is id, title only)", async () => {
    const creator = await signUpUser("notebooks-insert-created-by");

    const { error } = await creator.client.from("notebooks").insert({
      id: randomUUID(),
      title: `notebooks-insert-created-by ${randomUUID()}`,
      created_by: otherUser.userId,
    });

    expect(error?.code).toBe("42501");
  });

  it("rejects an anon insert with 42501", async () => {
    const { error } = await anonClient()
      .from("notebooks")
      .insert({ id: randomUUID(), title: `notebooks-insert-anon ${randomUUID()}` });

    expect(error?.code).toBe("42501");
  });

  it("rejects an empty title with 23514", async () => {
    const creator = await signUpUser("notebooks-insert-empty-title");
    const { error } = await creator.client.from("notebooks").insert({ id: randomUUID(), title: "" });
    expect(error?.code).toBe("23514");
  });

  it("rejects a whitespace-only title with 23514", async () => {
    const creator = await signUpUser("notebooks-insert-whitespace-title");
    const { error } = await creator.client.from("notebooks").insert({ id: randomUUID(), title: "   " });
    expect(error?.code).toBe("23514");
  });
});

describe("notebooks: update", () => {
  let owner: SignedInUser;
  let editor: SignedInUser;
  let viewer: SignedInUser;
  let stranger: SignedInUser;

  beforeAll(async () => {
    owner = await signUpUser("notebooks-update-owner");
    editor = await signUpUser("notebooks-update-editor");
    viewer = await signUpUser("notebooks-update-viewer");
    stranger = await signUpUser("notebooks-update-stranger");
  });

  async function freshNotebookWithMembers(): Promise<string> {
    const notebookId = await createNotebook(owner, "notebooks-update");
    await addMember(owner, notebookId, editor.userId, "editor");
    await addMember(owner, notebookId, viewer.userId, "viewer");
    return notebookId;
  }

  it("lets the owner update the title", async () => {
    const notebookId = await freshNotebookWithMembers();
    const newTitle = `notebooks-update-owner-new ${randomUUID()}`;

    const { data, error } = await owner.client
      .from("notebooks")
      .update({ title: newTitle })
      .eq("id", notebookId)
      .select("title");

    expect(error).toBeNull();
    expect(data).toEqual([{ title: newTitle }]);
  });

  it("lets an editor update the title", async () => {
    const notebookId = await freshNotebookWithMembers();
    const newTitle = `notebooks-update-editor-new ${randomUUID()}`;

    const { data, error } = await editor.client
      .from("notebooks")
      .update({ title: newTitle })
      .eq("id", notebookId)
      .select("title");

    expect(error).toBeNull();
    expect(data).toEqual([{ title: newTitle }]);
  });

  it("a viewer cannot update the title (0 rows affected, no error)", async () => {
    const notebookId = await freshNotebookWithMembers();
    const attemptedTitle = `notebooks-update-viewer-attempt ${randomUUID()}`;

    const { data, error } = await viewer.client
      .from("notebooks")
      .update({ title: attemptedTitle })
      .eq("id", notebookId)
      .select("title");

    expect(error).toBeNull();
    expect(data).toEqual([]);

    const { data: reread } = await owner.client.from("notebooks").select("title").eq("id", notebookId);
    expect(reread?.[0]?.title).not.toBe(attemptedTitle);
  });

  it("a stranger cannot update the title (0 rows affected, no error)", async () => {
    const notebookId = await freshNotebookWithMembers();
    const attemptedTitle = `notebooks-update-stranger-attempt ${randomUUID()}`;

    const { data, error } = await stranger.client
      .from("notebooks")
      .update({ title: attemptedTitle })
      .eq("id", notebookId)
      .select("title");

    expect(error).toBeNull();
    expect(data).toEqual([]);

    const { data: reread } = await owner.client.from("notebooks").select("title").eq("id", notebookId);
    expect(reread?.[0]?.title).not.toBe(attemptedTitle);
  });

  it("rejects updating created_by with 42501 (column grant is title only)", async () => {
    const notebookId = await freshNotebookWithMembers();

    const { error } = await owner.client
      .from("notebooks")
      .update({ created_by: randomUUID() })
      .eq("id", notebookId);

    expect(error?.code).toBe("42501");
  });
});

describe("notebooks: delete", () => {
  let owner: SignedInUser;
  let editor: SignedInUser;
  let viewer: SignedInUser;
  let stranger: SignedInUser;

  beforeAll(async () => {
    owner = await signUpUser("notebooks-delete-owner");
    editor = await signUpUser("notebooks-delete-editor");
    viewer = await signUpUser("notebooks-delete-viewer");
    stranger = await signUpUser("notebooks-delete-stranger");
  });

  async function freshNotebookWithMembers(): Promise<string> {
    const notebookId = await createNotebook(owner, "notebooks-delete");
    await addMember(owner, notebookId, editor.userId, "editor");
    await addMember(owner, notebookId, viewer.userId, "viewer");
    return notebookId;
  }

  it("an editor cannot delete the notebook (0 rows affected, no error)", async () => {
    const notebookId = await freshNotebookWithMembers();

    const { data, error } = await editor.client.from("notebooks").delete().eq("id", notebookId).select("id");
    expect(error).toBeNull();
    expect(data).toEqual([]);

    const { data: reread } = await owner.client.from("notebooks").select("id").eq("id", notebookId);
    expect(reread).toEqual([{ id: notebookId }]);
  });

  it("a viewer cannot delete the notebook (0 rows affected, no error)", async () => {
    const notebookId = await freshNotebookWithMembers();

    const { data, error } = await viewer.client.from("notebooks").delete().eq("id", notebookId).select("id");
    expect(error).toBeNull();
    expect(data).toEqual([]);

    const { data: reread } = await owner.client.from("notebooks").select("id").eq("id", notebookId);
    expect(reread).toEqual([{ id: notebookId }]);
  });

  it("a stranger cannot delete the notebook (0 rows affected, no error)", async () => {
    const notebookId = await freshNotebookWithMembers();

    const { data, error } = await stranger.client.from("notebooks").delete().eq("id", notebookId).select("id");
    expect(error).toBeNull();
    expect(data).toEqual([]);

    const { data: reread } = await owner.client.from("notebooks").select("id").eq("id", notebookId);
    expect(reread).toEqual([{ id: notebookId }]);
  });

  it("the owner deletes the notebook; cascade removes every membership row, even with a single (last) owner", async () => {
    // Single-owner notebook: this is the case that exercises guard_last_owner's
    // "parent notebook no longer exists" escape hatch and the delete audit path.
    const notebookId = await createNotebook(owner, "notebooks-delete-owner-only");

    const { data, error } = await owner.client.from("notebooks").delete().eq("id", notebookId).select("id");
    expect(error).toBeNull();
    expect(data).toEqual([{ id: notebookId }]);

    const { data: members, error: membersError } = await owner.client
      .from("notebook_members")
      .select("user_id")
      .eq("notebook_id", notebookId);
    expect(membersError).toBeNull();
    expect(members).toEqual([]);
  });
});
