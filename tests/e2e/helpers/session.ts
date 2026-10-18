// Seeds a real, local, freshly-created email/password session so a Playwright
// test can start "already logged in" without ever driving the GitHub OAuth
// round trip. Uses the exact same guarded local-only config as the RLS
// harness (tests/rls/helpers/clients.ts): no service role, no JWT signing
// secret, loopback host only (assertLocalHost/assertAnonKey run inside
// supabaseLocalConfig()).
//
// createServerClient() from @supabase/ssr needs a cookie "jar" to read from
// and write to; here that jar is a plain in-memory Map standing in for the
// browser. After sign-up, whatever it wrote to the jar is exactly what a
// browser would have received as Set-Cookie headers, so those name/value
// pairs can be handed to `context.addCookies()` directly.
import { randomUUID } from "node:crypto";
import { createServerClient, type CookieMethodsServer } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseLocalConfig } from "../../rls/helpers/clients";

export interface SeededCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
}

function randomPassword(): string {
  // Local minimum_password_length = 6 (supabase/config.toml); well above that.
  return `Aa1!${randomUUID()}`;
}

export interface SeededSession {
  cookies: SeededCookie[];
  /** The same signed-in user's own SupabaseClient, independent of the
   * cookie jar handed to the browser -- useful for a test to read back
   * database state as that user after the browser's own session has moved
   * on (e.g. after the browser signs out), without ever using the
   * admin/service-role credential. */
  client: SupabaseClient;
  userId: string;
}

/** Signs up a brand-new local user and returns both the auth cookies that
 * session produced (ready for `context.addCookies()` against
 * http://127.0.0.1:3000) and the signed-in client/user id, for tests that
 * need to assert on database state as that same user. */
export async function seedLocalSessionWithClient(label: string): Promise<SeededSession> {
  const { url, anonKey } = supabaseLocalConfig();
  const jar = new Map<string, string>();

  const cookieMethods: CookieMethodsServer = {
    getAll() {
      return Array.from(jar.entries()).map(([name, value]) => ({ name, value }));
    },
    setAll(cookiesToSet) {
      for (const { name, value } of cookiesToSet) {
        jar.set(name, value);
      }
    },
  };

  const client = createServerClient(url, anonKey, { cookies: cookieMethods });

  const email = `${label}-${randomUUID()}@example.test`;
  const password = randomPassword();

  const { data, error } = await client.auth.signUp({ email, password });
  if (error || !data.session || !data.user) {
    throw new Error(
      `seedLocalSessionWithClient(${label}): sign-up did not return a session (email confirmations must be ` +
        `off locally): ${error?.message ?? "no session/user in response"}`,
    );
  }

  const cookies = Array.from(jar.entries()).map(([name, value]) => ({
    name,
    value,
    domain: "127.0.0.1",
    path: "/",
  }));

  return { cookies, client, userId: data.user.id };
}

/** Signs up a brand-new local user and returns the auth cookies that session
 * produced, ready for `context.addCookies()` against http://127.0.0.1:3000. */
export async function seedLocalSession(label: string): Promise<SeededCookie[]> {
  const { cookies } = await seedLocalSessionWithClient(label);
  return cookies;
}
