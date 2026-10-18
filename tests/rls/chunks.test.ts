// RLS matrix for public.chunks (PR A1 contract). Every client is built from a
// real sign-in and a real JWT -- owner, editor, viewer, stranger, anon, and an
// anonymous-signin member -- never the admin/service-role credential.
//
// chunks has no UPDATE grant at all (per the schema contract an update policy
// may still exist, to satisfy the general "every table has update/select/
// insert/delete policies" catalog check in 000_catalog.test.sql, but the
// column grant is absent), so every actor's update attempt must fail with
// 42501 regardless of role -- that is a privilege failure, not an RLS one.
import { beforeAll, describe, expect, it } from "vitest";
import { anonClient, signInAnonymousUser, signUpUser, type SignedInUser } from "./helpers/clients";
import { addMember, createNotebook } from "./helpers/notebooks";
import { createSource, nearbyVector } from "./helpers/sources";

describe("chunks: select", () => {
  let owner: SignedInUser;
  let editor: SignedInUser;
  let viewer: SignedInUser;
  let stranger: SignedInUser;
  let notebookId: string;
  let chunkId: string;

  beforeAll(async () => {
    owner = await signUpUser("chunks-select-owner");
    editor = await signUpUser("chunks-select-editor");
    viewer = await signUpUser("chunks-select-viewer");
    stranger = await signUpUser("chunks-select-stranger");

    notebookId = await createNotebook(owner, "chunks-select");
    await addMember(owner, notebookId, editor.userId, "editor");
    await addMember(owner, notebookId, viewer.userId, "viewer");

    const sourceId = await createSource(owner, notebookId);
    const { data, error } = await owner.client
      .from("chunks")
      .insert({
        notebook_id: notebookId,
        source_id: sourceId,
        ordinal: 0,
        content: "chunk content",
        embedding: nearbyVector(1, 0.01),
      })
      .select("id");
    if (error || !data?.[0]) throw new Error(`fixture chunk insert failed: ${error?.code} ${error?.message}`);
    chunkId = data[0].id as string;
  });

  it("is visible to the owner", async () => {
    const { data, error } = await owner.client.from("chunks").select("id").eq("id", chunkId);
    expect(error).toBeNull();
    expect(data).toEqual([{ id: chunkId }]);
  });

  it("is visible to an editor", async () => {
    const { data, error } = await editor.client.from("chunks").select("id").eq("id", chunkId);
    expect(error).toBeNull();
    expect(data).toEqual([{ id: chunkId }]);
  });

  it("is visible to a viewer", async () => {
    const { data, error } = await viewer.client.from("chunks").select("id").eq("id", chunkId);
    expect(error).toBeNull();
    expect(data).toEqual([{ id: chunkId }]);
  });

  it("is invisible to a stranger (0 rows, no error)", async () => {
    const { data, error } = await stranger.client.from("chunks").select("id").eq("id", chunkId);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("rejects anon with 42501 (no grants for anon at all)", async () => {
    const { data, error } = await anonClient().from("chunks").select("id").eq("id", chunkId);
    expect(data).toBeNull();
    expect(error?.code).toBe("42501");
  });
});

describe("chunks: insert", () => {
  let owner: SignedInUser;
  let editor: SignedInUser;
  let viewer: SignedInUser;
  let stranger: SignedInUser;
  let anonymousMember: SignedInUser;
  let notebookId: string;
  let sourceId: string;

  beforeAll(async () => {
    owner = await signUpUser("chunks-insert-owner");
    editor = await signUpUser("chunks-insert-editor");
    viewer = await signUpUser("chunks-insert-viewer");
    stranger = await signUpUser("chunks-insert-stranger");
    anonymousMember = await signInAnonymousUser();

    notebookId = await createNotebook(owner, "chunks-insert");
    await addMember(owner, notebookId, editor.userId, "editor");
    await addMember(owner, notebookId, viewer.userId, "viewer");
    await addMember(owner, notebookId, anonymousMember.userId, "editor");
    sourceId = await createSource(owner, notebookId);
  });

  it("lets the owner insert a chunk", async () => {
    const { error } = await owner.client.from("chunks").insert({
      notebook_id: notebookId,
      source_id: sourceId,
      ordinal: 1,
      content: "owner chunk",
      embedding: nearbyVector(2, 0.01),
    });
    expect(error).toBeNull();
  });

  it("lets an editor insert a chunk", async () => {
    const { error } = await editor.client.from("chunks").insert({
      notebook_id: notebookId,
      source_id: sourceId,
      ordinal: 2,
      content: "editor chunk",
      embedding: nearbyVector(3, 0.01),
    });
    expect(error).toBeNull();
  });

  it("rejects a viewer inserting a chunk with 42501", async () => {
    const { error } = await viewer.client.from("chunks").insert({
      notebook_id: notebookId,
      source_id: sourceId,
      ordinal: 3,
      content: "viewer chunk",
      embedding: nearbyVector(4, 0.01),
    });
    expect(error?.code).toBe("42501");
  });

  it("rejects a stranger inserting a chunk with 42501", async () => {
    const { error } = await stranger.client.from("chunks").insert({
      notebook_id: notebookId,
      source_id: sourceId,
      ordinal: 4,
      content: "stranger chunk",
      embedding: nearbyVector(5, 0.01),
    });
    expect(error?.code).toBe("42501");
  });

  it("rejects an anon insert with 42501 (no grants for anon at all)", async () => {
    const { error } = await anonClient().from("chunks").insert({
      notebook_id: notebookId,
      source_id: sourceId,
      ordinal: 5,
      content: "anon chunk",
      embedding: nearbyVector(6, 0.01),
    });
    expect(error?.code).toBe("42501");
  });

  it("rejects an anonymous-signin editor inserting a chunk with 42501 (restrictive policy)", async () => {
    const { error } = await anonymousMember.client.from("chunks").insert({
      notebook_id: notebookId,
      source_id: sourceId,
      ordinal: 6,
      content: "anonymous editor chunk",
      embedding: nearbyVector(7, 0.01),
    });
    expect(error?.code).toBe("42501");
  });

  it("rejects a chunk whose notebook_id does not match its source's notebook_id with 23503", async () => {
    const otherNotebookId = await createNotebook(owner, "chunks-insert-other");
    const { error } = await owner.client.from("chunks").insert({
      notebook_id: otherNotebookId,
      source_id: sourceId,
      ordinal: 0,
      content: "mismatched chunk",
      embedding: nearbyVector(8, 0.01),
    });
    expect(error?.code).toBe("23503");
  });
});

describe("chunks: update (no grant, every role fails with 42501)", () => {
  let owner: SignedInUser;
  let editor: SignedInUser;
  let viewer: SignedInUser;
  let stranger: SignedInUser;
  let notebookId: string;
  let chunkId: string;

  beforeAll(async () => {
    owner = await signUpUser("chunks-update-owner");
    editor = await signUpUser("chunks-update-editor");
    viewer = await signUpUser("chunks-update-viewer");
    stranger = await signUpUser("chunks-update-stranger");

    notebookId = await createNotebook(owner, "chunks-update");
    await addMember(owner, notebookId, editor.userId, "editor");
    await addMember(owner, notebookId, viewer.userId, "viewer");

    const sourceId = await createSource(owner, notebookId);
    const { data, error } = await owner.client
      .from("chunks")
      .insert({
        notebook_id: notebookId,
        source_id: sourceId,
        ordinal: 0,
        content: "original content",
        embedding: nearbyVector(9, 0.01),
      })
      .select("id");
    if (error || !data?.[0]) throw new Error(`fixture chunk insert failed: ${error?.code} ${error?.message}`);
    chunkId = data[0].id as string;
  });

  it("rejects the owner updating content with 42501", async () => {
    const { error } = await owner.client.from("chunks").update({ content: "x" }).eq("id", chunkId);
    expect(error?.code).toBe("42501");
  });

  it("rejects an editor updating content with 42501", async () => {
    const { error } = await editor.client.from("chunks").update({ content: "x" }).eq("id", chunkId);
    expect(error?.code).toBe("42501");
  });

  it("rejects a viewer updating content with 42501", async () => {
    const { error } = await viewer.client.from("chunks").update({ content: "x" }).eq("id", chunkId);
    expect(error?.code).toBe("42501");
  });

  it("rejects a stranger updating content with 42501", async () => {
    const { error } = await stranger.client.from("chunks").update({ content: "x" }).eq("id", chunkId);
    expect(error?.code).toBe("42501");
  });

  it("rejects an anon update with 42501", async () => {
    const { data, error } = await anonClient().from("chunks").update({ content: "x" }).eq("id", chunkId);
    expect(data).toBeNull();
    expect(error?.code).toBe("42501");
  });
});

describe("chunks: delete", () => {
  let owner: SignedInUser;
  let editor: SignedInUser;
  let viewer: SignedInUser;
  let stranger: SignedInUser;
  let anonymousMember: SignedInUser;
  let notebookId: string;
  let sourceId: string;

  beforeAll(async () => {
    owner = await signUpUser("chunks-delete-owner");
    editor = await signUpUser("chunks-delete-editor");
    viewer = await signUpUser("chunks-delete-viewer");
    stranger = await signUpUser("chunks-delete-stranger");
    anonymousMember = await signInAnonymousUser();

    notebookId = await createNotebook(owner, "chunks-delete");
    await addMember(owner, notebookId, editor.userId, "editor");
    await addMember(owner, notebookId, viewer.userId, "viewer");
    await addMember(owner, notebookId, anonymousMember.userId, "editor");
    sourceId = await createSource(owner, notebookId);
  });

  async function freshChunk(ordinal: number): Promise<string> {
    const { data, error } = await owner.client
      .from("chunks")
      .insert({
        notebook_id: notebookId,
        source_id: sourceId,
        ordinal,
        content: `chunk ${ordinal}`,
        embedding: nearbyVector(100 + ordinal, 0.01),
      })
      .select("id");
    if (error || !data?.[0]) throw new Error(`freshChunk(${ordinal}): ${error?.code} ${error?.message}`);
    return data[0].id as string;
  }

  it("lets the owner delete a chunk", async () => {
    const chunkId = await freshChunk(1);
    const { data, error } = await owner.client.from("chunks").delete().eq("id", chunkId).select("id");
    expect(error).toBeNull();
    expect(data).toEqual([{ id: chunkId }]);
  });

  it("lets an editor delete a chunk", async () => {
    const chunkId = await freshChunk(2);
    const { data, error } = await editor.client.from("chunks").delete().eq("id", chunkId).select("id");
    expect(error).toBeNull();
    expect(data).toEqual([{ id: chunkId }]);
  });

  it("a viewer cannot delete a chunk (0 rows affected, no error)", async () => {
    const chunkId = await freshChunk(3);
    const { data, error } = await viewer.client.from("chunks").delete().eq("id", chunkId).select("id");
    expect(error).toBeNull();
    expect(data).toEqual([]);

    const { data: reread } = await owner.client.from("chunks").select("id").eq("id", chunkId);
    expect(reread).toEqual([{ id: chunkId }]);
  });

  it("a stranger cannot delete a chunk (0 rows affected, no error)", async () => {
    const chunkId = await freshChunk(4);
    const { data, error } = await stranger.client.from("chunks").delete().eq("id", chunkId).select("id");
    expect(error).toBeNull();
    expect(data).toEqual([]);

    const { data: reread } = await owner.client.from("chunks").select("id").eq("id", chunkId);
    expect(reread).toEqual([{ id: chunkId }]);
  });

  it("rejects an anon delete with 42501 (no grants for anon at all)", async () => {
    const chunkId = await freshChunk(5);
    const { data, error } = await anonClient().from("chunks").delete().eq("id", chunkId);
    expect(data).toBeNull();
    expect(error?.code).toBe("42501");
  });

  it("an anonymous-signin editor cannot delete a chunk (0 rows affected, reread as owner)", async () => {
    const chunkId = await freshChunk(6);
    const { data, error } = await anonymousMember.client.from("chunks").delete().eq("id", chunkId).select("id");
    expect(error).toBeNull();
    expect(data).toEqual([]);

    const { data: reread } = await owner.client.from("chunks").select("id").eq("id", chunkId);
    expect(reread).toEqual([{ id: chunkId }]);
  });
});
