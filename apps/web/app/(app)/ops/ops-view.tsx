import { categoryLabel, type OpsSummary } from "@/lib/server/ops/summary";

// The ops page body (ADR 0023): aggregates only, plain text, no remote content.

const usd = (n: number) => new Intl.NumberFormat("de-DE", { style: "currency", currency: "USD", maximumFractionDigits: 4 }).format(n);
const int = (n: number) => new Intl.NumberFormat("de-DE").format(n);
const KIND: Record<string, string> = { chat: "Chat", embedding: "Embeddings" };
const STATUS: Record<string, string> = { settled: "abgeschlossen", failed: "fehlgeschlagen", reserved: "reserviert" };

function dayLabel(day: string): string {
  const [y, m, d] = day.split("-");
  return `${d}.${m}.${y}`;
}

export function OpsView({ summary }: { summary: OpsSummary }) {
  const days = [...new Set(summary.cost_per_day.map((e) => e.day))];
  const cost = (day: string, kind: string) => summary.cost_per_day.find((e) => e.day === day && e.kind === kind)?.cost_usd ?? 0;
  const total = summary.cost_per_day.reduce((sum, e) => sum + e.cost_usd, 0);
  const run = summary.eval;
  return (
    <main id="inhalt" className="page ops">
      <h1>Betrieb</h1>
      <p className="ops-window">
        Zeitraum:{" "}
        {summary.days === 7 ? <strong>7 Tage</strong> : <a href="/ops">7 Tage</a>}
        {" · "}
        {summary.days === 30 ? <strong>30 Tage</strong> : <a href="/ops?tage=30">30 Tage</a>}
      </p>

      <section>
        <h2>Fehler beim Import</h2>
        {summary.ingest_errors.length === 0 ? (
          <p>Keine Fehler</p>
        ) : (
          <table>
            <tbody>
              {summary.ingest_errors.map((e) => (
                <tr key={e.category}>
                  <th scope="row">{categoryLabel(e.category)}</th>
                  <td>{int(e.count)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h2>Kosten pro Tag</h2>
        <p>Summe im Zeitraum: {usd(total)}</p>
        <table>
          <thead>
            <tr>
              <th scope="col">Tag</th>
              <th scope="col">Embeddings</th>
              <th scope="col">Chat</th>
            </tr>
          </thead>
          <tbody>
            {days.map((day) => (
              <tr key={day}>
                <th scope="row">{dayLabel(day)}</th>
                <td>{usd(cost(day, "embedding"))}</td>
                <td>{usd(cost(day, "chat"))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h2>Antwortzeit (p95)</h2>
        {summary.latency_p95.length === 0 ? (
          <p>Keine Aufrufe</p>
        ) : (
          <table>
            <tbody>
              {summary.latency_p95.map((l) => (
                <tr key={l.kind}>
                  <th scope="row">{KIND[l.kind] ?? l.kind}</th>
                  <td>{Math.round(l.p95_ms)} ms</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h2>Anfragen nach Status</h2>
        {summary.status_counts.length === 0 ? (
          <p>Keine Aufrufe</p>
        ) : (
          <table>
            <tbody>
              {summary.status_counts.map((s) => (
                <tr key={`${s.kind}-${s.status}`}>
                  <th scope="row">
                    {KIND[s.kind] ?? s.kind}, {STATUS[s.status] ?? s.status}
                  </th>
                  <td>{int(s.count)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h2>Heutiges Gesamtbudget</h2>
        <p>
          {usd(summary.global_today.spent_usd)} von {usd(summary.global_today.limit_usd)}
        </p>
      </section>

      <section>
        <h2>Einstellungen</h2>
        <table>
          <tbody>
            <tr>
              <th scope="row">Modellfunktionen</th>
              <td>{summary.settings.model_features_enabled ? "eingeschaltet" : "abgeschaltet"}</td>
            </tr>
            <tr>
              <th scope="row">Tageslimit pro Konto</th>
              <td>{usd(summary.settings.daily_limit_usd)}</td>
            </tr>
            <tr>
              <th scope="row">Tageslimit Demo</th>
              <td>{usd(summary.settings.daily_limit_anonymous_usd)}</td>
            </tr>
            <tr>
              <th scope="row">Globales Tageslimit</th>
              <td>{usd(summary.settings.global_daily_limit_usd)}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section>
        <h2>Eval</h2>
        {run === null ? (
          <p>Noch kein Eval-Lauf</p>
        ) : (
          <table>
            <tbody>
              <tr>
                <th scope="row">Ergebnis</th>
                <td>{run.ok ? "bestanden" : "nicht bestanden"}</td>
              </tr>
              <tr>
                <th scope="row">Sicherheit</th>
                <td>
                  {run.security_passed}/{run.security_total}
                </td>
              </tr>
              <tr>
                <th scope="row">Qualität</th>
                <td>
                  {run.quality_passed}/{run.quality_total}
                </td>
              </tr>
              <tr>
                <th scope="row">Fehler beim Lauf</th>
                <td>{int(run.errored)}</td>
              </tr>
              <tr>
                <th scope="row">Zeitpunkt</th>
                <td>{new Date(run.ran_at).toLocaleString("de-DE", { timeZone: "Europe/Berlin" })}</td>
              </tr>
              {run.commit_sha ? (
                <tr>
                  <th scope="row">Commit</th>
                  <td>
                    <code>{run.commit_sha.slice(0, 12)}</code>
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
