import { OpsView } from "./ops-view";
import { loadOpsSummary } from "@/lib/server/ops/read";

export const metadata = { title: "Betrieb" };

// Operator-only (layout.tsx). ?tage=30 switches the window; anything else is 7 days.
export default async function OpsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const days = (await searchParams).tage === "30" ? 30 : 7;
  let summary;
  try {
    summary = await loadOpsSummary(days);
  } catch {
    return (
      <main id="inhalt" className="page ops">
        <h1>Betrieb</h1>
        <p role="alert">Die Betriebsdaten konnten nicht geladen werden.</p>
      </main>
    );
  }
  return <OpsView summary={summary} />;
}
