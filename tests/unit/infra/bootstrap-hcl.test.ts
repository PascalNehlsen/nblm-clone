import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { bootstrapDir, concatTf, extractBlock, extractBlocks, infraDir, readBootstrapFile, walkFiles } from "./hcl";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const tofuScript = fs.readFileSync(path.join(repoRoot, "scripts/tofu.sh"), "utf8");

function expectedTofuVersion(): string {
  const match = tofuScript.match(/VERSION="([^"]+)"/);
  if (!match || !match[1]) throw new Error("could not find VERSION= in scripts/tofu.sh");
  return match[1];
}

describe("infra/bootstrap/versions.tf", () => {
  it("pins required_version to the same value as scripts/tofu.sh, and the aws provider to exactly 6.67.0", () => {
    const source = concatTf();

    const terraformBlock = extractBlock(source, /terraform\s*(?=\{)/);
    expect(terraformBlock, "expected a `terraform { ... }` block").toBeDefined();

    const requiredVersionMatch = terraformBlock?.body.match(/required_version\s*=\s*"([^"]+)"/);
    expect(requiredVersionMatch?.[1]).toBe("1.13.1");
    expect(requiredVersionMatch?.[1]).toBe(expectedTofuVersion());

    const requiredProvidersBlock = extractBlock(terraformBlock?.body ?? "", /required_providers\s*(?=\{)/);
    expect(requiredProvidersBlock, "expected a `required_providers { ... }` block").toBeDefined();

    const awsProviderBlock = extractBlock(requiredProvidersBlock?.body ?? "", /aws\s*=\s*(?=\{)/);
    expect(awsProviderBlock, "expected `aws = { ... }` inside required_providers").toBeDefined();
    expect(awsProviderBlock?.body).toMatch(/source\s*=\s*"hashicorp\/aws"/);

    const versionMatch = awsProviderBlock?.body.match(/version\s*=\s*"([^"]+)"/);
    expect(versionMatch?.[1]).toBe("6.67.0");
  });

  it("has no backend block (local state in this PR)", () => {
    const source = concatTf();
    const terraformBlock = extractBlock(source, /terraform\s*(?=\{)/);
    expect(terraformBlock?.body ?? "").not.toMatch(/backend\s+"/);
  });
});

describe("infra/bootstrap providers: exactly two `provider \"aws\"` blocks", () => {
  it("has a default provider with the workload profile/account and an aliased management provider", () => {
    const source = concatTf();
    const providerBlocks = extractBlocks(source, /provider\s+"aws"\s*(?=\{)/);

    expect(providerBlocks).toHaveLength(2);

    const defaultProviders = providerBlocks.filter((block) => !/alias\s*=/.test(block.body));
    const managementProviders = providerBlocks.filter((block) => /alias\s*=\s*"management"/.test(block.body));

    expect(defaultProviders).toHaveLength(1);
    expect(managementProviders).toHaveLength(1);

    const defaultBody = defaultProviders[0]?.body ?? "";
    expect(defaultBody).toMatch(/profile\s*=\s*var\.workload_profile/);
    expect(defaultBody).toMatch(/allowed_account_ids\s*=\s*\[\s*"278311879197"\s*\]/);

    const managementBody = managementProviders[0]?.body ?? "";
    expect(managementBody).toMatch(/profile\s*=\s*var\.management_profile/);
    expect(managementBody).toMatch(/allowed_account_ids\s*=\s*\[\s*"482146446868"\s*\]/);
  });

  it("variables.tf: workload_profile defaults to nblm-workload, management_profile to nblm-mgmt-admin", () => {
    const source = concatTf();

    const workloadVar = extractBlock(source, /variable\s+"workload_profile"\s*(?=\{)/);
    const managementVar = extractBlock(source, /variable\s+"management_profile"\s*(?=\{)/);

    expect(workloadVar, "expected variable \"workload_profile\" { ... }").toBeDefined();
    expect(managementVar, "expected variable \"management_profile\" { ... }").toBeDefined();

    expect(workloadVar?.body).toMatch(/default\s*=\s*"nblm-workload"/);
    expect(managementVar?.body).toMatch(/default\s*=\s*"nblm-mgmt-admin"/);
  });

  it("no access_key, secret_key or token anywhere under infra/", () => {
    const files = walkFiles(infraDir).filter((file) => !file.includes(`${path.sep}.terraform${path.sep}`));

    const offenders: string[] = [];
    for (const file of files) {
      const content = fs.readFileSync(file, "utf8");
      if (/\b(access_key|secret_key|token)\b/i.test(content)) {
        offenders.push(path.relative(repoRoot, file));
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe("infra/bootstrap: the PR 1 imports are applied, so there are no import blocks left", () => {
  it("infra/bootstrap/imports.tf does not exist", () => {
    expect(fs.existsSync(path.join(bootstrapDir, "imports.tf"))).toBe(false);
  });

  it("no `import { ... }` block exists in any infra/bootstrap/*.tf file", () => {
    const source = concatTf();
    const importBlocks = extractBlocks(source, /import\s*(?=\{)/);
    expect(importBlocks).toEqual([]);
  });
});

describe("infra/bootstrap: the legacy region SCP is detached", () => {
  it("no resource named legacy_region_restriction_root exists", () => {
    const source = concatTf();
    const attachments = extractBlocks(source, /resource\s+"aws_organizations_policy_attachment"\s+"[a-z_]+"\s*(?=\{)/);
    const names = attachments.map((block) => block.header.match(/"aws_organizations_policy_attachment"\s+"([a-z_]+)"/)?.[1]);
    expect(names).not.toContain("legacy_region_restriction_root");
  });

  it("no infra/bootstrap/*.tf file references p-grnvof89", () => {
    const source = concatTf();
    expect(source).not.toContain("p-grnvof89");
  });
});

describe("infra/bootstrap/scp.tf: protected vs. detachable resources", () => {
  const protectedResources: Array<[type: string, name: string]> = [
    ["aws_organizations_policy", "region_guard"],
    ["aws_organizations_policy_attachment", "region_guard_root"],
    ["aws_organizations_policy", "account_security"],
    ["aws_organizations_policy_attachment", "account_security_root"],
  ];

  function resourceBlock(type: string, name: string) {
    const source = concatTf();
    return extractBlock(source, new RegExp(`resource\\s+"${type}"\\s+"${name}"\\s*(?=\\{)`));
  }

  it.each(protectedResources)("%s.%s has lifecycle { prevent_destroy = true }", (type, name) => {
    const resource = resourceBlock(type, name);
    expect(resource, `expected resource "${type}" "${name}" { ... }`).toBeDefined();

    const lifecycle = extractBlock(resource?.body ?? "", /lifecycle\s*(?=\{)/);
    expect(lifecycle, `expected a lifecycle block in ${type}.${name}`).toBeDefined();
    expect(lifecycle?.body).toMatch(/prevent_destroy\s*=\s*true/);
  });

  it("every aws_organizations_* resource now has lifecycle { prevent_destroy = true }: none are detachable left after PR 1's imports are applied", () => {
    const source = concatTf();
    const organizationsResources = extractBlocks(source, /resource\s+"(aws_organizations_[a-z_]+)"\s+"[a-z_]+"\s*(?=\{)/);
    expect(organizationsResources.length).toBeGreaterThan(0);

    for (const resource of organizationsResources) {
      const lifecycle = extractBlock(resource.body, /lifecycle\s*(?=\{)/);
      expect(lifecycle, `expected a lifecycle block in ${resource.header}`).toBeDefined();
      expect(lifecycle?.body, `expected prevent_destroy = true in ${resource.header}`).toMatch(/prevent_destroy\s*=\s*true/);
    }
  });

  it("every aws_organizations_* resource uses provider = aws.management", () => {
    const source = concatTf();
    const organizationsResources = extractBlocks(source, /resource\s+"(aws_organizations_[a-z_]+)"\s+"[a-z_]+"\s*(?=\{)/);
    expect(organizationsResources.length).toBeGreaterThan(0);

    for (const resource of organizationsResources) {
      expect(resource.body, `${resource.header} should set provider = aws.management`).toMatch(/provider\s*=\s*aws\.management/);
    }
  });

  it("exactly two aws_organizations_policy_attachment resources exist (region_guard_root, account_security_root), both targeting r-tmxq", () => {
    const source = concatTf();
    const attachments = extractBlocks(source, /resource\s+"aws_organizations_policy_attachment"\s+"[a-z_]+"\s*(?=\{)/);
    const names = attachments.map((block) => block.header.match(/"aws_organizations_policy_attachment"\s+"([a-z_]+)"/)?.[1]);

    expect(new Set(names)).toEqual(new Set(["region_guard_root", "account_security_root"]));
    expect(attachments).toHaveLength(2);

    for (const attachment of attachments) {
      expect(attachment.body, `${attachment.header} should target r-tmxq`).toMatch(/target_id\s*=\s*"r-tmxq"/);
    }
  });

  it("region_guard content comes from policies/scp-region-guard.json, account_security from policies/scp-account-security.json", () => {
    const regionGuard = resourceBlock("aws_organizations_policy", "region_guard");
    const accountSecurity = resourceBlock("aws_organizations_policy", "account_security");

    expect(regionGuard?.body ?? "").toContain("policies/scp-region-guard.json");
    expect(accountSecurity?.body ?? "").toContain("policies/scp-account-security.json");
  });

  it("account_security has name and description ManagedAccountSecurityControlPolicy", () => {
    const accountSecurity = resourceBlock("aws_organizations_policy", "account_security");
    expect(accountSecurity?.body ?? "").toMatch(/name\s*=\s*"ManagedAccountSecurityControlPolicy"/);
    expect(accountSecurity?.body ?? "").toMatch(/description\s*=\s*"ManagedAccountSecurityControlPolicy"/);
  });

  it("region_guard is named nblm-region-guard and typed SERVICE_CONTROL_POLICY", () => {
    const regionGuard = resourceBlock("aws_organizations_policy", "region_guard");
    expect(regionGuard?.body ?? "").toMatch(/name\s*=\s*"nblm-region-guard"/);
    expect(regionGuard?.body ?? "").toMatch(/type\s*=\s*"SERVICE_CONTROL_POLICY"/);
  });
});

describe("infra/bootstrap tags: default_tags must not reach the imported wizard policy", () => {
  function resourceBlock(type: string, name: string) {
    const source = concatTf();
    return extractBlock(source, new RegExp(`resource\\s+"${type}"\\s+"${name}"\\s*(?=\\{)`));
  }

  it("the management provider (alias = \"management\") has no default_tags block", () => {
    const source = concatTf();
    const providerBlocks = extractBlocks(source, /provider\s+"aws"\s*(?=\{)/);
    const managementProvider = providerBlocks.find((block) => /alias\s*=\s*"management"/.test(block.body));

    expect(managementProvider, "expected a provider \"aws\" { alias = \"management\" ... } block").toBeDefined();
    // Checks for an actual `default_tags { ... }` block, not just the word
    // "default_tags" anywhere (a comment is allowed to explain why there
    // isn't one).
    expect(extractBlock(managementProvider?.body ?? "", /default_tags\s*(?=\{)/)).toBeUndefined();
  });

  it("account_security (the p-ivy9gxl6 import) has no tags, so the import shows no diff", () => {
    const accountSecurity = resourceBlock("aws_organizations_policy", "account_security");
    expect(accountSecurity, "expected resource \"aws_organizations_policy\" \"account_security\" { ... }").toBeDefined();
    expect(accountSecurity?.body ?? "").not.toMatch(/\btags\s*=/);
  });

  it("region_guard (the new policy) sets explicit tags: project, stack and managed-by", () => {
    const regionGuard = resourceBlock("aws_organizations_policy", "region_guard");
    expect(regionGuard, "expected resource \"aws_organizations_policy\" \"region_guard\" { ... }").toBeDefined();

    const tagsBlock = extractBlock(regionGuard?.body ?? "", /tags\s*=\s*(?=\{)/);
    expect(tagsBlock, "expected a tags = { ... } block in region_guard").toBeDefined();

    expect(tagsBlock?.body).toMatch(/project\s*=\s*"nblm-clone"/);
    expect(tagsBlock?.body).toMatch(/stack\s*=\s*"bootstrap"/);
    expect(tagsBlock?.body).toMatch(/managed-by\s*=\s*"opentofu"/);
  });
});

describe("infra/bootstrap/.terraform.lock.hcl", () => {
  it("pins registry.opentofu.org/hashicorp/aws to 6.67.0 with at least one h1: hash", () => {
    const content = readBootstrapFile(".terraform.lock.hcl");

    const providerBlock = extractBlock(content, /provider\s+"registry\.opentofu\.org\/hashicorp\/aws"\s*(?=\{)/);
    expect(providerBlock, "expected a provider \"registry.opentofu.org/hashicorp/aws\" { ... } block").toBeDefined();

    expect(providerBlock?.body).toMatch(/version\s*=\s*"6\.67\.0"/);
    expect(providerBlock?.body).toMatch(/h1:/);
  });
});
