import type { ReactNode } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { signOut } from "@/app/auth/actions";
import { REQUEST_PATH_HEADER } from "@/lib/auth/paths";
import { safeNextPath } from "@/lib/auth/redirect";
import { createClient } from "@/lib/supabase/server";

// Rendered per request: these pages depend on the session and are never prerendered.
export const dynamic = "force-dynamic";

// Every page in this group needs a session. getUser() asks the Auth server, so a
// revoked session is caught here even if the proxy's cookie check passed.
export default async function AppLayout({ children }: { children: ReactNode }) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) {
    // The proxy sets this header on every request; sanitized like any `next`.
    const next = safeNextPath((await headers()).get(REQUEST_PATH_HEADER));
    redirect(`/login?next=${encodeURIComponent(next)}`);
  }

  return (
    <>
      <form action={signOut} className="signout">
        <button type="submit" className="quiet">
          Abmelden
        </button>
      </form>
      {children}
    </>
  );
}
