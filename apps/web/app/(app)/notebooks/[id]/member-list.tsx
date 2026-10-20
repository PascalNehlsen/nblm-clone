import { addMemberAction, changeRoleAction, removeMemberAction } from "../actions";
import type { Member } from "@/lib/notebooks/members";
import { ASSIGNABLE_ROLES, ROLE_LABELS, canManageMembers } from "@/lib/notebooks/roles";
import { ConfirmAction } from "@/components/confirm-action";
import { ModalDialog } from "@/components/modal-dialog";

// Members as a compact list; for owners, the share, role and remove controls sit in a dialog
// behind "Verwalten". Owners (including co-owners) get no controls. Hiding them is for the UI;
// the database rejects these writes from anyone but an owner.
export function MemberList({
  members,
  currentUserId,
  myRole,
  notebookId = "",
  isAnonymous = false,
}: {
  members: Member[];
  currentUserId: string;
  myRole: string | null;
  notebookId?: string;
  isAnonymous?: boolean;
}) {
  const manage = canManageMembers(myRole);
  // Demo users cannot add members (restrictive policy from #10), so no dead-end form.
  const canShare = manage && !isAnonymous;

  const others = members.filter((member) => member.userId !== currentUserId && member.role !== "owner");

  return (
    <section className="panel members">
      <div className="panel-head">
        <h2>Mitglieder</h2>
        {canShare ? (
          <ModalDialog trigger="Verwalten" triggerClassName="small" title="Mitglieder verwalten" wide reopenKey={`members:${notebookId}`}>
            {others.length > 0 ? (
              <ul className="manage">
                {others.map((member) => (
                  <li key={member.userId}>
                    <span className="who">{member.userId.slice(0, 8)}</span>
                    <form action={changeRoleAction}>
                      <input type="hidden" name="notebookId" value={notebookId} />
                      <input type="hidden" name="userId" value={member.userId} />
                      <label>
                        Rolle ändern{" "}
                        <select name="role" defaultValue={member.role}>
                          {ASSIGNABLE_ROLES.map((role) => (
                            <option key={role} value={role}>
                              {ROLE_LABELS[role]}
                            </option>
                          ))}
                        </select>
                      </label>
                      <button type="submit">Speichern</button>
                    </form>
                    <ConfirmAction
                      action={removeMemberAction}
                      fields={{ notebookId, userId: member.userId }}
                      trigger="Entfernen"
                      title="Mitglied entfernen?"
                      confirmLabel="Endgültig entfernen"
                    >
                      Diese Person verliert den Zugriff auf das Notizbuch. Du kannst sie später wieder hinzufügen.
                    </ConfirmAction>
                  </li>
                ))}
              </ul>
            ) : (
              <p>Noch niemand sonst hat Zugriff.</p>
            )}
            <form action={addMemberAction} className="share">
              <h3>Teilen</h3>
              <input type="hidden" name="notebookId" value={notebookId} />
              <label>
                Nutzer-ID <input name="userId" required autoComplete="off" />
              </label>{" "}
              <label>
                Rolle{" "}
                <select name="role" defaultValue="viewer">
                  {ASSIGNABLE_ROLES.map((role) => (
                    <option key={role} value={role}>
                      {ROLE_LABELS[role]}
                    </option>
                  ))}
                </select>
              </label>{" "}
              <button type="submit">Teilen</button>
            </form>
          </ModalDialog>
        ) : null}
      </div>
      <ul>
        {members.map((member) => (
          <li key={member.userId}>
            <span>{member.userId === currentUserId ? "Du" : member.userId.slice(0, 8)}</span>{" "}
            <span>{ROLE_LABELS[member.role]}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
