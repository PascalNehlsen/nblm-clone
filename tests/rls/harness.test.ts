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
  const selfFile = path.resolve(rlsDir, "harness.test.ts");
  const keyGuardFile = path.resolve(rlsDir, "helpers/key-guard.ts");
  const keyGuardTestFile = path.resolve(rlsDir, "key-guard.test.ts");

  // key-guard.ts and its test are the only places allowed to even name a
  // secret shape, and only the minimum substring each needs to reject it --
  // every other needle stays forbidden in those two files too (e.g.
  // key-guard.ts may say `sb_secret_` but must not say `service_role`, and
  // neither file may ever say `SERVICE_ROLE_KEY`/`SECRET_KEY`/`JWT_SECRET`).
  // harness.test.ts itself is exempt wholesale because this very list of
  // substrings has to live somewhere. A silently-missing exempt file would
  // make the scan below pass for the wrong reason (nothing there to flag), so
  // existence is asserted separately instead of just skipped over.
  const allowedNeedlesByFile = new Map<string, Set<string>>([
    [keyGuardFile, new Set(["sb_secret_"])],
    [keyGuardTestFile, new Set(["sb_secret_", "service_role"])],
  ]);

  it("has every exempt file present", () => {
    for (const file of [keyGuardFile, keyGuardTestFile]) {
      expect(fs.existsSync(file), `expected exempt file to exist: ${path.relative(rlsDir, file)}`).toBe(
        true,
      );
    }
  });

  it("contains none of the forbidden substrings outside the allowed per-file exceptions", () => {
    const offenders: string[] = [];
    for (const file of collectFiles(rlsDir)) {
      const resolved = path.resolve(file);
      if (resolved === selfFile) continue;

      const content = fs.readFileSync(file, "utf8");
      const allowed = allowedNeedlesByFile.get(resolved) ?? new Set<string>();
      for (const needle of forbidden) {
        if (allowed.has(needle)) continue;
        if (content.includes(needle)) {
          offenders.push(`${path.relative(rlsDir, file)}: contains "${needle}"`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe("static guard: key-guard.ts has no I/O or dynamic-code primitives", () => {
  // This is a drift guard, not a sandbox: a determined rewrite of key-guard.ts
  // can still reach process/fs/network by going around these exact tokens
  // (string concatenation, a bracket property access that isn't literally
  // "globalThis", etc). What it does catch is the module quietly growing an
  // import, an env read or a network call over time, since key-guard.ts is
  // meant to stay a pure function of the string it is handed -- nothing read,
  // nothing sent. Patterns are matched word-boundary against the raw file
  // text, so a mention inside a comment counts too; that's intentional, since
  // a comment showing how to read `process.env` is itself a sign the module
  // has drifted from "pure function" even if the code path is unreachable.
  const keyGuardPath = path.resolve(import.meta.dirname, "helpers/key-guard.ts");

  it("exists", () => {
    expect(fs.existsSync(keyGuardPath)).toBe(true);
  });

  it("contains no import, export-from, require, process, globalThis, fetch, eval or Function", () => {
    const content = fs.readFileSync(keyGuardPath, "utf8");

    const forbiddenPatterns: Array<[RegExp, string]> = [
      // Catches a static or dynamic `import(...)`/`import "x"`/`import type`.
      [/\bimport\b/, "import"],
      // A re-export (`export { x } from "y"` / `export * from "y"`) is still
      // a module boundary this file should never have; a plain
      // `export function assertAnonKey` does not match (no "from").
      [/\bexport\b[^;\n]*\bfrom\b/, "export ... from"],
      [/\brequire\b/, "require"],
      [/\bprocess\b/, "process"],
      [/\bglobalThis\b/, "globalThis"],
      [/\bfetch\b/, "fetch"],
      [/\beval\b/, "eval"],
      [/\bFunction\b/, "Function"],
    ];

    for (const [pattern, label] of forbiddenPatterns) {
      expect(pattern.test(content), `key-guard.ts must not contain "${label}"`).toBe(false);
    }
  });
});
