// RLS/behaviour matrix for PR E1 (private.usage, private.model_settings,
// public.reserve_model_call, public.settle_model_call). Proves the negative:
// no real signed-in client -- owner, editor, viewer, stranger, a signed-in
// anonymous user, or anon (no session) -- can reach either table directly or
// call either function, through the real PostgREST path. Every client here
// comes from a real sign-in and a real JWT; the privileged service role is
// never used in this file (see AGENTS.md). The positive behavioural contract
// for both functions (budget arithmetic, kill switch, settle idempotency,
// ...) lives in supabase/tests/database/040_model_usage_budget.test.sql,
// exercised there as that service role via `set local role` inside a raw SQL
// session (never the real admin/service-role HTTP credential).
//
// private.usage and private.model_settings live in the `private` schema,
// which PostgREST never exposes at all -- see harness.test.ts's "schema
// exposure" describe and notebook_members.test.ts's "private schema is not
// reachable" describe. That means `.schema('private').from(...)` already
// fails with PGRST106 today, before the PR E1 migration adds either table:
// schema exposure is checked before PostgREST looks up any table inside it,
// so these assertions do not depend on the migration and are expected to
// pass right now too.
//
// reserve_model_call/settle_model_call are different: they do not exist at
// all yet, so every rpc(...) call below currently fails with PGRST202
// ("Could not find the function ... in the schema cache"), not 42501 -- that
// is this file's actual red, for the right reason (missing behaviour, not a
// broken test). Once the migration adds them with `revoke execute from
// public, anon, authenticated` (only the service role may execute, per the
// approved spec), every actor here must get exactly 42501 (permission
// denied) and this file turns green.
//
// settle_model_call's parameter names are not pinned by the approved spec
// (only reserve_model_call's exact signature -- p_user_id, p_is_anonymous,
// p_notebook_id, p_kind, p_model_id, p_estimated_cost_usd, p_call_count --
// is). This file assumes settle_model_call follows the same p_-prefixed,
// column-matching convention: p_usage_id, p_status, p_input_tokens,
// p_output_tokens, p_cost_usd, p_latency_ms, p_message_id,
// p_error_category. PostgREST resolves an rpc call by matching the supplied
// argument names against the function's actual parameter names *before* the
// EXECUTE grant is even checked, so if the migration names them differently
// this call keeps returning PGRST202 instead of 42501 after the migration
// lands -- that would be a real naming mismatch to fix (match this
// convention, or tell the test-author to update it), not something to work
// around.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  anonClient,
  signInAnonymousUser,
  signUpUser,
  type SignedInUser,
} from "./helpers/clients";
import { addMember, createNotebook } from "./helpers/notebooks";

describe("model_usage: private tables and reserve_model_call/settle_model_call are unreachable for every real client", () => {
  let owner: SignedInUser;
  let editor: SignedInUser;
  let viewer: SignedInUser;
  let stranger: SignedInUser;
  let anonymousMember: SignedInUser;
  let notebookId: string;

  beforeAll(async () => {
    owner = await signUpUser("model-usage-owner");
    editor = await signUpUser("model-usage-editor");
    viewer = await signUpUser("model-usage-viewer");
    stranger = await signUpUser("model-usage-stranger");
    anonymousMember = await signInAnonymousUser();

    notebookId = await createNotebook(owner, "model-usage");
    await addMember(owner, notebookId, editor.userId, "editor");
    await addMember(owner, notebookId, viewer.userId, "viewer");
    await addMember(owner, notebookId, anonymousMember.userId, "editor");
  });

  // Role membership in the fixture notebook has no bearing on access to
  // private.usage/private.model_settings or on who may call
  // reserve_model_call/settle_model_call (that is restricted to the service
  // role only, independent of any notebook role) -- owner/editor/viewer/stranger/
  // anonymous-signin member are included anyway, as the full RLS matrix
  // AGENTS.md asks for, to prove the restriction holds for every real actor
  // shape, not just an arbitrary one.
  function actors(): Array<[string, () => SignedInUser["client"]]> {
    return [
      ["owner", () => owner.client],
      ["editor", () => editor.client],
      ["viewer", () => viewer.client],
      ["stranger", () => stranger.client],
      ["a signed-in anonymous member", () => anonymousMember.client],
      ["anon (no session)", () => anonClient()],
    ];
  }

  describe.each(actors())("%s", (label, getClient) => {
    it(`${label} cannot select private.usage (PGRST106, private is not exposed)`, async () => {
      const { data, error } = await getClient().schema("private").from("usage").select();
      expect(data).toBeNull();
      expect(error?.code).toBe("PGRST106");
    });

    it(`${label} cannot insert into private.usage (PGRST106, private is not exposed)`, async () => {
      const { data, error } = await getClient()
        .schema("private")
        .from("usage")
        .insert({
          user_id: randomUUID(),
          kind: "chat",
          model_id: "test-model",
          status: "reserved",
          cost_usd: 0.01,
        });
      expect(data).toBeNull();
      expect(error?.code).toBe("PGRST106");
    });

    it(`${label} cannot update private.usage (PGRST106, private is not exposed)`, async () => {
      const { data, error } = await getClient()
        .schema("private")
        .from("usage")
        .update({ status: "settled" })
        .eq("id", randomUUID());
      expect(data).toBeNull();
      expect(error?.code).toBe("PGRST106");
    });

    it(`${label} cannot select private.model_settings (PGRST106, private is not exposed)`, async () => {
      const { data, error } = await getClient().schema("private").from("model_settings").select();
      expect(data).toBeNull();
      expect(error?.code).toBe("PGRST106");
    });

    it(`${label} cannot insert into private.model_settings (PGRST106, private is not exposed)`, async () => {
      const { data, error } = await getClient()
        .schema("private")
        .from("model_settings")
        .insert({ model_features_enabled: true, daily_limit_usd: 99 });
      expect(data).toBeNull();
      expect(error?.code).toBe("PGRST106");
    });

    it(`${label} cannot update private.model_settings (PGRST106, private is not exposed)`, async () => {
      const { data, error } = await getClient()
        .schema("private")
        .from("model_settings")
        .update({ model_features_enabled: true })
        .eq("id", true);
      expect(data).toBeNull();
      expect(error?.code).toBe("PGRST106");
    });

    it(`${label} cannot call reserve_model_call (expect 42501 once it exists; PGRST202 is today's expected red)`, async () => {
      const { data, error } = await getClient().rpc("reserve_model_call", {
        p_user_id: randomUUID(),
        p_is_anonymous: false,
        p_notebook_id: notebookId,
        p_kind: "chat",
        p_model_id: "test-model",
        p_estimated_cost_usd: 0.01,
        p_call_count: 1,
      });
      expect(data).toBeNull();
      expect(error?.code).toBe("42501");
    });

    it(`${label} cannot call settle_model_call (expect 42501 once it exists; PGRST202 is today's expected red)`, async () => {
      const { data, error } = await getClient().rpc("settle_model_call", {
        p_usage_id: randomUUID(),
        p_status: "settled",
        p_input_tokens: 10,
        p_output_tokens: 10,
        p_cost_usd: 0.01,
        p_latency_ms: 100,
        p_message_id: null,
        p_error_category: null,
      });
      expect(data).toBeNull();
      expect(error?.code).toBe("42501");
    });
  });
});
