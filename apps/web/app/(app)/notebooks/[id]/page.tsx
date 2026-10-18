import { notFound, redirect } from "next/navigation";
import { deleteNotebookAction } from "../actions";
import { MemberList } from "./member-list";
import { notebookErrorMessage } from "@/lib/notebooks/errors";
import { listMembers } from "@/lib/notebooks/members";
import { getNotebook } from "@/lib/notebooks/notebooks";
import { ROLE_LABELS, isUuid } from "@/lib/notebooks/roles";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Notizbuch" };

export default async function NotebookPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const { fehler } = await searchParams;
  if (!isUuid(id)) notFound();

  // Checked here too, not only in the layout (ADR 0005).
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) redirect("/login");

  const notebook = await getNotebook(supabase, id, data.user.id);
  if (!notebook) notFound();
  const members = await listMembers(supabase, id);

  return (
    <main>
      <h1>{notebook.title}</h1>
      <p>Deine Rolle: {ROLE_LABELS[notebook.role]}</p>
      {fehler ? <p role="alert">{notebookErrorMessage(fehler)}</p> : null}
      <MemberList
        members={members}
        currentUserId={data.user.id}
        myRole={notebook.role}
        notebookId={notebook.id}
        isAnonymous={data.user.is_anonymous ?? false}
      />
      {notebook.role === "owner" ? (
        <form action={deleteNotebookAction}>
          <input type="hidden" name="notebookId" value={notebook.id} />
          <label>
            <input type="checkbox" name="confirm" required /> Ich möchte dieses Notizbuch
            endgültig löschen
          </label>{" "}
          <button type="submit">Notizbuch löschen</button>
        </form>
      ) : null}
    </main>
  );
}
