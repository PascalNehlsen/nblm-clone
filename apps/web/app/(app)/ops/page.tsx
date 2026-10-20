import { notFound } from "next/navigation";
import { OpsView } from "./ops-view";
import { isOperator } from "@/lib/server/ops/access";
import { loadOpsSummary } from "@/lib/server/ops/read";
import { getVerifiedUser } from "@/lib/supabase/server";

export const metadata = { title: "Betrieb" };

// Operator-only. The layout checks too, but a layout does not re-run on every navigation
// (ADR 0005), so the page checks itself before loading anything (ADR 0023). ?tage=30 switches
// the window; anything else is 7 days.
export default async function OpsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { user } = await getVerifiedUser();
  if (!isOperator(user)) notFound();
  const days = (await searchParams).tage === "30" ? 30 : 7;
  let summary;
  try {
    summary = await loadOpsSummary(user, days);
  } catch {
    // A fixed line, no data: the runbook (ops-access.md) points here.
    console.error("ops store: summary failed");
    return (
      <main id="inhalt" className="page ops">
        <h1>Betrieb</h1>
        <p role="alert">Die Betriebsdaten konnten nicht geladen werden.</p>
      </main>
    );
  }
  return <OpsView summary={summary} />;
}
