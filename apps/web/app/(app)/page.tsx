import Link from "next/link";
import { redirect } from "next/navigation";
import { createNotebookAction } from "./notebooks/actions";
import { notebookErrorMessage } from "@/lib/notebooks/errors";
import { listNotebooks } from "@/lib/notebooks/notebooks";
import { ROLE_LABELS } from "@/lib/notebooks/roles";
import { createClient } from "@/lib/supabase/server";

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

  return (
    <main>
      <h1>Deine Notizbücher</h1>
      {params.fehler ? <p role="alert">{notebookErrorMessage(params.fehler)}</p> : null}
      {params.geloescht ? <p role="status">Das Notizbuch wurde gelöscht.</p> : null}
      {notebooks.length === 0 ? (
        <p>Noch keine Notizbücher. Bald kannst du hier Quellen hochladen und Fragen dazu stellen.</p>
      ) : (
        <ul>
          {notebooks.map((notebook) => (
            <li key={notebook.id}>
              <Link href={`/notebooks/${notebook.id}`}>{notebook.title}</Link>{" "}
              <span>{ROLE_LABELS[notebook.role]}</span>
            </li>
          ))}
        </ul>
      )}
      <form action={createNotebookAction}>
        <h2>Neues Notizbuch</h2>
        <label>
          Titel <input name="title" required maxLength={200} />
        </label>{" "}
        <button type="submit">Anlegen</button>
      </form>
      <p>
        <Link href="/profil">Profil</Link>
      </p>
    </main>
  );
}
