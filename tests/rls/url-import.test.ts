// RLS matrix for PR C2's new column public.sources.source_url (migration
// 20261021090000_source_url.sql; plan .git/PLAN_c2-url-import.md "DATA AND RLS").
// The column is insert-only (INSERT granted, no UPDATE grant: immutable), carries
// three named check constraints, and is covered by the existing insert/select
// policies (no new policy). Every client is a real sign-in with a real JWT --
// owner, editor, viewer, stranger, an anonymous-signin member, and anon (no
// session) -- never the admin/service-role credential (AGENTS.md).
//
// The "legacy url row without a URL" case (a NOT VALID constraint only exists for
// rows written before the migration) cannot be produced through PostgREST after
// the migration; it is covered in supabase/tests/database/060_url_import.test.sql.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { anonClient, signInAnonymousUser, signUpUser, type SignedInUser } from "./helpers/clients";
import { addMember, createNotebook } from "./helpers/notebooks";

const URL_A = "https://example.com/artikel";
const URL_B = "https://example.org/anderer-artikel";

interface Fixture {
  owner: SignedInUser;
  editor: SignedInUser;
  viewer: SignedInUser;
  stranger: SignedInUser;
  anonymousMember: SignedInUser;
  notebookId: string;
}

async function buildFixture(label: string): Promise<Fixture> {
  const owner = await signUpUser(`${label}-owner`);
  const editor = await signUpUser(`${label}-editor`);
  const viewer = await signUpUser(`${label}-viewer`);
  const stranger = await signUpUser(`${label}-stranger`);
  const anonymousMember = await signInAnonymousUser();
  const notebookId = await createNotebook(owner, label);
  await addMember(owner, notebookId, editor.userId, "editor");
  await addMember(owner, notebookId, viewer.userId, "viewer");
  // The owner (not anonymous) adds the anonymous user, so the restrictive
  // "no anonymous actor" policy on notebook_members does not apply to this insert.
  await addMember(owner, notebookId, anonymousMember.userId, "editor");
  return { owner, editor, viewer, stranger, anonymousMember, notebookId };
}

/** Inserts a url source as `actor`; returns the raw result so tests can assert on errors. */
async function insertUrlSource(actor: { client: SignedInUser["client"] }, notebookId: string, sourceUrl: string | null) {
  return actor.client
    .from("sources")
    .insert({ notebook_id: notebookId, kind: "url", title: `url-${randomUUID()}`, source_url: sourceUrl })
    .select("id, kind, source_url")
    .single();
}

async function countSourcesWithTitle(owner: SignedInUser, notebookId: string, title: string): Promise<number> {
  const { data, error } = await owner.client.from("sources").select("id").eq("notebook_id", notebookId).eq("title", title);
  if (error) throw new Error(`fixture: count sources: ${error.code ?? "?"} ${error.message}`);
  return (data ?? []).length;
}

describe("sources.source_url: insert", () => {
  let f: Fixture;

  beforeAll(async () => {
    f = await buildFixture("url-import-insert");
  });

  it("lets the owner insert a url source and reads the URL back", async () => {
    const { data, error } = await insertUrlSource(f.owner, f.notebookId, URL_A);
    expect(error).toBeNull();
    expect(data).toMatchObject({ kind: "url", source_url: URL_A });
  });

  it("lets an editor insert a url source", async () => {
    const { data, error } = await insertUrlSource(f.editor, f.notebookId, URL_B);
    expect(error).toBeNull();
    expect(data).toMatchObject({ kind: "url", source_url: URL_B });
  });

  it("accepts a plain http URL too", async () => {
    const { error } = await insertUrlSource(f.owner, f.notebookId, "http://example.com/seite");
    expect(error).toBeNull();
  });

  it("refuses a viewer with 42501", async () => {
    const title = `viewer-url-${randomUUID()}`;
    const { error } = await f.viewer.client
      .from("sources")
      .insert({ notebook_id: f.notebookId, kind: "url", title, source_url: URL_A });
    expect(error?.code).toBe("42501");
    expect(await countSourcesWithTitle(f.owner, f.notebookId, title)).toBe(0);
  });

  it("refuses a stranger with 42501", async () => {
    const title = `stranger-url-${randomUUID()}`;
    const { error } = await f.stranger.client
      .from("sources")
      .insert({ notebook_id: f.notebookId, kind: "url", title, source_url: URL_A });
    expect(error?.code).toBe("42501");
    expect(await countSourcesWithTitle(f.owner, f.notebookId, title)).toBe(0);
  });

  it("refuses an anonymous-signin member even though they are an editor (restrictive policy)", async () => {
    const title = `anonymous-url-${randomUUID()}`;
    const { error } = await f.anonymousMember.client
      .from("sources")
      .insert({ notebook_id: f.notebookId, kind: "url", title, source_url: URL_A });
    expect(error?.code).toBe("42501");
    expect(await countSourcesWithTitle(f.owner, f.notebookId, title)).toBe(0);
  });

  it("refuses anon (no session): an error, and no row", async () => {
    const title = `anon-url-${randomUUID()}`;
    const { error } = await anonClient()
      .from("sources")
      .insert({ notebook_id: f.notebookId, kind: "url", title, source_url: URL_A });
    expect(error).not.toBeNull();
    expect(await countSourcesWithTitle(f.owner, f.notebookId, title)).toBe(0);
  });
});

describe("sources.source_url: immutable (no update grant)", () => {
  let f: Fixture;
  let sourceId: string;

  beforeAll(async () => {
    f = await buildFixture("url-import-update");
    const { data, error } = await insertUrlSource(f.owner, f.notebookId, URL_A);
    if (error || !data) throw new Error(`fixture: insert url source: ${error?.code ?? "?"} ${error?.message}`);
    sourceId = data.id as string;
  });

  async function expectUnchanged(): Promise<void> {
    const { data } = await f.owner.client.from("sources").select("source_url").eq("id", sourceId);
    expect(data).toEqual([{ source_url: URL_A }]);
  }

  const ROLES = ["owner", "editor", "viewer", "stranger", "anonymousMember"] as const;
  it.each(ROLES)("%s cannot update source_url (42501), the value stays", async (role) => {
    const { error } = await f[role].client.from("sources").update({ source_url: URL_B }).eq("id", sourceId);
    expect(error?.code).toBe("42501");
    await expectUnchanged();
  });

  it("anon (no session) cannot update source_url, the value stays", async () => {
    const { error } = await anonClient().from("sources").update({ source_url: URL_B }).eq("id", sourceId);
    expect(error).not.toBeNull();
    await expectUnchanged();
  });

  it("the owner cannot null source_url either (and the kind check would reject it anyway)", async () => {
    const { error } = await f.owner.client.from("sources").update({ source_url: null }).eq("id", sourceId);
    expect(error?.code).toBe("42501");
    await expectUnchanged();
  });

  it("a title-only update on a url source still works (the new column does not break existing grants)", async () => {
    const { error } = await f.owner.client.from("sources").update({ title: `retitled-${randomUUID()}` }).eq("id", sourceId);
    expect(error).toBeNull();
    await expectUnchanged();
  });
});

describe("sources.source_url: select", () => {
  let f: Fixture;
  let sourceId: string;

  beforeAll(async () => {
    f = await buildFixture("url-import-select");
    const { data, error } = await insertUrlSource(f.owner, f.notebookId, URL_A);
    if (error || !data) throw new Error(`fixture: insert url source: ${error?.code ?? "?"} ${error?.message}`);
    sourceId = data.id as string;
  });

  const MEMBERS = ["owner", "editor", "viewer"] as const;
  it.each(MEMBERS)("%s sees source_url", async (role) => {
    const { data, error } = await f[role].client.from("sources").select("source_url").eq("id", sourceId);
    expect(error).toBeNull();
    expect(data).toEqual([{ source_url: URL_A }]);
  });

  it("a stranger gets 0 rows", async () => {
    const { data, error } = await f.stranger.client.from("sources").select("source_url").eq("id", sourceId);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("anon (no session) gets an error or 0 rows, never the URL", async () => {
    const { data, error } = await anonClient().from("sources").select("source_url").eq("id", sourceId);
    if (error) {
      expect(error.code).toBeDefined();
    } else {
      expect(data).toEqual([]);
    }
  });
});

describe("sources.source_url: check constraints (23514)", () => {
  let owner: SignedInUser;
  let notebookId: string;

  beforeAll(async () => {
    owner = await signUpUser("url-import-constraints-owner");
    notebookId = await createNotebook(owner, "url-import-constraints");
  });

  it("rejects kind url without source_url", async () => {
    const { error } = await insertUrlSource(owner, notebookId, null);
    expect(error?.code).toBe("23514");
  });

  it("rejects kind text with a source_url", async () => {
    const { error } = await owner.client
      .from("sources")
      .insert({ notebook_id: notebookId, kind: "text", title: "t", source_url: URL_A });
    expect(error?.code).toBe("23514");
  });

  it("rejects kind pdf with a source_url", async () => {
    const { error } = await owner.client
      .from("sources")
      .insert({ notebook_id: notebookId, kind: "pdf", title: "t", source_url: URL_A });
    expect(error?.code).toBe("23514");
  });

  const BAD_SCHEMES = ["javascript:x", "ftp://example.com/", "file:///etc/passwd", "data:text/html,x", "example.com/no-scheme"];
  it.each(BAD_SCHEMES)("rejects source_url %j (not http or https)", async (value) => {
    const { error } = await insertUrlSource(owner, notebookId, value);
    expect(error?.code).toBe("23514");
  });

  it("rejects a 2049-character source_url", async () => {
    const prefix = "https://example.com/";
    const value = prefix + "a".repeat(2049 - prefix.length);
    expect(value).toHaveLength(2049);
    const { error } = await insertUrlSource(owner, notebookId, value);
    expect(error?.code).toBe("23514");
  });

  it("accepts a 2048-character source_url", async () => {
    const prefix = "https://example.com/";
    const value = prefix + "a".repeat(2048 - prefix.length);
    expect(value).toHaveLength(2048);
    const { error } = await insertUrlSource(owner, notebookId, value);
    expect(error).toBeNull();
  });

  it("still accepts text and pdf rows with a null source_url (an app rollback needs no DB rollback)", async () => {
    const { error: textError } = await owner.client
      .from("sources")
      .insert({ notebook_id: notebookId, kind: "text", title: "t" });
    expect(textError).toBeNull();
    const { error: pdfError } = await owner.client
      .from("sources")
      .insert({ notebook_id: notebookId, kind: "pdf", title: "p" });
    expect(pdfError).toBeNull();
  });
});
