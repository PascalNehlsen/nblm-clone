// RLS and recall behaviour for public.match_chunks (PR A1 contract). Every
// client is built from a real sign-in and a real JWT -- member, stranger,
// anon -- never the admin/service-role credential.
//
// match_chunks does an *exact* nearest-neighbour search within the caller's
// notebook -- no approximate index (no hnsw, no ivfflat; see the ADR this
// PR's migration links and the "no approximate vector access method" check
// in supabase/tests/database/020_sources_chunks_messages.test.sql). Exact
// search needs no planner GUCs forced one way or another, so unlike an
// ANN-index design there is nothing PostgREST-specific this suite has to
// work around: the "post-filter recall" tests below (a much larger, much
// closer foreign notebook that must not leak into, or crowd out, the
// caller's own results) are a real end-to-end functional check straight
// through PostgREST, access and results together. The pgTAP file additionally
// pins the exact-match contract at the SQL level (a 60-chunk fixture with a
// known exact top-8, asserted in distance order) and the "no approximate
// index" catalog invariant; it is not needed here to make this suite
// trustworthy, just to catch a regression closer to its source.
import { beforeAll, describe, expect, it } from "vitest";
import { anonClient, signInAnonymousUser, signUpUser, type SignedInUser } from "./helpers/clients";
import { addMember, createNotebook } from "./helpers/notebooks";
import { createSourceWithChunks, queryVector, setSourceStatus } from "./helpers/sources";

describe("match_chunks: only chunks of ready sources are returned", () => {
  // The non-ready sources hold chunks that are much closer to the query vector
  // (tiny noise) than the ready source's, and there are fewer than match_count
  // rows in total per source, so an unfiltered search would return them first.
  let owner: SignedInUser;
  let editor: SignedInUser;
  let viewer: SignedInUser;
  let anonymousMember: SignedInUser;
  let stranger: SignedInUser;
  let notebookId: string;
  let readyChunkIds: string[];
  let notReadyChunkIds: string[];

  beforeAll(async () => {
    owner = await signUpUser("match-ready-owner");
    editor = await signUpUser("match-ready-editor");
    viewer = await signUpUser("match-ready-viewer");
    anonymousMember = await signInAnonymousUser();
    stranger = await signUpUser("match-ready-stranger");

    notebookId = await createNotebook(owner, "match-ready");
    await addMember(owner, notebookId, editor.userId, "editor");
    await addMember(owner, notebookId, viewer.userId, "viewer");
    await addMember(owner, notebookId, anonymousMember.userId, "viewer");

    readyChunkIds = (await createSourceWithChunks(owner, notebookId, 3, 0.05, 0, { status: "ready" })).chunkIds;
    const pending = await createSourceWithChunks(owner, notebookId, 3, 0.0005, 100, { status: "pending" });
    const processing = await createSourceWithChunks(owner, notebookId, 3, 0.0005, 200, { status: "processing" });
    const failed = await createSourceWithChunks(owner, notebookId, 3, 0.0005, 300, { status: "failed" });
    notReadyChunkIds = [...pending.chunkIds, ...processing.chunkIds, ...failed.chunkIds];
  });

  async function idsFor(user: SignedInUser): Promise<string[]> {
    const { data, error } = await user.client.rpc("match_chunks", {
      query_embedding: queryVector(),
      p_notebook_id: notebookId,
      match_count: 50,
    });
    expect(error).toBeNull();
    return (data ?? []).map((row: { id: string }) => row.id);
  }

  it.each([
    ["owner", () => owner],
    ["editor", () => editor],
    ["viewer", () => viewer],
    ["anonymous-signin member", () => anonymousMember],
  ])("%s gets the ready source's chunks and none of the pending, processing or failed ones", async (_name, who) => {
    const ids = await idsFor(who());
    expect(new Set(ids)).toEqual(new Set(readyChunkIds));
    for (const id of notReadyChunkIds) {
      expect(ids).not.toContain(id);
    }
  });

  it("a stranger still gets no rows", async () => {
    const { data, error } = await stranger.client.rpc("match_chunks", {
      query_embedding: queryVector(),
      p_notebook_id: notebookId,
      match_count: 50,
    });
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("anon still gets 42501", async () => {
    const { data, error } = await anonClient().rpc("match_chunks", {
      query_embedding: queryVector(),
      p_notebook_id: notebookId,
      match_count: 50,
    });
    expect(data).toBeNull();
    expect(error?.code).toBe("42501");
  });

  it("a source that becomes ready appears, and drops out again when it goes back to processing", async () => {
    const source = await createSourceWithChunks(owner, notebookId, 2, 0.0005, 400, { status: "processing" });
    expect(await idsFor(viewer)).not.toContain(source.chunkIds[0]);

    await setSourceStatus(owner, source.sourceId, "ready");
    const whenReady = await idsFor(viewer);
    for (const id of source.chunkIds) {
      expect(whenReady).toContain(id);
    }

    await setSourceStatus(owner, source.sourceId, "processing");
    const whenProcessing = await idsFor(viewer);
    for (const id of source.chunkIds) {
      expect(whenProcessing).not.toContain(id);
    }
  });
});

describe("match_chunks: access", () => {
  let owner: SignedInUser;
  let editor: SignedInUser;
  let viewer: SignedInUser;
  let anonymousMember: SignedInUser;
  let stranger: SignedInUser;
  let notebookId: string;

  beforeAll(async () => {
    owner = await signUpUser("match-access-owner");
    editor = await signUpUser("match-access-editor");
    viewer = await signUpUser("match-access-viewer");
    anonymousMember = await signInAnonymousUser();
    stranger = await signUpUser("match-access-stranger");

    notebookId = await createNotebook(owner, "match-access");
    await addMember(owner, notebookId, editor.userId, "editor");
    await addMember(owner, notebookId, viewer.userId, "viewer");
    await addMember(owner, notebookId, anonymousMember.userId, "viewer");
    await createSourceWithChunks(owner, notebookId, 5, 0.01);
  });

  it("returns results to a member (owner)", async () => {
    const { data, error } = await owner.client.rpc("match_chunks", {
      query_embedding: queryVector(),
      p_notebook_id: notebookId,
      match_count: 8,
    });
    expect(error).toBeNull();
    expect(data?.length).toBeGreaterThan(0);
  });

  it("returns results to an editor", async () => {
    const { data, error } = await editor.client.rpc("match_chunks", {
      query_embedding: queryVector(),
      p_notebook_id: notebookId,
      match_count: 8,
    });
    expect(error).toBeNull();
    expect(data?.length).toBeGreaterThan(0);
  });

  it("returns results to a viewer", async () => {
    const { data, error } = await viewer.client.rpc("match_chunks", {
      query_embedding: queryVector(),
      p_notebook_id: notebookId,
      match_count: 8,
    });
    expect(error).toBeNull();
    expect(data?.length).toBeGreaterThan(0);
  });

  it("returns results to an anonymous-signin member", async () => {
    const { data, error } = await anonymousMember.client.rpc("match_chunks", {
      query_embedding: queryVector(),
      p_notebook_id: notebookId,
      match_count: 8,
    });
    expect(error).toBeNull();
    expect(data?.length).toBeGreaterThan(0);
  });

  it("returns 0 rows to a stranger calling with the same notebook id (no error)", async () => {
    const { data, error } = await stranger.client.rpc("match_chunks", {
      query_embedding: queryVector(),
      p_notebook_id: notebookId,
      match_count: 8,
    });
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("rejects anon with 42501 (execute revoked from anon)", async () => {
    const { data, error } = await anonClient().rpc("match_chunks", {
      query_embedding: queryVector(),
      p_notebook_id: notebookId,
      match_count: 8,
    });
    expect(data).toBeNull();
    expect(error?.code).toBe("42501");
  });
});

describe("match_chunks: match_count clamp", () => {
  let owner: SignedInUser;
  let notebookId: string;

  beforeAll(async () => {
    owner = await signUpUser("match-clamp-owner");
    notebookId = await createNotebook(owner, "match-clamp");
    // 60 chunks so a clamp to 50 is actually observable.
    await createSourceWithChunks(owner, notebookId, 60, 0.01);
  });

  it("clamps match_count=1000 to at most 50 rows", async () => {
    const { data, error } = await owner.client.rpc("match_chunks", {
      query_embedding: queryVector(),
      p_notebook_id: notebookId,
      match_count: 1000,
    });
    expect(error).toBeNull();
    expect(data?.length).toBeLessThanOrEqual(50);
  });

  it("clamps match_count=0 up to 1 row", async () => {
    const { data, error } = await owner.client.rpc("match_chunks", {
      query_embedding: queryVector(),
      p_notebook_id: notebookId,
      match_count: 0,
    });
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });
});

describe("match_chunks: post-filter recall survives a much closer, much larger foreign notebook", () => {
  // match_chunks is an exact search (no approximate index), so this is a
  // straightforward real end-to-end check: access (RLS/grants) and the
  // result (the right 5 rows, not fewer and not foreign ones) together,
  // through the real PostgREST/JWT path. There is no "iterative scan" or
  // planner behaviour left to pin here -- the pgTAP file's 60-chunk
  // exact-top-8 test is what asserts exactness and distance order at the SQL
  // level; this suite just confirms the same contract holds for a real
  // caller.
  let owner: SignedInUser;
  let foreignOwner: SignedInUser;
  let ownNotebookId: string;
  let ownChunkIds: string[];

  beforeAll(async () => {
    owner = await signUpUser("match-recall-owner");
    foreignOwner = await signUpUser("match-recall-foreign-owner");

    ownNotebookId = await createNotebook(owner, "match-recall-own");
    const foreignNotebookId = await createNotebook(foreignOwner, "match-recall-foreign");

    // The foreign notebook's 300 chunks sit deceptively close to the query
    // vector (tiny noise); the caller's own 5 chunks are farther away (larger
    // noise) but still the only ones the caller is actually allowed to see.
    const own = await createSourceWithChunks(owner, ownNotebookId, 5, 0.05);
    ownChunkIds = own.chunkIds;
    await createSourceWithChunks(foreignOwner, foreignNotebookId, 300, 0.0005);
  });

  it("returns all 5 of the caller's own chunks, not foreign ones and not fewer", async () => {
    const { data, error } = await owner.client.rpc("match_chunks", {
      query_embedding: queryVector(),
      p_notebook_id: ownNotebookId,
      match_count: 8,
    });
    expect(error).toBeNull();
    const ids = (data ?? []).map((row: { id: string }) => row.id);
    expect(new Set(ids)).toEqual(new Set(ownChunkIds));
  });
});

describe("match_chunks: the p_notebook_id filter itself, not just RLS, restricts the result", () => {
  // Every other suite in this file that proves "the wrong notebook's chunks
  // do not leak in" uses a *stranger* or a *foreign* owner for the other
  // notebook -- RLS alone already removes those rows, so none of those tests
  // can tell match_chunks's own `where notebook_id = p_notebook_id` filter
  // apart from a mutant that deletes it entirely. This is the one case where
  // the caller is a genuine member (owner) of *both* notebooks: RLS lets them
  // see chunks in either one, so only the function's own notebook_id filter
  // -- not RLS -- can be responsible for excluding notebook B's chunks from a
  // call scoped to notebook A. Confirmed against a real mutant (the human
  // removed the notebook_id filter from match_chunks): the pgTAP suite caught
  // it, but this file's other tests stayed green, because they never exercise
  // the "member of the nearer notebook too" case.
  let owner: SignedInUser;
  let notebookAId: string;
  let notebookBId: string;
  let notebookAChunkIds: string[];

  beforeAll(async () => {
    owner = await signUpUser("match-own-filter-owner");
    notebookAId = await createNotebook(owner, "match-own-filter-a");
    notebookBId = await createNotebook(owner, "match-own-filter-b");

    // Notebook A: few chunks (fewer than match_count), farther from the query
    // vector (larger noise) -- every one of them must come back.
    const a = await createSourceWithChunks(owner, notebookAId, 3, 0.05);
    notebookAChunkIds = a.chunkIds;
    // Notebook B: more chunks than match_count, deceptively much closer to
    // the query vector (tiny noise). The owner can see these too (they own
    // notebook B as well), so if match_chunks ever stopped filtering by
    // notebook_id, B's chunks would crowd out some or all of A's in a call
    // scoped to notebook A.
    await createSourceWithChunks(owner, notebookBId, 10, 0.0005);
  });

  it("scoping the call to notebook A returns only notebook A's chunks, all of them, even though notebook B's are nearer and visible to the same owner", async () => {
    const { data, error } = await owner.client.rpc("match_chunks", {
      query_embedding: queryVector(),
      p_notebook_id: notebookAId,
      match_count: 8,
    });
    expect(error).toBeNull();
    const ids = (data ?? []).map((row: { id: string }) => row.id);
    expect(new Set(ids)).toEqual(new Set(notebookAChunkIds));
  });
});
