// Deletion behaviour for PR A1's tables through the real PostgREST/JWT path.
// The actual cascade (the rows are really gone, not just RLS-hidden) is
// asserted with a privileged query in
// supabase/tests/database/020_sources_chunks_messages.test.sql; what this
// file adds is the real end-to-end behaviour, with a real JWT, that a client
// of the app would actually observe.
//
// Non-vacuousness (reviewer finding): the "after" checks below are only
// meaningful if the same rows were actually visible *before* the delete --
// otherwise "the editor sees nothing" could just as well mean "the editor
// never had access in the first place" as "the cascade worked". Two
// consequences:
//   * the `it`s in the first describe block are deliberately ordered and
//     share state (fixtures in beforeAll do NOT delete the notebook; one
//     `it` checks "before", the next `it` performs the delete, the next
//     checks "after") -- vitest runs `it`s within a describe sequentially by
//     default, which this relies on.
//   * the messages used for "before"/"after" and the positive control are
//     the *editor's own* messages, not the owner's: the per-user message
//     history policy would hide an owner-authored message from the editor
//     regardless of whether the notebook was ever deleted, which would make
//     either check vacuously pass for the wrong reason.
import { beforeAll, describe, expect, it } from "vitest";
import { signUpUser, type SignedInUser } from "./helpers/clients";
import { addMember, createNotebook } from "./helpers/notebooks";
import { createSource, insertMessage, nearbyVector } from "./helpers/sources";

describe("deleting a notebook cascades away its sources, chunks and messages", () => {
  let owner: SignedInUser;
  let editor: SignedInUser;
  let deletedNotebookId: string;
  let untouchedNotebookId: string;
  let deletedSourceId: string;
  let deletedChunkId: string;
  let editorMessageInDeletedId: string;
  let untouchedSourceId: string;
  let editorMessageInUntouchedId: string;

  beforeAll(async () => {
    owner = await signUpUser("notebook-deletion-owner");
    editor = await signUpUser("notebook-deletion-editor");

    deletedNotebookId = await createNotebook(owner, "notebook-deletion-deleted");
    untouchedNotebookId = await createNotebook(owner, "notebook-deletion-untouched");
    await addMember(owner, deletedNotebookId, editor.userId, "editor");
    await addMember(owner, untouchedNotebookId, editor.userId, "editor");

    deletedSourceId = await createSource(owner, deletedNotebookId);
    const { data: chunkRows, error: chunkError } = await owner.client
      .from("chunks")
      .insert({
        notebook_id: deletedNotebookId,
        source_id: deletedSourceId,
        ordinal: 0,
        content: "will be cascaded away",
        embedding: nearbyVector(1, 0.01),
      })
      .select("id");
    if (chunkError || !chunkRows?.[0]) {
      throw new Error(`fixture chunk insert failed: ${chunkError?.code} ${chunkError?.message}`);
    }
    deletedChunkId = chunkRows[0].id as string;
    editorMessageInDeletedId = await insertMessage(
      editor,
      deletedNotebookId,
      "user",
      "editor's own message, will be cascaded away",
    );

    untouchedSourceId = await createSource(owner, untouchedNotebookId);
    editorMessageInUntouchedId = await insertMessage(
      editor,
      untouchedNotebookId,
      "user",
      "editor's own message, must survive",
    );
  });

  it("before deletion: the editor sees the notebook's source, chunk and their own message", async () => {
    const { data: sourceRows, error: sourceError } = await editor.client
      .from("sources")
      .select("id")
      .eq("id", deletedSourceId);
    expect(sourceError).toBeNull();
    expect(sourceRows).toEqual([{ id: deletedSourceId }]);

    const { data: chunkRows, error: chunkError } = await editor.client
      .from("chunks")
      .select("id")
      .eq("id", deletedChunkId);
    expect(chunkError).toBeNull();
    expect(chunkRows).toEqual([{ id: deletedChunkId }]);

    const { data: messageRows, error: messageError } = await editor.client
      .from("messages")
      .select("id")
      .eq("id", editorMessageInDeletedId);
    expect(messageError).toBeNull();
    expect(messageRows).toEqual([{ id: editorMessageInDeletedId }]);
  });

  it("the owner deletes the notebook", async () => {
    const { error: deleteError } = await owner.client.from("notebooks").delete().eq("id", deletedNotebookId);
    expect(deleteError).toBeNull();
  });

  it("after deletion: the editor no longer sees the notebook's source, chunk or their own message", async () => {
    const { data: sourceRows, error: sourceError } = await editor.client
      .from("sources")
      .select("id")
      .eq("id", deletedSourceId);
    expect(sourceError).toBeNull();
    expect(sourceRows).toEqual([]);

    const { data: chunkRows, error: chunkError } = await editor.client
      .from("chunks")
      .select("id")
      .eq("id", deletedChunkId);
    expect(chunkError).toBeNull();
    expect(chunkRows).toEqual([]);

    const { data: messageRows, error: messageError } = await editor.client
      .from("messages")
      .select("id")
      .eq("id", editorMessageInDeletedId);
    expect(messageError).toBeNull();
    expect(messageRows).toEqual([]);
  });

  it("positive control: the editor still sees the untouched notebook's source and their own message", async () => {
    const { data: sourceRows, error: sourceError } = await editor.client
      .from("sources")
      .select("id")
      .eq("id", untouchedSourceId);
    expect(sourceError).toBeNull();
    expect(sourceRows).toEqual([{ id: untouchedSourceId }]);

    const { data: messageRows, error: messageError } = await editor.client
      .from("messages")
      .select("id")
      .eq("id", editorMessageInUntouchedId);
    expect(messageError).toBeNull();
    expect(messageRows).toEqual([{ id: editorMessageInUntouchedId }]);
  });
});

describe("deleting a source cascades away its chunks", () => {
  let owner: SignedInUser;
  let notebookId: string;

  beforeAll(async () => {
    owner = await signUpUser("source-deletion-owner");
    notebookId = await createNotebook(owner, "source-deletion");
  });

  it("removes the source's chunks when the source is deleted", async () => {
    const sourceId = await createSource(owner, notebookId);
    const { data: chunkRows, error: chunkError } = await owner.client
      .from("chunks")
      .insert({
        notebook_id: notebookId,
        source_id: sourceId,
        ordinal: 0,
        content: "will be cascaded away with its source",
        embedding: nearbyVector(2, 0.01),
      })
      .select("id");
    if (chunkError || !chunkRows?.[0]) {
      throw new Error(`fixture chunk insert failed: ${chunkError?.code} ${chunkError?.message}`);
    }
    const chunkId = chunkRows[0].id as string;

    const { error: deleteError } = await owner.client.from("sources").delete().eq("id", sourceId);
    expect(deleteError).toBeNull();

    const { data: reread, error: rereadError } = await owner.client.from("chunks").select("id").eq("id", chunkId);
    expect(rereadError).toBeNull();
    expect(reread).toEqual([]);
  });
});
