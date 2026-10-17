// Helpers for the RLS matrix: real sign-ins against the local Supabase Auth,
// real PostgREST clients built from the resulting JWTs. Per AGENTS.md this
// file must never touch the admin/service credential (the long-lived secret
// that bypasses RLS) or the JWT signing secret -- only the public API URL and
// the anon/publishable key, which are safe to use from a browser.
//
// Config comes from SUPABASE_URL / SUPABASE_ANON_KEY if set, otherwise from
// `supabase status -o env`. When parsing that output we only ever look at the
// two lines we need; every other line (including the admin credential and the
// JWT signing secret) is skipped before it is ever assigned to a variable.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export interface DecodedJwt {
  sub?: string;
  role?: string;
  is_anonymous?: boolean;
  [claim: string]: unknown;
}

/** Minimal base64url decoder for JWT payloads; no extra dependency needed. */
function base64UrlDecode(segment: string): string {
  const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  const padLength = (4 - (base64.length % 4)) % 4;
  return Buffer.from(base64 + "=".repeat(padLength), "base64").toString("utf8");
}

export function decodeJwt(token: string): DecodedJwt {
  const payload = token.split(".")[1];
  if (payload === undefined) {
    throw new Error("decodeJwt: token does not look like a JWT (no payload segment)");
  }
  return JSON.parse(base64UrlDecode(payload)) as DecodedJwt;
}

export interface SupabaseLocalConfig {
  url: string;
  anonKey: string;
}

let cachedConfig: SupabaseLocalConfig | undefined;

// Only these two keys are ever read from `supabase status -o env`. Every
// other line -- including the admin credential and the JWT signing secret --
// is skipped by the `continue` below before its value is ever read into a
// variable, so this process can neither hold nor leak it.
const WANTED_KEYS = new Set(["API_URL", "ANON_KEY", "PUBLISHABLE_KEY"]);

function readConfigFromCli(): SupabaseLocalConfig {
  const repoRoot = path.resolve(import.meta.dirname, "../../..");
  const supabaseBinary = path.join(repoRoot, "node_modules", ".bin", "supabase");
  const output = execFileSync(supabaseBinary, ["status", "-o", "env"], {
    encoding: "utf8",
    cwd: repoRoot,
  });

  let url: string | undefined;
  let anonKey: string | undefined;

  for (const line of output.split("\n")) {
    const separatorIndex = line.indexOf("=");
    if (separatorIndex === -1) continue;
    const key = line.slice(0, separatorIndex).trim();
    if (!WANTED_KEYS.has(key)) continue;

    const rawValue = line.slice(separatorIndex + 1).trim();
    const value = rawValue.replace(/^"(.*)"$/, "$1");

    if (key === "API_URL") {
      url = value;
    } else if (anonKey === undefined) {
      // ANON_KEY appears before PUBLISHABLE_KEY in `supabase status` output,
      // so the first match wins and PUBLISHABLE_KEY is only a fallback.
      anonKey = value;
    }
  }

  if (!url || !anonKey) {
    throw new Error(
      "clients.ts: could not read API_URL and ANON_KEY/PUBLISHABLE_KEY from `supabase status -o env`. " +
        "Is the local stack running (`pnpm db:start`)?",
    );
  }

  return { url, anonKey };
}

export function supabaseLocalConfig(): SupabaseLocalConfig {
  if (cachedConfig) return cachedConfig;

  const envUrl = process.env.SUPABASE_URL;
  const envAnonKey = process.env.SUPABASE_ANON_KEY;
  if (envUrl && envAnonKey) {
    cachedConfig = { url: envUrl, anonKey: envAnonKey };
    return cachedConfig;
  }

  cachedConfig = readConfigFromCli();
  return cachedConfig;
}

/** A fresh, unauthenticated client. Never shares state with any other client. */
export function anonClient(): SupabaseClient {
  const { url, anonKey } = supabaseLocalConfig();
  return createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export interface SignedInUser {
  client: SupabaseClient;
  userId: string;
  accessToken: string;
}

function randomPassword(): string {
  // Local minimum_password_length = 6; this is always well above that.
  return `Aa1!${randomUUID()}`;
}

export async function signUpUser(label: string): Promise<SignedInUser> {
  const client = anonClient();
  const email = `${label}-${randomUUID()}@example.test`;
  const password = randomPassword();

  const { data, error } = await client.auth.signUp({ email, password });
  if (error || !data.session || !data.user) {
    throw new Error(
      `signUpUser(${label}): sign-up did not return a session (email confirmations must be off locally): ${
        error?.message ?? "no session/user in response"
      }`,
    );
  }

  return { client, userId: data.user.id, accessToken: data.session.access_token };
}

export async function signInAnonymousUser(): Promise<SignedInUser> {
  const client = anonClient();

  const { data, error } = await client.auth.signInAnonymously();
  if (error || !data.session || !data.user) {
    throw new Error(
      `signInAnonymousUser: anonymous sign-in failed (is enable_anonymous_sign_ins on?): ${
        error?.message ?? "no session/user in response"
      }`,
    );
  }

  return { client, userId: data.user.id, accessToken: data.session.access_token };
}
