// PR E2: the only place the server derives a VerifiedUser from the real Auth
// server. Same mocking technique as tests/unit/web-shell.test.tsx and
// tests/unit/auth/callback.test.ts: vi.mock the module so caller.ts's own
// `import { createClient } from "@/lib/supabase/server"` resolves to this fake.
import { afterEach, describe, expect, it, vi } from "vitest";

const getUserMock = vi.fn();
const getClaimsMock = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: {
      getUser: getUserMock,
      getClaims: getClaimsMock,
    },
  })),
}));

import { getVerifiedUser } from "@/lib/server/model/caller";
import { createClient } from "@/lib/supabase/server";

afterEach(() => {
  vi.clearAllMocks();
});

describe("getVerifiedUser", () => {
  it("is_anonymous: true maps to isAnonymous: true", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "u1", is_anonymous: true } }, error: null });
    await expect(getVerifiedUser()).resolves.toEqual({ id: "u1", isAnonymous: true });
  });

  it("is_anonymous: false maps to isAnonymous: false", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "u2", is_anonymous: false } }, error: null });
    await expect(getVerifiedUser()).resolves.toEqual({ id: "u2", isAnonymous: false });
  });

  it("a missing is_anonymous field defaults to isAnonymous: true (fail closed toward anonymous limits)", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "u3" } }, error: null });
    await expect(getVerifiedUser()).resolves.toEqual({ id: "u3", isAnonymous: true });
  });

  it("an Auth error returns null", async () => {
    getUserMock.mockResolvedValue({ data: { user: null }, error: new Error("auth down") });
    await expect(getVerifiedUser()).resolves.toBeNull();
  });

  it("no user (no error, but no user either) returns null", async () => {
    getUserMock.mockResolvedValue({ data: { user: null }, error: null });
    await expect(getVerifiedUser()).resolves.toBeNull();
  });

  it("createClient throwing (e.g. outside a request context) returns null", async () => {
    vi.mocked(createClient).mockRejectedValueOnce(new Error("no cookies here"));
    await expect(getVerifiedUser()).resolves.toBeNull();
  });

  it("getUser throwing returns null", async () => {
    getUserMock.mockRejectedValueOnce(new Error("network blip"));
    await expect(getVerifiedUser()).resolves.toBeNull();
  });

  it("never calls getClaims (ADR/approved API: getUser only)", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "u4", is_anonymous: false } }, error: null });
    await getVerifiedUser();
    expect(getClaimsMock).not.toHaveBeenCalled();
  });
});
