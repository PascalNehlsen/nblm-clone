import "server-only";

import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { isPublicPath } from "../auth/paths";
import { publicSupabaseEnv } from "./env";

// Refreshes the session cookie on every matched request and keeps logged-out users on
// public routes. A fast first check only: pages and actions call getUser() again.
export async function updateSession(request: NextRequest): Promise<NextResponse> {
  const { url, publishableKey, siteUrl } = publicSupabaseEnv();
  let response = NextResponse.next({ request });
  // Cache headers that @supabase/ssr sends with refreshed auth cookies, so no shared
  // cache stores one user's session for another.
  let cacheHeaders: Record<string, string> = {};
  const pendingCookies = new Map<string, { value: string; options: CookieOptions }>();

  const supabase = createServerClient(url, publishableKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      // @supabase/ssr may call this more than once per request, with the cache headers
      // only on the first call, so cookies and headers accumulate across calls.
      setAll(cookiesToSet, headers) {
        for (const { name, value, options } of cookiesToSet) {
          request.cookies.set(name, value);
          pendingCookies.set(name, { value, options });
        }
        cacheHeaders = { ...cacheHeaders, ...headers };
        response = NextResponse.next({ request });
        for (const [name, { value, options }] of pendingCookies) {
          response.cookies.set(name, value, options);
        }
        for (const [name, value] of Object.entries(cacheHeaders)) {
          response.headers.set(name, value);
        }
      },
    },
  });

  // getClaims() verifies the JWT and refreshes an expired session; nothing may run
  // between creating the client and this call.
  const { data } = await supabase.auth.getClaims();
  const loggedIn = Boolean(data?.claims);
  const { pathname, search } = request.nextUrl;

  if (!loggedIn && !isPublicPath(pathname)) {
    return redirectKeepingSession(response, cacheHeaders, siteUrl, "/login", {
      next: pathname + search,
    });
  }
  if (loggedIn && pathname === "/login") {
    return redirectKeepingSession(response, cacheHeaders, siteUrl, "/", {});
  }
  return response;
}

// Redirects on the configured site origin, never the request's Host header, and keeps
// the refreshed cookies and their cache headers.
function redirectKeepingSession(
  response: NextResponse,
  cacheHeaders: Record<string, string>,
  siteUrl: string,
  pathname: string,
  params: Record<string, string>,
): NextResponse {
  const target = new URL(pathname, siteUrl);
  target.search = new URLSearchParams(params).toString();
  const redirect = NextResponse.redirect(target);
  for (const cookie of response.cookies.getAll()) redirect.cookies.set(cookie);
  for (const [name, value] of Object.entries(cacheHeaders)) redirect.headers.set(name, value);
  return redirect;
}
