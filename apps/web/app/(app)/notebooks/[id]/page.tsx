import { notFound, redirect } from "next/navigation";
import { AddSource } from "./add-source";
import { Chat } from "./chat";
import { DeleteNotebook } from "./delete-notebook";
import { MarginProvider } from "@/components/margin";
import { MemberList } from "./member-list";
import { SourceList } from "./source-list";
import { listHistory } from "@/lib/chat/history";
import { notebookErrorMessage } from "@/lib/notebooks/errors";
import { listMembers } from "@/lib/notebooks/members";
import { isUuid } from "@/lib/notebooks/roles";
import { listSources } from "@/lib/sources/sources";
import { getVerifiedUser } from "@/lib/supabase/server";
import { getNotebookForUser } from "./access";
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
  const { supabase, user } = await getVerifiedUser();
  if (!user) redirect("/login");

  // In parallel, not one round trip after another; RLS decides what each query may see.
  // The notebook itself comes from the layout's cached check (no second query).
  // A failing history query must not take the notebook page down.
  const [{ notebook }, members, sources, historyResult] = await Promise.all([
    getNotebookForUser(id),
    listMembers(supabase, id),
    listSources(supabase, id),
    listHistory(supabase, id).then(
      (entries) => ({ ok: true as const, entries }),
      () => ({ ok: false as const }),
    ),
  ]);
  if (!notebook) notFound();
  const history = historyResult.ok ? historyResult.entries : [];
  const historyFailed = !historyResult.ok;
  const canEditSources =
    (notebook.role === "owner" || notebook.role === "editor") && !(user.is_anonymous ?? false);

  const hues = assignHues(sources.map((source) => source.title));

  return (
    <MarginProvider>
    <main id="inhalt" className="notebook">
      <div className="nb-head">
        <Link href="/" className="back">
          Alle Notizbücher
        </Link>
        <div className="nb-title">
          <h1>{notebook.title}</h1>
          {notebook.role === "owner" && !user.is_anonymous ? (
            <DeleteNotebook notebookId={notebook.id} title={notebook.title} />
          ) : null}
        </div>
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
          <div className="panel-head">
            <h2>Quellen</h2>
            {canEditSources ? <AddSource notebookId={notebook.id} /> : null}
          </div>
          <div className="list">
            <SourceList sources={sources} notebookId={notebook.id} canEdit={canEditSources} hues={hues} />
          </div>
        </section>
        <MemberList
          members={members}
          currentUserId={user.id}
          myRole={notebook.role}
          notebookId={notebook.id}
          isAnonymous={user.is_anonymous ?? false}
        />
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
    </MarginProvider>
  );
}
