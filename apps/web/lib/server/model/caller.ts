import "server-only";

import { createClient } from "@/lib/supabase/server";

export interface VerifiedUser {
  id: string;
  isAnonymous: boolean;
}

// The user as verified by the Auth server (getUser, not the local JWT claims), because
// the budget RPC trusts the id and the anonymous flag it receives (ADR 0006). A missing
// flag counts as anonymous, like coalesce(p_is_anonymous, true) in the DB.
export async function getVerifiedUser(): Promise<VerifiedUser | null> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) return null;
    return { id: data.user.id, isAnonymous: data.user.is_anonymous !== false };
  } catch {
    return null;
  }
}
