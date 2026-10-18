// The client-visible Supabase config, read lazily so `next build` works without env.
// Refuses anything that looks like an admin credential; the error never contains it.

export interface PublicSupabaseEnv {
  url: string;
  publishableKey: string;
  siteUrl: string;
}

function jwtRole(key: string): string | null {
  const parts = key.split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (payload && typeof payload === "object" && "role" in payload) {
      const role = (payload as { role: unknown }).role;
      return typeof role === "string" ? role : "";
    }
    return "";
  } catch {
    return null;
  }
}

// Allowlist: a publishable key ("sb_publishable_...") or a legacy JWT with the anon role.
// Every other "sb_" key and every other JWT role is refused.
function assertPublishableKey(key: string): void {
  if (key.startsWith("sb_publishable_")) return;
  if (jwtRole(key) === "anon") return;
  throw new Error(
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY must be a publishable key or an anon JWT.",
  );
}

export function publicSupabaseEnv(): PublicSupabaseEnv {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL;
  if (!url || !publishableKey || !siteUrl) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY and NEXT_PUBLIC_SITE_URL must be set.",
    );
  }
  assertPublishableKey(publishableKey);
  return { url, publishableKey, siteUrl: siteUrl.replace(/\/+$/, "") };
}
