import "server-only";

// Starting the demo after the anonymous sign-in (block F2, ADR 0012): the database trigger
// copies the template into the user's first notebook. Error texts never reach the URL or a log.

export type DemoOutcome = { redirect: string };

export interface DemoDeps {
  getUser: () => Promise<{ id: string; isAnonymous: boolean } | null>;
  firstNotebookId: () => Promise<string | null>;
  createNotebook: (title: string) => Promise<{ id: string } | { error: string }>;
}

export const DEMO_NOTEBOOK_TITLE = "Demo: Beispielquellen";

export async function startDemoCore(deps: DemoDeps): Promise<DemoOutcome> {
  const user = await deps.getUser();
  if (!user) return { redirect: "/login" };
  if (!user.isAnonymous) return { redirect: "/" };

  const existing = await deps.firstNotebookId();
  if (existing) return { redirect: `/notebooks/${existing}` };

  const created = await deps.createNotebook(DEMO_NOTEBOOK_TITLE);
  if ("id" in created) return { redirect: `/notebooks/${created.id}` };

  const error = created.error;
  if (error.includes("demo_notebook_exists")) {
    const again = await deps.firstNotebookId();
    return { redirect: again ? `/notebooks/${again}` : "/" };
  }
  if (error.includes("demo_unavailable")) return { redirect: "/login?fehler=demo_nicht_verfuegbar" };
  if (error.includes("demo_capacity")) return { redirect: "/login?fehler=demo_voll" };
  return { redirect: "/login?fehler=anmeldung" };
}
