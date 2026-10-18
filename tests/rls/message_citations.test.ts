// RLS matrix and cross-cutting behaviour for public.message_citations (the
// citations redesign: citations move out of messages.citations jsonb into
// their own table). Every client is a real sign-in with a real JWT -- owner,
// editor, viewer, stranger, anon, and an anonymous-signin member -- never the
// admin/service-role credential.
//
// message_citations' own RLS requires both "the caller is a member of
// notebook_id" (private.notebook_role) AND "the cited message belongs to the
// caller" (messages.user_id = auth.uid()) -- a citation is private to the
// user whose question/answer it annotates, same as the message it points
// into. Insert additionally requires chunk_id is not null: a client never
// creates a quote-only or chunk-only citation row; both arrive together, and
// only private.clear_citation_quote()/private.redact_cited_answers() null
// them back out together later, when the cited chunk is deleted.
import { beforeAll, describe, expect, it } from "vitest";
import { anonClient, signInAnonymousUser, signUpUser, type SignedInUser } from "./helpers/clients";
import { addMember, createNotebook } from "./helpers/notebooks";
import { createSourceWithChunks, insertCitation, insertMessage } from "./helpers/sources";

/**
 * Every fixture below creates exactly one chunk and needs its id. Under
 * strict `noUncheckedIndexedAccess`, `chunkIds[0]` types as `string |
 * undefined`, not `string` -- indexing cannot prove the array is non-empty.
 * A real check (throw if it actually came back empty) is used here instead
 * of a `!` non-null assertion: a genuine "0 chunks came back" bug then fails
 * loudly with a clear message, rather than smuggling `undefined` into a
 * `string`-typed id that later ends up silently matching nothing in a
 * `.eq(...)` filter.
 */
function firstChunkId(chunkIds: string[]): string {
  const id = chunkIds[0];
  if (id === undefined) {
    throw new Error("expected createSourceWithChunks to return at least one chunk id");
  }
  return id;
}

describe("message_citations: select", () => {
  let owner: SignedInUser;
  let editor: SignedInUser;
  let viewer: SignedInUser;
  let stranger: SignedInUser;
  let notebookId: string;
  let chunkId: string;
  let ownerMessageId: string;
  let editorMessageId: string;
  let viewerMessageId: string;

  beforeAll(async () => {
    owner = await signUpUser("citations-select-owner");
    editor = await signUpUser("citations-select-editor");
    viewer = await signUpUser("citations-select-viewer");
    stranger = await signUpUser("citations-select-stranger");

    notebookId = await createNotebook(owner, "citations-select");
    await addMember(owner, notebookId, editor.userId, "editor");
    await addMember(owner, notebookId, viewer.userId, "viewer");

    const { chunkIds } = await createSourceWithChunks(owner, notebookId, 1, 0.01);
    chunkId = firstChunkId(chunkIds);

    ownerMessageId = await insertMessage(owner, notebookId, "assistant", "owner's answer");
    await insertCitation(owner, notebookId, ownerMessageId, 1, { chunkId, quote: "owner's quote" });

    editorMessageId = await insertMessage(editor, notebookId, "assistant", "editor's answer");
    await insertCitation(editor, notebookId, editorMessageId, 1, { chunkId, quote: "editor's quote" });

    viewerMessageId = await insertMessage(viewer, notebookId, "assistant", "viewer's answer");
    await insertCitation(viewer, notebookId, viewerMessageId, 1, { chunkId, quote: "viewer's quote" });
  });

  it("lets the owner see their own citation but not the editor's", async () => {
    const { data, error } = await owner.client
      .from("message_citations")
      .select("message_id")
      .eq("notebook_id", notebookId);
    expect(error).toBeNull();
    expect(data).toEqual([{ message_id: ownerMessageId }]);
  });

  it("lets the editor see their own citation but not the owner's", async () => {
    const { data, error } = await editor.client
      .from("message_citations")
      .select("message_id")
      .eq("notebook_id", notebookId);
    expect(error).toBeNull();
    expect(data).toEqual([{ message_id: editorMessageId }]);
  });

  it("lets a viewer see their own citation but not another member's", async () => {
    const { data, error } = await viewer.client
      .from("message_citations")
      .select("message_id")
      .eq("notebook_id", notebookId);
    expect(error).toBeNull();
    expect(data).toEqual([{ message_id: viewerMessageId }]);
  });

  it("shows a stranger nothing (0 rows, no error)", async () => {
    const { data, error } = await stranger.client
      .from("message_citations")
      .select("message_id")
      .eq("notebook_id", notebookId);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("rejects anon with 42501 (no grants for anon at all)", async () => {
    const { data, error } = await anonClient()
      .from("message_citations")
      .select("message_id")
      .eq("notebook_id", notebookId);
    expect(data).toBeNull();
    expect(error?.code).toBe("42501");
  });
});

describe("message_citations: insert", () => {
  let owner: SignedInUser;
  let editor: SignedInUser;
  let viewer: SignedInUser;
  let anonymousMember: SignedInUser;
  let stranger: SignedInUser;
  let notebookId: string;
  let chunkId: string;
  let foreignChunkId: string;
  let ownerMessageId: string;

  beforeAll(async () => {
    owner = await signUpUser("citations-insert-owner");
    editor = await signUpUser("citations-insert-editor");
    viewer = await signUpUser("citations-insert-viewer");
    anonymousMember = await signInAnonymousUser();
    stranger = await signUpUser("citations-insert-stranger");

    notebookId = await createNotebook(owner, "citations-insert");
    await addMember(owner, notebookId, editor.userId, "editor");
    await addMember(owner, notebookId, viewer.userId, "viewer");
    await addMember(owner, notebookId, anonymousMember.userId, "viewer");

    const otherNotebookId = await createNotebook(owner, "citations-insert-other");

    const { chunkIds } = await createSourceWithChunks(owner, notebookId, 1, 0.01);
    chunkId = firstChunkId(chunkIds);
    const foreign = await createSourceWithChunks(owner, otherNotebookId, 1, 0.01);
    foreignChunkId = firstChunkId(foreign.chunkIds);

    ownerMessageId = await insertMessage(owner, notebookId, "assistant", "owner's answer");
  });

  it("lets the owner insert a citation for their own message", async () => {
    await insertCitation(owner, notebookId, ownerMessageId, 1, { chunkId, quote: "a quote" });
    const { data, error } = await owner.client
      .from("message_citations")
      .select("ordinal")
      .eq("message_id", ownerMessageId)
      .eq("ordinal", 1);
    expect(error).toBeNull();
    expect(data).toEqual([{ ordinal: 1 }]);
  });

  it("lets an editor insert a citation for their own message", async () => {
    const messageId = await insertMessage(editor, notebookId, "assistant", "editor's answer");
    await insertCitation(editor, notebookId, messageId, 1, { chunkId, quote: "a quote" });
    const { data, error } = await editor.client
      .from("message_citations")
      .select("ordinal")
      .eq("message_id", messageId);
    expect(error).toBeNull();
    expect(data).toEqual([{ ordinal: 1 }]);
  });

  it("lets a viewer insert a citation for their own message", async () => {
    const messageId = await insertMessage(viewer, notebookId, "assistant", "viewer's answer");
    await insertCitation(viewer, notebookId, messageId, 1, { chunkId, quote: "a quote" });
    const { data, error } = await viewer.client
      .from("message_citations")
      .select("ordinal")
      .eq("message_id", messageId);
    expect(error).toBeNull();
    expect(data).toEqual([{ ordinal: 1 }]);
  });

  it("lets an anonymous-signin member insert a citation for their own message", async () => {
    const messageId = await insertMessage(anonymousMember, notebookId, "assistant", "demo user's answer");
    await insertCitation(anonymousMember, notebookId, messageId, 1, { chunkId, quote: "a quote" });
    const { data, error } = await anonymousMember.client
      .from("message_citations")
      .select("ordinal")
      .eq("message_id", messageId);
    expect(error).toBeNull();
    expect(data).toEqual([{ ordinal: 1 }]);
  });

  it("rejects a stranger inserting a citation with 42501", async () => {
    const { error } = await stranger.client.from("message_citations").insert({
      message_id: ownerMessageId,
      notebook_id: notebookId,
      ordinal: 2,
      chunk_id: chunkId,
      quote: "x",
    });
    expect(error?.code).toBe("42501");
  });

  it("rejects an anon insert with 42501 (no grants for anon at all)", async () => {
    const { error } = await anonClient().from("message_citations").insert({
      message_id: ownerMessageId,
      notebook_id: notebookId,
      ordinal: 3,
      chunk_id: chunkId,
      quote: "x",
    });
    expect(error?.code).toBe("42501");
  });

  it("rejects an editor inserting a citation for someone else's (the owner's) message with 42501", async () => {
    const { error } = await editor.client.from("message_citations").insert({
      message_id: ownerMessageId,
      notebook_id: notebookId,
      ordinal: 4,
      chunk_id: chunkId,
      quote: "x",
    });
    expect(error?.code).toBe("42501");
  });

  it("rejects a citation referencing a chunk from another notebook with 23503", async () => {
    const { error } = await owner.client.from("message_citations").insert({
      message_id: ownerMessageId,
      notebook_id: notebookId,
      ordinal: 5,
      chunk_id: foreignChunkId,
      quote: "x",
    });
    expect(error?.code).toBe("23503");
  });

  it("rejects a citation with chunk_id null (insert policy requires a chunk) with 42501", async () => {
    const { error } = await owner.client.from("message_citations").insert({
      message_id: ownerMessageId,
      notebook_id: notebookId,
      ordinal: 6,
      chunk_id: null,
      quote: null,
    });
    expect(error?.code).toBe("42501");
  });
});

describe("message_citations: update (no grant, every role fails with 42501)", () => {
  let owner: SignedInUser;
  let editor: SignedInUser;
  let viewer: SignedInUser;
  let stranger: SignedInUser;
  let notebookId: string;
  let messageId: string;

  beforeAll(async () => {
    owner = await signUpUser("citations-update-owner");
    editor = await signUpUser("citations-update-editor");
    viewer = await signUpUser("citations-update-viewer");
    stranger = await signUpUser("citations-update-stranger");
    notebookId = await createNotebook(owner, "citations-update");
    await addMember(owner, notebookId, editor.userId, "editor");
    await addMember(owner, notebookId, viewer.userId, "viewer");
    const { chunkIds } = await createSourceWithChunks(owner, notebookId, 1, 0.01);
    messageId = await insertMessage(owner, notebookId, "assistant", "owner's answer");
    await insertCitation(owner, notebookId, messageId, 1, { chunkId: firstChunkId(chunkIds), quote: "original quote" });
  });

  it("rejects the owner updating their own citation's quote with 42501", async () => {
    const { error } = await owner.client
      .from("message_citations")
      .update({ quote: "edited" })
      .eq("message_id", messageId)
      .eq("ordinal", 1);
    expect(error?.code).toBe("42501");
  });

  it("rejects an editor updating the owner's citation with 42501", async () => {
    const { error } = await editor.client
      .from("message_citations")
      .update({ quote: "edited" })
      .eq("message_id", messageId)
      .eq("ordinal", 1);
    expect(error?.code).toBe("42501");
  });

  it("rejects a viewer updating the owner's citation with 42501", async () => {
    const { error } = await viewer.client
      .from("message_citations")
      .update({ quote: "edited" })
      .eq("message_id", messageId)
      .eq("ordinal", 1);
    expect(error?.code).toBe("42501");
  });

  it("rejects a stranger updating the owner's citation with 42501", async () => {
    const { error } = await stranger.client
      .from("message_citations")
      .update({ quote: "edited" })
      .eq("message_id", messageId)
      .eq("ordinal", 1);
    expect(error?.code).toBe("42501");
  });

  it("rejects an anon update with 42501", async () => {
    const { data, error } = await anonClient()
      .from("message_citations")
      .update({ quote: "edited" })
      .eq("message_id", messageId)
      .eq("ordinal", 1);
    expect(data).toBeNull();
    expect(error?.code).toBe("42501");
  });
});

describe("message_citations: delete", () => {
  let owner: SignedInUser;
  let editor: SignedInUser;
  let viewer: SignedInUser;
  let stranger: SignedInUser;
  let notebookId: string;
  let chunkId: string;

  beforeAll(async () => {
    owner = await signUpUser("citations-delete-owner");
    editor = await signUpUser("citations-delete-editor");
    viewer = await signUpUser("citations-delete-viewer");
    stranger = await signUpUser("citations-delete-stranger");
    notebookId = await createNotebook(owner, "citations-delete");
    await addMember(owner, notebookId, editor.userId, "editor");
    await addMember(owner, notebookId, viewer.userId, "viewer");
    const { chunkIds } = await createSourceWithChunks(owner, notebookId, 1, 0.01);
    chunkId = firstChunkId(chunkIds);
  });

  it("lets a member delete their own citation", async () => {
    const messageId = await insertMessage(owner, notebookId, "assistant", "to be deleted");
    await insertCitation(owner, notebookId, messageId, 1, { chunkId, quote: "q" });

    const { data, error } = await owner.client
      .from("message_citations")
      .delete()
      .eq("message_id", messageId)
      .eq("ordinal", 1)
      .select("message_id");
    expect(error).toBeNull();
    expect(data).toEqual([{ message_id: messageId }]);
  });

  it("lets a viewer delete their own citation", async () => {
    const messageId = await insertMessage(viewer, notebookId, "assistant", "viewer's own, to be deleted");
    await insertCitation(viewer, notebookId, messageId, 1, { chunkId, quote: "q" });

    const { data, error } = await viewer.client
      .from("message_citations")
      .delete()
      .eq("message_id", messageId)
      .eq("ordinal", 1)
      .select("message_id");
    expect(error).toBeNull();
    expect(data).toEqual([{ message_id: messageId }]);
  });

  it("a viewer cannot delete another member's citation (0 rows affected, no error)", async () => {
    const messageId = await insertMessage(owner, notebookId, "assistant", "owner's answer, not the viewer's to delete");
    await insertCitation(owner, notebookId, messageId, 1, { chunkId, quote: "q" });

    const { data, error } = await viewer.client
      .from("message_citations")
      .delete()
      .eq("message_id", messageId)
      .eq("ordinal", 1)
      .select("message_id");
    expect(error).toBeNull();
    expect(data).toEqual([]);

    const { data: reread } = await owner.client
      .from("message_citations")
      .select("message_id")
      .eq("message_id", messageId)
      .eq("ordinal", 1);
    expect(reread).toEqual([{ message_id: messageId }]);
  });

  it("another member cannot delete someone else's citation (0 rows affected, no error)", async () => {
    const messageId = await insertMessage(owner, notebookId, "assistant", "owner's answer, not editor's to delete");
    await insertCitation(owner, notebookId, messageId, 1, { chunkId, quote: "q" });

    const { data, error } = await editor.client
      .from("message_citations")
      .delete()
      .eq("message_id", messageId)
      .eq("ordinal", 1)
      .select("message_id");
    expect(error).toBeNull();
    expect(data).toEqual([]);

    const { data: reread } = await owner.client
      .from("message_citations")
      .select("message_id")
      .eq("message_id", messageId)
      .eq("ordinal", 1);
    expect(reread).toEqual([{ message_id: messageId }]);
  });

  it("a stranger cannot delete someone else's citation (0 rows affected, no error)", async () => {
    const messageId = await insertMessage(owner, notebookId, "assistant", "owner's answer, stranger has no access");
    await insertCitation(owner, notebookId, messageId, 1, { chunkId, quote: "q" });

    const { data, error } = await stranger.client
      .from("message_citations")
      .delete()
      .eq("message_id", messageId)
      .eq("ordinal", 1)
      .select("message_id");
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("rejects an anon delete with 42501 (no grants for anon at all)", async () => {
    const messageId = await insertMessage(owner, notebookId, "assistant", "anon cannot touch this");
    await insertCitation(owner, notebookId, messageId, 1, { chunkId, quote: "q" });

    const { data, error } = await anonClient()
      .from("message_citations")
      .delete()
      .eq("message_id", messageId)
      .eq("ordinal", 1);
    expect(data).toBeNull();
    expect(error?.code).toBe("42501");
  });
});

describe("message_citations: deleting a cited chunk's source redacts only the citing message, cross-user", () => {
  // The human's explicit requirement: deletion is done by a DIFFERENT member
  // (an editor) than the one who asked the question and owns the citation (a
  // viewer). Inside the chunk_id FK's ON DELETE SET NULL action,
  // private.redact_cited_answers() runs as the deleting user (the editor);
  // if it were SECURITY INVOKER, an RLS-respecting UPDATE of the viewer's own
  // message would silently touch 0 rows instead of erroring -- this test
  // asserts the message content actually changed, not just that the delete
  // succeeded. Chunk X and chunk Y live in different sources, and a second,
  // unrelated member's own answer citing only Y is used as a control: both
  // prove the redaction is scoped to exactly the row whose citation pointed
  // at the deleted chunk, not a blanket effect on the notebook or the chunk.
  let owner: SignedInUser;
  let editor: SignedInUser;
  let viewer: SignedInUser;
  let notebookId: string;
  let sourceXId: string;
  let chunkXId: string;
  let chunkYId: string;
  let viewerQuestionId: string;
  let viewerAnswerId: string;
  let ownerAnswerId: string;

  beforeAll(async () => {
    owner = await signUpUser("citations-redact-owner");
    editor = await signUpUser("citations-redact-editor");
    viewer = await signUpUser("citations-redact-viewer");

    notebookId = await createNotebook(owner, "citations-redact");
    await addMember(owner, notebookId, editor.userId, "editor");
    await addMember(owner, notebookId, viewer.userId, "viewer");

    const x = await createSourceWithChunks(owner, notebookId, 1, 0.01);
    sourceXId = x.sourceId;
    chunkXId = firstChunkId(x.chunkIds);
    const y = await createSourceWithChunks(owner, notebookId, 1, 0.02, 1000);
    chunkYId = firstChunkId(y.chunkIds);

    viewerQuestionId = await insertMessage(viewer, notebookId, "user", "What does the document say?");
    // The role filter in private.redact_cited_answers(): a citation on the
    // *question* (role='user') pointing at the same chunk X must still get
    // nulled (the chunk_id FK/clear_citation_quote apply regardless of
    // role), but the question's own content must stay untouched -- only
    // `role = 'assistant'` rows get overwritten. Without this citation, that
    // filter is untested.
    await insertCitation(viewer, notebookId, viewerQuestionId, 1, {
      chunkId: chunkXId,
      quote: "quote from X in the question",
    });
    viewerAnswerId = await insertMessage(viewer, notebookId, "assistant", "According to the sources...");
    await insertCitation(viewer, notebookId, viewerAnswerId, 1, { chunkId: chunkXId, quote: "quote from X" });
    await insertCitation(viewer, notebookId, viewerAnswerId, 2, { chunkId: chunkYId, quote: "quote from Y" });

    ownerAnswerId = await insertMessage(owner, notebookId, "assistant", "owner's own answer, cites Y only");
    await insertCitation(owner, notebookId, ownerAnswerId, 1, { chunkId: chunkYId, quote: "owner's quote from Y" });
  });

  // Its own asserted test, not a bare `expect` buried in beforeAll: if a
  // mutation (e.g. redact_cited_answers as SECURITY INVOKER) makes this
  // delete itself fail, this test must show up as a FAILURE. A failing
  // beforeAll instead marks every dependent `it` in the describe as
  // "skipped" rather than "failed" -- confirmed against a real mutant, where
  // the redaction bug surfaced as "permission denied for table messages" on
  // the delete, but with the delete inside beforeAll the whole suite reported
  // 0 failures (everything downstream silently skipped) instead of catching
  // it. The assertions below never read a shared "did the delete succeed"
  // flag either: each queries the database directly, so if this test were
  // ever skipped or failed, they independently re-discover and FAIL on the
  // real (unredacted) state themselves rather than passing vacuously.
  it("an editor (not the viewer who owns the citation) deletes source X", async () => {
    const { error } = await editor.client.from("sources").delete().eq("id", sourceXId);
    expect(error).toBeNull();

    const { data: reread, error: rereadError } = await owner.client.from("sources").select("id").eq("id", sourceXId);
    expect(rereadError).toBeNull();
    expect(reread).toEqual([]);
  });

  it("the citation to the deleted chunk X has chunk_id and quote both null", async () => {
    const { data, error } = await viewer.client
      .from("message_citations")
      .select("chunk_id, quote")
      .eq("message_id", viewerAnswerId)
      .eq("ordinal", 1);
    expect(error).toBeNull();
    expect(data).toEqual([{ chunk_id: null, quote: null }]);
  });

  it("the assistant message's content is redacted to exactly 'Antwort entfernt, Quelle gelöscht'", async () => {
    const { data, error } = await viewer.client.from("messages").select("content").eq("id", viewerAnswerId);
    expect(error).toBeNull();
    expect(data).toEqual([{ content: "Antwort entfernt, Quelle gelöscht" }]);
  });

  it("the viewer's user question is unchanged", async () => {
    const { data, error } = await viewer.client.from("messages").select("content").eq("id", viewerQuestionId);
    expect(error).toBeNull();
    expect(data).toEqual([{ content: "What does the document say?" }]);
  });

  it("the question's own citation to the deleted chunk X is also nulled, even though its content is untouched", async () => {
    const { data, error } = await viewer.client
      .from("message_citations")
      .select("chunk_id, quote")
      .eq("message_id", viewerQuestionId)
      .eq("ordinal", 1);
    expect(error).toBeNull();
    expect(data).toEqual([{ chunk_id: null, quote: null }]);
  });

  it("the citation to chunk Y is unchanged", async () => {
    const { data, error } = await viewer.client
      .from("message_citations")
      .select("chunk_id, quote")
      .eq("message_id", viewerAnswerId)
      .eq("ordinal", 2);
    expect(error).toBeNull();
    expect(data).toEqual([{ chunk_id: chunkYId, quote: "quote from Y" }]);
  });

  it("another member's own answer citing only Y is unchanged", async () => {
    const { data: messageRows, error: messageError } = await owner.client
      .from("messages")
      .select("content")
      .eq("id", ownerAnswerId);
    expect(messageError).toBeNull();
    expect(messageRows).toEqual([{ content: "owner's own answer, cites Y only" }]);

    const { data: citationRows, error: citationError } = await owner.client
      .from("message_citations")
      .select("chunk_id, quote")
      .eq("message_id", ownerAnswerId)
      .eq("ordinal", 1);
    expect(citationError).toBeNull();
    expect(citationRows).toEqual([{ chunk_id: chunkYId, quote: "owner's quote from Y" }]);
  });
});

describe("message_citations: deleting the notebook cascades away its messages and citations", () => {
  // Through PostgREST this is necessarily a visibility check -- the owner
  // loses their own membership along with the notebook, so "0 rows" here is
  // consistent with "RLS now hides it" as much as with "the cascade ran".
  // The non-vacuous proof (the rows are really gone, not just hidden) is the
  // privileged pgTAP check in 020_sources_chunks_messages.test.sql, the same
  // split used throughout this suite (see notebook_deletion.test.ts).
  let owner: SignedInUser;
  let notebookId: string;
  let messageId: string;

  beforeAll(async () => {
    owner = await signUpUser("citations-notebook-deletion-owner");
    notebookId = await createNotebook(owner, "citations-notebook-deletion");
    const { chunkIds } = await createSourceWithChunks(owner, notebookId, 1, 0.01);
    messageId = await insertMessage(owner, notebookId, "assistant", "will be cascaded away");
    await insertCitation(owner, notebookId, messageId, 1, { chunkId: chunkIds[0], quote: "q" });
  });

  // Its own asserted test rather than a bare `expect` in beforeAll -- see the
  // comment on the equivalent test in the cross-user redaction describe block
  // above for why a failing setup step must FAIL the suite, not silently skip
  // every dependent assertion.
  it("the owner deletes the notebook", async () => {
    const { error } = await owner.client.from("notebooks").delete().eq("id", notebookId);
    expect(error).toBeNull();
  });

  it("the owner no longer sees the message or its citation", async () => {
    const { data: messageRows, error: messageError } = await owner.client
      .from("messages")
      .select("id")
      .eq("id", messageId);
    expect(messageError).toBeNull();
    expect(messageRows).toEqual([]);

    const { data: citationRows, error: citationError } = await owner.client
      .from("message_citations")
      .select("message_id")
      .eq("message_id", messageId);
    expect(citationError).toBeNull();
    expect(citationRows).toEqual([]);
  });
});
