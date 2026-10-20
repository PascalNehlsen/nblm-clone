import "server-only";

import { cache } from "react";
import { getNotebook } from "@/lib/notebooks/notebooks";
import { getVerifiedUser } from "@/lib/supabase/server";

// The notebook as the signed-in user may see it (RLS), once per request: the segment layout
// checks it before the loading skeleton streams (so a missing notebook is a real 404), and the
// page reuses the result.
export const getNotebookForUser = cache(async (id: string) => {
  const { supabase, user } = await getVerifiedUser();
  if (!user) return { supabase, user, notebook: null };
  return { supabase, user, notebook: await getNotebook(supabase, id, user.id) };
});
