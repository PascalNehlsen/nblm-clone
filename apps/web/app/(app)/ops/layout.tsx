import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { isOperator } from "@/lib/server/ops/access";
import { getVerifiedUser } from "@/lib/supabase/server";

// /ops exists only for operators (ADR 0023). Everyone else, also a signed-in user, gets a
// real 404, decided here before anything renders, so the page's existence is not revealed.
export default async function OpsLayout({ children }: { children: ReactNode }) {
  const { user } = await getVerifiedUser();
  if (!isOperator(user)) notFound();
  return children;
}
