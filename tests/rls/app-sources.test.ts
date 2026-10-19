// RLS behaviour for PR C1's app-level library functions
// (apps/web/lib/sources/sources.ts), imported directly and driven with real
// signed-in users' own SupabaseClient instances (never the admin/
// service-role credential, per AGENTS.md). These functions are thin wrappers
// around PostgREST/Storage calls that run under the user's JWT, so RLS
// (supabase/migrations/20261018120000_sources_chunks_messages.sql,
// supabase/migrations/..._sources_storage.sql and PR C1's own
// 20261020090000_ingestion.sql) is what actually enforces every rejection
// asserted below; the wrapper's job is only to shape a PostgREST/Storage
// error into the `Error` with `.code` the server actions use.
//
// Imported by relative path, not the "@/..." alias: the "rls" vitest project
// has no such alias configured -- see tests/rls/app-notebooks.test.ts's
// header for the same note.
import { beforeAll, describe, expect, it } from "vitest";
import { signUpUser, type SignedInUser } from "./helpers/clients";
import { addMember, createNotebook } from "./helpers/notebooks";
import { insertChunks, queryVector } from "./helpers/sources";
import { deleteNotebook } from "../../apps/web/lib/notebooks/notebooks";
import { createSource, deleteSource, listSources, uploadTextObject } from "../../apps/web/lib/sources/sources";

const BUCKET = "sources";

describe("createSource (lib)", () => {
  let owner: SignedInUser;
  let editor: SignedInUser;
  let viewer: SignedInUser;
  let notebookId: string;

  beforeAll(async () => {
    owner = await signUpUser("app-sources-create-owner");
    editor = await signUpUser("app-sources-create-editor");
    viewer = await signUpUser("app-sources-create-viewer");
    notebookId = await createNotebook(owner, "app-sources-create");
    await addMember(owner, notebookId, editor.userId, "editor");
    await addMember(owner, notebookId, viewer.userId, "viewer");
  });

  it("creates a source as an editor and returns its id and storage_path", async () => {
    const result = await createSource(editor.client, notebookId, "text", "t");
    expect(typeof result.id).toBe("string");
    expect(result.storagePath).toBe(`${notebookId}/${result.id}`);
  });

  it("throws with code nicht_erlaubt for a viewer", async () => {
    await expect(createSource(viewer.client, notebookId, "text", "t")).rejects.toMatchObject({
      code: "nicht_erlaubt",
    });
  });
});

describe("uploadTextObject (lib)", () => {
  let editor: SignedInUser;
  let notebookId: string;
  let owner: SignedInUser;

  beforeAll(async () => {
    owner = await signUpUser("app-sources-upload-owner");
    editor = await signUpUser("app-sources-upload-editor");
    notebookId = await createNotebook(owner, "app-sources-upload");
    await addMember(owner, notebookId, editor.userId, "editor");
  });

  it("creates a readable text/plain object at the source's storage path", async () => {
    const { storagePath: path } = await createSource(editor.client, notebookId, "text", "t");
    await uploadTextObject(editor.client, path, "hello from uploadTextObject");

    const { data, error } = await editor.client.storage.from(BUCKET).download(path);
    expect(error).toBeNull();
    expect(await data?.text()).toBe("hello from uploadTextObject");
    expect(data?.type ?? "").toContain("text/plain");
  });
});

describe("listSources (lib)", () => {
  it("shows a viewer the source with its status and errorCategory", async () => {
    const owner = await signUpUser("app-sources-list-owner");
    const viewer = await signUpUser("app-sources-list-viewer");
    const notebookId = await createNotebook(owner, "app-sources-list");
    await addMember(owner, notebookId, viewer.userId, "viewer");

    const { id } = await createSource(owner.client, notebookId, "text", "listed source");

    const sources = await listSources(viewer.client, notebookId);
    const found = sources.find((s) => s.id === id);
    expect(found).toBeDefined();
    expect(found?.status).toBe("pending");
    expect(found?.errorCategory).toBeNull();
  });
});

describe("deleteSource (lib)", () => {
  let owner: SignedInUser;
  let editor: SignedInUser;
  let viewer: SignedInUser;
  let notebookId: string;

  beforeAll(async () => {
    owner = await signUpUser("app-sources-delete-owner");
    editor = await signUpUser("app-sources-delete-editor");
    viewer = await signUpUser("app-sources-delete-viewer");
    notebookId = await createNotebook(owner, "app-sources-delete");
    await addMember(owner, notebookId, editor.userId, "editor");
    await addMember(owner, notebookId, viewer.userId, "viewer");
  });

  it("an editor deletes a source with an uploaded object and chunks: the row, the chunks and the object are all gone", async () => {
    const { id, storagePath: path } = await createSource(editor.client, notebookId, "text", "to be deleted");
    await uploadTextObject(editor.client, path, "will be removed");
    await insertChunks(owner, notebookId, id, [{ ordinal: 0, content: "chunk zero", embedding: queryVector() }]);

    await deleteSource(editor.client, id);

    const { data: rowAfter } = await owner.client.from("sources").select("id").eq("id", id);
    expect(rowAfter).toEqual([]);

    const { data: chunksAfter } = await owner.client.from("chunks").select("id").eq("source_id", id);
    expect(chunksAfter ?? []).toHaveLength(0);

    const { data: listed, error: listError } = await owner.client.storage.from(BUCKET).list(notebookId, {
      search: id,
    });
    expect(listError).toBeNull();
    expect(listed ?? []).toEqual([]);
  });

  it("a viewer's deleteSource throws, and the object and chunks remain", async () => {
    const { id, storagePath: path } = await createSource(owner.client, notebookId, "text", "viewer cannot delete");
    await uploadTextObject(owner.client, path, "stays put");
    await insertChunks(owner, notebookId, id, [{ ordinal: 0, content: "stays too", embedding: queryVector() }]);

    await expect(deleteSource(viewer.client, id)).rejects.toThrow();

    const { data: listed, error: listError } = await owner.client.storage.from(BUCKET).list(notebookId, {
      search: id,
    });
    expect(listError).toBeNull();
    expect((listed ?? []).some((entry) => path.endsWith(entry.name))).toBe(true);

    const { data: chunksAfter } = await owner.client.from("chunks").select("id").eq("source_id", id);
    expect(chunksAfter ?? []).toHaveLength(1);
  });
});

describe("deleteNotebook (lib): cleans up an uploaded source's object and chunks", () => {
  it("removes the object and leaves no chunk or source row behind", async () => {
    const owner = await signUpUser("app-sources-delete-notebook-owner");
    const notebookId = await createNotebook(owner, "app-sources-delete-notebook");
    const { id, storagePath: path } = await createSource(owner.client, notebookId, "text", "doomed source");
    await uploadTextObject(owner.client, path, "doomed content");
    await insertChunks(owner, notebookId, id, [{ ordinal: 0, content: "doomed chunk", embedding: queryVector() }]);

    await deleteNotebook(owner.client, notebookId);

    // The notebook (and its cascaded sources row) is gone, so the real proof
    // of cleanup is the row/chunk selects below -- same caveat as
    // tests/rls/app-notebooks.test.ts's deleteNotebook tests about the
    // Storage select policy denying access once the sources row is gone
    // regardless of whether the object itself was removed.
    const { data: sourceRowAfter } = await owner.client.from("sources").select("id").eq("id", id);
    expect(sourceRowAfter ?? []).toEqual([]);

    const { data: chunksAfter } = await owner.client.from("chunks").select("id").eq("source_id", id);
    expect(chunksAfter ?? []).toHaveLength(0);

    const { data: listed, error: listError } = await owner.client.storage.from(BUCKET).list(notebookId, {
      search: id,
    });
    expect(listError).toBeNull();
    expect((listed ?? []).some((entry) => path.endsWith(entry.name))).toBe(false);
  });
});
