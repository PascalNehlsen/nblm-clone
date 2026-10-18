import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { signOut } from "@/app/auth/actions";
import { createClient } from "@/lib/supabase/server";

// Rendered per request: these pages depend on the session and are never prerendered.
export const dynamic = "force-dynamic";

// Every page in this group needs a session. getUser() asks the Auth server, so a
// revoked session is caught here even if the proxy's cookie check passed.
export default async function AppLayout({ children }: { children: ReactNode }) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) redirect("/login");

  return (
    <>
      <form action={signOut}>
        <button type="submit">Abmelden</button>
      </form>
      {children}
    </>
  );
}
