import Link from "next/link";
import { redirect } from "next/navigation";
import { CopyIdButton } from "./copy-id-button";
import { DeleteAccount } from "./delete-account";
import { soleOwnedNotebooks } from "@/lib/server/account/delete-account";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Profil" };

// Sharing works by user id: the invitee copies it here and sends it to the owner. No
// email lookup or user directory. Demo users (anonymous) see no id: they cannot be
// members of other notebooks (enforced in PR F).
const ERRORS: Record<string, string> = {
  konto_loeschen: "Das Konto konnte nicht gelöscht werden.",
  bestaetigung: "Bitte bestätige das Löschen im Dialog.",
};

export default async function ProfilePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) redirect("/login");
  const fehler = (await searchParams).fehler;
  const error = typeof fehler === "string" ? ERRORS[fehler] : undefined;

  // What the deletion dialog has to name: notebooks the user owns alone, and how many of
  // them have other members (who lose access).
  const sole = await soleOwnedNotebooks(supabase, data.user.id).catch(() => [] as string[]);
  let shared = 0;
  if (sole.length > 0) {
    const { data: others } = await supabase
      .from("notebook_members")
      .select("notebook_id")
      .in("notebook_id", sole.slice(0, 1000))
      .neq("user_id", data.user.id);
    shared = new Set((others ?? []).map((m: { notebook_id: string }) => m.notebook_id)).size;
  }

  return (
    <main id="inhalt" className="page">
      <Link href="/" className="back">
        Alle Notizbücher
      </Link>
      <h1>Profil</h1>
      {data.user.is_anonymous ? (
        <p>Im Demo-Zugang kannst du keine Notizbücher geteilt bekommen.</p>
      ) : (
        <>
          <p>Deine Nutzer-ID zum Teilen:</p>
          <p className="id-card">
            <code data-testid="nutzer-id">{data.user.id}</code> <CopyIdButton value={data.user.id} />
          </p>
        </>
      )}
      {error ? <p role="alert">{error}</p> : null}
      <DeleteAccount anonymous={data.user.is_anonymous === true} sole={sole.length} shared={shared} />
    </main>
  );
}
