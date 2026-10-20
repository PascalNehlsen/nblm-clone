import type { NextRequest } from "next/server";
import { gameDayFault, gameDayResponse } from "./lib/server/game-day";
import { updateSession } from "./lib/supabase/proxy";

export async function proxy(request: NextRequest) {
  // Game day (ADR 0025): off unless GAME_DAY_FAULT=live-login is set for this deployment.
  if (
    gameDayFault({
      env: process.env.GAME_DAY_FAULT,
      siteUrl: process.env.NEXT_PUBLIC_SITE_URL,
      host: request.headers.get("host"),
      pathname: request.nextUrl.pathname,
    })
  ) {
    console.warn("game day fault: live-login");
    return gameDayResponse();
  }
  return updateSession(request);
}

// Everything except build assets and static images.
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon\\.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
