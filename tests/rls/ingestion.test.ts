// RLS matrix for PR C1's ingestion additions to public.sources: the
// `error_category`/`status_changed_at` columns and their constraints and
// grants, the claim() semantics of sourceStore() (lib/sources/sources.ts),
// createSignedUpload() against the `sources` Storage bucket, and the
// per-notebook source cap trigger. Every client is built from a real sign-in
// and a real JWT -- owner, editor, viewer, stranger, anon (no session), and an
// anonymous-signin user added as a real member -- never the admin/
// service-role credential (AGENTS.md). See tests/rls/sources.test.ts for the
// pre-existing title/status column matrix this file extends, and
// tests/rls/storage.test.ts for the pre-existing upload/download/remove
// matrix this file extends with createSignedUpload().
//
// sourceStore()/createSignedUpload() are imported by relative path, not the
// "@/..." alias: the "rls" vitest project (vitest.config.ts) has no such
// alias configured, unlike "unit" -- see tests/rls/app-notebooks.test.ts's
// header for the same note about apps/web/lib/notebooks.
//
// Hedge for createSignedUpload's negative cases (reviewer-requested
// robustness): Supabase's `createSignedUploadUrl` may or may not check the
// storage.objects INSERT policy at the moment the token is minted -- some
// versions defer the real rejection to the moment the token is actually used
// via `uploadToSignedUrl`. Both behaviours satisfy the real security
// property ("this actor can never make a real object exist at this path"),
// so `assertSignedUploadDenied` below does not hard-assert on whether
// createSignedUpload() itself throws; it always drives the returned token
// through a real uploadToSignedUrl() attempt and then proves the object does
// not exist afterwards (via Storage list()), which is true either way.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { anonClient, signInAnonymousUser, signUpUser, type SignedInUser } from "./helpers/clients";
import { addMember, createNotebook } from "./helpers/notebooks";
import { createSource, storagePath } from "./helpers/sources";
import { createSignedUpload, sourceStore } from "../../apps/web/lib/sources/sources";

const BUCKET = "sources";

describe("sources: error_category update", () => {
  let owner: SignedInUser;
  let editor: SignedInUser;
  let viewer: SignedInUser;
  let stranger: SignedInUser;
  let anonymousMember: SignedInUser;
  let notebookId: string;

  beforeAll(async () => {
    owner = await signUpUser("ingestion-errcat-owner");
    editor = await signUpUser("ingestion-errcat-editor");
    viewer = await signUpUser("ingestion-errcat-viewer");
    stranger = await signUpUser("ingestion-errcat-stranger");
    anonymousMember = await signInAnonymousUser();

    notebookId = await createNotebook(owner, "ingestion-errcat");
    await addMember(owner, notebookId, editor.userId, "editor");
    await addMember(owner, notebookId, viewer.userId, "viewer");
    // The owner (not anonymous) performs this insert, so the restrictive
    // "no anonymous actor" policy on notebook_members does not apply here.
    await addMember(owner, notebookId, anonymousMember.userId, "editor");
  });

  /** A fresh source, already moved to `failed` by the owner (allowed today via
   * the existing `status` column grant), so error_category may legally be set. */
  async function freshFailedSource(): Promise<string> {
    const sourceId = await createSource(owner, notebookId);
    const { error } = await owner.client.from("sources").update({ status: "failed" }).eq("id", sourceId);
    if (error) throw new Error(`fixture: set status failed: ${error.code ?? "?"} ${error.message}`);
    return sourceId;
  }

  it("lets the owner set error_category while failed, and reads it back", async () => {
    const sourceId = await freshFailedSource();
    const { data, error } = await owner.client
      .from("sources")
      .update({ error_category: "no_text" })
      .eq("id", sourceId)
      .select("error_category");
    expect(error).toBeNull();
    expect(data).toEqual([{ error_category: "no_text" }]);
  });

  it("lets an editor set error_category the same way", async () => {
    const sourceId = await freshFailedSource();
    const { data, error } = await editor.client
      .from("sources")
      .update({ error_category: "no_text" })
      .eq("id", sourceId)
      .select("error_category");
    expect(error).toBeNull();
    expect(data).toEqual([{ error_category: "no_text" }]);
  });

  it("a viewer cannot set error_category (0 rows affected, value unchanged)", async () => {
    const sourceId = await freshFailedSource();
    const { data, error } = await viewer.client
      .from("sources")
      .update({ error_category: "no_text" })
      .eq("id", sourceId)
      .select("error_category");
    expect(error).toBeNull();
    expect(data).toEqual([]);

    const { data: reread } = await owner.client.from("sources").select("error_category").eq("id", sourceId);
    expect(reread).toEqual([{ error_category: null }]);
  });

  it("a stranger cannot set error_category (0 rows affected, value unchanged)", async () => {
    const sourceId = await freshFailedSource();
    const { data, error } = await stranger.client
      .from("sources")
      .update({ error_category: "no_text" })
      .eq("id", sourceId)
      .select("error_category");
    expect(error).toBeNull();
    expect(data).toEqual([]);

    const { data: reread } = await owner.client.from("sources").select("error_category").eq("id", sourceId);
    expect(reread).toEqual([{ error_category: null }]);
  });

  it("an anonymous-signin editor cannot set error_category (0 rows affected, restrictive policy)", async () => {
    const sourceId = await freshFailedSource();
    const { data, error } = await anonymousMember.client
      .from("sources")
      .update({ error_category: "no_text" })
      .eq("id", sourceId)
      .select("error_category");
    expect(error).toBeNull();
    expect(data).toEqual([]);

    const { data: reread } = await owner.client.from("sources").select("error_category").eq("id", sourceId);
    expect(reread).toEqual([{ error_category: null }]);
  });

  it("anon (no session) cannot set error_category: an error, or 0 rows, value unchanged either way", async () => {
    const sourceId = await freshFailedSource();
    const { data, error } = await anonClient()
      .from("sources")
      .update({ error_category: "no_text" })
      .eq("id", sourceId)
      .select("error_category");
    if (error) {
      expect(error.code).toBeDefined();
    } else {
      expect(data).toEqual([]);
    }

    const { data: reread } = await owner.client.from("sources").select("error_category").eq("id", sourceId);
    expect(reread).toEqual([{ error_category: null }]);
  });
});

describe("sources: error_category check constraints", () => {
  let owner: SignedInUser;
  let notebookId: string;

  beforeAll(async () => {
    owner = await signUpUser("ingestion-errcat-constraints-owner");
    notebookId = await createNotebook(owner, "ingestion-errcat-constraints");
  });

  it("rejects an error_category that does not match ^[a-z_]{1,40}$ with 23514", async () => {
    const sourceId = await createSource(owner, notebookId);
    await owner.client.from("sources").update({ status: "failed" }).eq("id", sourceId);

    const { error } = await owner.client.from("sources").update({ error_category: "Bad-Cat" }).eq("id", sourceId);
    expect(error?.code).toBe("23514");
  });

  it("rejects setting error_category while status is ready with 23514", async () => {
    const sourceId = await createSource(owner, notebookId);
    const { error: readyError } = await owner.client.from("sources").update({ status: "ready" }).eq("id", sourceId);
    expect(readyError).toBeNull(); // sanity: moving to ready alone is allowed today

    const { error } = await owner.client.from("sources").update({ error_category: "no_text" }).eq("id", sourceId);
    expect(error?.code).toBe("23514");
  });
});

describe("sources: status_changed_at", () => {
  let owner: SignedInUser;
  let notebookId: string;

  beforeAll(async () => {
    owner = await signUpUser("ingestion-statuschanged-owner");
    notebookId = await createNotebook(owner, "ingestion-statuschanged");
  });

  it("denies a direct update of status_changed_at by the owner with 42501 (no update grant on this column)", async () => {
    const sourceId = await createSource(owner, notebookId);
    const { error } = await owner.client
      .from("sources")
      .update({ status_changed_at: new Date().toISOString() })
      .eq("id", sourceId);
    expect(error?.code).toBe("42501");
  });

  it("advances status_changed_at after a status update (allowing for clock resolution)", async () => {
    const sourceId = await createSource(owner, notebookId);
    const { data: before, error: beforeError } = await owner.client
      .from("sources")
      .select("status_changed_at")
      .eq("id", sourceId)
      .single();
    expect(beforeError).toBeNull();

    // A small, deliberate delay: makes the comparison below robust to a
    // coarse system clock, not a correctness requirement of the trigger
    // itself (network round trips alone are normally enough, but this
    // removes any doubt).
    await new Promise((resolve) => setTimeout(resolve, 50));

    const { error: updateError } = await owner.client
      .from("sources")
      .update({ status: "processing" })
      .eq("id", sourceId);
    expect(updateError).toBeNull();

    const { data: after, error: afterError } = await owner.client
      .from("sources")
      .select("status_changed_at")
      .eq("id", sourceId)
      .single();
    expect(afterError).toBeNull();

    expect(new Date(after!.status_changed_at as string).getTime()).toBeGreaterThan(
      new Date(before!.status_changed_at as string).getTime(),
    );
  });

  it("leaves status_changed_at unchanged after a title-only update", async () => {
    const sourceId = await createSource(owner, notebookId);
    const { data: before, error: beforeError } = await owner.client
      .from("sources")
      .select("status_changed_at")
      .eq("id", sourceId)
      .single();
    expect(beforeError).toBeNull();

    const { error: updateError } = await owner.client
      .from("sources")
      .update({ title: `retitled ${randomUUID()}` })
      .eq("id", sourceId);
    expect(updateError).toBeNull();

    const { data: after, error: afterError } = await owner.client
      .from("sources")
      .select("status_changed_at")
      .eq("id", sourceId)
      .single();
    expect(afterError).toBeNull();
    expect(after?.status_changed_at).toBe(before?.status_changed_at);
  });
});

describe("sourceStore(client).claim(id)", () => {
  let owner: SignedInUser;
  let viewer: SignedInUser;
  let notebookId: string;

  beforeAll(async () => {
    owner = await signUpUser("ingestion-claim-owner");
    viewer = await signUpUser("ingestion-claim-viewer");
    notebookId = await createNotebook(owner, "ingestion-claim");
    await addMember(owner, notebookId, viewer.userId, "viewer");
  });

  it("claims a pending source: status becomes processing, and returns the claimed shape", async () => {
    const sourceId = await createSource(owner, notebookId, { kind: "text" });

    const claimed = await sourceStore(owner.client).claim(sourceId);
    expect(claimed).toEqual({
      id: sourceId,
      notebookId,
      kind: "text",
      storagePath: storagePath(notebookId, sourceId),
      sourceUrl: null, // C2: claim() now also returns source_url (null for a text source)
    });

    const { data } = await owner.client.from("sources").select("status").eq("id", sourceId).single();
    expect(data?.status).toBe("processing");
  });

  it("a second claim right after the first returns null", async () => {
    const sourceId = await createSource(owner, notebookId);

    const first = await sourceStore(owner.client).claim(sourceId);
    expect(first).not.toBeNull();

    const second = await sourceStore(owner.client).claim(sourceId);
    expect(second).toBeNull();
  });

  it("a viewer's claim returns null, and the status stays pending", async () => {
    const sourceId = await createSource(owner, notebookId);

    const result = await sourceStore(viewer.client).claim(sourceId);
    expect(result).toBeNull();

    const { data } = await owner.client.from("sources").select("status").eq("id", sourceId).single();
    expect(data?.status).toBe("pending");
  });
});

describe("createSignedUpload", () => {
  let owner: SignedInUser;
  let editor: SignedInUser;
  let viewer: SignedInUser;
  let stranger: SignedInUser;
  let anonymousMember: SignedInUser;
  let notebookId: string;

  beforeAll(async () => {
    owner = await signUpUser("ingestion-signedupload-owner");
    editor = await signUpUser("ingestion-signedupload-editor");
    viewer = await signUpUser("ingestion-signedupload-viewer");
    stranger = await signUpUser("ingestion-signedupload-stranger");
    anonymousMember = await signInAnonymousUser();

    notebookId = await createNotebook(owner, "ingestion-signedupload");
    await addMember(owner, notebookId, editor.userId, "editor");
    await addMember(owner, notebookId, viewer.userId, "viewer");
    await addMember(owner, notebookId, anonymousMember.userId, "editor");
  });

  /** See the file header: tolerant of either Supabase behaviour (RLS checked
   * at token-creation time, or only at real-upload time). Either way, the one
   * thing that must always be true is that no real object exists afterwards
   * at `path`, checked by listing the notebook folder for `searchId` (the
   * last path segment) as the owner. */
  async function assertSignedUploadDenied(actor: SignedInUser, path: string, searchId: string): Promise<void> {
    let signedUrl: string | undefined;
    try {
      ({ signedUrl } = await createSignedUpload(actor.client, path));
    } catch {
      signedUrl = undefined;
    }

    if (signedUrl) {
      const token = new URL(signedUrl).searchParams.get("token") ?? "";
      await actor.client.storage
        .from(BUCKET)
        .uploadToSignedUrl(path, token, new Blob(["should never land"], { type: "text/plain" }));
    }

    const { data, error } = await owner.client.storage.from(BUCKET).list(notebookId, { search: searchId });
    expect(error).toBeNull();
    expect(data ?? []).toEqual([]);
  }

  it("gives the owner a signedUrl for their source's storage_path", async () => {
    const sourceId = await createSource(owner, notebookId);
    const path = storagePath(notebookId, sourceId);

    const { signedUrl } = await createSignedUpload(owner.client, path);
    expect(typeof signedUrl).toBe("string");
    expect(signedUrl.length).toBeGreaterThan(0);
  });

  it("gives an editor a signedUrl for an existing source's storage_path", async () => {
    const sourceId = await createSource(owner, notebookId);
    const path = storagePath(notebookId, sourceId);

    const { signedUrl } = await createSignedUpload(editor.client, path);
    expect(typeof signedUrl).toBe("string");
    expect(signedUrl.length).toBeGreaterThan(0);
  });

  it("denies a viewer (no real object ever lands at the path)", async () => {
    const sourceId = await createSource(owner, notebookId);
    await assertSignedUploadDenied(viewer, storagePath(notebookId, sourceId), sourceId);
  });

  it("denies a stranger (no real object ever lands at the path)", async () => {
    const sourceId = await createSource(owner, notebookId);
    await assertSignedUploadDenied(stranger, storagePath(notebookId, sourceId), sourceId);
  });

  it("denies an anonymous-signin editor, even though they are an editor (restrictive policy; no real object lands)", async () => {
    const sourceId = await createSource(owner, notebookId);
    await assertSignedUploadDenied(anonymousMember, storagePath(notebookId, sourceId), sourceId);
  });

  it("denies the owner a signed upload for a path with no sources row at all (orphan path)", async () => {
    const orphanId = randomUUID();
    await assertSignedUploadDenied(owner, storagePath(notebookId, orphanId), orphanId);
  });

  it("a fresh signed token cannot overwrite an existing object; the original content stays", async () => {
    const sourceId = await createSource(owner, notebookId);
    const path = storagePath(notebookId, sourceId);
    const original = Buffer.from("original payload\n", "utf8");

    const { error: uploadError } = await owner.client.storage
      .from(BUCKET)
      .upload(path, original, { contentType: "text/plain" });
    if (uploadError) throw new Error(`fixture upload failed: ${uploadError.message}`);

    // Tolerant of either Supabase behaviour, same as assertSignedUploadDenied
    // above: measured local behaviour is that createSignedUploadUrl() itself
    // rejects a path that already has an object ("The resource already
    // exists"), so createSignedUpload() throws before a token is ever minted
    // -- the stronger, safe outcome. But nothing here depends on that timing;
    // if a token were returned, uploadToSignedUrl() using it must still fail.
    // Either way, the one thing that must always be true is that the
    // original content is still there afterwards.
    let signedUrl: string | undefined;
    try {
      ({ signedUrl } = await createSignedUpload(owner.client, path));
    } catch {
      signedUrl = undefined;
    }

    if (signedUrl) {
      const token = new URL(signedUrl).searchParams.get("token") ?? "";
      const { error: reuploadError } = await owner.client.storage
        .from(BUCKET)
        .uploadToSignedUrl(path, token, Buffer.from("new payload\n", "utf8"));
      expect(reuploadError).not.toBeNull();
    }

    const { data, error: downloadError } = await owner.client.storage.from(BUCKET).download(path);
    expect(downloadError).toBeNull();
    expect(await data?.text()).toBe(original.toString("utf8"));
  });
});

describe("sources: per-notebook source cap (50)", () => {
  let owner: SignedInUser;
  let notebookId: string;
  let otherNotebookId: string;

  beforeAll(async () => {
    owner = await signUpUser("ingestion-cap-owner");
    notebookId = await createNotebook(owner, "ingestion-cap");
    otherNotebookId = await createNotebook(owner, "ingestion-cap-other");
  });

  it("allows exactly 50 sources in one notebook, rejects the 51st with 54000/notebook_source_limit, and another notebook is unaffected", async () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({
      notebook_id: notebookId,
      kind: "text" as const,
      title: `cap-source-${i}-${randomUUID()}`,
    }));
    const { error: bulkError } = await owner.client.from("sources").insert(rows);
    expect(bulkError).toBeNull();

    const { error: overflowError } = await owner.client
      .from("sources")
      .insert({ notebook_id: notebookId, kind: "text", title: "cap-source-51" });
    expect(overflowError?.code).toBe("54000");
    expect(overflowError?.message ?? "").toContain("notebook_source_limit");

    const { error: otherError } = await owner.client
      .from("sources")
      .insert({ notebook_id: otherNotebookId, kind: "text", title: "unaffected notebook" });
    expect(otherError).toBeNull();
  });
});
