import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { bootstrapDir } from "./hcl";
import { EXPECTED_ACCOUNT_SECURITY_CONTENT } from "./region-guard-fixtures";

const policyPath = path.join(bootstrapDir, "policies/scp-account-security.json");

describe("infra/bootstrap/policies/scp-account-security.json", () => {
  it("deep-equals the imported p-ivy9gxl6 (ManagedAccountSecurityControlPolicy) content, so the import shows no diff", () => {
    const raw = fs.readFileSync(policyPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;

    expect(parsed).toEqual(EXPECTED_ACCOUNT_SECURITY_CONTENT);
  });
});
