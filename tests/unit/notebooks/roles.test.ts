// PR B2: small pure helpers used by the notebooks UI and server actions.
// canManageMembers gates every member-management control (MemberList,
// share/role-change/remove forms); ASSIGNABLE_ROLES is what a share/role-
// change form may offer (never "owner" -- promotion to owner is not a thing
// an inviter does, only guard_last_owner-aware membership updates); isUuid
// and validateTitle are the input guards the server actions run before ever
// touching the database (AGENTS.md: actions validate input, RLS is the
// second line of defense, not the first).
import { describe, expect, it } from "vitest";
import { ASSIGNABLE_ROLES, canManageMembers, isUuid, validateTitle } from "@/lib/notebooks/roles";

describe("canManageMembers", () => {
  it("is true only for the owner role", () => {
    expect(canManageMembers("owner")).toBe(true);
  });

  it("is false for editor, viewer, null, empty and unknown strings", () => {
    expect(canManageMembers("editor")).toBe(false);
    expect(canManageMembers("viewer")).toBe(false);
    expect(canManageMembers(null)).toBe(false);
    expect(canManageMembers("")).toBe(false);
    expect(canManageMembers("owners")).toBe(false);
    expect(canManageMembers("Owner")).toBe(false);
  });
});

describe("ASSIGNABLE_ROLES", () => {
  it("is exactly editor and viewer, in that order", () => {
    expect(ASSIGNABLE_ROLES).toEqual(["editor", "viewer"]);
  });

  it("never offers owner (promotion to owner is not part of the share/role-change UI)", () => {
    expect(ASSIGNABLE_ROLES).not.toContain("owner");
  });
});

describe("isUuid", () => {
  it("accepts a v4 uuid", () => {
    expect(isUuid("3fa85f64-5717-4562-b3fc-2c963f66afa6")).toBe(true);
  });

  it("rejects the empty string and obvious garbage", () => {
    expect(isUuid("")).toBe(false);
    expect(isUuid("x")).toBe(false);
    expect(isUuid("not-a-uuid")).toBe(false);
  });

  it("rejects a uuid-shaped value containing a space", () => {
    // Same length as a real uuid, but a hex digit replaced by a space --
    // must not be accepted by a check that merely counts characters/dashes.
    expect(isUuid(" fa85f64-5717-4562-b3fc-2c963f66afa6")).toBe(false);
    expect(isUuid("3fa85f64-5717-4562-b3fc-2c963f66afa6 ")).toBe(false);
    expect(isUuid("3fa85f64-5717-4562-b3fc-2c963f66af a6")).toBe(false);
  });

  it("rejects non-string values", () => {
    expect(isUuid(null)).toBe(false);
    expect(isUuid(undefined)).toBe(false);
    expect(isUuid(42)).toBe(false);
    expect(isUuid(true)).toBe(false);
    expect(isUuid({})).toBe(false);
    expect(isUuid([])).toBe(false);
    expect(isUuid(["3fa85f64-5717-4562-b3fc-2c963f66afa6"])).toBe(false);
  });
});

describe("validateTitle", () => {
  it("trims surrounding whitespace", () => {
    expect(validateTitle("  Mein Notizbuch  ")).toBe("Mein Notizbuch");
  });

  it("rejects an empty or whitespace-only title", () => {
    expect(validateTitle("")).toBeNull();
    expect(validateTitle("   ")).toBeNull();
    expect(validateTitle("\t\n")).toBeNull();
  });

  it("rejects a title over 200 characters (after trimming)", () => {
    expect(validateTitle("a".repeat(201))).toBeNull();
    // Padding that trims away must not rescue an over-long title.
    expect(validateTitle(`  ${"a".repeat(201)}  `)).toBeNull();
  });

  it("rejects non-string input", () => {
    expect(validateTitle(null)).toBeNull();
    expect(validateTitle(undefined)).toBeNull();
    expect(validateTitle(42)).toBeNull();
    expect(validateTitle({})).toBeNull();
    expect(validateTitle([])).toBeNull();
  });

  it("accepts exactly 1 and exactly 200 characters", () => {
    expect(validateTitle("a")).toBe("a");
    const longTitle = "a".repeat(200);
    expect(validateTitle(longTitle)).toBe(longTitle);
  });
});

describe("lib/notebooks internal imports are relative, not \"@/...\"", () => {
  // The vitest "rls" project (tests/rls/**) imports these lib modules
  // directly by relative path and has no "@" alias configured (only the
  // "unit" project does, see vitest.config.ts) -- so if notebooks.ts or
  // members.ts imported a sibling module (e.g. roles.ts, errors.ts) through
  // the "@/..." alias instead of a relative path, loading them from
  // tests/rls/app-notebooks.test.ts would fail to resolve that inner import
  // even though the exact same file resolves fine from a "unit" test. This
  // guards the contract between the two vitest projects, not just style.
  it("apps/web/lib/notebooks/*.ts never imports a sibling module through the \"@/\" alias", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const dir = path.resolve(import.meta.dirname, "../../../apps/web/lib/notebooks");

    expect(fs.existsSync(dir), "apps/web/lib/notebooks is missing").toBe(true);

    const offenders: string[] = [];
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".ts")) continue;
      const content = fs.readFileSync(path.join(dir, name), "utf8");
      if (/from\s+["']@\/lib\/notebooks\//.test(content)) {
        offenders.push(name);
      }
    }
    expect(offenders).toEqual([]);
  });
});
