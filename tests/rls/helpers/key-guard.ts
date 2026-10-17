// Accepts only keys that act as the anon role, so the RLS matrix can never run with
// an admin key from the environment by mistake. Pure function on purpose: no I/O, no
// imports (harness.test.ts enforces that), so this exempt file cannot read a secret.

const PUBLISHABLE_PREFIX = "sb_publishable_";
const SECRET_PREFIX = "sb_secret_";

function reject(reason: string): never {
  // The message never contains the key itself.
  throw new Error(`key-guard: refusing Supabase key (${reason}); the RLS tests need the anon or publishable key`);
}

function jwtRole(key: string): unknown {
  const parts = key.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) return undefined;
  const payloadPart = parts[1] ?? "";
  try {
    const base64 = payloadPart.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const payload: unknown = JSON.parse(atob(padded));
    if (typeof payload !== "object" || payload === null) return undefined;
    return (payload as { role?: unknown }).role;
  } catch {
    return undefined;
  }
}

export function assertAnonKey(key: string): void {
  if (key.length === 0) reject("empty");
  if (key.startsWith(SECRET_PREFIX)) reject("secret key");
  if (key.startsWith(PUBLISHABLE_PREFIX)) return;

  const role = jwtRole(key);
  if (role === undefined) reject("neither a publishable key nor a JWT with a role");
  if (role !== "anon") reject(`JWT role is not anon`);
}
