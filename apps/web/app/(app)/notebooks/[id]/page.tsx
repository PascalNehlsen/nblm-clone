import { notFound, redirect } from "next/navigation";
import { deleteNotebookAction } from "../actions";
import { AddSource } from "./add-source";
import { Chat } from "./chat";
import { MemberList } from "./member-list";
import { SourceList } from "./source-list";
import { listHistory } from "@/lib/chat/history";
import { notebookErrorMessage } from "@/lib/notebooks/errors";
import { listMembers } from "@/lib/notebooks/members";
import { getNotebook } from "@/lib/notebooks/notebooks";
import { ROLE_LABELS, isUuid } from "@/lib/notebooks/roles";
import { listSources } from "@/lib/sources/sources";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Notizbuch" };

// Ingestion runs inline in the server actions of this page (ADR 0007).
export const maxDuration = 300;

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
  const sources = await listSources(supabase, id);
  // A failing history query must not take the notebook page down.
  let history: Awaited<ReturnType<typeof listHistory>> = [];
  let historyFailed = false;
  try {
    history = await listHistory(supabase, id);
  } catch {
    historyFailed = true;
  }
  const canEditSources =
    (notebook.role === "owner" || notebook.role === "editor") && !(data.user.is_anonymous ?? false);

  return (
    <main>
      {data.user.is_anonymous ? (
        <p role="note">Demo: Dieses Notizbuch und dein Demo-Zugang werden nach 24 Stunden gelöscht.</p>
      ) : null}
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
      <section>
        <h2>Quellen</h2>
        <SourceList sources={sources} notebookId={notebook.id} canEdit={canEditSources} />
        {canEditSources ? <AddSource notebookId={notebook.id} /> : null}
      </section>
      <Chat notebookId={notebook.id} initialHistory={history} historyFailed={historyFailed} />
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
