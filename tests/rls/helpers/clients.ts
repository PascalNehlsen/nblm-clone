// Helpers for the RLS matrix: real sign-ins against the local Supabase Auth,
// real PostgREST clients built from the resulting JWTs. Per AGENTS.md this
// file must never use the admin/service credential (the long-lived secret
// that bypasses RLS) or the JWT signing secret -- only the public API URL and
// the anon/publishable key, which are safe to use from a browser.
//
// Config comes from SUPABASE_URL / SUPABASE_ANON_KEY if set, otherwise from
// `supabase status -o env`. That command's raw stdout does contain the admin
// credential and the JWT signing secret: it is held in memory only long
// enough to be scanned line by line below, with stderr discarded outright
// and a failure re-thrown as a plain message instead of the original error,
// so neither a successful nor a failed invocation's full output ever leaves
// this function. Every line except API_URL, ANON_KEY and PUBLISHABLE_KEY is
// skipped before it is ever assigned to a named variable, so nothing beyond
// those two values is ever held, logged or returned.
//
// SUPABASE_URL (from the environment or from the CLI) must resolve to
// 127.0.0.1 or localhost: this harness signs up real users and must never be
// pointed at a real project by a stray environment variable.
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

// This harness signs up real users with real passwords against whatever
// SUPABASE_URL resolves to; refusing anything but loopback hosts means a
// stray/misconfigured environment variable can never point it at a real
// project.
const ALLOWED_HOSTNAMES = new Set(["127.0.0.1", "localhost"]);

/** Exported so the harness tests can exercise it directly, independent of
 * supabaseLocalConfig()'s module-level cache. */
export function assertLocalHost(url: string): void {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    throw new Error(`clients.ts: SUPABASE_URL is not a valid URL: ${url}`);
  }

  if (!ALLOWED_HOSTNAMES.has(hostname)) {
    throw new Error(
      `clients.ts: refusing to use SUPABASE_URL with host "${hostname}" -- only 127.0.0.1 ` +
        "and localhost are allowed. This harness signs up real users and must never run against a real project.",
    );
  }
}

// Only these two keys are ever read from `supabase status -o env`. Every
// other line -- including the admin credential and the JWT signing secret --
// is skipped by the `continue` below before its value is ever read into a
// variable, so only API_URL/ANON_KEY/PUBLISHABLE_KEY ever leave this function
// (see the file header for how the raw stdout itself is handled).
const WANTED_KEYS = new Set(["API_URL", "ANON_KEY", "PUBLISHABLE_KEY"]);

function readConfigFromCli(): SupabaseLocalConfig {
  const repoRoot = path.resolve(import.meta.dirname, "../../..");
  const supabaseBinary = path.join(repoRoot, "node_modules", ".bin", "supabase");

  let output: string;
  try {
    output = execFileSync(supabaseBinary, ["status", "-o", "env"], {
      encoding: "utf8",
      cwd: repoRoot,
      // stderr is discarded outright; stdout is captured only so this
      // function can scan it below, never to be echoed back whole.
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    // Deliberately not including the caught error: on failure, Node attaches
    // whatever stdout/stderr it captured to the error object, and that can
    // include partial `supabase status` output (admin credential included).
    throw new Error(
      "clients.ts: `supabase status -o env` failed. Is the local stack running (`pnpm db:start`)?",
    );
  }

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
    assertLocalHost(envUrl);
    cachedConfig = { url: envUrl, anonKey: envAnonKey };
    return cachedConfig;
  }

  const config = readConfigFromCli();
  assertLocalHost(config.url);
  cachedConfig = config;
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
