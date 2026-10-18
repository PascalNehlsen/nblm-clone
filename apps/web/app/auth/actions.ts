"use server";

import { redirect } from "next/navigation";
import { safeNextPath } from "@/lib/auth/redirect";
import { publicSupabaseEnv } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";

// Starts the GitHub login. The callback URL is built from NEXT_PUBLIC_SITE_URL, never
// from the request's Host header, and `next` is sanitized before it is passed on.
export async function signInWithGitHub(formData: FormData): Promise<void> {
  const next = safeNextPath(formData.get("next"));
  const { siteUrl } = publicSupabaseEnv();
  const supabase = await createClient();

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "github",
    options: { redirectTo: `${siteUrl}/auth/callback?next=${encodeURIComponent(next)}` },
  });
  if (error || !data.url) redirect("/login?fehler=anmeldung");
  redirect(data.url);
}

// Ends this browser's session only (scope local), not the user's other devices.
export async function signOut(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut({ scope: "local" });
  redirect("/login?fehler=abgemeldet");
}
