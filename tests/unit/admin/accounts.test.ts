// Account deletion: lib/server/admin/accounts.ts is the second module that holds the
// service_role key (next to admin/usage.ts, ADR 0006). Same rules as usage.ts: only a
// secret key / service_role JWT is accepted, a missing or wrong key fails closed before any
// request, and no error message carries the key or a response body.
//
// Contract pinned here (the plan said "exports only deleteAuthUser"; it also needs a way to
// ask whether the key is usable BEFORE any notebook is deleted, and this module is the only
// one allowed to look at the key, so it exports exactly two functions):
//   - deleteAuthUser(userId): Promise<void>   DELETE /auth/v1/admin/users/<id>, hard delete
//   - adminConfigured(): boolean              true only for URL + a key that passes the same
//                                             allowlist as usage.ts; never throws, never
//                                             makes a request
//
// vi.resetModules() + a dynamic import per test: the admin client is created lazily and
// cached, and supabase-js resolves `fetch` when it is first loaded (same as usage.test.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Built at runtime so a secret scanner does not flag fake fixtures. None are real keys.
const SECRET_KEY = ["sb", "secret", "accounts", "fixture"].join("_");
const ANOTHER_SECRET_KEY_FIXTURE = ["sb", "secret", "another", "fixture"].join("_");
const PUBLISHABLE_KEY_FIXTURE = ["sb", "publishable", "accounts", "fixture"].join("_");
const SUPABASE_URL = "http://127.0.0.1:54321";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_USER_ID = "22222222-2222-4222-8222-222222222222";

function base64url(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function fakeJwt(role: string): string {
  return `${base64url({ alg: "HS256", typ: "JWT" })}.${base64url({ role })}.sig`;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function loadAccounts() {
  vi.resetModules();
  return import("@/lib/server/admin/accounts");
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", SUPABASE_URL);
  vi.stubEnv("SUPABASE_SECRET_KEY", SECRET_KEY);
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.SUPABASE_SECRET_KEY;
});

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// The message of the rejection; fails the test if the promise resolved (a try/catch around
// expect.unreachable would swallow that failure).
async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  const outcome = await promise.then(
    () => ({ rejected: false as const }),
    (error: unknown) => ({ rejected: true as const, message: messageOf(error) }),
  );
  expect(outcome.rejected, "expected the call to reject").toBe(true);
  return outcome.rejected ? outcome.message : "";
}

describe("module surface", () => {
  it("exports exactly adminConfigured and deleteAuthUser", async () => {
    const mod = await loadAccounts();
    expect(Object.keys(mod).sort()).toEqual(["adminConfigured", "deleteAuthUser"]);
  });
});

describe("deleteAuthUser", () => {
  it("sends exactly one DELETE to /auth/v1/admin/users/<exactly that id>, as a hard delete", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ id: USER_ID }));
    const { deleteAuthUser } = await loadAccounts();

    await expect(deleteAuthUser(USER_ID)).resolves.toBeUndefined();

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(fetch).mock.calls[0] ?? [];
    expect(String(url)).toBe(`${SUPABASE_URL}/auth/v1/admin/users/${USER_ID}`);
    expect((init as RequestInit | undefined)?.method).toBe("DELETE");
    const rawBody = (init as RequestInit | undefined)?.body;
    if (rawBody) {
      // A soft delete would keep the row, and with it the email, which is personal data.
      const body = JSON.parse(String(rawBody)) as { should_soft_delete?: unknown };
      expect(body.should_soft_delete).not.toBe(true);
    }
  });

  it("uses the id it was given, not a fixed or remembered one", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({}));
    const { deleteAuthUser } = await loadAccounts();

    await deleteAuthUser(USER_ID);
    await deleteAuthUser(OTHER_USER_ID);

    const urls = vi.mocked(fetch).mock.calls.map(([url]) => String(url));
    expect(urls).toEqual([
      `${SUPABASE_URL}/auth/v1/admin/users/${USER_ID}`,
      `${SUPABASE_URL}/auth/v1/admin/users/${OTHER_USER_ID}`,
    ]);
  });

  it("carries the secret key in the apikey and Authorization headers", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({}));
    const { deleteAuthUser } = await loadAccounts();

    await deleteAuthUser(USER_ID);

    const [, init] = vi.mocked(fetch).mock.calls[0] ?? [];
    const headers = new Headers((init as RequestInit | undefined)?.headers);
    expect(headers.get("apikey")).toBe(SECRET_KEY);
    expect(headers.get("authorization")).toBe(`Bearer ${SECRET_KEY}`);
  });

  it.each(["", "not-a-uuid", "../../auth/v1/admin/users", `${USER_ID}/../${OTHER_USER_ID}`, `${USER_ID}?x=1`])(
    "rejects the id %j before any request (never builds a URL from free text)",
    async (badId) => {
      vi.mocked(fetch).mockResolvedValue(jsonResponse({}));
      const { deleteAuthUser } = await loadAccounts();

      await expect(deleteAuthUser(badId)).rejects.toThrow();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("an HTTP error throws with neither the key nor the response body in the message", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("upstream exploded: sensitive-auth-detail-31", { status: 500 }));
    const { deleteAuthUser } = await loadAccounts();

    const message = await rejectionMessage(deleteAuthUser(USER_ID));
    expect(message).not.toContain(SECRET_KEY);
    expect(message).not.toContain("sensitive-auth-detail-31");
    expect(message).not.toContain(USER_ID);
  });

  it("a network error throws with the key never in the message", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error(`fetch failed while using key ${SECRET_KEY}`));
    const { deleteAuthUser } = await loadAccounts();

    expect(await rejectionMessage(deleteAuthUser(USER_ID))).not.toContain(SECRET_KEY);
  });

  it("error messages are fixed: a different response body or a network error gives the same message", async () => {
    const messages: string[] = [];
    const attempts: Array<() => void> = [
      () => vi.mocked(fetch).mockResolvedValue(new Response("body-one-aaaa", { status: 500 })),
      () => vi.mocked(fetch).mockResolvedValue(new Response("body-two-bbbb", { status: 500 })),
      () => vi.mocked(fetch).mockRejectedValue(new Error("boom-cccc")),
    ];
    for (const arrange of attempts) {
      arrange();
      const { deleteAuthUser } = await loadAccounts();
      messages.push(await rejectionMessage(deleteAuthUser(USER_ID)));
    }
    expect(messages).toHaveLength(3);
    expect(new Set(messages).size).toBe(1);
    expect(messages[0]).not.toMatch(/aaaa|bbbb|cccc/);
  });
});

describe("fails closed without a usable secret key", () => {
  it("a missing SUPABASE_SECRET_KEY throws before any fetch", async () => {
    delete process.env.SUPABASE_SECRET_KEY;
    const { deleteAuthUser } = await loadAccounts();

    await expect(deleteAuthUser(USER_ID)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("a missing NEXT_PUBLIC_SUPABASE_URL throws before any fetch", async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    const { deleteAuthUser } = await loadAccounts();

    await expect(deleteAuthUser(USER_ID)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("a publishable key throws before any fetch, without echoing it", async () => {
    vi.stubEnv("SUPABASE_SECRET_KEY", PUBLISHABLE_KEY_FIXTURE);
    const { deleteAuthUser } = await loadAccounts();

    expect(await rejectionMessage(deleteAuthUser(USER_ID))).not.toContain(PUBLISHABLE_KEY_FIXTURE);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["anon", "authenticated"])("a %s-role JWT throws before any fetch", async (role) => {
    vi.stubEnv("SUPABASE_SECRET_KEY", fakeJwt(role));
    const { deleteAuthUser } = await loadAccounts();

    await expect(deleteAuthUser(USER_ID)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("a service_role JWT is accepted and reaches fetch", async () => {
    vi.stubEnv("SUPABASE_SECRET_KEY", fakeJwt("service_role"));
    vi.mocked(fetch).mockResolvedValue(jsonResponse({}));
    const { deleteAuthUser } = await loadAccounts();

    await deleteAuthUser(USER_ID);

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("an sb_secret_ key is accepted and reaches fetch", async () => {
    vi.stubEnv("SUPABASE_SECRET_KEY", ANOTHER_SECRET_KEY_FIXTURE);
    vi.mocked(fetch).mockResolvedValue(jsonResponse({}));
    const { deleteAuthUser } = await loadAccounts();

    await deleteAuthUser(USER_ID);

    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("adminConfigured", () => {
  it("is true for an sb_secret_ key and for a service_role JWT", async () => {
    let mod = await loadAccounts();
    expect(mod.adminConfigured()).toBe(true);

    vi.stubEnv("SUPABASE_SECRET_KEY", fakeJwt("service_role"));
    mod = await loadAccounts();
    expect(mod.adminConfigured()).toBe(true);
  });

  it.each([
    ["a missing key", () => delete process.env.SUPABASE_SECRET_KEY],
    ["an empty key", () => vi.stubEnv("SUPABASE_SECRET_KEY", "")],
    ["a publishable key", () => vi.stubEnv("SUPABASE_SECRET_KEY", PUBLISHABLE_KEY_FIXTURE)],
    ["an anon-role JWT", () => vi.stubEnv("SUPABASE_SECRET_KEY", fakeJwt("anon"))],
    ["an authenticated-role JWT", () => vi.stubEnv("SUPABASE_SECRET_KEY", fakeJwt("authenticated"))],
    ["a missing URL", () => delete process.env.NEXT_PUBLIC_SUPABASE_URL],
  ])("is false for %s, without throwing and without a request", async (_label, arrange) => {
    arrange();
    const { adminConfigured } = await loadAccounts();

    expect(adminConfigured()).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
});
