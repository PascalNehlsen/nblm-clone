// Unit tests for PR 3 (infra/bootstrap-state): the state bucket, its KMS key
// and the GitHub OIDC provider + plan/apply roles in infra/bootstrap.
//
// Two kinds of checks, mirroring bootstrap-hcl.test.ts:
//  - the IAM/KMS/S3 policy *.json.tftpl templates, read and parsed as plain
//    JSON (the ${...} placeholders only ever appear inside JSON string
//    values, so the raw template text is valid JSON on its own);
//  - HCL text checks over infra/bootstrap/*.tf using the brace-counting
//    helpers in ./hcl.
//
// state.tf, oidc.tf, outputs.tf and the policy templates already exist (PR
// 3's first pass is built, and this file was green for it). This file also
// carries review follow-ups for the apply-guard policy (the bootstrap state
// prefix from ADR 0002, the key alias arn, kms:CreateGrant and iam:UpdateRole
// on both roles) that the builder has not added yet, so only those specific
// assertions are expected to fail: the apply-guard lookups succeed (the
// template and the resource both exist), but some of the actions/resources
// they check for are still missing from the rendered policy.

import { describe, expect, it } from "vitest";
import { concatTf, extractBlock, extractBlocks, readBootstrapFile } from "./hcl";

function resourceBlock(type: string, name: string) {
  const source = concatTf();
  return extractBlock(source, new RegExp(`resource\\s+"${type}"\\s+"${name}"\\s*(?=\\{)`));
}

function outputBlock(name: string) {
  const source = concatTf();
  return extractBlock(source, new RegExp(`output\\s+"${name}"\\s*(?=\\{)`));
}

// ---------------------------------------------------------------------------
// Policy template JSON helpers
// ---------------------------------------------------------------------------

interface IamStatement {
  Sid?: string;
  Effect: string;
  Principal?: string | Record<string, unknown>;
  Action?: string | string[];
  Resource?: string | string[];
  Condition?: Record<string, Record<string, unknown>>;
}

interface IamPolicyDocument {
  Version: string;
  Statement: IamStatement[];
}

function readPolicyTemplate(relativePath: string): IamPolicyDocument {
  const raw = readBootstrapFile(relativePath);
  return JSON.parse(raw) as IamPolicyDocument;
}

/** Normalises an IAM Action/Resource value (string or string[]) to an array. */
function toArray(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function expectNoWildcard(value: string, label: string) {
  expect(value, `${label} must not contain a wildcard character`).not.toMatch(/[*?]/);
}

/** Sums the actions denied/allowed per resource, across every statement in the document. */
function actionsByResource(policy: IamPolicyDocument): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const statement of policy.Statement) {
    for (const resource of toArray(statement.Resource)) {
      const actions = map.get(resource) ?? new Set<string>();
      for (const action of toArray(statement.Action)) actions.add(action);
      map.set(resource, actions);
    }
  }
  return map;
}

const TEMPLATES = [
  "policies/trust-github-plan.json.tftpl",
  "policies/trust-github-apply.json.tftpl",
  "policies/plan-state-read.json.tftpl",
  "policies/plan-budgets-read.json.tftpl",
  "policies/apply-guard.json.tftpl",
  "policies/kms-state-key.json.tftpl",
  "policies/state-bucket.json.tftpl",
];

// P1 fix from the Codex review: the plan role must not trust every
// pull_request run. Anyone who can push a branch (the sandbox included)
// could then run arbitrary code (scripts/tofu.sh, an external data source)
// with the plan role. The plan job now runs in the GitHub environment "plan",
// which has a required reviewer, exactly like the apply role's "infra".
const PLAN_SUBJECT = "repo:PascalNehlsen@164803589/nblm-clone@1421836505:environment:plan";
const APPLY_SUBJECT = "repo:PascalNehlsen@164803589/nblm-clone@1421836505:environment:infra";
const MUTABLE_SUBJECT_PREFIX = "repo:PascalNehlsen/nblm-clone";

describe("infra/bootstrap policy templates: well-formed JSON documents", () => {
  it.each(TEMPLATES)("%s parses as JSON, has Version 2012-10-17 and unique Sids", (relativePath) => {
    const policy = readPolicyTemplate(relativePath);

    expect(policy.Version).toBe("2012-10-17");
    expect(Array.isArray(policy.Statement)).toBe(true);
    expect(policy.Statement.length).toBeGreaterThan(0);

    const sids = policy.Statement.map((statement) => statement.Sid);
    for (const sid of sids) {
      expect(typeof sid, "every statement needs an explicit Sid").toBe("string");
    }
    expect(new Set(sids).size).toBe(sids.length);
  });
});

function expectTrustPolicy(relativePath: string, expectedSubs: string | string[]) {
  const expectedList = Array.isArray(expectedSubs) ? expectedSubs : [expectedSubs];
  const policy = readPolicyTemplate(relativePath);
  expect(policy.Statement).toHaveLength(1);
  const statement = policy.Statement[0];
  if (!statement) throw new Error("expected exactly one statement");

  expect(statement.Effect).toBe("Allow");

  const principal = statement.Principal;
  expect(principal).not.toBe("*");
  const federated = typeof principal === "object" && principal !== null ? (principal as { Federated?: unknown }).Federated : undefined;
  expect(federated).toBe("${oidc_provider_arn}");
  expectNoWildcard(String(federated), "Principal.Federated");

  expect(toArray(statement.Action)).toEqual(["sts:AssumeRoleWithWebIdentity"]);

  const conditionKeys = Object.keys(statement.Condition ?? {});
  expect(conditionKeys).toEqual(["StringEquals"]);

  const stringEquals = statement.Condition?.StringEquals ?? {};
  const conditionValueKeys = Object.keys(stringEquals);
  expect(conditionValueKeys.sort()).toEqual(
    ["token.actions.githubusercontent.com:aud", "token.actions.githubusercontent.com:sub"].sort(),
  );

  const aud = toArray(stringEquals["token.actions.githubusercontent.com:aud"] as string | string[] | undefined);
  const sub = toArray(stringEquals["token.actions.githubusercontent.com:sub"] as string | string[] | undefined);

  expect(aud).toEqual(["sts.amazonaws.com"]);
  // Exactly the expected subjects (order free), no more: the plan role now
  // takes two (plan and drift), the apply role still one.
  expect([...sub].sort()).toEqual([...expectedList].sort());
  for (const value of [...aud, ...sub]) expectNoWildcard(value, "condition value");

  for (const s of sub) {
    expect(s).not.toContain(MUTABLE_SUBJECT_PREFIX);

    // P1 review fix: neither role may trust a plain pull_request run or a
    // branch/tag ref (anyone who can push one, including the sandbox, could
    // then run arbitrary code with that role). Every trusted subject must be
    // scoped to a GitHub environment. Not every environment has a required
    // reviewer: `plan` and `infra` do, `drift` has none and is restricted to
    // the main branch only (ADR 0024).
    expect(s, "must not trust every pull_request run").not.toContain(":pull_request");
    expect(s, "must not trust a branch or tag ref").not.toContain(":ref:");
    expect(s, "must be scoped to a GitHub environment").toMatch(/:environment:[a-z-]+$/);
  }

  const raw = JSON.stringify(policy);
  expect(raw).not.toContain("StringLike");
  expect(raw).not.toContain("ForAnyValue");
  expect(raw).not.toContain("ForAllValues");
}

// Drift detection (nightly plan, .github/workflows/drift.yml) runs in the GitHub
// environment `drift` and assumes the same read-only plan role.
const DRIFT_SUBJECT = "repo:PascalNehlsen@164803589/nblm-clone@1421836505:environment:drift";

describe("infra/bootstrap/policies/trust-github-plan.json.tftpl", () => {
  it("trusts the GitHub OIDC provider for exactly the plan and drift environments, on the immutable repo subject, with StringEquals", () => {
    expectTrustPolicy("policies/trust-github-plan.json.tftpl", [PLAN_SUBJECT, DRIFT_SUBJECT]);
  });

  it("the drift subject differs from the plan subject only in the environment name, and the apply subject is not trusted", () => {
    expect(DRIFT_SUBJECT.replace(/:environment:drift$/, ":environment:plan")).toBe(PLAN_SUBJECT);
    const raw = readBootstrapFile("policies/trust-github-plan.json.tftpl");
    expect(raw).not.toContain(":environment:infra");
  });
});

describe("infra/bootstrap: the plan role's budgets read (drift plan of the aws stack reads the budget)", () => {
  const TEMPLATE = "policies/plan-budgets-read.json.tftpl";

  it("aws_iam_role_policy.tofu_plan_budgets_read renders policies/plan-budgets-read.json.tftpl for the plan role, with the workload account id", () => {
    const policy = resourceBlock("aws_iam_role_policy", "tofu_plan_budgets_read");
    expect(policy, "expected aws_iam_role_policy.tofu_plan_budgets_read").toBeDefined();
    expect(policy?.body ?? "").toContain(TEMPLATE);
    expect(policy?.body ?? "").toMatch(/role\s*=\s*aws_iam_role\.tofu_plan\.id/);
    expect(policy?.body ?? "").toMatch(/account_id\s*=\s*(local\.account_id|"278311879197")/);
    expect(policy?.body ?? "").not.toMatch(/provider\s*=\s*aws\.management/);
  });

  it("is a well-formed document with one Allow statement for exactly budgets:ViewBudget and budgets:ListTagsForResource on budget/* of the workload account", () => {
    const policy = readPolicyTemplate(TEMPLATE);
    expect(policy.Version).toBe("2012-10-17");
    expect(policy.Statement).toHaveLength(1);
    const statement = policy.Statement[0];
    expect(statement?.Effect).toBe("Allow");
    expect(typeof statement?.Sid).toBe("string");
    expect([...toArray(statement?.Action)].sort()).toEqual(["budgets:ListTagsForResource", "budgets:ViewBudget"]);
    const resources = toArray(statement?.Resource);
    expect(resources).toHaveLength(1);
    expect(resources[0]).toMatch(/^arn:aws:budgets::(\$\{account_id\}|278311879197):budget\/\*$/);
    expect(statement?.Condition).toBeUndefined();
    expect(statement?.Principal).toBeUndefined();
  });

  it("grants no write action and no wildcard action", () => {
    const actions = readPolicyTemplate(TEMPLATE)
      .Statement.filter((s) => s.Effect === "Allow")
      .flatMap((s) => toArray(s.Action));
    expect(actions.length).toBeGreaterThan(0);
    for (const action of actions) {
      expect(action).not.toMatch(/[*?]/);
      expect(action).not.toMatch(/^budgets:(Create|Update|Delete|Modify|Tag|Untag|Execute)/);
    }
  });
});

describe("infra/bootstrap/policies/trust-github-apply.json.tftpl", () => {
  it("trusts the GitHub OIDC provider for the infra environment on the immutable repo subject", () => {
    expectTrustPolicy("policies/trust-github-apply.json.tftpl", APPLY_SUBJECT);
  });
});

describe("infra/bootstrap: the plan and apply trust subjects", () => {
  it("are different GitHub environments, so neither role can be assumed via the other's environment", () => {
    const planSub = toArray(
      readPolicyTemplate("policies/trust-github-plan.json.tftpl").Statement[0]?.Condition?.StringEquals?.[
        "token.actions.githubusercontent.com:sub"
      ] as string | string[] | undefined,
    )[0];
    const applySub = toArray(
      readPolicyTemplate("policies/trust-github-apply.json.tftpl").Statement[0]?.Condition?.StringEquals?.[
        "token.actions.githubusercontent.com:sub"
      ] as string | string[] | undefined,
    )[0];

    expect(planSub).toBeDefined();
    expect(applySub).toBeDefined();
    expect(planSub).not.toEqual(applySub);
  });
});

describe("infra/bootstrap/policies/plan-state-read.json.tftpl", () => {
  const policy = () => readPolicyTemplate("policies/plan-state-read.json.tftpl");

  it("allows s3:ListBucket on the bucket arn only", () => {
    const statement = policy().Statement.find((s) => s.Effect === "Allow" && toArray(s.Action).includes("s3:ListBucket"));
    expect(statement, "expected an Allow statement for s3:ListBucket").toBeDefined();
    expect(toArray(statement?.Resource)).toEqual(["${bucket_arn}"]);
  });

  it("allows s3:GetObject on the bucket's objects only", () => {
    const statement = policy().Statement.find((s) => s.Effect === "Allow" && toArray(s.Action).includes("s3:GetObject"));
    expect(statement, "expected an Allow statement for s3:GetObject").toBeDefined();
    expect(toArray(statement?.Resource)).toEqual(["${bucket_arn}/*"]);
  });

  it("allows kms:Decrypt on the key arn only", () => {
    const statement = policy().Statement.find((s) => s.Effect === "Allow" && toArray(s.Action).includes("kms:Decrypt"));
    expect(statement, "expected an Allow statement for kms:Decrypt").toBeDefined();
    expect(toArray(statement?.Resource)).toEqual(["${key_arn}"]);
  });

  it("denies writing or deleting objects in the bucket", () => {
    const byResource = actionsByResource(policy());
    const objectActions = byResource.get("${bucket_arn}/*") ?? new Set();
    const denyStatements = policy().Statement.filter(
      (s) => s.Effect === "Deny" && toArray(s.Resource).includes("${bucket_arn}/*"),
    );
    expect(denyStatements.length).toBeGreaterThan(0);

    for (const action of ["s3:PutObject", "s3:DeleteObject", "s3:DeleteObjectVersion"]) {
      expect(objectActions.has(action), `expected ${action} denied on \${bucket_arn}/*`).toBe(true);
    }
  });

  // Requirement change in PR 4 (ADR 0003): OpenTofu 1.13.1's aws_kms key
  // provider calls kms:GenerateDataKey on every Provide() call, including
  // plan-only, read-only runs, so the plan role needs it. The blanket
  // `/^kms:GenerateDataKey/` prefix check below is narrowed to the two
  // data-key variants that are never needed for reading state: the "without
  // plaintext" and the asymmetric "pair" forms. Plain kms:GenerateDataKey is
  // covered by its own allow-list test below instead.
  it("no Allow action is wildcarded, a write/delete action, or an encrypt/pair-data-key/re-encrypt KMS action", () => {
    const allowActions = policy()
      .Statement.filter((s) => s.Effect === "Allow")
      .flatMap((s) => toArray(s.Action));

    expect(allowActions.length).toBeGreaterThan(0);
    for (const action of allowActions) {
      expect(action, `${action} must not be wildcarded`).not.toMatch(/[*?]/);
      expect(action, `${action} must not be a Put action`).not.toMatch(/^s3:Put/);
      expect(action, `${action} must not be a Delete action`).not.toMatch(/^s3:Delete/);
      expect(action, `${action} must not encrypt`).not.toBe("kms:Encrypt");
      expect(action, `${action} must not generate a data key without plaintext`).not.toBe("kms:GenerateDataKeyWithoutPlaintext");
      expect(action, `${action} must not generate an asymmetric data key pair`).not.toMatch(/^kms:GenerateDataKeyPair/);
      expect(action, `${action} must not re-encrypt`).not.toMatch(/^kms:ReEncrypt/);
    }
  });

  it(
    'allows kms:GenerateDataKey on the key arn only, with Sid "GenerateDataKeyForStateEncryption" and no Condition ' +
      "(ADR 0003: OpenTofu's aws_kms key provider calls GenerateDataKey on every Provide(), including reads)",
    () => {
      const statement = policy().Statement.find((s) => s.Sid === "GenerateDataKeyForStateEncryption");
      expect(statement, 'expected a statement with Sid "GenerateDataKeyForStateEncryption"').toBeDefined();
      expect(statement?.Effect).toBe("Allow");
      expect(toArray(statement?.Action)).toEqual(["kms:GenerateDataKey"]);
      expect(toArray(statement?.Resource)).toEqual(["${key_arn}"]);
      expect(statement?.Condition).toBeUndefined();
    },
  );

  // Review follow-up: the previous check only looked up Sid
  // "GenerateDataKeyForStateEncryption" and asserted things about it. A
  // second Allow statement, under a different Sid, granting
  // kms:GenerateDataKey (or a wildcard covering it, like kms:GenerateDataKey*,
  // kms:* or *) on "*" would have passed unnoticed. This scans every Allow
  // statement in the whole document for any action that is or covers
  // kms:GenerateDataKey, and requires there to be exactly one such statement:
  // the one found above.
  it("exactly one Allow statement grants a kms:GenerateDataKey-covering action, and it is GenerateDataKeyForStateEncryption scoped to the key arn", () => {
    const coversGenerateDataKey = (action: string) =>
      action === "kms:GenerateDataKey" || action === "kms:*" || action === "*" || /^kms:GenerateDataKey/.test(action);

    const grantingStatements = policy().Statement.filter(
      (s) => s.Effect === "Allow" && toArray(s.Action).some(coversGenerateDataKey),
    );

    expect(grantingStatements, "expected exactly one Allow statement granting a kms:GenerateDataKey-covering action").toHaveLength(1);

    const statement = grantingStatements[0];
    expect(statement?.Sid).toBe("GenerateDataKeyForStateEncryption");
    expect(toArray(statement?.Action)).toEqual(["kms:GenerateDataKey"]);
    expect(toArray(statement?.Resource)).toEqual(["${key_arn}"]);
  });

  it("no Allow statement's Resource mentions .tflock (use_lockfile creates a <key>.tflock object via conditional PutObject; the plan role must not be allowed to create it, since CI plans run with -lock=false)", () => {
    const allowResources = policy()
      .Statement.filter((s) => s.Effect === "Allow")
      .flatMap((s) => toArray(s.Resource));

    for (const resource of allowResources) {
      expect(resource, `${resource} must not reference .tflock`).not.toContain(".tflock");
    }
  });
});

describe("infra/bootstrap/policies/apply-guard.json.tftpl", () => {
  const policy = () => readPolicyTemplate("policies/apply-guard.json.tftpl");

  it("every statement is a Deny (the apply role otherwise keeps AdministratorAccess)", () => {
    for (const statement of policy().Statement) {
      expect(statement.Effect).toBe("Deny");
    }
  });

  it("denies destructive actions on the state bucket itself", () => {
    const bucketActions = actionsByResource(policy()).get("${bucket_arn}") ?? new Set();
    for (const action of [
      "s3:DeleteBucket",
      "s3:PutBucketPolicy",
      "s3:DeleteBucketPolicy",
      "s3:PutBucketVersioning",
      "s3:PutBucketPublicAccessBlock",
      "s3:PutEncryptionConfiguration",
      "s3:PutLifecycleConfiguration",
      "s3:PutBucketOwnershipControls",
      "s3:PutReplicationConfiguration",
    ]) {
      expect(bucketActions.has(action), `expected ${action} denied on \${bucket_arn}`).toBe(true);
    }
  });

  it("denies permanently destroying any object version in the bucket", () => {
    const objectActions = actionsByResource(policy()).get("${bucket_arn}/*") ?? new Set();
    expect(objectActions.has("s3:DeleteObjectVersion"), "expected s3:DeleteObjectVersion denied on \${bucket_arn}/*").toBe(
      true,
    );
  });

  it("denies CI ever writing or deleting bootstrap's own state object (ADR 0002: bootstrap state lives under bucket_arn/bootstrap/*, from PR 4)", () => {
    const bootstrapPrefixActions = actionsByResource(policy()).get("${bucket_arn}/bootstrap/*") ?? new Set();
    for (const action of ["s3:PutObject", "s3:DeleteObject"]) {
      expect(bootstrapPrefixActions.has(action), `expected ${action} denied on \${bucket_arn}/bootstrap/*`).toBe(true);
    }
  });

  it("denies destructive actions on the KMS key, including creating new grants", () => {
    const keyActions = actionsByResource(policy()).get("${key_arn}") ?? new Set();
    for (const action of [
      "kms:ScheduleKeyDeletion",
      "kms:DisableKey",
      "kms:PutKeyPolicy",
      "kms:DisableKeyRotation",
      "kms:CreateGrant",
    ]) {
      expect(keyActions.has(action), `expected ${action} denied on \${key_arn}`).toBe(true);
    }
  });

  it("denies repointing or deleting the state key's alias", () => {
    const aliasActions = actionsByResource(policy()).get("${key_alias_arn}") ?? new Set();
    for (const action of ["kms:UpdateAlias", "kms:DeleteAlias"]) {
      expect(aliasActions.has(action), `expected ${action} denied on \${key_alias_arn}`).toBe(true);
    }
  });

  it("denies trust and policy changes, and whole-role updates, on both the plan and apply role", () => {
    const byResource = actionsByResource(policy());
    for (const resource of ["${plan_role_arn}", "${apply_role_arn}"]) {
      const roleActions = byResource.get(resource) ?? new Set();
      for (const action of [
        "iam:UpdateAssumeRolePolicy",
        "iam:DeleteRole",
        "iam:AttachRolePolicy",
        "iam:DetachRolePolicy",
        "iam:PutRolePolicy",
        "iam:DeleteRolePolicy",
        "iam:PutRolePermissionsBoundary",
        "iam:DeleteRolePermissionsBoundary",
        "iam:UpdateRole",
      ]) {
        expect(roleActions.has(action), `expected ${action} denied on ${resource}`).toBe(true);
      }
    }
  });

  it("denies changes to the OIDC provider", () => {
    const oidcActions = actionsByResource(policy()).get("${oidc_provider_arn}") ?? new Set();
    for (const action of [
      "iam:DeleteOpenIDConnectProvider",
      "iam:AddClientIDToOpenIDConnectProvider",
      "iam:RemoveClientIDFromOpenIDConnectProvider",
      "iam:UpdateOpenIDConnectProviderThumbprint",
    ]) {
      expect(oidcActions.has(action), `expected ${action} denied on \${oidc_provider_arn}`).toBe(true);
    }
  });
});

describe("infra/bootstrap/policies/kms-state-key.json.tftpl", () => {
  it("has exactly one Allow statement granting the account root kms:* on *", () => {
    const policy = readPolicyTemplate("policies/kms-state-key.json.tftpl");
    const allowStatements = policy.Statement.filter((s) => s.Effect === "Allow");
    expect(allowStatements).toHaveLength(1);

    const statement = allowStatements[0];
    if (!statement) throw new Error("expected one Allow statement");
    expect(statement.Principal).toEqual({ AWS: "arn:aws:iam::${account_id}:root" });
    expect(toArray(statement.Action)).toEqual(["kms:*"]);
    expect(toArray(statement.Resource)).toEqual(["*"]);
  });

  it('never grants Principal "*" (only the account root, so IAM policies decide)', () => {
    const policy = readPolicyTemplate("policies/kms-state-key.json.tftpl");
    for (const statement of policy.Statement) {
      expect(statement.Principal).not.toBe("*");
      if (typeof statement.Principal === "object" && statement.Principal !== null) {
        expect((statement.Principal as Record<string, unknown>).AWS).not.toBe("*");
      }
    }
  });
});

describe("infra/bootstrap/policies/state-bucket.json.tftpl", () => {
  it("has no Allow statements", () => {
    const policy = readPolicyTemplate("policies/state-bucket.json.tftpl");
    expect(policy.Statement.filter((s) => s.Effect === "Allow")).toEqual([]);
  });

  it('denies s3:* for Principal "*" on the bucket and its objects unless the transport is TLS', () => {
    const policy = readPolicyTemplate("policies/state-bucket.json.tftpl");
    const statement = policy.Statement.find(
      (s) => s.Effect === "Deny" && s.Principal === "*" && toArray(s.Action).includes("s3:*"),
    );
    expect(statement, 'expected a Deny statement for Principal "*" on s3:*').toBeDefined();
    expect(new Set(toArray(statement?.Resource))).toEqual(new Set(["${bucket_arn}", "${bucket_arn}/*"]));

    const condition = statement?.Condition ?? {};
    expect(condition.Bool).toEqual({ "aws:SecureTransport": "false" });
  });
});

// ---------------------------------------------------------------------------
// HCL checks over infra/bootstrap/*.tf
// ---------------------------------------------------------------------------

describe("infra/bootstrap/state.tf: KMS key for state encryption", () => {
  it("aws_kms_key.state rotates, has a 30 day deletion window and prevent_destroy", () => {
    const resource = resourceBlock("aws_kms_key", "state");
    expect(resource, 'expected resource "aws_kms_key" "state" { ... }').toBeDefined();
    expect(resource?.body).toMatch(/enable_key_rotation\s*=\s*true/);
    expect(resource?.body).toMatch(/deletion_window_in_days\s*=\s*30/);

    const lifecycle = extractBlock(resource?.body ?? "", /lifecycle\s*(?=\{)/);
    expect(lifecycle, "expected a lifecycle block in aws_kms_key.state").toBeDefined();
    expect(lifecycle?.body).toMatch(/prevent_destroy\s*=\s*true/);
  });

  it("aws_kms_alias.state points at alias/nblm-tofu-state and the state key", () => {
    const resource = resourceBlock("aws_kms_alias", "state");
    expect(resource, 'expected resource "aws_kms_alias" "state" { ... }').toBeDefined();
    expect(resource?.body).toMatch(/name\s*=\s*"alias\/nblm-tofu-state"/);
    expect(resource?.body).toMatch(/target_key_id\s*=\s*aws_kms_key\.state\.key_id/);
  });
});

describe("infra/bootstrap/state.tf: S3 state bucket", () => {
  it("aws_s3_bucket.state is named with the workload account id and protected", () => {
    const resource = resourceBlock("aws_s3_bucket", "state");
    expect(resource, 'expected resource "aws_s3_bucket" "state" { ... }').toBeDefined();
    expect(resource?.body).toMatch(/bucket\s*=\s*"nblm-tofu-state-278311879197"/);

    const lifecycle = extractBlock(resource?.body ?? "", /lifecycle\s*(?=\{)/);
    expect(lifecycle, "expected a lifecycle block in aws_s3_bucket.state").toBeDefined();
    expect(lifecycle?.body).toMatch(/prevent_destroy\s*=\s*true/);
  });

  it("no force_destroy = true anywhere in infra/bootstrap", () => {
    expect(concatTf()).not.toMatch(/force_destroy\s*=\s*true/);
  });

  it("every other aws_s3_bucket_* resource points at aws_s3_bucket.state.id", () => {
    const source = concatTf();
    const subResources = extractBlocks(source, /resource\s+"(aws_s3_bucket_[a-z_]+)"\s+"state"\s*(?=\{)/);
    expect(subResources.length).toBeGreaterThan(0);

    for (const resource of subResources) {
      expect(resource.body, `${resource.header} should set bucket = aws_s3_bucket.state.id`).toMatch(
        /bucket\s*=\s*aws_s3_bucket\.state\.id/,
      );
    }
  });

  it("aws_s3_bucket_versioning.state is Enabled", () => {
    const resource = resourceBlock("aws_s3_bucket_versioning", "state");
    expect(resource, "expected aws_s3_bucket_versioning.state").toBeDefined();
    const versioningConfig = extractBlock(resource?.body ?? "", /versioning_configuration\s*(?=\{)/);
    expect(versioningConfig, "expected a versioning_configuration block").toBeDefined();
    expect(versioningConfig?.body).toMatch(/status\s*=\s*"Enabled"/);
  });

  it("aws_s3_bucket_public_access_block.state blocks all four public access paths", () => {
    const resource = resourceBlock("aws_s3_bucket_public_access_block", "state");
    expect(resource, "expected aws_s3_bucket_public_access_block.state").toBeDefined();
    for (const flag of ["block_public_acls", "block_public_policy", "ignore_public_acls", "restrict_public_buckets"]) {
      expect(resource?.body ?? "", `expected ${flag} = true`).toMatch(new RegExp(`${flag}\\s*=\\s*true`));
    }
  });

  it("aws_s3_bucket_ownership_controls.state enforces BucketOwnerEnforced", () => {
    const resource = resourceBlock("aws_s3_bucket_ownership_controls", "state");
    expect(resource, "expected aws_s3_bucket_ownership_controls.state").toBeDefined();
    const rule = extractBlock(resource?.body ?? "", /rule\s*(?=\{)/);
    expect(rule, "expected a rule block").toBeDefined();
    expect(rule?.body).toMatch(/object_ownership\s*=\s*"BucketOwnerEnforced"/);
  });

  it("aws_s3_bucket_server_side_encryption_configuration.state uses aws:kms with bucket keys and the state key", () => {
    const resource = resourceBlock("aws_s3_bucket_server_side_encryption_configuration", "state");
    expect(resource, "expected aws_s3_bucket_server_side_encryption_configuration.state").toBeDefined();

    const rule = extractBlock(resource?.body ?? "", /rule\s*(?=\{)/);
    expect(rule, "expected a rule block").toBeDefined();
    expect(rule?.body).toMatch(/bucket_key_enabled\s*=\s*true/);

    const applyDefault = extractBlock(rule?.body ?? "", /apply_server_side_encryption_by_default\s*(?=\{)/);
    expect(applyDefault, "expected an apply_server_side_encryption_by_default block").toBeDefined();
    expect(applyDefault?.body).toMatch(/sse_algorithm\s*=\s*"aws:kms"/);
    expect(applyDefault?.body).toMatch(/kms_master_key_id\s*=\s*aws_kms_key\.state\.arn/);
  });

  it("aws_s3_bucket_lifecycle_configuration.state expires noncurrent versions after 90 days and aborts multipart uploads after 7", () => {
    const resource = resourceBlock("aws_s3_bucket_lifecycle_configuration", "state");
    expect(resource, "expected aws_s3_bucket_lifecycle_configuration.state").toBeDefined();

    const rule = extractBlock(resource?.body ?? "", /rule\s*(?=\{)/);
    expect(rule, "expected a rule block").toBeDefined();

    const noncurrent = extractBlock(rule?.body ?? "", /noncurrent_version_expiration\s*(?=\{)/);
    expect(noncurrent, "expected a noncurrent_version_expiration block").toBeDefined();
    expect(noncurrent?.body).toMatch(/noncurrent_days\s*=\s*90/);

    const abortIncomplete = extractBlock(rule?.body ?? "", /abort_incomplete_multipart_upload\s*(?=\{)/);
    expect(abortIncomplete, "expected an abort_incomplete_multipart_upload block").toBeDefined();
    expect(abortIncomplete?.body).toMatch(/days_after_initiation\s*=\s*7/);
  });

  it("aws_s3_bucket_policy.state renders policies/state-bucket.json.tftpl with the bucket arn", () => {
    const resource = resourceBlock("aws_s3_bucket_policy", "state");
    expect(resource, "expected aws_s3_bucket_policy.state").toBeDefined();
    expect(resource?.body ?? "").toContain("policies/state-bucket.json.tftpl");
    expect(resource?.body ?? "").toMatch(/bucket_arn\s*=\s*aws_s3_bucket\.state\.arn/);
  });
});

describe("infra/bootstrap/oidc.tf: GitHub OIDC provider and the plan/apply roles", () => {
  it("aws_iam_openid_connect_provider.github is the GitHub Actions issuer, no explicit thumbprint, protected", () => {
    const resource = resourceBlock("aws_iam_openid_connect_provider", "github");
    expect(resource, "expected aws_iam_openid_connect_provider.github").toBeDefined();
    expect(resource?.body).toMatch(/url\s*=\s*"https:\/\/token\.actions\.githubusercontent\.com"/);
    expect(resource?.body).toMatch(/client_id_list\s*=\s*\[\s*"sts\.amazonaws\.com"\s*\]/);
    expect(resource?.body ?? "").not.toMatch(/thumbprint_list\s*=/);

    const lifecycle = extractBlock(resource?.body ?? "", /lifecycle\s*(?=\{)/);
    expect(lifecycle, "expected a lifecycle block in aws_iam_openid_connect_provider.github").toBeDefined();
    expect(lifecycle?.body).toMatch(/prevent_destroy\s*=\s*true/);
  });

  it("aws_iam_role.tofu_plan is named nblm-tofu-plan, 1 hour sessions, trusted via the plan template", () => {
    const resource = resourceBlock("aws_iam_role", "tofu_plan");
    expect(resource, "expected aws_iam_role.tofu_plan").toBeDefined();
    expect(resource?.body).toMatch(/name\s*=\s*"nblm-tofu-plan"/);
    expect(resource?.body).toMatch(/max_session_duration\s*=\s*3600/);
    expect(resource?.body ?? "").toContain("trust-github-plan.json.tftpl");
  });

  it("aws_iam_role.tofu_apply is named nblm-tofu-apply, 1 hour sessions, trusted via the apply template", () => {
    const resource = resourceBlock("aws_iam_role", "tofu_apply");
    expect(resource, "expected aws_iam_role.tofu_apply").toBeDefined();
    expect(resource?.body).toMatch(/name\s*=\s*"nblm-tofu-apply"/);
    expect(resource?.body).toMatch(/max_session_duration\s*=\s*3600/);
    expect(resource?.body ?? "").toContain("trust-github-apply.json.tftpl");
  });

  it("tofu_plan is attached to SecurityAudit", () => {
    const attachment = resourceBlock("aws_iam_role_policy_attachment", "tofu_plan_security_audit");
    expect(attachment, "expected aws_iam_role_policy_attachment.tofu_plan_security_audit").toBeDefined();
    expect(attachment?.body).toMatch(/role\s*=\s*aws_iam_role\.tofu_plan\.name/);
    expect(attachment?.body).toMatch(/policy_arn\s*=\s*"arn:aws:iam::aws:policy\/SecurityAudit"/);
  });

  it("tofu_apply is attached to AdministratorAccess", () => {
    const attachment = resourceBlock("aws_iam_role_policy_attachment", "tofu_apply_admin");
    expect(attachment, "expected aws_iam_role_policy_attachment.tofu_apply_admin").toBeDefined();
    expect(attachment?.body).toMatch(/role\s*=\s*aws_iam_role\.tofu_apply\.name/);
    expect(attachment?.body).toMatch(/policy_arn\s*=\s*"arn:aws:iam::aws:policy\/AdministratorAccess"/);
  });

  it("aws_iam_role_policy.tofu_plan_state_read renders policies/plan-state-read.json.tftpl for the plan role", () => {
    const policy = resourceBlock("aws_iam_role_policy", "tofu_plan_state_read");
    expect(policy, "expected aws_iam_role_policy.tofu_plan_state_read").toBeDefined();
    expect(policy?.body ?? "").toContain("policies/plan-state-read.json.tftpl");
    expect(policy?.body ?? "").toMatch(/role\s*=\s*aws_iam_role\.tofu_plan\.id/);
  });

  it("aws_iam_role_policy.tofu_apply_guard renders policies/apply-guard.json.tftpl for the apply role", () => {
    const policy = resourceBlock("aws_iam_role_policy", "tofu_apply_guard");
    expect(policy, "expected aws_iam_role_policy.tofu_apply_guard").toBeDefined();
    expect(policy?.body ?? "").toContain("policies/apply-guard.json.tftpl");
    expect(policy?.body ?? "").toMatch(/role\s*=\s*aws_iam_role\.tofu_apply\.id/);
  });

  it("aws_iam_role_policy.tofu_apply_guard passes the real apply role arn and the key alias arn, not a hand-built string", () => {
    const policy = resourceBlock("aws_iam_role_policy", "tofu_apply_guard");
    expect(policy, "expected aws_iam_role_policy.tofu_apply_guard").toBeDefined();
    // There is no cycle: aws_iam_role.tofu_apply.arn can be used directly.
    expect(policy?.body ?? "").toMatch(/apply_role_arn\s*=\s*aws_iam_role\.tofu_apply\.arn/);
    expect(policy?.body ?? "").toMatch(/key_alias_arn\s*=\s*aws_kms_alias\.state\.arn/);
  });

  const workloadResources: Array<[type: string, name: string]> = [
    ["aws_kms_key", "state"],
    ["aws_kms_alias", "state"],
    ["aws_s3_bucket", "state"],
    ["aws_s3_bucket_versioning", "state"],
    ["aws_s3_bucket_public_access_block", "state"],
    ["aws_s3_bucket_ownership_controls", "state"],
    ["aws_s3_bucket_server_side_encryption_configuration", "state"],
    ["aws_s3_bucket_lifecycle_configuration", "state"],
    ["aws_s3_bucket_policy", "state"],
    ["aws_iam_openid_connect_provider", "github"],
    ["aws_iam_role", "tofu_plan"],
    ["aws_iam_role", "tofu_apply"],
    ["aws_iam_role_policy_attachment", "tofu_plan_security_audit"],
    ["aws_iam_role_policy_attachment", "tofu_apply_admin"],
    ["aws_iam_role_policy", "tofu_plan_state_read"],
    ["aws_iam_role_policy", "tofu_apply_guard"],
  ];

  it.each(workloadResources)("%s.%s does not set provider = aws.management (it stays in the workload account)", (type, name) => {
    const resource = resourceBlock(type, name);
    expect(resource, `expected resource "${type}" "${name}" { ... }`).toBeDefined();
    expect(resource?.body ?? "").not.toMatch(/provider\s*=\s*aws\.management/);
  });
});

describe("infra/bootstrap/outputs.tf", () => {
  it.each(["state_bucket", "state_key_arn", "state_key_alias", "plan_role_arn", "apply_role_arn", "oidc_provider_arn"])(
    'output "%s" exists',
    (name) => {
      expect(outputBlock(name), `expected output "${name}" { ... }`).toBeDefined();
    },
  );
});
