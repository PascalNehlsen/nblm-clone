// RLS matrix for the `sources` Storage bucket (PR A2 contract). Every client
// is built from a real sign-in and a real JWT -- owner, editor, viewer,
// stranger, anon (no session), and an anonymous-signin user added as a real
// member -- never the admin/service-role credential (AGENTS.md). Uploads and
// downloads go through the real local Storage API (supabase-js's `.storage`
// client), not through a direct Postgres connection: that is the only path
// that actually exercises storage.objects' RLS policies together with the
// Storage server's own bucket-level checks (MIME type allowlist, size limit).
//
// Human requirement (final shape of the A2 policies, after the first plan
// draft): a leftover object must stop being reachable the moment its
// `sources` row is deleted, not only once the whole notebook is gone --
// select, insert AND delete on storage.objects all look the object's name up
// as a public.sources.storage_path and read membership off that row's own
// notebook_id, not by parsing or casting any part of the object name itself.
// Deleting a notebook cascades away its sources rows (ADR 0004 /
// 020_sources_chunks_messages.test.sql), so "notebook deleted" is really a
// special case of "the sources row is gone" -- both are exercised below,
// since the app's own delete order (object, then row; see ADR 0004) is
// itself a safety property worth pinning down.
//
// Red-for-the-right-reason, before and after the migration: every negative
// assertion below goes through `expectDenied`, which fails as long as the
// underlying error is "Bucket not found" (the state before this PR's
// migration exists) and only passes once the denial is an actual policy
// decision. A bare `expect(error).not.toBeNull()` would pass today for the
// wrong reason (the bucket is simply missing) and stay green after the
// migration too, without ever having exercised the policy it names -- this
// project's house rule against meaningless assertions. remove() is the one
// exception: Supabase Storage's remove() does not error when RLS lets zero
// rows match (same "DELETE affects 0 rows, no error" semantics as a plain
// PostgREST table delete under RLS) -- that case must be checked by the
// object still existing afterwards, not by an error field.
//
// remove()'s own select-first resolution is also a real limit of what this
// file can prove about the delete POLICY specifically: remove() looks the
// object up through the select policy before it ever reaches delete, so once
// an object is invisible under select (a leftover whose sources row is gone),
// remove() has nothing to act on -- it reports 0 objects deleted whether the
// delete policy itself would have allowed or denied that row. The cases below
// that go through remove() on an already-invisible leftover are named and
// commented accordingly: they prove the real app code path is a harmless
// no-op, not that the delete policy denied anything. The delete policy's own
// shape (including its owner/editor-only restriction and its "existing
// sources row" requirement, independent of select) is driven directly in
// 030_sources_storage.test.sql, which lifts storage.protect_delete's escape
// hatch to issue a real DELETE as the role authenticated.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { anonClient, signInAnonymousUser, signUpUser, type SignedInUser } from "./helpers/clients";
import { addMember, createNotebook } from "./helpers/notebooks";
import { createSource, storagePath } from "./helpers/sources";

const BUCKET = "sources";
const TEXT_BODY = Buffer.from("hello from the storage rls matrix\n", "utf8");
const OTHER_BODY = Buffer.from("a different payload that must never land\n", "utf8");

interface StorageLikeError {
  message?: string;
  statusCode?: string;
}

/**
 * Fails as long as the error is "Bucket not found" (the state before the A2
 * migration creates the `sources` bucket) and only passes once the rejection
 * is a genuine policy/validation decision. See file header for why this is
 * not a bare `expect(error).not.toBeNull()`.
 */
function expectDenied(error: StorageLikeError | null): void {
  expect(error).not.toBeNull();
  expect(error?.message ?? "").not.toMatch(/bucket not found/i);
}

/** Creates a fresh source as `creator` and returns its id and storage path. */
async function freshPath(creator: SignedInUser, notebookId: string): Promise<{ sourceId: string; path: string }> {
  const sourceId = await createSource(creator, notebookId);
  return { sourceId, path: storagePath(notebookId, sourceId) };
}

function sizedBody(bytes: number): Buffer {
  return Buffer.alloc(bytes, 0x41);
}

describe("storage: upload", () => {
  let owner: SignedInUser;
  let editor: SignedInUser;
  let viewer: SignedInUser;
  let stranger: SignedInUser;
  let anonymousMember: SignedInUser;
  let notebookId: string;
  let otherNotebookId: string;

  beforeAll(async () => {
    owner = await signUpUser("storage-upload-owner");
    editor = await signUpUser("storage-upload-editor");
    viewer = await signUpUser("storage-upload-viewer");
    stranger = await signUpUser("storage-upload-stranger");
    anonymousMember = await signInAnonymousUser();

    notebookId = await createNotebook(owner, "storage-upload");
    await addMember(owner, notebookId, editor.userId, "editor");
    await addMember(owner, notebookId, viewer.userId, "viewer");
    // Added by the (non-anonymous) owner, so the restrictive "no anonymous
    // actor" policy on notebook_members does not apply to this insert itself
    // -- see sources.test.ts for the same pattern.
    await addMember(owner, notebookId, anonymousMember.userId, "editor");

    // A second notebook the owner also owns, but editor is not a member of --
    // for the "upload to another notebook's path" case below.
    otherNotebookId = await createNotebook(owner, "storage-upload-other");
  });

  it("lets the owner upload to their own existing source's path", async () => {
    const { path } = await freshPath(owner, notebookId);
    const { data, error } = await owner.client.storage
      .from(BUCKET)
      .upload(path, TEXT_BODY, { contentType: "text/plain" });
    expect(error).toBeNull();
    expect(data?.path).toBe(path);
  });

  it("lets an editor upload to an existing source's path (row created by the owner)", async () => {
    const { path } = await freshPath(owner, notebookId);
    const { data, error } = await editor.client.storage
      .from(BUCKET)
      .upload(path, TEXT_BODY, { contentType: "text/plain" });
    expect(error).toBeNull();
    expect(data?.path).toBe(path);
  });

  it("denies a viewer uploading to an existing source's path", async () => {
    const { path } = await freshPath(owner, notebookId);
    const { error } = await viewer.client.storage
      .from(BUCKET)
      .upload(path, TEXT_BODY, { contentType: "text/plain" });
    expectDenied(error);
  });

  it("denies a stranger uploading to an existing source's path", async () => {
    const { path } = await freshPath(owner, notebookId);
    const { error } = await stranger.client.storage
      .from(BUCKET)
      .upload(path, TEXT_BODY, { contentType: "text/plain" });
    expectDenied(error);
  });

  it("denies an anonymous-signin member uploading, even though they are an editor (restrictive is_anonymous policy)", async () => {
    const { path } = await freshPath(owner, notebookId);
    const { error } = await anonymousMember.client.storage
      .from(BUCKET)
      .upload(path, TEXT_BODY, { contentType: "text/plain" });
    expectDenied(error);
  });

  it("denies anon (no session at all) uploading", async () => {
    const { path } = await freshPath(owner, notebookId);
    const { error } = await anonClient()
      .storage.from(BUCKET)
      .upload(path, TEXT_BODY, { contentType: "text/plain" });
    expectDenied(error);
  });

  it("denies uploading to a path with no sources row at all (orphan upload)", async () => {
    const path = storagePath(notebookId, randomUUID());
    const { error } = await owner.client.storage
      .from(BUCKET)
      .upload(path, TEXT_BODY, { contentType: "text/plain" });
    expectDenied(error);
  });

  it("denies uploading to a path whose sources row has since been deleted", async () => {
    const { sourceId, path } = await freshPath(owner, notebookId);
    const { error: deleteError } = await owner.client.from("sources").delete().eq("id", sourceId);
    expect(deleteError).toBeNull();

    const { error } = await owner.client.storage
      .from(BUCKET)
      .upload(path, TEXT_BODY, { contentType: "text/plain" });
    expectDenied(error);
  });

  it("denies an editor uploading to a source's path in a notebook they are not a member of", async () => {
    const { path } = await freshPath(owner, otherNotebookId);
    const { error } = await editor.client.storage
      .from(BUCKET)
      .upload(path, TEXT_BODY, { contentType: "text/plain" });
    expectDenied(error);
  });

  it("denies uploading to a malformed path without a 500, and listing still works afterwards", async () => {
    const { error } = await owner.client.storage
      .from(BUCKET)
      .upload("not-a-uuid/x", TEXT_BODY, { contentType: "text/plain" });
    expectDenied(error);
    expect((error as StorageLikeError | null)?.statusCode).not.toBe("500");

    const { error: listError } = await owner.client.storage.from(BUCKET).list(notebookId);
    expect(listError).toBeNull();
  });
});

describe("storage: limits", () => {
  let owner: SignedInUser;
  let notebookId: string;

  beforeAll(async () => {
    owner = await signUpUser("storage-limits-owner");
    notebookId = await createNotebook(owner, "storage-limits");
  });

  it("rejects a disallowed MIME type", async () => {
    const { path } = await freshPath(owner, notebookId);
    const { error } = await owner.client.storage
      .from(BUCKET)
      .upload(path, sizedBody(16), { contentType: "image/png" });
    expectDenied(error);
  });

  it("rejects a file over the 20 MiB limit", async () => {
    const { path } = await freshPath(owner, notebookId);
    const oversized = sizedBody(20 * 1024 * 1024 + 1);
    const { error } = await owner.client.storage
      .from(BUCKET)
      .upload(path, oversized, { contentType: "application/pdf" });
    expectDenied(error);
  });
});

describe("storage: download", () => {
  let owner: SignedInUser;
  let editor: SignedInUser;
  let viewer: SignedInUser;
  let stranger: SignedInUser;
  let anonymousMember: SignedInUser;
  let notebookId: string;
  let sourceId: string;
  let path: string;

  beforeAll(async () => {
    owner = await signUpUser("storage-download-owner");
    editor = await signUpUser("storage-download-editor");
    viewer = await signUpUser("storage-download-viewer");
    stranger = await signUpUser("storage-download-stranger");
    anonymousMember = await signInAnonymousUser();

    notebookId = await createNotebook(owner, "storage-download");
    await addMember(owner, notebookId, editor.userId, "editor");
    await addMember(owner, notebookId, viewer.userId, "viewer");
    await addMember(owner, notebookId, anonymousMember.userId, "viewer");

    ({ sourceId, path } = await freshPath(owner, notebookId));
    const { error } = await owner.client.storage.from(BUCKET).upload(path, TEXT_BODY, { contentType: "text/plain" });
    if (error) throw new Error(`fixture upload failed: ${error.message}`);
  });

  // Reviewer finding: without this, "no longer lists it" below (after the
  // sources row is deleted) could pass vacuously even if listing was broken
  // outright, since an always-empty list() would also show no entry. Proving
  // the object WAS listed first is what gives the later "it is gone" checks
  // their meaning.
  it("lists the object for the owner before any deletion", async () => {
    const { data, error } = await owner.client.storage.from(BUCKET).list(notebookId);
    expect(error).toBeNull();
    expect((data ?? []).some((entry) => path.endsWith(entry.name))).toBe(true);
  });

  it("lets the owner download the object with the uploaded content", async () => {
    const { data, error } = await owner.client.storage.from(BUCKET).download(path);
    expect(error).toBeNull();
    expect(await data?.text()).toBe(TEXT_BODY.toString("utf8"));
  });

  it("lets an editor download the object", async () => {
    const { data, error } = await editor.client.storage.from(BUCKET).download(path);
    expect(error).toBeNull();
    expect(await data?.text()).toBe(TEXT_BODY.toString("utf8"));
  });

  it("lets a viewer download the object", async () => {
    const { data, error } = await viewer.client.storage.from(BUCKET).download(path);
    expect(error).toBeNull();
    expect(await data?.text()).toBe(TEXT_BODY.toString("utf8"));
  });

  // Intended, same as sources/chunks select: there is no restrictive
  // is_anonymous policy on select, so an anonymous-signin member reads like
  // any other member.
  it("lets an anonymous-signin member download the object (select has no restrictive anonymous block, like sources)", async () => {
    const { data, error } = await anonymousMember.client.storage.from(BUCKET).download(path);
    expect(error).toBeNull();
    expect(await data?.text()).toBe(TEXT_BODY.toString("utf8"));
  });

  it("denies a stranger downloading the object", async () => {
    const { error } = await stranger.client.storage.from(BUCKET).download(path);
    expectDenied(error);
  });

  it("denies anon (no session) downloading the object", async () => {
    const { error } = await anonClient().storage.from(BUCKET).download(path);
    expectDenied(error);
  });

  it("returns no entries to a stranger listing the notebook's folder", async () => {
    const { data, error } = await stranger.client.storage.from(BUCKET).list(notebookId);
    expect(error).toBeNull();
    expect(data ?? []).toEqual([]);
  });

  describe("after the sources row is deleted (object still present in Storage)", () => {
    beforeAll(async () => {
      const { error } = await owner.client.from("sources").delete().eq("id", sourceId);
      if (error) throw new Error(`fixture: deleting the sources row failed: ${error.message}`);
    });

    it("no longer lets the owner download it", async () => {
      const { error } = await owner.client.storage.from(BUCKET).download(path);
      expectDenied(error);
    });

    it("no longer lets the former editor download it", async () => {
      const { error } = await editor.client.storage.from(BUCKET).download(path);
      expectDenied(error);
    });

    it("no longer lets the former viewer download it", async () => {
      const { error } = await viewer.client.storage.from(BUCKET).download(path);
      expectDenied(error);
    });

    it("no longer lists it for the owner (it was listed above, before the deletion)", async () => {
      const { data, error } = await owner.client.storage.from(BUCKET).list(notebookId);
      expect(error).toBeNull();
      expect((data ?? []).some((entry) => path.endsWith(entry.name))).toBe(false);
    });

    // This does NOT exercise the delete policy: the Storage API's remove()
    // resolves the object through the SELECT policy first, and that policy
    // already hides a leftover (same "existing sources row" requirement,
    // proven above by the download/list checks) -- remove() therefore has
    // nothing to act on and reports 0 objects deleted regardless of what the
    // delete policy itself says. A mutation that drops the delete policy's own
    // requirements entirely is invisible to this test for exactly that reason;
    // the real behavioural proof of the delete policy's own shape is in
    // 030_sources_storage.test.sql section 6, which drives it directly (it has
    // to lift storage.protect_delete's escape hatch to do so -- see that
    // file). This test only proves: once the leftover is invisible, the real
    // app code path (remove()) is a safe, harmless no-op, not a crash or a
    // silent delete of something else.
    it("remove() on a now-invisible leftover deletes nothing (0 objects reported, not an error) -- proves select's invisibility is harmless for remove(), not the delete policy itself", async () => {
      const { data, error } = await owner.client.storage.from(BUCKET).remove([path]);
      expect(error).toBeNull();
      expect(data ?? []).toEqual([]);
    });
  });
});

describe("storage: overwrite", () => {
  let owner: SignedInUser;
  let notebookId: string;
  let path: string;

  beforeAll(async () => {
    owner = await signUpUser("storage-overwrite-owner");
    notebookId = await createNotebook(owner, "storage-overwrite");
    ({ path } = await freshPath(owner, notebookId));
    const { error } = await owner.client.storage.from(BUCKET).upload(path, TEXT_BODY, { contentType: "text/plain" });
    if (error) throw new Error(`fixture upload failed: ${error.message}`);
  });

  it("denies the owner overwriting the object with upsert: true (no update policy)", async () => {
    const { error } = await owner.client.storage
      .from(BUCKET)
      .upload(path, OTHER_BODY, { contentType: "text/plain", upsert: true });
    expectDenied(error);
  });

  it("leaves the original content intact after the rejected overwrite", async () => {
    const { data, error } = await owner.client.storage.from(BUCKET).download(path);
    expect(error).toBeNull();
    expect(await data?.text()).toBe(TEXT_BODY.toString("utf8"));
  });
});

describe("storage: delete", () => {
  let owner: SignedInUser;
  let editor: SignedInUser;
  let viewer: SignedInUser;
  let stranger: SignedInUser;
  let anonymousMember: SignedInUser;
  let notebookId: string;

  beforeAll(async () => {
    owner = await signUpUser("storage-delete-owner");
    editor = await signUpUser("storage-delete-editor");
    viewer = await signUpUser("storage-delete-viewer");
    stranger = await signUpUser("storage-delete-stranger");
    anonymousMember = await signInAnonymousUser();

    notebookId = await createNotebook(owner, "storage-delete");
    await addMember(owner, notebookId, editor.userId, "editor");
    await addMember(owner, notebookId, viewer.userId, "viewer");
    await addMember(owner, notebookId, anonymousMember.userId, "editor");
  });

  it("lets the owner remove an object they can see", async () => {
    const { path } = await freshPath(owner, notebookId);
    const { error: uploadError } = await owner.client.storage
      .from(BUCKET)
      .upload(path, TEXT_BODY, { contentType: "text/plain" });
    if (uploadError) throw new Error(`fixture upload failed: ${uploadError.message}`);

    const { error: removeError } = await owner.client.storage.from(BUCKET).remove([path]);
    expect(removeError).toBeNull();

    const { error: downloadError } = await owner.client.storage.from(BUCKET).download(path);
    expectDenied(downloadError); // genuinely gone, not merely invisible
  });

  it("lets an editor remove an object", async () => {
    const { path } = await freshPath(owner, notebookId);
    const { error: uploadError } = await owner.client.storage
      .from(BUCKET)
      .upload(path, TEXT_BODY, { contentType: "text/plain" });
    if (uploadError) throw new Error(`fixture upload failed: ${uploadError.message}`);

    const { error: removeError } = await editor.client.storage.from(BUCKET).remove([path]);
    expect(removeError).toBeNull();

    const { error: downloadError } = await owner.client.storage.from(BUCKET).download(path);
    expectDenied(downloadError);
  });

  // Storage's remove() mirrors a plain PostgREST delete under RLS: a row RLS
  // hides is simply not matched, so remove() itself can come back with no
  // error and an empty `data` array even though nothing happened (see file
  // header). The only reliable way to prove "this actor could not remove it"
  // is that the object is still there afterwards, as the owner.
  it("does not let a viewer remove an object (it still exists afterwards)", async () => {
    const { path } = await freshPath(owner, notebookId);
    const { error: uploadError } = await owner.client.storage
      .from(BUCKET)
      .upload(path, TEXT_BODY, { contentType: "text/plain" });
    if (uploadError) throw new Error(`fixture upload failed: ${uploadError.message}`);

    await viewer.client.storage.from(BUCKET).remove([path]);

    const { data, error } = await owner.client.storage.from(BUCKET).download(path);
    expect(error).toBeNull();
    expect(await data?.text()).toBe(TEXT_BODY.toString("utf8"));
  });

  it("does not let a stranger remove an object (it still exists afterwards)", async () => {
    const { path } = await freshPath(owner, notebookId);
    const { error: uploadError } = await owner.client.storage
      .from(BUCKET)
      .upload(path, TEXT_BODY, { contentType: "text/plain" });
    if (uploadError) throw new Error(`fixture upload failed: ${uploadError.message}`);

    await stranger.client.storage.from(BUCKET).remove([path]);

    const { data, error } = await owner.client.storage.from(BUCKET).download(path);
    expect(error).toBeNull();
    expect(await data?.text()).toBe(TEXT_BODY.toString("utf8"));
  });

  it("does not let an anonymous-signin member remove an object, even as an editor (it still exists afterwards)", async () => {
    const { path } = await freshPath(owner, notebookId);
    const { error: uploadError } = await owner.client.storage
      .from(BUCKET)
      .upload(path, TEXT_BODY, { contentType: "text/plain" });
    if (uploadError) throw new Error(`fixture upload failed: ${uploadError.message}`);

    await anonymousMember.client.storage.from(BUCKET).remove([path]);

    const { data, error } = await owner.client.storage.from(BUCKET).download(path);
    expect(error).toBeNull();
    expect(await data?.text()).toBe(TEXT_BODY.toString("utf8"));
  });

  it("does not let anon (no session at all) remove an object (it still exists afterwards)", async () => {
    const { path } = await freshPath(owner, notebookId);
    const { error: uploadError } = await owner.client.storage
      .from(BUCKET)
      .upload(path, TEXT_BODY, { contentType: "text/plain" });
    if (uploadError) throw new Error(`fixture upload failed: ${uploadError.message}`);

    await anonClient().storage.from(BUCKET).remove([path]);

    const { data, error } = await owner.client.storage.from(BUCKET).download(path);
    expect(error).toBeNull();
    expect(await data?.text()).toBe(TEXT_BODY.toString("utf8"));
  });
});

describe("storage: move and copy", () => {
  let owner: SignedInUser;
  let notebookId: string;

  beforeAll(async () => {
    owner = await signUpUser("storage-move-owner");
    notebookId = await createNotebook(owner, "storage-move");
  });

  // move() is implemented as an UPDATE of storage.objects.name; there is no
  // update policy at all for bucket sources (see 030_sources_storage.test.sql
  // section 3), so it must be denied regardless of whether the destination
  // has a sources row of its own.
  it("denies the owner moving an object (no update policy covers move)", async () => {
    const { path } = await freshPath(owner, notebookId);
    const { error: uploadError } = await owner.client.storage
      .from(BUCKET)
      .upload(path, TEXT_BODY, { contentType: "text/plain" });
    if (uploadError) throw new Error(`fixture upload failed: ${uploadError.message}`);
    const { path: destPath } = await freshPath(owner, notebookId);

    const { error } = await owner.client.storage.from(BUCKET).move(path, destPath);
    expectDenied(error);

    const { data, error: downloadError } = await owner.client.storage.from(BUCKET).download(path);
    expect(downloadError).toBeNull();
    expect(await data?.text()).toBe(TEXT_BODY.toString("utf8"));
  });

  it("denies copying an object to a path with no sources row (orphan copy)", async () => {
    const { path } = await freshPath(owner, notebookId);
    const { error: uploadError } = await owner.client.storage
      .from(BUCKET)
      .upload(path, TEXT_BODY, { contentType: "text/plain" });
    if (uploadError) throw new Error(`fixture upload failed: ${uploadError.message}`);
    const orphanDest = storagePath(notebookId, randomUUID());

    const { error } = await owner.client.storage.from(BUCKET).copy(path, orphanDest);
    expectDenied(error);
  });
});

describe("storage: deletion order (ADR 0004)", () => {
  let owner: SignedInUser;
  let editor: SignedInUser;

  beforeAll(async () => {
    owner = await signUpUser("storage-order-owner");
    editor = await signUpUser("storage-order-editor");
  });

  it("orphans the object when the notebook (and its cascaded sources row) is deleted first: neither the former owner nor the former editor can still download or remove it", async () => {
    const notebookId = await createNotebook(owner, "storage-order-notebook-first");
    await addMember(owner, notebookId, editor.userId, "editor");
    const { path } = await freshPath(owner, notebookId);
    const { error: uploadError } = await owner.client.storage
      .from(BUCKET)
      .upload(path, TEXT_BODY, { contentType: "text/plain" });
    if (uploadError) throw new Error(`fixture upload failed: ${uploadError.message}`);

    const { error: deleteNotebookError } = await owner.client.from("notebooks").delete().eq("id", notebookId);
    expect(deleteNotebookError).toBeNull();

    const { error: ownerDownloadError } = await owner.client.storage.from(BUCKET).download(path);
    expectDenied(ownerDownloadError);
    const { error: editorDownloadError } = await editor.client.storage.from(BUCKET).download(path);
    expectDenied(editorDownloadError);

    // Same caveat as the "storage: download" describe above: this does not
    // test the delete policy on its own -- remove() resolves the object
    // through select first, which already hides it (download above already
    // proved that), so remove() has nothing to act on. It still confirms the
    // real app code path behaves harmlessly here: `data` lists exactly the
    // objects actually deleted, so an empty array (no error) is the expected
    // "nothing to delete" response, not a crash.
    const { data: ownerRemoveData, error: ownerRemoveError } = await owner.client.storage.from(BUCKET).remove([path]);
    expect(ownerRemoveError).toBeNull();
    expect(ownerRemoveData ?? []).toEqual([]);
  });

  it("leaves nothing behind when the object is removed first, then the notebook is deleted", async () => {
    const notebookId = await createNotebook(owner, "storage-order-object-first");
    const { path } = await freshPath(owner, notebookId);
    const { error: uploadError } = await owner.client.storage
      .from(BUCKET)
      .upload(path, TEXT_BODY, { contentType: "text/plain" });
    if (uploadError) throw new Error(`fixture upload failed: ${uploadError.message}`);

    // Point 1 (reviewer): without this, "leaves nothing behind" below could
    // pass vacuously even if listing never worked at all.
    const { data: before, error: beforeError } = await owner.client.storage.from(BUCKET).list(notebookId);
    expect(beforeError).toBeNull();
    expect((before ?? []).some((entry) => path.endsWith(entry.name))).toBe(true);

    const { data: removeData, error: removeError } = await owner.client.storage.from(BUCKET).remove([path]);
    expect(removeError).toBeNull();
    expect((removeData ?? []).map((entry) => entry.name)).toEqual([path]);

    const { data: listed, error: listError } = await owner.client.storage.from(BUCKET).list(notebookId);
    expect(listError).toBeNull();
    expect(listed ?? []).toEqual([]);

    const { error: deleteNotebookError } = await owner.client.from("notebooks").delete().eq("id", notebookId);
    expect(deleteNotebookError).toBeNull();
  });
});
