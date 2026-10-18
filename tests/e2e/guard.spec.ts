// Mirrors the static guard in tests/rls/harness.test.ts: tests/e2e signs in
// real, freshly-created local users (see helpers/session.ts) and must never
// grow a dependency on the admin/service credential or the JWT signing
// secret. This check needs no browser, so it runs even where the Chromium
// binary is not available.
import * as fs from "node:fs";
import * as path from "node:path";
import { expect, test } from "@playwright/test";

const e2eDir = path.resolve(import.meta.dirname, ".");
const selfFile = path.resolve(e2eDir, "guard.spec.ts");
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

test("tests/e2e contains no admin credential material", () => {
  const offenders: string[] = [];
  for (const file of collectFiles(e2eDir)) {
    if (path.resolve(file) === selfFile) continue; // this file has to name the forbidden substrings

    const content = fs.readFileSync(file, "utf8");
    for (const needle of forbidden) {
      if (content.includes(needle)) {
        offenders.push(`${path.relative(e2eDir, file)}: contains "${needle}"`);
      }
    }
  }

  expect(offenders).toEqual([]);
});
