import "server-only";

// Structural: only the two fields that decide (the Supabase user has both).
interface MaybeUser {
  is_anonymous?: boolean;
  app_metadata?: unknown;
}

// Who may see /ops (ADR 0023): a signed-in, non-anonymous user whose app_metadata carries
// ops: true. app_metadata is set only by an operator in the database (runbook ops-access.md);
// users cannot edit it. Anything unexpected is a no.
export function isOperator(user: MaybeUser | null | undefined): boolean {
  try {
    if (typeof user !== "object" || user === null) return false;
    if (user.is_anonymous === true) return false;
    const meta: unknown = user.app_metadata;
    return typeof meta === "object" && meta !== null && (meta as { ops?: unknown }).ops === true;
  } catch {
    return false;
  }
}
