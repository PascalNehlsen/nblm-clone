"use server";

import { redirect } from "next/navigation";
import { deleteAccount, deleteAccountDeps } from "@/lib/server/account/delete-account";
import { createClient } from "@/lib/supabase/server";

// Deletes the signed-in user's account (ADR 0021). The user id comes from the session inside
// deleteAccount; nothing from the form but the confirm field is read.
export async function deleteAccountAction(formData: FormData): Promise<void> {
  const supabase = await createClient();
  const { redirectTo } = await deleteAccount(deleteAccountDeps(supabase), formData);
  redirect(redirectTo);
}
