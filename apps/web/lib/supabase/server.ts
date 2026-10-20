import "server-only";

import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { cache } from "react";
import { publicSupabaseEnv } from "./env";

// The user's client for server components, server actions and route handlers. Every
// query runs under the user's JWT, so RLS applies. Never the service role.
export async function createClient(): Promise<SupabaseClient> {
  // Reading cookies first marks the route as dynamic before the env is checked.
  const cookieStore = await cookies();
  const { url, publishableKey } = publicSupabaseEnv();

  return createServerClient(url, publishableKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Server components cannot set cookies; the proxy refreshes the session.
        }
      },
    },
  });
}

// The signed-in user, checked with the Auth server (getUser, not just the cookie), once per
// request: the (app) layout and the page both need it, and React's cache() shares the
// result within one render instead of a second round trip. The page still checks (ADR 0005).
export const getVerifiedUser = cache(async () => {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  return { supabase, user: data.user };
});
