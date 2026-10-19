import { notFound, redirect } from "next/navigation";
import { AddSource } from "./add-source";
import { Chat } from "./chat";
import { DeleteNotebook } from "./delete-notebook";
import { MemberList } from "./member-list";
import { SourceList } from "./source-list";
import { listHistory } from "@/lib/chat/history";
import { notebookErrorMessage } from "@/lib/notebooks/errors";
import { listMembers } from "@/lib/notebooks/members";
import { getNotebook } from "@/lib/notebooks/notebooks";
import { isUuid } from "@/lib/notebooks/roles";
import { listSources } from "@/lib/sources/sources";
import { createClient } from "@/lib/supabase/server";
import { assignHues } from "@/lib/ui/source-hue";
import Link from "next/link";

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

  const hues = assignHues(sources.map((source) => source.title));

  return (
    <main id="inhalt" className="notebook">
      <div className="nb-head">
        <Link href="/" className="back">
          Alle Notizbücher
        </Link>
        <h1>{notebook.title}</h1>
        {sources.length > 0 ? (
          <div className="spectrum" aria-hidden="true">
            {sources.map((source) => (
              <span key={source.id} data-hue={hues[source.title]} />
            ))}
          </div>
        ) : null}
        {fehler ? <p role="alert">{notebookErrorMessage(fehler)}</p> : null}
      </div>
      <aside className="nb-rail" aria-label="Quellen und Mitglieder">
        <section className="panel sources">
          <h2>Quellen</h2>
          <SourceList sources={sources} notebookId={notebook.id} canEdit={canEditSources} hues={hues} />
          {canEditSources ? <AddSource notebookId={notebook.id} /> : null}
        </section>
        <MemberList
          members={members}
          currentUserId={data.user.id}
          myRole={notebook.role}
          notebookId={notebook.id}
          isAnonymous={data.user.is_anonymous ?? false}
        />
        {notebook.role === "owner" && !data.user.is_anonymous ? (
          <DeleteNotebook notebookId={notebook.id} title={notebook.title} />
        ) : null}
      </aside>
      <Chat
        notebookId={notebook.id}
        initialHistory={history}
        historyFailed={historyFailed}
        hues={hues}
        hasReadySources={sources.some((source) => source.status === "ready")}
        canAddSources={canEditSources}
      />
    </main>
  );
}
