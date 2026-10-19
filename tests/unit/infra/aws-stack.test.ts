// Static HCL checks for the new infra/aws stack (PR A,
// infra/aws-pipeline-and-roles). Same approach as bootstrap-hcl.test.ts: a
// brace-counting text scan (hcl.ts), not a real HCL parser. Reuses
// extractBlock(s)/stripHclComments from hcl.ts (they take a plain `source`
// string, so they work unchanged against infra/aws content) and the new
// directory-parameterised readers in tf-dir.ts.
//
// Run with: pnpm test (vitest run --project unit)

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { extractBlock, extractBlocks, stripHclComments } from "./hcl";
import { awsDir, concatTfFrom, readAllTfFrom, readFileFrom, repoRoot } from "./tf-dir";

const tofuScript = fs.readFileSync(path.join(repoRoot, "scripts/tofu.sh"), "utf8");
const STATE_KEY_ARN = "arn:aws:kms:eu-central-1:278311879197:key/88593446-cbdc-4378-a1b3-6b7a92c427f1";

function expectedTofuVersion(): string {
  const match = tofuScript.match(/VERSION="([^"]+)"/);
  if (!match || !match[1]) throw new Error("could not find VERSION= in scripts/tofu.sh");
  return match[1];
}

/**
 * Resolves a `kms_key_id = ...` (or any `attr = ...`) value inside `body` to a
 * literal string: either the value is already a quoted literal, or it is a
 * `local.<name>` reference, in which case the referenced local (looked up in
 * any `locals { ... }` block in `source`) must itself be the literal, exactly
 * as infra/bootstrap's `local.state_key_arn` pattern does.
 */
function resolveLiteral(source: string, body: string, attr: string): string | undefined {
  const direct = body.match(new RegExp(`${attr}\\s*=\\s*"([^"]+)"`));
  if (direct) return direct[1];

  const localRef = body.match(new RegExp(`${attr}\\s*=\\s*local\\.([a-zA-Z0-9_]+)`));
  if (!localRef) return undefined;

  const localsBlocks = extractBlocks(source, /locals\s*(?=\{)/);
  for (const block of localsBlocks) {
    const assignment = block.body.match(new RegExp(`${localRef[1]}\\s*=\\s*"([^"]+)"`));
    if (assignment) return assignment[1];
  }
  return undefined;
}

describe("infra/aws exists as a stack", () => {
  it("infra/aws is a directory containing at least one .tf file", () => {
    expect(fs.existsSync(awsDir), "expected infra/aws to exist").toBe(true);
    expect(readAllTfFrom(awsDir).length).toBeGreaterThan(0);
  });
});

describe("infra/aws/versions.tf", () => {
  it("pins required_version to the same value as scripts/tofu.sh, and the aws provider to exactly 6.67.0", () => {
    const source = concatTfFrom(awsDir);

    const terraformBlock = extractBlock(source, /terraform\s*(?=\{)/);
    expect(terraformBlock, "expected a `terraform { ... }` block in infra/aws").toBeDefined();

    const requiredVersionMatch = terraformBlock?.body.match(/required_version\s*=\s*"([^"]+)"/);
    expect(requiredVersionMatch?.[1]).toBe(expectedTofuVersion());

    const requiredProvidersBlock = extractBlock(terraformBlock?.body ?? "", /required_providers\s*(?=\{)/);
    expect(requiredProvidersBlock, "expected a `required_providers { ... }` block").toBeDefined();

    const awsProviderBlock = extractBlock(requiredProvidersBlock?.body ?? "", /aws\s*=\s*(?=\{)/);
    expect(awsProviderBlock, "expected `aws = { ... }` inside required_providers").toBeDefined();
    expect(awsProviderBlock?.body).toMatch(/source\s*=\s*"hashicorp\/aws"/);

    const versionMatch = awsProviderBlock?.body.match(/version\s*=\s*"([^"]+)"/);
    expect(versionMatch?.[1]).toBe("6.67.0");
  });

  it("has exactly one backend block, type s3, pointed at the infra/aws state key with a locking, encrypted write path, and no profile argument", () => {
    const source = concatTfFrom(awsDir);
    const terraformBlock = extractBlock(source, /terraform\s*(?=\{)/);
    expect(terraformBlock, "expected a `terraform { ... }` block").toBeDefined();

    const backendBlocks = extractBlocks(terraformBlock?.body ?? "", /backend\s+"[a-z0-9_]+"\s*(?=\{)/);
    expect(backendBlocks).toHaveLength(1);

    const backend = backendBlocks[0];
    expect(backend?.header).toMatch(/backend\s+"s3"/);
    expect(backend?.body).toMatch(/bucket\s*=\s*"nblm-tofu-state-278311879197"/);
    expect(backend?.body).toMatch(/key\s*=\s*"aws\/terraform\.tfstate"/);
    expect(backend?.body).toMatch(/region\s*=\s*"eu-central-1"/);
    expect(backend?.body).toMatch(/use_lockfile\s*=\s*true/);
    expect(backend?.body).toMatch(/encrypt\s*=\s*true/);
    expect(backend?.body).toMatch(/allowed_account_ids\s*=\s*\[\s*"278311879197"\s*\]/);
    expect(backend?.body ?? "").not.toMatch(/\bprofile\s*=/);

    const resolvedKmsKeyId = resolveLiteral(source, backend?.body ?? "", "kms_key_id");
    expect(
      resolvedKmsKeyId,
      "expected the backend's kms_key_id to be the state key arn literal, or a local that resolves to it",
    ).toBe(STATE_KEY_ARN);
  });

  it("the encryption block uses aws_kms/aes_gcm on the same state key, with exactly two enforced = true and no unencrypted method or fallback", () => {
    const source = stripHclComments(concatTfFrom(awsDir));
    const terraformBlock = extractBlock(source, /terraform\s*(?=\{)/);
    expect(terraformBlock, "expected a `terraform { ... }` block").toBeDefined();

    const encryption = extractBlock(terraformBlock?.body ?? "", /encryption\s*(?=\{)/);
    expect(encryption, "expected an encryption { ... } block inside terraform {}").toBeDefined();

    const keyProviderBlocks = extractBlocks(encryption?.body ?? "", /key_provider\s+"aws_kms"\s+"[a-z0-9_]+"\s*(?=\{)/);
    expect(keyProviderBlocks.length).toBeGreaterThan(0);
    const keyProvider = keyProviderBlocks[0];

    const resolvedKmsKeyId = resolveLiteral(source, keyProvider?.body ?? "", "kms_key_id");
    expect(
      resolvedKmsKeyId,
      "expected the key_provider's kms_key_id to be the state key arn literal, or a local that resolves to it",
    ).toBe(STATE_KEY_ARN);

    const methodBlocks = extractBlocks(encryption?.body ?? "", /method\s+"[^"]+"\s+"[^"]+"\s*(?=\{)/);
    expect(methodBlocks).toHaveLength(1);
    expect(methodBlocks[0]?.header).toMatch(/method\s+"aes_gcm"/);

    expect(encryption?.body ?? "").not.toMatch(/method\s+"unencrypted"/);
    expect(encryption?.body ?? "").not.toMatch(/fallback\s*(?=\{)/);

    const stateBlock = extractBlock(encryption?.body ?? "", /state\s*(?=\{)/);
    const planBlock = extractBlock(encryption?.body ?? "", /plan\s*(?=\{)/);
    expect(stateBlock, "expected a state { ... } block inside encryption").toBeDefined();
    expect(planBlock, "expected a plan { ... } block inside encryption").toBeDefined();
    expect(stateBlock?.body).toMatch(/enforced\s*=\s*true/);
    expect(planBlock?.body).toMatch(/enforced\s*=\s*true/);

    const enforcedValues = [...(encryption?.body ?? "").matchAll(/\benforced\s*=\s*(\S+)/g)].map((m) => m[1]);
    expect(enforcedValues).toHaveLength(2);
    for (const value of enforcedValues) {
      expect(value).toBe("true");
    }
  });

  it("no profile argument anywhere in infra/aws/*.tf (CI authenticates through OIDC environment credentials, not a named profile)", () => {
    const files = readAllTfFrom(awsDir);
    const offenders = files.filter((file) => /\bprofile\s*=/.test(stripHclComments(file.content))).map((file) => file.fileName);
    expect(offenders, "no infra/aws/*.tf file may set a `profile` argument").toEqual([]);
  });
});

describe("infra/aws/providers.tf", () => {
  it("has exactly one provider \"aws\" block, unaliased, region eu-central-1, scoped to the workload account", () => {
    const source = concatTfFrom(awsDir);
    const providerBlocks = extractBlocks(source, /provider\s+"aws"\s*(?=\{)/);
    expect(providerBlocks).toHaveLength(1);

    const provider = providerBlocks[0];
    expect(provider?.body ?? "").not.toMatch(/\balias\s*=/);
    expect(provider?.body).toMatch(/region\s*=\s*"eu-central-1"/);
    expect(provider?.body).toMatch(/allowed_account_ids\s*=\s*\[\s*"278311879197"\s*\]/);
  });
});

describe("infra/aws/.terraform.lock.hcl", () => {
  it("pins registry.opentofu.org/hashicorp/aws to 6.67.0", () => {
    expect(fs.existsSync(path.join(awsDir, ".terraform.lock.hcl")), "expected infra/aws/.terraform.lock.hcl to exist").toBe(true);

    const content = readFileFrom(awsDir, ".terraform.lock.hcl");
    const providerBlock = extractBlock(content, /provider\s+"registry\.opentofu\.org\/hashicorp\/aws"\s*(?=\{)/);
    expect(providerBlock, 'expected a provider "registry.opentofu.org/hashicorp/aws" { ... } block').toBeDefined();
    expect(providerBlock?.body).toMatch(/version\s*=\s*"6\.67\.0"/);
    expect(providerBlock?.body).toMatch(/h1:/);
  });
});

describe("infra/aws outputs", () => {
  it("defines develop_role_arn and production_role_arn", () => {
    const source = concatTfFrom(awsDir);
    expect(extractBlock(source, /output\s+"develop_role_arn"\s*(?=\{)/), 'expected output "develop_role_arn" { ... }').toBeDefined();
    expect(
      extractBlock(source, /output\s+"production_role_arn"\s*(?=\{)/),
      'expected output "production_role_arn" { ... }',
    ).toBeDefined();
  });
});

// Note: the existing "no access_key, secret_key or token anywhere under
// infra/" guard in bootstrap-hcl.test.ts already scans the whole of infraDir
// (tests/unit/infra/hcl.ts's walkFiles(infraDir)), so it covers infra/aws too
// once that directory exists; it is not duplicated here.
