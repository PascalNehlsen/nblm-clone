import type { ReactNode } from "react";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { signOut } from "@/app/auth/actions";
import { REQUEST_PATH_HEADER } from "@/lib/auth/paths";
import { safeNextPath } from "@/lib/auth/redirect";
import { getVerifiedUser } from "@/lib/supabase/server";

// Rendered per request: these pages depend on the session and are never prerendered.
export const dynamic = "force-dynamic";

// Every page in this group needs a session. getUser() asks the Auth server, so a
// revoked session is caught here even if the proxy's cookie check passed.
export default async function AppLayout({ children }: { children: ReactNode }) {
  const { user } = await getVerifiedUser();
  if (!user) {
    // The proxy sets this header on every request; sanitized like any `next`.
    const next = safeNextPath((await headers()).get(REQUEST_PATH_HEADER));
    redirect(`/login?next=${encodeURIComponent(next)}`);
  }

  return (
    <>
      <nav className="account" aria-label="Konto">
        <Link href="/profil" className="icon-link" aria-label="Profil">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
            <circle cx="12" cy="8" r="4" stroke="currentColor" strokeWidth="1.7" />
            <path d="M4 20c1.5-3.6 4.4-5.5 8-5.5s6.5 1.9 8 5.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
          </svg>
          <span role="tooltip" className="tip">
            Profil
          </span>
        </Link>
        <form action={signOut}>
          <button type="submit" className="quiet">
            Abmelden
          </button>
        </form>
      </nav>
      {children}
    </>
  );
}
