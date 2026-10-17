// RLS matrix for public.notebook_members (PR 3 contract), including the
// last-owner guard and the private schema's non-exposure through PostgREST.
// Every client is built from a real sign-in and a real JWT -- owner, editor,
// viewer, stranger, anon, and an anonymous-signin user -- never the admin/
// service-role credential. Users are created once per describe block (beforeAll), not per `it`, per
// the local Auth rate limits (raised for this harness, see
// supabase/config.toml).
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { anonClient, signInAnonymousUser, signUpUser, type SignedInUser } from "./helpers/clients";
import { addMember, createNotebook } from "./helpers/notebooks";

describe("notebook_members: select", () => {
  let owner: SignedInUser;
  let editor: SignedInUser;
  let viewer: SignedInUser;
  let stranger: SignedInUser;
  let notebookId: string;

  beforeAll(async () => {
    owner = await signUpUser("members-select-owner");
    editor = await signUpUser("members-select-editor");
    viewer = await signUpUser("members-select-viewer");
    stranger = await signUpUser("members-select-stranger");

    notebookId = await createNotebook(owner, "members-select");
    await addMember(owner, notebookId, editor.userId, "editor");
    await addMember(owner, notebookId, viewer.userId, "viewer");
  });

  function userIds(rows: { user_id: string }[] | null): Set<string> {
    return new Set((rows ?? []).map((row) => row.user_id));
  }

  it("shows all three members to the owner", async () => {
    const { data, error } = await owner.client
      .from("notebook_members")
      .select("user_id")
      .eq("notebook_id", notebookId);
    expect(error).toBeNull();
    expect(userIds(data)).toEqual(new Set([owner.userId, editor.userId, viewer.userId]));
  });

  it("shows all three members to an editor", async () => {
    const { data, error } = await editor.client
      .from("notebook_members")
      .select("user_id")
      .eq("notebook_id", notebookId);
    expect(error).toBeNull();
    expect(userIds(data)).toEqual(new Set([owner.userId, editor.userId, viewer.userId]));
  });

  it("shows all three members to a viewer", async () => {
    const { data, error } = await viewer.client
      .from("notebook_members")
      .select("user_id")
      .eq("notebook_id", notebookId);
    expect(error).toBeNull();
    expect(userIds(data)).toEqual(new Set([owner.userId, editor.userId, viewer.userId]));
  });

  it("shows nothing to a stranger", async () => {
    const { data, error } = await stranger.client
      .from("notebook_members")
      .select("user_id")
      .eq("notebook_id", notebookId);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("rejects anon with 42501 (no grants for anon at all)", async () => {
    const { data, error } = await anonClient()
      .from("notebook_members")
      .select("user_id")
      .eq("notebook_id", notebookId);
    expect(data).toBeNull();
    expect(error?.code).toBe("42501");
  });
});

describe("notebook_members: insert", () => {
  let owner: SignedInUser;
  let editor: SignedInUser;
  let viewer: SignedInUser;
  let stranger: SignedInUser;
  let newUser: SignedInUser;
  let anonymousOwner: SignedInUser;
  let otherOwner: SignedInUser;
  let notebookA: string;
  let notebookB: string;
  let anonymousNotebook: string;

  beforeAll(async () => {
    owner = await signUpUser("members-insert-owner");
    editor = await signUpUser("members-insert-editor");
    viewer = await signUpUser("members-insert-viewer");
    stranger = await signUpUser("members-insert-stranger");
    newUser = await signUpUser("members-insert-new-user");
    anonymousOwner = await signInAnonymousUser();
    otherOwner = await signUpUser("members-insert-other-owner");

    notebookA = await createNotebook(owner, "members-insert-a");
    await addMember(owner, notebookA, editor.userId, "editor");
    await addMember(owner, notebookA, viewer.userId, "viewer");

    notebookB = await createNotebook(otherOwner, "members-insert-b");
    anonymousNotebook = await createNotebook(anonymousOwner, "members-insert-anon-owned");
  });

  it("lets the owner add a new member as viewer", async () => {
    const { error } = await owner.client
      .from("notebook_members")
      .insert({ notebook_id: notebookA, user_id: newUser.userId, role: "viewer" });
    expect(error).toBeNull();

    const { data, error: selectError } = await owner.client
      .from("notebook_members")
      .select("role")
      .eq("notebook_id", notebookA)
      .eq("user_id", newUser.userId);
    expect(selectError).toBeNull();
    expect(data).toEqual([{ role: "viewer" }]);
  });

  it("rejects an editor adding a member with 42501", async () => {
    const someone = await signUpUser("members-insert-editor-target");
    const { error } = await editor.client
      .from("notebook_members")
      .insert({ notebook_id: notebookA, user_id: someone.userId, role: "viewer" });
    expect(error?.code).toBe("42501");
  });

  it("rejects a viewer adding a member with 42501", async () => {
    const someone = await signUpUser("members-insert-viewer-target");
    const { error } = await viewer.client
      .from("notebook_members")
      .insert({ notebook_id: notebookA, user_id: someone.userId, role: "viewer" });
    expect(error?.code).toBe("42501");
  });

  it("rejects a stranger inserting themselves into a foreign notebook as owner with 42501", async () => {
    const { error } = await stranger.client
      .from("notebook_members")
      .insert({ notebook_id: notebookA, user_id: stranger.userId, role: "owner" });
    expect(error?.code).toBe("42501");
  });

  it("rejects a stranger inserting themselves into a foreign notebook as viewer with 42501", async () => {
    const { error } = await stranger.client
      .from("notebook_members")
      .insert({ notebook_id: notebookA, user_id: stranger.userId, role: "viewer" });
    expect(error?.code).toBe("42501");
  });

  it("rejects an owner of notebook A inserting a membership into notebook B (owned by someone else) with 42501", async () => {
    const { error } = await owner.client
      .from("notebook_members")
      .insert({ notebook_id: notebookB, user_id: owner.userId, role: "viewer" });
    expect(error?.code).toBe("42501");
  });

  it("rejects an anonymous-signin user inserting a membership, even into a notebook they own, with 42501 (restrictive policy)", async () => {
    const { error } = await anonymousOwner.client
      .from("notebook_members")
      .insert({ notebook_id: anonymousNotebook, user_id: stranger.userId, role: "viewer" });
    expect(error?.code).toBe("42501");
  });
});

describe("notebook_members: update", () => {
  let owner: SignedInUser;
  let editor: SignedInUser;
  let viewer: SignedInUser;
  let stranger: SignedInUser;
  let notebookId: string;

  beforeAll(async () => {
    owner = await signUpUser("members-update-owner");
    editor = await signUpUser("members-update-editor");
    viewer = await signUpUser("members-update-viewer");
    stranger = await signUpUser("members-update-stranger");

    notebookId = await createNotebook(owner, "members-update");
    await addMember(owner, notebookId, editor.userId, "editor");
    await addMember(owner, notebookId, viewer.userId, "viewer");
  });

  it("an editor updating another member's role changes nothing", async () => {
    const { data, error } = await editor.client
      .from("notebook_members")
      .update({ role: "editor" })
      .eq("notebook_id", notebookId)
      .eq("user_id", viewer.userId)
      .select("role");
    expect(error).toBeNull();
    expect(data).toEqual([]);

    const { data: reread, error: rereadError } = await owner.client
      .from("notebook_members")
      .select("role")
      .eq("notebook_id", notebookId)
      .eq("user_id", viewer.userId);
    expect(rereadError).toBeNull();
    expect(reread).toEqual([{ role: "viewer" }]);
  });

  it("a viewer updating another member's role changes nothing", async () => {
    const { data, error } = await viewer.client
      .from("notebook_members")
      .update({ role: "viewer" })
      .eq("notebook_id", notebookId)
      .eq("user_id", editor.userId)
      .select("role");
    expect(error).toBeNull();
    expect(data).toEqual([]);

    const { data: reread, error: rereadError } = await owner.client
      .from("notebook_members")
      .select("role")
      .eq("notebook_id", notebookId)
      .eq("user_id", editor.userId);
    expect(rereadError).toBeNull();
    expect(reread).toEqual([{ role: "editor" }]);
  });

  it("a stranger updating a member's role changes nothing", async () => {
    const { data, error } = await stranger.client
      .from("notebook_members")
      .update({ role: "owner" })
      .eq("notebook_id", notebookId)
      .eq("user_id", viewer.userId)
      .select("role");
    expect(error).toBeNull();
    expect(data).toEqual([]);

    const { data: reread, error: rereadError } = await owner.client
      .from("notebook_members")
      .select("role")
      .eq("notebook_id", notebookId)
      .eq("user_id", viewer.userId);
    expect(rereadError).toBeNull();
    expect(reread).toEqual([{ role: "viewer" }]);
  });

  it("rejects an anon update with 42501 (no grants for anon at all)", async () => {
    const { data, error } = await anonClient()
      .from("notebook_members")
      .update({ role: "owner" })
      .eq("notebook_id", notebookId)
      .eq("user_id", viewer.userId);
    expect(data).toBeNull();
    expect(error?.code).toBe("42501");
  });

  it("an editor setting their own role to owner changes nothing", async () => {
    const { data, error } = await editor.client
      .from("notebook_members")
      .update({ role: "owner" })
      .eq("notebook_id", notebookId)
      .eq("user_id", editor.userId)
      .select("role");
    expect(error).toBeNull();
    expect(data).toEqual([]);

    const { data: reread } = await owner.client
      .from("notebook_members")
      .select("role")
      .eq("notebook_id", notebookId)
      .eq("user_id", editor.userId);
    expect(reread).toEqual([{ role: "editor" }]);
  });

  it("a viewer setting their own role to editor changes nothing", async () => {
    const { data, error } = await viewer.client
      .from("notebook_members")
      .update({ role: "editor" })
      .eq("notebook_id", notebookId)
      .eq("user_id", viewer.userId)
      .select("role");
    expect(error).toBeNull();
    expect(data).toEqual([]);

    const { data: reread } = await owner.client
      .from("notebook_members")
      .select("role")
      .eq("notebook_id", notebookId)
      .eq("user_id", viewer.userId);
    expect(reread).toEqual([{ role: "viewer" }]);
  });

  it("the owner can demote the editor to viewer", async () => {
    const { data, error } = await owner.client
      .from("notebook_members")
      .update({ role: "viewer" })
      .eq("notebook_id", notebookId)
      .eq("user_id", editor.userId)
      .select("role");
    expect(error).toBeNull();
    expect(data).toEqual([{ role: "viewer" }]);
  });

  it("rejects the owner updating user_id with 42501 (column grant is role only)", async () => {
    const { error } = await owner.client
      .from("notebook_members")
      .update({ user_id: randomUUID() })
      .eq("notebook_id", notebookId)
      .eq("user_id", viewer.userId);
    expect(error?.code).toBe("42501");
  });

  it("rejects the owner updating notebook_id with 42501 (column grant is role only)", async () => {
    const { error } = await owner.client
      .from("notebook_members")
      .update({ notebook_id: randomUUID() })
      .eq("notebook_id", notebookId)
      .eq("user_id", viewer.userId);
    expect(error?.code).toBe("42501");
  });
});

describe("notebook_members: delete", () => {
  let owner: SignedInUser;
  let editor: SignedInUser;
  let viewerA: SignedInUser;
  let viewerB: SignedInUser;
  let stranger: SignedInUser;
  let notebookId: string;

  beforeAll(async () => {
    owner = await signUpUser("members-delete-owner");
    editor = await signUpUser("members-delete-editor");
    viewerA = await signUpUser("members-delete-viewer-a");
    viewerB = await signUpUser("members-delete-viewer-b");
    stranger = await signUpUser("members-delete-stranger");

    notebookId = await createNotebook(owner, "members-delete");
    await addMember(owner, notebookId, editor.userId, "editor");
    await addMember(owner, notebookId, viewerA.userId, "viewer");
    await addMember(owner, notebookId, viewerB.userId, "viewer");
  });

  it("the owner can remove a viewer", async () => {
    const { data, error } = await owner.client
      .from("notebook_members")
      .delete()
      .eq("notebook_id", notebookId)
      .eq("user_id", viewerA.userId)
      .select("user_id");
    expect(error).toBeNull();
    expect(data).toEqual([{ user_id: viewerA.userId }]);

    const { data: reread } = await owner.client
      .from("notebook_members")
      .select("user_id")
      .eq("notebook_id", notebookId)
      .eq("user_id", viewerA.userId);
    expect(reread).toEqual([]);
  });

  it("an editor removing a viewer removes nothing", async () => {
    const { data, error } = await editor.client
      .from("notebook_members")
      .delete()
      .eq("notebook_id", notebookId)
      .eq("user_id", viewerB.userId)
      .select("user_id");
    expect(error).toBeNull();
    expect(data).toEqual([]);

    const { data: reread } = await owner.client
      .from("notebook_members")
      .select("user_id")
      .eq("notebook_id", notebookId)
      .eq("user_id", viewerB.userId);
    expect(reread).toEqual([{ user_id: viewerB.userId }]);
  });

  it("a viewer removing another member removes nothing", async () => {
    const { data, error } = await viewerB.client
      .from("notebook_members")
      .delete()
      .eq("notebook_id", notebookId)
      .eq("user_id", editor.userId)
      .select("user_id");
    expect(error).toBeNull();
    expect(data).toEqual([]);

    const { data: reread, error: rereadError } = await owner.client
      .from("notebook_members")
      .select("user_id")
      .eq("notebook_id", notebookId)
      .eq("user_id", editor.userId);
    expect(rereadError).toBeNull();
    expect(reread).toEqual([{ user_id: editor.userId }]);
  });

  it("a stranger removing a member removes nothing", async () => {
    const { data, error } = await stranger.client
      .from("notebook_members")
      .delete()
      .eq("notebook_id", notebookId)
      .eq("user_id", editor.userId)
      .select("user_id");
    expect(error).toBeNull();
    expect(data).toEqual([]);

    const { data: reread, error: rereadError } = await owner.client
      .from("notebook_members")
      .select("user_id")
      .eq("notebook_id", notebookId)
      .eq("user_id", editor.userId);
    expect(rereadError).toBeNull();
    expect(reread).toEqual([{ user_id: editor.userId }]);
  });

  it("rejects an anon delete with 42501 (no grants for anon at all)", async () => {
    const { data, error } = await anonClient()
      .from("notebook_members")
      .delete()
      .eq("notebook_id", notebookId)
      .eq("user_id", editor.userId);
    expect(data).toBeNull();
    expect(error?.code).toBe("42501");
  });

  it("an editor deleting their own membership (self-leave) removes nothing", async () => {
    const { data, error } = await editor.client
      .from("notebook_members")
      .delete()
      .eq("notebook_id", notebookId)
      .eq("user_id", editor.userId)
      .select("user_id");
    expect(error).toBeNull();
    expect(data).toEqual([]);

    const { data: reread } = await owner.client
      .from("notebook_members")
      .select("role")
      .eq("notebook_id", notebookId)
      .eq("user_id", editor.userId);
    expect(reread).toEqual([{ role: "editor" }]);
  });
});

describe("notebook_members: last-owner guard", () => {
  let soleOwner: SignedInUser;
  let notebookId: string;

  beforeAll(async () => {
    soleOwner = await signUpUser("members-last-owner-sole");
    notebookId = await createNotebook(soleOwner, "members-last-owner");
  });

  it("rejects the sole owner demoting themselves with P0001", async () => {
    const { error } = await soleOwner.client
      .from("notebook_members")
      .update({ role: "editor" })
      .eq("notebook_id", notebookId)
      .eq("user_id", soleOwner.userId);
    expect(error?.code).toBe("P0001");
  });

  it("rejects the sole owner deleting their own membership with P0001", async () => {
    const { error } = await soleOwner.client
      .from("notebook_members")
      .delete()
      .eq("notebook_id", notebookId)
      .eq("user_id", soleOwner.userId);
    expect(error?.code).toBe("P0001");
  });

  it("lets the owner demote themselves once a second owner exists, and the second owner remains", async () => {
    const secondOwner = await signUpUser("members-last-owner-second");
    await addMember(soleOwner, notebookId, secondOwner.userId, "owner");

    const { data, error } = await soleOwner.client
      .from("notebook_members")
      .update({ role: "editor" })
      .eq("notebook_id", notebookId)
      .eq("user_id", soleOwner.userId)
      .select("role");
    expect(error).toBeNull();
    expect(data).toEqual([{ role: "editor" }]);

    const { data: secondOwnerRow, error: selectError } = await soleOwner.client
      .from("notebook_members")
      .select("role")
      .eq("notebook_id", notebookId)
      .eq("user_id", secondOwner.userId);
    expect(selectError).toBeNull();
    expect(secondOwnerRow).toEqual([{ role: "owner" }]);
  });
});

describe("notebook_members: bulk operations and flat ownership", () => {
  // Reproduces the reported bug through the real PostgREST/JWT path (the
  // pgTAP suite in supabase/tests/database/010_notebooks_memberships.test.sql
  // reproduces it directly against Postgres, with the acting owner's row
  // deterministically ordered before/after the other owner's, since this bug
  // depends on which owner's own row is processed first -- not on insertion
  // order, and not controllable through a real sign-up, whose user id is
  // assigned by Supabase Auth). With two owners, a bulk statement matching
  // every membership row for a notebook must raise P0001 and change nothing,
  // exactly like the single-row last-owner guard above.
  //
  // Each `it` below gets its own fresh notebook/owners: unlike every other
  // multi-row-safe describe in this file, a bulk delete/demote that
  // currently (bug) succeeds instead of raising would otherwise mutate a
  // fixture shared across tests and corrupt whichever test runs next.
  let owner: SignedInUser;
  let coOwner: SignedInUser;

  beforeAll(async () => {
    owner = await signUpUser("members-bulk-owner");
    coOwner = await signUpUser("members-bulk-co-owner");
  });

  it("a bulk delete matching every member of the notebook raises P0001 and changes nothing", async () => {
    const notebookId = await createNotebook(owner, "members-bulk-delete");
    await addMember(owner, notebookId, coOwner.userId, "owner");

    const { data, error } = await coOwner.client
      .from("notebook_members")
      .delete()
      .eq("notebook_id", notebookId);
    expect(data).toBeNull();
    expect(error?.code).toBe("P0001");

    const { data: reread, error: rereadError } = await owner.client
      .from("notebook_members")
      .select("user_id")
      .eq("notebook_id", notebookId);
    expect(rereadError).toBeNull();
    expect(reread).toHaveLength(2);
  });

  it("a bulk demote matching every member of the notebook raises P0001 and changes nothing", async () => {
    const notebookId = await createNotebook(owner, "members-bulk-demote");
    await addMember(owner, notebookId, coOwner.userId, "owner");

    const { data, error } = await owner.client
      .from("notebook_members")
      .update({ role: "viewer" })
      .eq("notebook_id", notebookId);
    expect(data).toBeNull();
    expect(error?.code).toBe("P0001");

    const { data: reread, error: rereadError } = await owner.client
      .from("notebook_members")
      .select("role")
      .eq("notebook_id", notebookId);
    expect(rereadError).toBeNull();
    expect(reread).toHaveLength(2);
    for (const row of reread ?? []) {
      expect(row.role).toBe("owner");
    }
  });

  it("one owner can demote a different owner (not themselves) while a third owner remains", async () => {
    const notebookId = await createNotebook(owner, "members-bulk-demote-another");
    await addMember(owner, notebookId, coOwner.userId, "owner");
    const thirdOwner = await signUpUser("members-bulk-third-owner");
    await addMember(owner, notebookId, thirdOwner.userId, "owner");

    const { data, error } = await owner.client
      .from("notebook_members")
      .update({ role: "editor" })
      .eq("notebook_id", notebookId)
      .eq("user_id", coOwner.userId)
      .select("role");
    expect(error).toBeNull();
    expect(data).toEqual([{ role: "editor" }]);

    const { data: thirdOwnerRow, error: thirdOwnerError } = await owner.client
      .from("notebook_members")
      .select("role")
      .eq("notebook_id", notebookId)
      .eq("user_id", thirdOwner.userId);
    expect(thirdOwnerError).toBeNull();
    expect(thirdOwnerRow).toEqual([{ role: "owner" }]);
  });
});

describe("notebook_members: private schema is not reachable through PostgREST", () => {
  let user: SignedInUser;

  beforeAll(async () => {
    user = await signUpUser("members-private-schema");
  });

  it("rejects .schema('private').from('membership_audit') with PGRST106", async () => {
    const { data, error } = await user.client.schema("private").from("membership_audit").select();
    expect(data).toBeNull();
    expect(error?.code).toBe("PGRST106");
  });

  it("rejects rpc('notebook_role', ...) on the public schema with PGRST202 (not found)", async () => {
    const { data, error } = await user.client.rpc("notebook_role", { p_notebook_id: randomUUID() });
    expect(data).toBeNull();
    expect(error?.code).toBe("PGRST202");
  });
});
