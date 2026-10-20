"use client";

import { ConfirmAction } from "@/components/confirm-action";
import { deleteAccountAction } from "./actions";

function notebooks(n: number): string {
  return n === 1 ? "1 Notizbuch, das nur dir gehört, wird" : `${n} Notizbücher, die nur dir gehören, werden`;
}

// The danger zone on /profil. The dialog says what goes: every notebook the user owns alone,
// also shared ones (their members lose access). Demo users end their demo the same way.
export function DeleteAccount({ anonymous, sole, shared }: { anonymous: boolean; sole: number; shared: number }) {
  const label = anonymous ? "Demo beenden und Daten löschen" : "Konto löschen";
  return (
    <section className="danger-zone" aria-label={label}>
      <ConfirmAction
        action={deleteAccountAction}
        fields={{}}
        trigger={label}
        triggerClassName="danger"
        title={`${label}?`}
        confirmLabel="Endgültig löschen"
      >
        {sole === 0
          ? "Dein Konto wird gelöscht. Du besitzt kein Notizbuch allein; deine Mitgliedschaften und Fragen in fremden Notizbüchern werden entfernt."
          : `Dein Konto wird gelöscht. ${notebooks(sole)} mit allen Quellen, Abschnitten, Fragen und Dateien gelöscht.` +
            (shared > 0 ? ` ${shared} davon geteilt: Die Mitglieder verlieren den Zugriff.` : "")}{" "}
        Das lässt sich nicht rückgängig machen.
      </ConfirmAction>
    </section>
  );
}
