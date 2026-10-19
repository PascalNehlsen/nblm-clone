"use server";

import { randomUUID } from "node:crypto";
import { redirect } from "next/navigation";
import { startDemoCore } from "@/lib/auth/demo";
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

// Called by the demo button right after the browser's anonymous sign-in. Everything runs
// with the user's own session; the copy happens in the database (ADR 0012).
export async function startDemo(): Promise<void> {
  const supabase = await createClient();
  const outcome = await startDemoCore({
    getUser: async () => {
      const { data } = await supabase.auth.getUser();
      return data.user ? { id: data.user.id, isAnonymous: data.user.is_anonymous ?? false } : null;
    },
    firstNotebookId: async () => {
      const { data } = await supabase
        .from("notebooks")
        .select("id")
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle<{ id: string }>();
      return data?.id ?? null;
    },
    // A client-generated id, as in lib/notebooks: the row is readable only once the owner
    // trigger has run, so the insert does not read it back.
    createNotebook: async (title) => {
      const id = randomUUID();
      const { error } = await supabase.from("notebooks").insert({ id, title });
      if (error) return { error: error.message ?? "fehler" };
      return { id };
    },
  });
  redirect(outcome.redirect);
}
