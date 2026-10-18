// Role rules for the UI. The database enforces them (RLS from #10); these only decide
// which controls are shown and validate input before it reaches the database.

export type MemberRole = "owner" | "editor" | "viewer";

export const ROLE_LABELS: Record<MemberRole, string> = {
  owner: "Eigentümer",
  editor: "Bearbeiter",
  viewer: "Betrachter",
};

// Promoting to owner is not offered in the UI.
export const ASSIGNABLE_ROLES = ["editor", "viewer"] as const;
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

export function canManageMembers(role: string | null): boolean {
  return role === "owner";
}

export function isAssignableRole(value: unknown): value is AssignableRole {
  return typeof value === "string" && (ASSIGNABLE_ROLES as readonly string[]).includes(value);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

// Same bounds as the check constraint on notebooks.title.
export function validateTitle(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const title = raw.trim();
  return title.length >= 1 && title.length <= 200 ? title : null;
}
