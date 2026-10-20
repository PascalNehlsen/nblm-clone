import "server-only";

// Account deletion's admin call (ADR 0021): the second module that holds the service_role
// key, next to admin/usage.ts (ADR 0006). It deletes exactly one auth user, by an id the
// caller took from the verified session, and only lib/server/account/delete-account.ts may
// import it (eslint.config.mjs). Same key rules as usage.ts: only a secret key or a
// service_role JWT, a missing key fails closed before any request, and errors carry fixed
// messages: never the key, the id or a response body.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function jwtRole(key: string): string | null {
  const parts = key.split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (payload && typeof payload === "object" && "role" in payload) {
      const role = (payload as { role: unknown }).role;
      return typeof role === "string" ? role : null;
    }
    return null;
  } catch {
    return null;
  }
}

// Allowlist: a secret key ("sb_secret_...") or a legacy JWT with the service_role role.
function isSecretKey(key: string): boolean {
  return key.startsWith("sb_secret_") || jwtRole(key) === "service_role";
}

function config(): { url: string; key: string } | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key || !isSecretKey(key)) return null;
  return { url: url.replace(/\/+$/, ""), key };
}

// Whether deleteAuthUser can work at all. Asked before anything is deleted, so a deployment
// without the key (Preview) deletes nothing. Never throws, never makes a request.
export function adminConfigured(): boolean {
  return config() !== null;
}

// Hard delete: the user's sessions, identities and every row that cascades from auth.users.
export async function deleteAuthUser(userId: string): Promise<void> {
  const c = config();
  if (!c) throw new Error("account admin unavailable: not configured");
  if (typeof userId !== "string" || !UUID.test(userId)) throw new Error("account admin: invalid user id");
  let response: Response;
  try {
    response = await fetch(`${c.url}/auth/v1/admin/users/${userId}`, {
      method: "DELETE",
      headers: { apikey: c.key, authorization: `Bearer ${c.key}`, "content-type": "application/json" },
      body: JSON.stringify({ should_soft_delete: false }),
    });
  } catch {
    throw new Error("account admin: delete failed");
  }
  if (!response.ok) throw new Error("account admin: delete failed");
}
