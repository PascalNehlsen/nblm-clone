import { NextResponse, type NextRequest } from "next/server";
import { safeNextPath } from "@/lib/auth/redirect";
import { publicSupabaseEnv } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";

// OAuth callback (PKCE): exchanges the code for a session cookie, then continues to the
// sanitized `next` path on the configured site origin, never the Host header.
export async function GET(request: NextRequest): Promise<NextResponse> {
  const { siteUrl } = publicSupabaseEnv();
  const code = request.nextUrl.searchParams.get("code");
  const next = safeNextPath(request.nextUrl.searchParams.get("next"));

  let target = new URL("/login?fehler=anmeldung", siteUrl);
  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) target = new URL(next, siteUrl);
  }
  // The exchange sets session cookies on this response: no shared cache may keep it.
  const response = NextResponse.redirect(target);
  response.headers.set("Cache-Control", "private, no-cache, no-store, must-revalidate, max-age=0");
  return response;
}
