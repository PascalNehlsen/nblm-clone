import { redirect } from "next/navigation";
import { CopyIdButton } from "./copy-id-button";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Profil" };

// Sharing works by user id: the invitee copies it here and sends it to the owner. No
// email lookup or user directory. Demo users (anonymous) see no id: they cannot be
// members of other notebooks (enforced in PR F).
export default async function ProfilePage() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) redirect("/login");

  return (
    <main>
      <h1>Profil</h1>
      {data.user.is_anonymous ? (
        <p>Im Demo-Zugang kannst du keine Notizbücher geteilt bekommen.</p>
      ) : (
        <>
          <p>Deine Nutzer-ID zum Teilen:</p>
          <p>
            <code data-testid="nutzer-id">{data.user.id}</code> <CopyIdButton value={data.user.id} />
          </p>
        </>
      )}
    </main>
  );
}
