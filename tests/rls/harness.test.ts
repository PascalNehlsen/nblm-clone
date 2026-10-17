// Proves the RLS test harness itself works against the real local Supabase
// stack, before any table or policy exists (PR 3 adds those). Every client
// here is built from a real sign-in and a real JWT -- never service_role.
//
// Users are created once per describe block (beforeAll), not per `it`, to
// stay well below the local Auth rate limits (sign_in_sign_ups / anonymous
// sign-in limits apply per IP) as the RLS matrix in PR 3 adds many more cases.
import * as fs from "node:fs";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  anonClient,
  assertLocalHost,
  decodeJwt,
  signInAnonymousUser,
  signUpUser,
  supabaseLocalConfig,
  type SignedInUser,
} from "./helpers/clients";

describe("signUpUser", () => {
  let user: SignedInUser;

  beforeAll(async () => {
    user = await signUpUser("owner");
  });

  it("returns a JWT for an authenticated, non-anonymous user whose sub is the user id", () => {
    const claims = decodeJwt(user.accessToken);

    expect(claims.role).toBe("authenticated");
    expect(claims.is_anonymous).toBe(false);
    expect(claims.sub).toBe(user.userId);
  });
});

describe("signInAnonymousUser", () => {
  let user: SignedInUser;

  beforeAll(async () => {
    user = await signInAnonymousUser();
  });

  it("returns a JWT for an authenticated, anonymous user", () => {
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
  let stranger: SignedInUser;

  beforeAll(async () => {
    stranger = await signUpUser("stranger");
  });

  it("rejects an anon request to the private schema with PGRST106", async () => {
    const client = anonClient();
    const { data, error } = await client.schema("private").from("anything").select();

    expect(data).toBeNull();
    expect(error?.code).toBe("PGRST106");
  });

  it("rejects a signed-up user's request to the private schema with PGRST106", async () => {
    const { data, error } = await stranger.client.schema("private").from("anything").select();

    expect(data).toBeNull();
    expect(error?.code).toBe("PGRST106");
  });
});

describe("assertLocalHost", () => {
  it("accepts 127.0.0.1 and localhost URLs", () => {
    expect(() => assertLocalHost("http://127.0.0.1:54321")).not.toThrow();
    expect(() => assertLocalHost("http://localhost:54321")).not.toThrow();
  });

  it("refuses a non-loopback host", () => {
    expect(() => assertLocalHost("https://project-ref.supabase.co")).toThrow(
      /refusing to use SUPABASE_URL/,
    );
  });

  it("refuses a value that is not a URL at all", () => {
    expect(() => assertLocalHost("not-a-url")).toThrow(/not a valid URL/);
  });
});

describe("static guard: no admin credential material under tests/rls", () => {
  const forbidden = ["service_role", "SERVICE_ROLE_KEY", "SECRET_KEY", "sb_secret_", "JWT_SECRET"];

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

  const rlsDir = path.resolve(import.meta.dirname, ".");

  // key-guard.ts and its test are the only places allowed to even name a
  // secret prefix/claim (so they can reject it); the guard test itself is
  // exempt because this very list of forbidden substrings has to live
  // somewhere. A silently-missing exempt file would make this scan pass for
  // the wrong reason (nothing there to flag), so its own existence is
  // asserted separately below instead of just skipped over.
  const exemptFiles = [
    path.resolve(rlsDir, "harness.test.ts"),
    path.resolve(rlsDir, "helpers/key-guard.ts"),
    path.resolve(rlsDir, "key-guard.test.ts"),
  ];

  it("has every exempt file present", () => {
    for (const file of exemptFiles) {
      expect(fs.existsSync(file), `expected exempt file to exist: ${path.relative(rlsDir, file)}`).toBe(
        true,
      );
    }
  });

  it("contains none of the forbidden substrings outside the exempt files", () => {
    const exempt = new Set(exemptFiles.map((file) => path.resolve(file)));

    const offenders: string[] = [];
    for (const file of collectFiles(rlsDir)) {
      if (exempt.has(path.resolve(file))) continue;

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

describe("static guard: key-guard.ts cannot read or exfiltrate a secret itself", () => {
  // key-guard.ts is the one file allowed to name a secret prefix/claim (to
  // reject it), so it must be structurally unable to read one from the
  // environment, the filesystem or a subprocess, or send one anywhere: a
  // pure function of the string it is handed, nothing else.
  const keyGuardPath = path.resolve(import.meta.dirname, "helpers/key-guard.ts");

  it("exists", () => {
    expect(fs.existsSync(keyGuardPath)).toBe(true);
  });

  it("contains none of process.env, node:fs, fs, child_process or fetch(, and imports only types", () => {
    const content = fs.readFileSync(keyGuardPath, "utf8");

    const forbidden = ["process.env", "node:fs", "fs", "child_process", "fetch("];
    for (const needle of forbidden) {
      expect(content.includes(needle), `key-guard.ts must not contain "${needle}"`).toBe(false);
    }

    const importLines = content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("import "));

    for (const line of importLines) {
      const isTypeOnly = /^import\s+type\b/.test(line) || /^import\s*\{\s*type\b/.test(line);
      expect(isTypeOnly, `key-guard.ts may only import types: "${line}"`).toBe(true);
    }
  });
});
