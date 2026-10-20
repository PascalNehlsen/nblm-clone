import type { ReactNode } from "react";
import { notFound, redirect } from "next/navigation";
import { isUuid } from "@/lib/notebooks/roles";
import { getNotebookForUser } from "./access";

// Runs before this segment's loading skeleton streams, so a missing or hidden notebook still
// answers with status 404 (a page-level notFound() after streaming would answer 200).
export default async function NotebookLayout({ children, params }: { children: ReactNode; params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const { user, notebook } = await getNotebookForUser(id);
  if (!user) redirect("/login");
  if (!notebook) notFound();
  return children;
}
