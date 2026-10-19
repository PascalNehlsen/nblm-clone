// RLS behaviour for PR C2's app-level library function createUrlSource
// (apps/web/lib/sources/sources.ts) and its interplay with uploadTextObject,
// sourceStore().claim() and deleteSource, driven with real signed-in users'
// own SupabaseClient instances (never the admin/service-role credential, per
// AGENTS.md). Follows tests/rls/app-sources.test.ts. Imported by relative path,
// not the "@/..." alias: the "rls" vitest project has no such alias.
import { beforeAll, describe, expect, it } from "vitest";
import { signUpUser, type SignedInUser } from "./helpers/clients";
import { addMember, createNotebook } from "./helpers/notebooks";
import { insertChunks, queryVector } from "./helpers/sources";
import {
  createUrlSource,
  deleteSource,
  sourceStore,
  uploadTextObject,
} from "../../apps/web/lib/sources/sources";

const BUCKET = "sources";
const PAGE_URL = "https://example.com/artikel";

describe("createUrlSource (lib)", () => {
  let owner: SignedInUser;
  let editor: SignedInUser;
  let viewer: SignedInUser;
  let stranger: SignedInUser;
  let notebookId: string;

  beforeAll(async () => {
    owner = await signUpUser("app-url-create-owner");
    editor = await signUpUser("app-url-create-editor");
    viewer = await signUpUser("app-url-create-viewer");
    stranger = await signUpUser("app-url-create-stranger");
    notebookId = await createNotebook(owner, "app-url-create");
    await addMember(owner, notebookId, editor.userId, "editor");
    await addMember(owner, notebookId, viewer.userId, "viewer");
  });

  it("creates a url source as an editor: id, storage path, kind url and the stored URL", async () => {
    const result = await createUrlSource(editor.client, notebookId, "Eine Seite", PAGE_URL);
    expect(typeof result.id).toBe("string");
    expect(result.storagePath).toBe(`${notebookId}/${result.id}`);

    const { data, error } = await owner.client
      .from("sources")
      .select("kind, title, source_url, status")
      .eq("id", result.id)
      .single();
    expect(error).toBeNull();
    expect(data).toEqual({ kind: "url", title: "Eine Seite", source_url: PAGE_URL, status: "pending" });
  });

  it("creates a url source as the owner", async () => {
    const result = await createUrlSource(owner.client, notebookId, "Owner Seite", PAGE_URL);
    expect(result.storagePath).toBe(`${notebookId}/${result.id}`);
  });

  it("throws with code nicht_erlaubt for a viewer", async () => {
    await expect(createUrlSource(viewer.client, notebookId, "t", PAGE_URL)).rejects.toMatchObject({
      code: "nicht_erlaubt",
    });
  });

  it("throws with code nicht_erlaubt for a stranger", async () => {
    await expect(createUrlSource(stranger.client, notebookId, "t", PAGE_URL)).rejects.toMatchObject({
      code: "nicht_erlaubt",
    });
  });

  it("throws (code fehler) for a URL the database constraint rejects", async () => {
    await expect(createUrlSource(owner.client, notebookId, "t", "javascript:x")).rejects.toMatchObject({
      code: "fehler",
    });
  });
});

describe("sourceStore(client).claim(id) on a url source", () => {
  it("returns the stored source URL on the claimed source", async () => {
    const owner = await signUpUser("app-url-claim-owner");
    const notebookId = await createNotebook(owner, "app-url-claim");
    const { id, storagePath } = await createUrlSource(owner.client, notebookId, "claimed", PAGE_URL);

    const claimed = await sourceStore(owner.client).claim(id);

    expect(claimed).toEqual({ id, notebookId, kind: "url", storagePath, sourceUrl: PAGE_URL });
  });
});

describe("uploadTextObject (lib) on a url source", () => {
  it("an editor stores fetched text at a url source's path as text/plain", async () => {
    const owner = await signUpUser("app-url-upload-owner");
    const editor = await signUpUser("app-url-upload-editor");
    const notebookId = await createNotebook(owner, "app-url-upload");
    await addMember(owner, notebookId, editor.userId, "editor");
    const { storagePath } = await createUrlSource(editor.client, notebookId, "stored", PAGE_URL);

    await uploadTextObject(editor.client, storagePath, "Text der Seite");

    const { data, error } = await editor.client.storage.from(BUCKET).download(storagePath);
    expect(error).toBeNull();
    expect(await data?.text()).toBe("Text der Seite");
  });
});

describe("deleteSource (lib) on a url source", () => {
  let owner: SignedInUser;
  let editor: SignedInUser;
  let viewer: SignedInUser;
  let notebookId: string;

  beforeAll(async () => {
    owner = await signUpUser("app-url-delete-owner");
    editor = await signUpUser("app-url-delete-editor");
    viewer = await signUpUser("app-url-delete-viewer");
    notebookId = await createNotebook(owner, "app-url-delete");
    await addMember(owner, notebookId, editor.userId, "editor");
    await addMember(owner, notebookId, viewer.userId, "viewer");
  });

  it("an editor deletes a url source with its stored text and chunks: row, chunks and object are all gone", async () => {
    const { id, storagePath } = await createUrlSource(editor.client, notebookId, "to be deleted", PAGE_URL);
    await uploadTextObject(editor.client, storagePath, "fetched page text");
    await insertChunks(owner, notebookId, id, [{ ordinal: 0, content: "chunk zero", embedding: queryVector() }]);

    await deleteSource(editor.client, id);

    const { data: rowAfter } = await owner.client.from("sources").select("id").eq("id", id);
    expect(rowAfter ?? []).toEqual([]);

    const { data: chunksAfter } = await owner.client.from("chunks").select("id").eq("source_id", id);
    expect(chunksAfter ?? []).toHaveLength(0);

    const { data: listed, error: listError } = await owner.client.storage.from(BUCKET).list(notebookId, {
      search: id,
    });
    expect(listError).toBeNull();
    expect(listed ?? []).toEqual([]);
  });

  it("a url source whose fetch never produced an object (failed import) can be deleted", async () => {
    const { id } = await createUrlSource(owner.client, notebookId, "never fetched", PAGE_URL);

    await deleteSource(owner.client, id);

    const { data: rowAfter } = await owner.client.from("sources").select("id").eq("id", id);
    expect(rowAfter ?? []).toEqual([]);
  });

  it("a viewer's deleteSource throws, and the url row and its object remain", async () => {
    const { id, storagePath } = await createUrlSource(owner.client, notebookId, "viewer cannot delete", PAGE_URL);
    await uploadTextObject(owner.client, storagePath, "stays put");

    await expect(deleteSource(viewer.client, id)).rejects.toThrow();

    const { data: rowAfter } = await owner.client.from("sources").select("id, source_url").eq("id", id);
    expect(rowAfter).toEqual([{ id, source_url: PAGE_URL }]);
    const { data: listed, error: listError } = await owner.client.storage.from(BUCKET).list(notebookId, {
      search: id,
    });
    expect(listError).toBeNull();
    expect((listed ?? []).some((entry) => storagePath.endsWith(entry.name))).toBe(true);
  });
});
