// RLS matrix for the ops page: public.ops_summary, public.record_eval_run and private.eval_runs.
// Every client is a real sign-in with a real JWT; the service role is never used here (AGENTS.md).
// The positive behaviour of both functions is proven in supabase/tests/database/090_ops.test.sql,
// as the server-side admin role through `set local role` in a raw SQL session.
//
// What must hold for every actor (owner, editor, viewer, stranger, a signed-in anonymous demo
// user, anon with no session): both functions answer 42501 (permission denied), and
// private.eval_runs cannot be reached at all (PGRST106: the private schema is not exposed).
//
// Red before the migration: neither function exists, so rpc answers PGRST202 (not found in the
// schema cache) instead of 42501. The private-schema assertions already pass today, as in
// model_usage.test.ts: PostgREST checks schema exposure before it looks for a table.
//
// An operator flag (app_metadata.ops) gives no database access either: the page reads through
// the server-side admin role, so no JWT claim can make these calls succeed from the API. That is
// covered by the rows above (a real user JWT without the claim) and by the unit tests for
// isOperator; a JWT with app_metadata cannot be minted here without the admin credential.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { anonClient, signInAnonymousUser, signUpUser, type SignedInUser } from "./helpers/clients";
import { addMember, createNotebook } from "./helpers/notebooks";

describe("ops: ops_summary, record_eval_run and private.eval_runs are unreachable for every real client", () => {
  let owner: SignedInUser;
  let editor: SignedInUser;
  let viewer: SignedInUser;
  let stranger: SignedInUser;
  let anonymousDemo: SignedInUser;
  let notebookId: string;

  beforeAll(async () => {
    owner = await signUpUser("ops-owner");
    editor = await signUpUser("ops-editor");
    viewer = await signUpUser("ops-viewer");
    stranger = await signUpUser("ops-stranger");
    anonymousDemo = await signInAnonymousUser();

    notebookId = await createNotebook(owner, "ops");
    await addMember(owner, notebookId, editor.userId, "editor");
    await addMember(owner, notebookId, viewer.userId, "viewer");
    await addMember(owner, notebookId, anonymousDemo.userId, "editor");
  });

  function actors(): Array<[string, () => SignedInUser["client"]]> {
    return [
      ["owner", () => owner.client],
      ["editor", () => editor.client],
      ["viewer", () => viewer.client],
      ["stranger", () => stranger.client],
      ["a signed-in anonymous demo user", () => anonymousDemo.client],
      ["anon (no session)", () => anonClient()],
    ];
  }

  describe.each(actors())("%s", (label, getClient) => {
    it(`${label} cannot call ops_summary for 7 days (42501)`, async () => {
      const { data, error } = await getClient().rpc("ops_summary", { p_days: 7 });
      expect(data).toBeNull();
      expect(error?.code).toBe("42501");
    });

    it(`${label} cannot call ops_summary for 30 days (42501)`, async () => {
      const { data, error } = await getClient().rpc("ops_summary", { p_days: 30 });
      expect(data).toBeNull();
      expect(error?.code).toBe("42501");
    });

    it(`${label} gets 42501, not a validation error, for an invalid window (the grant is checked first)`, async () => {
      const { data, error } = await getClient().rpc("ops_summary", { p_days: 8 });
      expect(data).toBeNull();
      expect(error?.code).toBe("42501");
    });

    it(`${label} cannot call record_eval_run (42501)`, async () => {
      const { data, error } = await getClient().rpc("record_eval_run", {
        p_commit_sha: randomUUID(),
        p_security_passed: 5,
        p_security_total: 5,
        p_quality_passed: 12,
        p_quality_total: 12,
        p_errored: 0,
        p_ok: true,
      });
      expect(data).toBeNull();
      expect(error?.code).toBe("42501");
    });

    it(`${label} cannot call record_eval_run with an invalid score either (42501, not 22023)`, async () => {
      const { data, error } = await getClient().rpc("record_eval_run", {
        p_commit_sha: null,
        p_security_passed: 9,
        p_security_total: 5,
        p_quality_passed: -1,
        p_quality_total: 12,
        p_errored: -3,
        p_ok: true,
      });
      expect(data).toBeNull();
      expect(error?.code).toBe("42501");
    });

    it(`${label} cannot select private.eval_runs (PGRST106, private is not exposed)`, async () => {
      const { data, error } = await getClient().schema("private").from("eval_runs").select();
      expect(data).toBeNull();
      expect(error?.code).toBe("PGRST106");
    });

    it(`${label} cannot insert into private.eval_runs (PGRST106, private is not exposed)`, async () => {
      const { data, error } = await getClient()
        .schema("private")
        .from("eval_runs")
        .insert({ commit_sha: "forged", security_passed: 5, security_total: 5, quality_passed: 12, quality_total: 12, errored: 0, ok: true });
      expect(data).toBeNull();
      expect(error?.code).toBe("PGRST106");
    });

    it(`${label} cannot update or delete private.eval_runs (PGRST106, private is not exposed)`, async () => {
      const update = await getClient().schema("private").from("eval_runs").update({ ok: true }).eq("id", 1);
      expect(update.data).toBeNull();
      expect(update.error?.code).toBe("PGRST106");
      const del = await getClient().schema("private").from("eval_runs").delete().eq("id", 1);
      expect(del.data).toBeNull();
      expect(del.error?.code).toBe("PGRST106");
    });
  });
});
