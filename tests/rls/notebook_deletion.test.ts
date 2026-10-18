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
import { createSource, createSourceWithChunks, insertCitation, insertMessage, nearbyVector } from "./helpers/sources";

/** createSourceWithChunks returns chunkIds as a plain array; under strict
 * `noUncheckedIndexedAccess`, chunkIds[0] types as `string | undefined`. A
 * real check (throw if it actually came back empty), not a `!` assertion. */
function firstChunkId(chunkIds: string[]): string {
  const id = chunkIds[0];
  if (id === undefined) {
    throw new Error("expected createSourceWithChunks to return at least one chunk id");
  }
  return id;
}

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

describe("deleting a notebook with cited assistant answers from two users succeeds and leaves nothing behind", () => {
  // PR #19, item 2: the deletion risk is a single DELETE statement's cascade
  // hitting the same message_citations row from two FK paths at once (the
  // cited chunk's own cascade nulling chunk_id, the citing message's own
  // cascade deleting the row outright) -- "tuple to be updated was already
  // modified by an operation triggered by the current command". Two
  // different users' own cited answers, both citing the same chunk, is what
  // actually exercises that: a single-user fixture cannot tell "the cascade
  // is safe" apart from "RLS just hid it from me afterwards" as cleanly, and
  // cannot reproduce the two-FK-paths-same-row shape at all with only one
  // citing message.
  let owner: SignedInUser;
  let viewer: SignedInUser;
  let notebookId: string;
  let sourceId: string;
  let chunkId: string;
  let viewerAnswerId: string;
  let ownerAnswerId: string;

  beforeAll(async () => {
    owner = await signUpUser("notebook-deletion-cited-owner");
    viewer = await signUpUser("notebook-deletion-cited-viewer");

    notebookId = await createNotebook(owner, "notebook-deletion-cited");
    await addMember(owner, notebookId, viewer.userId, "viewer");

    const { sourceId: createdSourceId, chunkIds } = await createSourceWithChunks(owner, notebookId, 1, 0.01);
    sourceId = createdSourceId;
    chunkId = firstChunkId(chunkIds);

    viewerAnswerId = await insertMessage(viewer, notebookId, "assistant", "viewer's cited answer");
    await insertCitation(viewer, notebookId, viewerAnswerId, 1, { chunkId, quote: "viewer's quote" });

    ownerAnswerId = await insertMessage(owner, notebookId, "assistant", "owner's cited answer, same chunk");
    await insertCitation(owner, notebookId, ownerAnswerId, 1, { chunkId, quote: "owner's quote" });
  });

  it("the owner deletes the notebook in one statement, with no error", async () => {
    const { error } = await owner.client.from("notebooks").delete().eq("id", notebookId);
    expect(error).toBeNull();
  });

  it("the former viewer no longer sees the source, their own answer or its citation", async () => {
    const { data: sourceRows, error: sourceError } = await viewer.client.from("sources").select("id").eq("id", sourceId);
    expect(sourceError).toBeNull();
    expect(sourceRows).toEqual([]);

    const { data: messageRows, error: messageError } = await viewer.client
      .from("messages")
      .select("id")
      .eq("id", viewerAnswerId);
    expect(messageError).toBeNull();
    expect(messageRows).toEqual([]);

    const { data: citationRows, error: citationError } = await viewer.client
      .from("message_citations")
      .select("message_id")
      .eq("message_id", viewerAnswerId);
    expect(citationError).toBeNull();
    expect(citationRows).toEqual([]);
  });

  it("the former owner no longer sees the chunk, their own answer or its citation", async () => {
    const { data: chunkRows, error: chunkError } = await owner.client.from("chunks").select("id").eq("id", chunkId);
    expect(chunkError).toBeNull();
    expect(chunkRows).toEqual([]);

    const { data: messageRows, error: messageError } = await owner.client
      .from("messages")
      .select("id")
      .eq("id", ownerAnswerId);
    expect(messageError).toBeNull();
    expect(messageRows).toEqual([]);

    const { data: citationRows, error: citationError } = await owner.client
      .from("message_citations")
      .select("message_id")
      .eq("message_id", ownerAnswerId);
    expect(citationError).toBeNull();
    expect(citationRows).toEqual([]);
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
