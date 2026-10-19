// RLS matrix for the demo login (F1, database part). Every client is built from a real
// sign-in and a real JWT: anonymous users via signInAnonymously with the publishable key,
// a second non-anonymous user, and a client with no session. Never the admin/service-role
// credential (AGENTS.md).
//
// The template is the one seeded by supabase/seed.sql (fixed ids, see helpers/demo.ts).
// Its owner has no password, so "the template owner cannot read the copy" is asserted
// through a non-anonymous stranger: the copy is owned by the anonymous user alone.
//
// Red before the F1 migration: an anonymous notebook insert yields an empty notebook, so
// the copy assertions fail on counts, and the second-insert case sees no error.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { anonClient, signInAnonymousUser, signUpUser, type SignedInUser } from "./helpers/clients";
import {
  DEMO_TEMPLATE_NOTEBOOK_ID,
  SEED_PENDING_SOURCE,
  SEED_READY_CHUNK_COUNT,
  SEED_READY_SOURCES,
  readCopy,
  tryCreateNotebook,
  unitVector,
} from "./helpers/demo";

const BUCKET = "sources";

describe("demo copy: an anonymous notebook insert gets the template's ready sources", () => {
  let demoUser: SignedInUser;
  let copyId: string;

  beforeAll(async () => {
    demoUser = await signInAnonymousUser();
    const created = await tryCreateNotebook(demoUser);
    expect(created.error).toBeNull();
    copyId = created.notebookId;
  });

  it("the copy holds exactly the ready sources of the seed, with their kind and title", async () => {
    const { sources } = await readCopy(demoUser, copyId);
    expect(sources.map((s) => ({ kind: s.kind, title: s.title, status: s.status }))).toEqual(
      [...SEED_READY_SOURCES]
        .map((s) => ({ kind: s.kind, title: s.title, status: "ready" }))
        .sort((a, b) => a.title.localeCompare(b.title)),
    );
  });

  it("the pending template source is absent from the copy", async () => {
    const { sources, chunks } = await readCopy(demoUser, copyId);
    expect(sources.map((s) => s.title)).not.toContain(SEED_PENDING_SOURCE.title);
    for (const chunk of SEED_PENDING_SOURCE.chunks) {
      expect(chunks.map((c) => c.content)).not.toContain(chunk.content);
    }
  });

  it("the copy gets new ids, never the template's", async () => {
    const { sources } = await readCopy(demoUser, copyId);
    const templateIds = new Set(SEED_READY_SOURCES.map((s) => s.id));
    expect(sources.length).toBe(SEED_READY_SOURCES.length);
    for (const source of sources) {
      expect(templateIds.has(source.id)).toBe(false);
    }
  });

  it("the copied chunks match the seed in count, ordinal and content, each under its own source", async () => {
    const { sources, chunks } = await readCopy(demoUser, copyId);
    expect(chunks).toHaveLength(SEED_READY_CHUNK_COUNT);

    for (const seedSource of SEED_READY_SOURCES) {
      const copied = sources.find((s) => s.title === seedSource.title);
      expect(copied).toBeDefined();
      const own = chunks
        .filter((c) => c.source_id === copied?.id)
        .map((c) => ({ ordinal: c.ordinal, content: c.content, page: c.page }))
        .sort((a, b) => a.ordinal - b.ordinal);
      expect(own).toEqual(seedSource.chunks.map((c) => ({ ordinal: c.ordinal, content: c.content, page: null })));
    }
  });

  it("match_chunks on the copy returns the copied chunks, nearest first", async () => {
    const { chunks } = await readCopy(demoUser, copyId);
    const copiedIds = new Set(chunks.map((c) => c.id));

    const { data, error } = await demoUser.client.rpc("match_chunks", {
      query_embedding: unitVector(0),
      p_notebook_id: copyId,
      match_count: 50,
    });
    expect(error).toBeNull();
    const rows = (data ?? []) as { id: string; content: string }[];
    expect(rows).toHaveLength(SEED_READY_CHUNK_COUNT);
    for (const row of rows) {
      expect(copiedIds.has(row.id)).toBe(true);
    }
    // The seed vector with its 1.0 at position 0 is the first chunk of the first source.
    expect(rows[0]?.content).toBe(SEED_READY_SOURCES[0]?.chunks[0]?.content);
  });

  it("match_chunks on the copy finds the embedding of a later chunk too (embeddings were copied, not zeroed)", async () => {
    const target = SEED_READY_SOURCES[1]?.chunks[2];
    expect(target).toBeDefined();
    const { data, error } = await demoUser.client.rpc("match_chunks", {
      query_embedding: unitVector(target?.position ?? 0),
      p_notebook_id: copyId,
      match_count: 1,
    });
    expect(error).toBeNull();
    expect((data as { content: string }[])[0]?.content).toBe(target?.content);
  });

  it("no Storage object exists under the copy", async () => {
    const { data, error } = await demoUser.client.storage.from(BUCKET).list(copyId);
    // Either an empty listing or a policy denial is fine; an object is not.
    if (!error) {
      expect(data ?? []).toEqual([]);
    }
  });
});

describe("demo copy: the template and the copy stay isolated", () => {
  let demoUser: SignedInUser;
  let otherDemoUser: SignedInUser;
  let stranger: SignedInUser;
  let copyId: string;
  let otherCopyId: string;

  beforeAll(async () => {
    demoUser = await signInAnonymousUser();
    otherDemoUser = await signInAnonymousUser();
    stranger = await signUpUser("demo-stranger");

    const first = await tryCreateNotebook(demoUser);
    expect(first.error).toBeNull();
    copyId = first.notebookId;
    const second = await tryCreateNotebook(otherDemoUser);
    expect(second.error).toBeNull();
    otherCopyId = second.notebookId;
  });

  it("the anonymous user cannot read the template notebook", async () => {
    const { data, error } = await demoUser.client
      .from("notebooks")
      .select("id")
      .eq("id", DEMO_TEMPLATE_NOTEBOOK_ID);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("the anonymous user cannot read the template's sources or chunks", async () => {
    const template = await readCopy(demoUser, DEMO_TEMPLATE_NOTEBOOK_ID);
    expect(template.sources).toEqual([]);
    expect(template.chunks).toEqual([]);

    const byId = await demoUser.client
      .from("sources")
      .select("id")
      .in(
        "id",
        [...SEED_READY_SOURCES, SEED_PENDING_SOURCE].map((s) => s.id),
      );
    expect(byId.error).toBeNull();
    expect(byId.data).toEqual([]);
  });

  it("match_chunks on the template returns nothing to the anonymous user", async () => {
    const { data, error } = await demoUser.client.rpc("match_chunks", {
      query_embedding: unitVector(0),
      p_notebook_id: DEMO_TEMPLATE_NOTEBOOK_ID,
      match_count: 50,
    });
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("the copy is not the template: they differ and the template is not listed among the user's notebooks", async () => {
    const { data, error } = await demoUser.client.from("notebooks").select("id");
    expect(error).toBeNull();
    expect((data ?? []).map((n: { id: string }) => n.id)).toEqual([copyId]);
  });

  it("a non-anonymous stranger (standing in for the template owner) cannot read the copy", async () => {
    const notebook = await stranger.client.from("notebooks").select("id").eq("id", copyId);
    expect(notebook.error).toBeNull();
    expect(notebook.data).toEqual([]);

    const copy = await readCopy(stranger, copyId);
    expect(copy.sources).toEqual([]);
    expect(copy.chunks).toEqual([]);

    const { data, error } = await stranger.client.rpc("match_chunks", {
      query_embedding: unitVector(0),
      p_notebook_id: copyId,
      match_count: 50,
    });
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("a second anonymous user cannot read the first copy", async () => {
    const notebook = await otherDemoUser.client.from("notebooks").select("id").eq("id", copyId);
    expect(notebook.error).toBeNull();
    expect(notebook.data).toEqual([]);

    const copy = await readCopy(otherDemoUser, copyId);
    expect(copy.sources).toEqual([]);
    expect(copy.chunks).toEqual([]);

    const { data, error } = await otherDemoUser.client.rpc("match_chunks", {
      query_embedding: unitVector(0),
      p_notebook_id: copyId,
      match_count: 50,
    });
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("the second anonymous user's own copy is complete and distinct from the first", async () => {
    const mine = await readCopy(otherDemoUser, otherCopyId);
    expect(mine.sources).toHaveLength(SEED_READY_SOURCES.length);
    expect(mine.chunks).toHaveLength(SEED_READY_CHUNK_COUNT);

    const first = await readCopy(demoUser, copyId);
    const firstIds = new Set(first.sources.map((s) => s.id));
    for (const source of mine.sources) {
      expect(firstIds.has(source.id)).toBe(false);
    }
  });

  it("a session-less anon client gets nothing from the template or either copy", async () => {
    const client = anonClient();
    for (const id of [DEMO_TEMPLATE_NOTEBOOK_ID, copyId, otherCopyId]) {
      const notebooks = await client.from("notebooks").select("id").eq("id", id);
      expect(notebooks.data ?? []).toEqual([]);
      const sources = await client.from("sources").select("id").eq("notebook_id", id);
      expect(sources.data ?? []).toEqual([]);
      const chunks = await client.from("chunks").select("id").eq("notebook_id", id);
      expect(chunks.data ?? []).toEqual([]);
    }
    const { data, error } = await client.rpc("match_chunks", {
      query_embedding: unitVector(0),
      p_notebook_id: copyId,
      match_count: 50,
    });
    expect(data).toBeNull();
    expect(error?.code).toBe("42501");
  });
});

describe("demo copy: the anonymous user cannot change sources, chunks or Storage in their copy", () => {
  let demoUser: SignedInUser;
  let copyId: string;

  beforeAll(async () => {
    demoUser = await signInAnonymousUser();
    const created = await tryCreateNotebook(demoUser);
    expect(created.error).toBeNull();
    copyId = created.notebookId;
  });

  it("cannot insert a source", async () => {
    const { error } = await demoUser.client
      .from("sources")
      .insert({ notebook_id: copyId, kind: "text", title: `extra-${randomUUID()}.txt` });
    expect(error).not.toBeNull();
    const { sources } = await readCopy(demoUser, copyId);
    expect(sources).toHaveLength(SEED_READY_SOURCES.length);
  });

  it("cannot insert a chunk", async () => {
    const { sources, chunks } = await readCopy(demoUser, copyId);
    const { error } = await demoUser.client.from("chunks").insert({
      notebook_id: copyId,
      source_id: sources[0]?.id,
      ordinal: 99,
      content: "injected",
      embedding: unitVector(10),
    });
    expect(error).not.toBeNull();
    const after = await readCopy(demoUser, copyId);
    expect(after.chunks).toHaveLength(chunks.length);
  });

  it("cannot update a source or a chunk", async () => {
    const before = await readCopy(demoUser, copyId);
    const sourceId = before.sources[0]?.id as string;
    const chunkId = before.chunks[0]?.id as string;

    const sourceUpdate = await demoUser.client
      .from("sources")
      .update({ status: "failed", error_category: "extract_failed" })
      .eq("id", sourceId)
      .select("id");
    expect(sourceUpdate.data ?? []).toEqual([]);

    const chunkUpdate = await demoUser.client
      .from("chunks")
      .update({ content: "tampered" })
      .eq("id", chunkId)
      .select("id");
    expect(chunkUpdate.data ?? []).toEqual([]);

    const after = await readCopy(demoUser, copyId);
    expect(after.sources).toEqual(before.sources);
    expect(after.chunks).toEqual(before.chunks);
  });

  it("cannot delete a source or a chunk", async () => {
    const before = await readCopy(demoUser, copyId);

    const chunkDelete = await demoUser.client.from("chunks").delete().eq("id", before.chunks[0]?.id as string).select("id");
    expect(chunkDelete.data ?? []).toEqual([]);

    const sourceDelete = await demoUser.client.from("sources").delete().eq("id", before.sources[0]?.id as string).select("id");
    expect(sourceDelete.data ?? []).toEqual([]);

    const after = await readCopy(demoUser, copyId);
    expect(after.sources).toHaveLength(before.sources.length);
    expect(after.chunks).toHaveLength(before.chunks.length);
  });

  it("cannot upload a Storage object under the copy, neither at a copied source's path nor a fresh one", async () => {
    const { sources } = await readCopy(demoUser, copyId);
    const body = Buffer.from("not allowed\n", "utf8");
    for (const name of [sources[0]?.id as string, randomUUID()]) {
      const { error } = await demoUser.client.storage
        .from(BUCKET)
        .upload(`${copyId}/${name}`, body, { contentType: "text/plain" });
      expect(error).not.toBeNull();
      expect(error?.message ?? "").not.toMatch(/bucket not found/i);
    }
    const listing = await demoUser.client.storage.from(BUCKET).list(copyId);
    if (!listing.error) {
      expect(listing.data ?? []).toEqual([]);
    }
  });
});

describe("demo copy: who does not get a copy, and the one-notebook limit", () => {
  it("a non-anonymous user's notebook insert stays empty", async () => {
    const user = await signUpUser("demo-regular");
    const created = await tryCreateNotebook(user);
    expect(created.error).toBeNull();

    const { sources, chunks } = await readCopy(user, created.notebookId);
    expect(sources).toEqual([]);
    expect(chunks).toEqual([]);
  });

  it("a second notebook insert by the same anonymous user fails with demo_notebook_exists", async () => {
    const user = await signInAnonymousUser();
    const first = await tryCreateNotebook(user);
    expect(first.error).toBeNull();

    const second = await tryCreateNotebook(user);
    expect(second.error).not.toBeNull();
    expect(second.error?.message).toContain("demo_notebook_exists");

    // The failed insert rolled back: still one notebook, still a complete copy.
    const { data } = await user.client.from("notebooks").select("id");
    expect((data ?? []).map((n: { id: string }) => n.id)).toEqual([first.notebookId]);
    const copy = await readCopy(user, first.notebookId);
    expect(copy.sources).toHaveLength(SEED_READY_SOURCES.length);
    expect(copy.chunks).toHaveLength(SEED_READY_CHUNK_COUNT);
  });
});

describe("demo copy: parallel notebook inserts by one anonymous user", () => {
  it("exactly one of ten simultaneous inserts succeeds and the user ends with one complete copy", async () => {
    const user = await signInAnonymousUser();
    const results = await Promise.all(Array.from({ length: 10 }, () => tryCreateNotebook(user)));

    const succeeded = results.filter((r) => r.error === null);
    const failed = results.filter((r) => r.error !== null);
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(9);
    for (const result of failed) {
      expect(result.error?.message).toContain("demo_notebook_exists");
    }

    const { data, error } = await user.client.from("notebooks").select("id");
    expect(error).toBeNull();
    expect((data ?? []).map((n: { id: string }) => n.id)).toEqual([succeeded[0]?.notebookId]);

    const copy = await readCopy(user, succeeded[0]?.notebookId as string);
    expect(copy.sources).toHaveLength(SEED_READY_SOURCES.length);
    expect(copy.sources).toHaveLength(2);
    expect(copy.chunks).toHaveLength(SEED_READY_CHUNK_COUNT);
    expect(copy.chunks).toHaveLength(6);
  });
});

describe("private.demo_template is unreachable through the API", () => {
  let demoUser: SignedInUser;
  let regularUser: SignedInUser;

  beforeAll(async () => {
    demoUser = await signInAnonymousUser();
    regularUser = await signUpUser("demo-template-probe");
  });

  it.each([
    ["anonymous-signin user", () => demoUser],
    ["non-anonymous user", () => regularUser],
  ])("%s cannot read it, by schema or as a public table", async (_name, who) => {
    const client = who().client;

    const viaPublic = await client.from("demo_template").select("*");
    expect(viaPublic.error).not.toBeNull();
    expect(viaPublic.data).toBeNull();

    // `private` is not an exposed schema, so PostgREST refuses the profile outright.
    const viaPrivate = await client.schema("private" as never).from("demo_template").select("*");
    expect(viaPrivate.error).not.toBeNull();
    expect(viaPrivate.data).toBeNull();
  });

  it("a session-less anon client cannot read it either", async () => {
    const client = anonClient();
    const viaPublic = await client.from("demo_template").select("*");
    expect(viaPublic.error).not.toBeNull();
    const viaPrivate = await client.schema("private" as never).from("demo_template").select("*");
    expect(viaPrivate.error).not.toBeNull();
  });

  it("nobody can write it through the API", async () => {
    const client = regularUser.client;
    const insert = await client
      .schema("private" as never)
      .from("demo_template")
      .insert({ notebook_id: randomUUID(), updated_by: "attacker", reason: "x" });
    expect(insert.error).not.toBeNull();
  });
});
