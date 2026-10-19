import Link from "next/link";
import { redirect } from "next/navigation";
import { createNotebookAction } from "./notebooks/actions";
import { notebookErrorMessage } from "@/lib/notebooks/errors";
import { listNotebooks } from "@/lib/notebooks/notebooks";
import { ROLE_LABELS } from "@/lib/notebooks/roles";
import { createClient } from "@/lib/supabase/server";
import { assignHues } from "@/lib/ui/source-hue";

export default async function Home({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) redirect("/login");
  const notebooks = await listNotebooks(supabase, data.user.id);
  const params = (await searchParams) ?? {};
  const hues = assignHues(notebooks.map((notebook) => notebook.id));

  return (
    <main id="inhalt" className="page">
      <div className="shelf-head">
        <div>
          <p className="eyebrow">Lesesaal</p>
          <h1>Deine Notizbücher</h1>
        </div>
        <Link href="/profil" className="button quiet">
          Profil
        </Link>
      </div>
      {params.fehler ? <p role="alert">{notebookErrorMessage(params.fehler)}</p> : null}
      {params.geloescht ? <p role="status">Das Notizbuch wurde gelöscht.</p> : null}
      {notebooks.length === 0 ? (
        <p className="empty">Noch keine Notizbücher. Leg unten dein erstes an, füg Quellen hinzu und stell Fragen dazu.</p>
      ) : (
        <ul className="shelf stagger">
          {notebooks.map((notebook) => (
            <li key={notebook.id} className="book" data-hue={hues[notebook.id]} data-tilt="8">
              <Link href={`/notebooks/${notebook.id}`}>{notebook.title}</Link>{" "}
              <span className="pill">{ROLE_LABELS[notebook.role]}</span>
            </li>
          ))}
        </ul>
      )}
      <form action={createNotebookAction} className="new-book">
        <h2>Neues Notizbuch</h2>
        <div className="row">
          <label>
            Titel <input name="title" required maxLength={200} />
          </label>{" "}
          <button type="submit" className="primary">
            Anlegen
          </button>
        </div>
      </form>
    </main>
  );
}
