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

/** Signs up a brand-new local user and returns the auth cookies that session
 * produced, ready for `context.addCookies()` against http://127.0.0.1:3000. */
export async function seedLocalSession(label: string): Promise<SeededCookie[]> {
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
  if (error || !data.session) {
    throw new Error(
      `seedLocalSession(${label}): sign-up did not return a session (email confirmations must be ` +
        `off locally): ${error?.message ?? "no session in response"}`,
    );
  }

  return Array.from(jar.entries()).map(([name, value]) => ({
    name,
    value,
    domain: "127.0.0.1",
    path: "/",
  }));
}
