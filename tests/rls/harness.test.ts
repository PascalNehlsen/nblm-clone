// Proves the RLS test harness itself works against the real local Supabase
// stack, before any table or policy exists (PR 3 adds those). Every client
// here is built from a real sign-in and a real JWT -- never service_role.
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  anonClient,
  decodeJwt,
  signInAnonymousUser,
  signUpUser,
  supabaseLocalConfig,
} from "./helpers/clients";

describe("signUpUser", () => {
  it("returns a JWT for an authenticated, non-anonymous user whose sub is the user id", async () => {
    const user = await signUpUser("owner");
    const claims = decodeJwt(user.accessToken);

    expect(claims.role).toBe("authenticated");
    expect(claims.is_anonymous).toBe(false);
    expect(claims.sub).toBe(user.userId);
  });
});

describe("signInAnonymousUser", () => {
  it("returns a JWT for an authenticated, anonymous user", async () => {
    const user = await signInAnonymousUser();
    const claims = decodeJwt(user.accessToken);

    expect(claims.role).toBe("authenticated");
    expect(claims.is_anonymous).toBe(true);
    expect(claims.sub).toBe(user.userId);
  });
});

describe("anonClient", () => {
  it("starts with no session", async () => {
    const client = anonClient();
    const { data, error } = await client.auth.getSession();

    expect(error).toBeNull();
    expect(data.session).toBeNull();
  });
});

describe("local Auth settings", () => {
  it("reports GitHub and anonymous sign-ins enabled", async () => {
    const { url, anonKey } = supabaseLocalConfig();

    const response = await fetch(`${url}/auth/v1/settings`, {
      headers: { apikey: anonKey },
    });
    expect(response.status).toBe(200);

    const settings = (await response.json()) as {
      external?: { github?: boolean; anonymous_users?: boolean };
    };

    expect(settings.external?.github).toBe(true);
    expect(settings.external?.anonymous_users).toBe(true);
  });
});

describe("schema exposure: private is not reachable through PostgREST", () => {
  it("rejects an anon request to the private schema with PGRST106", async () => {
    const client = anonClient();
    const { data, error } = await client.schema("private").from("anything").select();

    expect(data).toBeNull();
    expect(error?.code).toBe("PGRST106");
  });

  it("rejects a signed-up user's request to the private schema with PGRST106", async () => {
    const user = await signUpUser("stranger");
    const { data, error } = await user.client.schema("private").from("anything").select();

    expect(data).toBeNull();
    expect(error?.code).toBe("PGRST106");
  });
});

describe("static guard: no admin credential material under tests/rls", () => {
  const forbidden = ["service_role", "SERVICE_ROLE_KEY", "SECRET_KEY", "sb_secret_"];

  function collectFiles(dir: string): string[] {
    const files: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...collectFiles(full));
      } else {
        files.push(full);
      }
    }
    return files;
  }

  it("contains none of the forbidden substrings outside this guard test", () => {
    const rlsDir = path.resolve(import.meta.dirname, ".");
    const selfFile = path.resolve(import.meta.dirname, "harness.test.ts");

    const offenders: string[] = [];
    for (const file of collectFiles(rlsDir)) {
      if (path.resolve(file) === selfFile) continue;

      const content = fs.readFileSync(file, "utf8");
      for (const needle of forbidden) {
        if (content.includes(needle)) {
          offenders.push(`${path.relative(rlsDir, file)}: contains "${needle}"`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
