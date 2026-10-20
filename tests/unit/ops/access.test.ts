// Who may see /ops. isOperator(user) is true only for a signed-in, non-anonymous user whose
// app_metadata.ops is the boolean true. app_metadata is set by the server (or a human with
// SQL access) and cannot be edited by the user; user_metadata can, so it is never read.
// The layout turns every other case into a real 404 (notFound()).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isOperator } from "@/lib/server/ops/access";

type U = Parameters<typeof isOperator>[0];

const user = (over: Record<string, unknown>): U => ({ id: "11111111-1111-4111-8111-111111111111", ...over }) as unknown as U;

describe("isOperator truth table", () => {
  it.each([
    ["app_metadata.ops is true", { app_metadata: { ops: true } }, true],
    ["app_metadata.ops is true and is_anonymous is false", { app_metadata: { ops: true }, is_anonymous: false }, true],
    ["app_metadata.ops is true next to other claims", { app_metadata: { provider: "github", ops: true } }, true],
    ["app_metadata.ops is false", { app_metadata: { ops: false } }, false],
    ["app_metadata.ops is the string \"true\"", { app_metadata: { ops: "true" } }, false],
    ["app_metadata.ops is the string \"false\"", { app_metadata: { ops: "false" } }, false],
    ["app_metadata.ops is 1", { app_metadata: { ops: 1 } }, false],
    ["app_metadata.ops is an object", { app_metadata: { ops: {} } }, false],
    ["app_metadata.ops is an array", { app_metadata: { ops: [true] } }, false],
    ["app_metadata.ops is null", { app_metadata: { ops: null } }, false],
    ["app_metadata is empty", { app_metadata: {} }, false],
    ["app_metadata is missing", {}, false],
    ["app_metadata is null", { app_metadata: null }, false],
    ["ops only in user_metadata", { app_metadata: {}, user_metadata: { ops: true } }, false],
    ["ops only in user_metadata, app_metadata missing", { user_metadata: { ops: true } }, false],
    ["ops false in app_metadata, true in user_metadata", { app_metadata: { ops: false }, user_metadata: { ops: true } }, false],
    ["anonymous user with ops in app_metadata", { app_metadata: { ops: true }, is_anonymous: true }, false],
    ["anonymous user with ops in both", { app_metadata: { ops: true }, user_metadata: { ops: true }, is_anonymous: true }, false],
    ["an ops-like key with another name", { app_metadata: { operator: true, is_ops: true, Ops: true } }, false],
  ] as const)("%s -> %s", (_label, over, expected) => {
    expect(isOperator(user(over))).toBe(expected);
  });

  it.each([[null], [undefined]])("is false for %s (no session)", (value) => {
    expect(isOperator(value as U)).toBe(false);
  });

  it("is false for something that is not a user object", () => {
    for (const value of ["ops", 1, true, [], () => true]) {
      expect(isOperator(value as unknown as U)).toBe(false);
    }
  });

  it("never reads user_metadata (a getter that throws is never called)", () => {
    const u = {
      id: "11111111-1111-4111-8111-111111111111",
      app_metadata: { ops: true },
      get user_metadata(): never {
        throw new Error("user_metadata was read");
      },
    } as unknown as U;
    expect(() => isOperator(u)).not.toThrow();
    expect(isOperator(u)).toBe(true);

    const denied = {
      id: "11111111-1111-4111-8111-111111111111",
      app_metadata: { ops: false },
      get user_metadata(): never {
        throw new Error("user_metadata was read");
      },
    } as unknown as U;
    expect(() => isOperator(denied)).not.toThrow();
    expect(isOperator(denied)).toBe(false);
  });

  it("is false, and does not throw, when reading app_metadata throws", () => {
    const u = {
      get app_metadata(): never {
        throw new Error("boom");
      },
    } as unknown as U;
    expect(isOperator(u)).toBe(false);
  });
});

// The layout: a real 404 for everyone but operators, decided on the verified user.
const getVerifiedUser = vi.fn();
vi.mock("@/lib/supabase/server", () => ({ getVerifiedUser: () => getVerifiedUser() }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  redirect: () => {
    throw new Error("NEXT_REDIRECT");
  },
}));

describe("ops layout", () => {
  beforeEach(() => {
    getVerifiedUser.mockReset();
  });

  async function renderLayout() {
    const { default: OpsLayout } = await import("@/app/(app)/ops/layout");
    return OpsLayout({ children: "CHILD_MARKER" });
  }

  it("renders its children for an operator", async () => {
    getVerifiedUser.mockResolvedValue({ supabase: {}, user: user({ app_metadata: { ops: true } }) });
    const out = await renderLayout();
    expect(JSON.stringify(out)).toContain("CHILD_MARKER");
  });

  it.each([
    ["a signed-in user without the flag", { app_metadata: {} }],
    ["ops only in user_metadata", { app_metadata: {}, user_metadata: { ops: true } }],
    ["ops as the string \"true\"", { app_metadata: { ops: "true" } }],
    ["an anonymous demo user with the flag", { app_metadata: { ops: true }, is_anonymous: true }],
  ])("calls notFound() for %s", async (_label, over) => {
    getVerifiedUser.mockResolvedValue({ supabase: {}, user: user(over) });
    await expect(renderLayout()).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("calls notFound(), not redirect(), when there is no user (fail closed, no hint that /ops exists)", async () => {
    getVerifiedUser.mockResolvedValue({ supabase: {}, user: null });
    await expect(renderLayout()).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("never renders its children when verifying the user throws", async () => {
    getVerifiedUser.mockRejectedValue(new Error("auth down"));
    await expect(renderLayout()).rejects.toThrow();
  });
});
