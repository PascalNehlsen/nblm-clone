import { createBrowserClient } from "@supabase/ssr";

// The browser client (block F2): only the two public values, which Next inlines at build
// time. The demo sign-in runs in the browser so Supabase's per-IP limit counts the visitor,
// not Vercel's egress addresses (ADR 0012).
export function createBrowserSupabase() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "",
  );
}
