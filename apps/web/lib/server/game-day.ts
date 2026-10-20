import "server-only";

// The game day fault switch (ADR 0025, runbook game-day.md). With GAME_DAY_FAULT=live-login
// set in Vercel (nblm-web, Production only), every request to /login on the site's own domain
// answers 500.
// The release's staged smoke and canary use the *.vercel.app deployment URL and pass, the live
// smoke on the domain fails, and release.yml rolls back by itself. Off for any other value, any
// other host or path, or a missing site URL; never throws.

export function gameDayFault(input: {
  env: string | undefined;
  siteUrl: string | undefined;
  host: string | null;
  pathname: string;
}): boolean {
  if (input.env !== "live-login" || input.pathname !== "/login" || !input.host || !input.siteUrl) return false;
  let siteHost: string;
  try {
    siteHost = new URL(input.siteUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  const host = input.host.toLowerCase().replace(/:\d+$/, "");
  return host === siteHost;
}

export function gameDayResponse(): Response {
  return new Response("Vorübergehend nicht verfügbar.", {
    status: 500,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}
