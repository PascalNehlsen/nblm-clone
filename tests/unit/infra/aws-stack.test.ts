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

// ---------------------------------------------------------------------------
// D-infra: chat model permissions for the web roles (spec: bedrock-chat inline
// policy next to bedrock-embeddings). Static only: the template is rendered in
// TypeScript from the arguments of the templatefile() call in vercel.tf, using
// the literal locals of that file. Supported template forms: `${name}` and
// `${jsonencode(name)}`. Nothing is executed and no network is used.
// ---------------------------------------------------------------------------

const PROFILE_ARN = "arn:aws:bedrock:eu-central-1:278311879197:inference-profile/eu.amazon.nova-2-lite-v1:0";
const EU_REGIONS = ["eu-central-1", "eu-west-1", "eu-west-3", "eu-north-1", "eu-south-1", "eu-south-2"];
const EXPECTED_MODEL_ARNS = EU_REGIONS.map((r) => `arn:aws:bedrock:${r}::foundation-model/amazon.nova-2-lite-v1:0`);
const CHAT_ACTIONS = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"];

type TplValue = string | string[];

function vercelSource(): string {
  return stripHclComments(readFileFrom(awsDir, "vercel.tf"));
}

/** Evaluates the literal locals the chat policy needs: strings, string lists and one-level `for` lists. */
function evaluateLocals(source: string): Record<string, TplValue> {
  const result: Record<string, TplValue> = {};
  const blocks = extractBlocks(source, /locals\s*(?=\{)/);
  const body = blocks.map((b) => b.body).join("\n");

  for (const m of body.matchAll(/^\s*([a-z0-9_]+)\s*=\s*"([^"\n]*)"\s*$/gm)) {
    if (m[1] && m[2] !== undefined) result[m[1]] = m[2];
  }
  for (const m of body.matchAll(/^\s*([a-z0-9_]+)\s*=\s*\[\s*("[^\]\[]*")\s*\]\s*$/gm)) {
    if (m[1] && m[2]) result[m[1]] = [...m[2].matchAll(/"([^"]*)"/g)].map((x) => x[1] ?? "");
  }
  for (const m of body.matchAll(/^\s*([a-z0-9_]+)\s*=\s*\[\s*for\s+(\w+)\s+in\s+local\.([a-z0-9_]+)\s*:\s*"([^"\n]*)"\s*\]\s*$/gm)) {
    const [, name, iter, listName, tpl] = m;
    const list = listName ? result[listName] : undefined;
    if (name && iter && tpl !== undefined && Array.isArray(list)) {
      result[name] = list.map((item) => tpl.split("${" + iter + "}").join(item));
    }
  }
  return result;
}

function templateArgs(resourceBody: string, locals: Record<string, TplValue>): Record<string, TplValue> {
  const call = resourceBody.match(/templatefile\([^,]+,\s*\{([\s\S]*?)\}\s*\)/);
  if (!call?.[1]) throw new Error("no templatefile(..., { ... }) call found");
  const args: Record<string, TplValue> = {};
  for (const line of call[1].split("\n")) {
    const lit = line.match(/^\s*([a-z0-9_]+)\s*=\s*"([^"]*)"\s*$/);
    const ref = line.match(/^\s*([a-z0-9_]+)\s*=\s*local\.([a-z0-9_]+)\s*$/);
    if (lit?.[1] && lit[2] !== undefined) args[lit[1]] = lit[2];
    else if (ref?.[1] && ref[2]) {
      const v = locals[ref[2]];
      if (v === undefined) throw new Error(`local.${ref[2]} is not a literal in vercel.tf`);
      args[ref[1]] = v;
    }
  }
  return args;
}

function renderTemplate(template: string, args: Record<string, TplValue>): unknown {
  const rendered = template.replace(/\$\{\s*(jsonencode\(\s*)?([a-z0-9_]+)\s*\)?\s*\}/g, (_all, enc: string | undefined, name: string) => {
    const v = args[name];
    if (v === undefined) throw new Error(`template variable ${name} is not passed by templatefile()`);
    return enc ? JSON.stringify(v) : String(v);
  });
  if (/\$\{|%\{/.test(rendered)) throw new Error("template uses a construct this test cannot render");
  return JSON.parse(rendered);
}

function renderPolicy(resourceName: string, templateFile: string): { Statement: Record<string, unknown>[] } & Record<string, unknown> {
  const source = vercelSource();
  const resource = extractBlock(source, new RegExp(`resource\\s+"aws_iam_role_policy"\\s+"${resourceName}"\\s*(?=\\{)`));
  expect(resource, `expected resource aws_iam_role_policy.${resourceName} in vercel.tf`).toBeDefined();
  expect(resource?.body).toContain(`policies/${templateFile}`);
  const args = templateArgs(resource?.body ?? "", evaluateLocals(source));
  const template = readFileFrom(awsDir, `policies/${templateFile}`);
  return renderTemplate(template, args) as { Statement: Record<string, unknown>[] } & Record<string, unknown>;
}

function asArray(v: unknown): string[] {
  return Array.isArray(v) ? (v as string[]) : [v as string];
}

describe("infra/aws web roles: inline policies", () => {
  it("every web role has exactly the inline policies bedrock-embeddings and bedrock-chat, each for_each over local.web_roles", () => {
    const source = vercelSource();
    const policies = extractBlocks(source, /resource\s+"aws_iam_role_policy"\s+"[a-z0-9_]+"\s*(?=\{)/);
    const names = policies.map((p) => p.body.match(/\bname\s*=\s*"([^"]+)"/)?.[1]).sort();
    expect(names).toEqual(["bedrock-chat", "bedrock-embeddings"]);
    for (const policy of policies) {
      expect(policy.body).toMatch(/for_each\s*=\s*local\.web_roles/);
      expect(policy.body).toMatch(/role\s*=\s*aws_iam_role\.web\[each\.key\]\.name/);
    }
    const chat = policies.find((p) => /name\s*=\s*"bedrock-chat"/.test(p.body));
    expect(chat?.header).toMatch(/"web_bedrock_chat"/);
    expect(chat?.body).toContain("policies/bedrock-chat.json.tftpl");
  });

  it("no other attachment mechanism grants the web roles anything (no managed or extra inline policies)", () => {
    const source = vercelSource();
    expect(source).not.toMatch(/aws_iam_role_policy_attachment/);
    expect(source).not.toMatch(/aws_iam_role_policies_exclusive/);
    expect(source).not.toMatch(/managed_policy_arns/);
  });
});

describe("infra/aws policies/bedrock-chat.json.tftpl", () => {
  it("exists", () => {
    expect(fs.existsSync(path.join(awsDir, "policies/bedrock-chat.json.tftpl")), "expected policies/bedrock-chat.json.tftpl").toBe(true);
  });

  it("vercel.tf defines the profile ARN, the region list and the model ARNs as literals", () => {
    const locals = evaluateLocals(vercelSource());
    expect(locals.chat_profile_arn).toBe(PROFILE_ARN);
    expect(locals.chat_model_regions).toEqual(EU_REGIONS);
    expect(locals.chat_model_arns).toEqual(EXPECTED_MODEL_ARNS);
  });

  it("renders to exactly two statements with exactly the two invoke actions", () => {
    const policy = renderPolicy("web_bedrock_chat", "bedrock-chat.json.tftpl");
    expect(policy.Version).toBe("2012-10-17");
    expect(policy.Statement).toHaveLength(2);
    for (const stmt of policy.Statement) {
      expect(stmt.Effect).toBe("Allow");
      expect(asArray(stmt.Action).slice().sort()).toEqual([...CHAT_ACTIONS].sort());
      expect(stmt).not.toHaveProperty("NotAction");
      expect(stmt).not.toHaveProperty("NotResource");
      expect(stmt).not.toHaveProperty("Principal");
    }
    expect(policy.Statement.map((s) => s.Sid)).toEqual(["InvokeChatProfile", "InvokeChatModelThroughProfile"]);
  });

  it("has no * in any action or resource", () => {
    const policy = renderPolicy("web_bedrock_chat", "bedrock-chat.json.tftpl");
    for (const stmt of policy.Statement) {
      for (const value of [...asArray(stmt.Action), ...asArray(stmt.Resource)]) {
        expect(value, "wildcard in action or resource").not.toContain("*");
      }
    }
  });

  it("profile statement has only the profile ARN and no condition", () => {
    const policy = renderPolicy("web_bedrock_chat", "bedrock-chat.json.tftpl");
    const stmt = policy.Statement.find((s) => s.Sid === "InvokeChatProfile");
    expect(stmt).toBeDefined();
    expect(asArray(stmt?.Resource)).toEqual([PROFILE_ARN]);
    expect(stmt).not.toHaveProperty("Condition");
  });

  it("model statement has exactly the six EU foundation-model ARNs and is bound to the profile by a StringEquals condition", () => {
    const policy = renderPolicy("web_bedrock_chat", "bedrock-chat.json.tftpl");
    const stmt = policy.Statement.find((s) => s.Sid === "InvokeChatModelThroughProfile");
    expect(stmt).toBeDefined();
    expect(asArray(stmt?.Resource).slice().sort()).toEqual([...EXPECTED_MODEL_ARNS].sort());
    expect(stmt?.Condition).toEqual({ StringEquals: { "bedrock:InferenceProfileArn": PROFILE_ARN } });
  });

  it("every region in the policy ARNs is one of the six EU regions", () => {
    const policy = renderPolicy("web_bedrock_chat", "bedrock-chat.json.tftpl");
    const arns = policy.Statement.flatMap((s) => asArray(s.Resource));
    expect(arns.length).toBe(1 + EU_REGIONS.length);
    for (const arn of arns) {
      const parts = arn.split(":");
      expect(parts[0]).toBe("arn");
      expect(parts[2]).toBe("bedrock");
      expect(EU_REGIONS, `region of ${arn}`).toContain(parts[3]);
    }
    const modelRegions = policy.Statement.flatMap((s) => asArray(s.Resource))
      .filter((a) => a.includes(":foundation-model/"))
      .map((a) => a.split(":")[3])
      .sort();
    expect(modelRegions).toEqual([...EU_REGIONS].sort());
  });
});

describe("infra/aws policies/bedrock-embeddings.json.tftpl (unchanged)", () => {
  it("still renders to the single InvokeModel statement on the Titan v2 model in eu-central-1", () => {
    const policy = renderPolicy("web_bedrock_embeddings", "bedrock-embeddings.json.tftpl");
    expect(policy).toEqual({
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "InvokeEmbeddingModel",
          Effect: "Allow",
          Action: "bedrock:InvokeModel",
          Resource: "arn:aws:bedrock:eu-central-1::foundation-model/amazon.titan-embed-text-v2:0",
        },
      ],
    });
  });
});

// ---------------------------------------------------------------------------
// Ops page PR: AWS cost budget (infra/aws/budget.tf). Static checks only.
// ---------------------------------------------------------------------------

describe("infra/aws budget", () => {
  const strippedAws = () => stripHclComments(concatTfFrom(awsDir));

  it("has exactly one aws_budgets_budget, in budget.tf", () => {
    expect(fs.existsSync(path.join(awsDir, "budget.tf")), "expected infra/aws/budget.tf").toBe(true);
    const blocks = extractBlocks(strippedAws(), /resource\s+"aws_budgets_budget"\s+"[a-z0-9_]+"\s*(?=\{)/);
    expect(blocks).toHaveLength(1);
    const inBudgetTf = extractBlocks(
      stripHclComments(readFileFrom(awsDir, "budget.tf")),
      /resource\s+"aws_budgets_budget"\s+"[a-z0-9_]+"\s*(?=\{)/,
    );
    expect(inBudgetTf).toHaveLength(1);
  });

  it("has no budget actions and no SNS topic or subscription anywhere in infra/aws", () => {
    const source = strippedAws();
    expect(source).not.toMatch(/aws_budgets_budget_action/);
    expect(source).not.toMatch(/aws_sns_/);
  });

  it("the limit is the literal \"10\", given through a local", () => {
    const source = strippedAws();
    const budget = extractBlocks(source, /resource\s+"aws_budgets_budget"\s+"[a-z0-9_]+"\s*(?=\{)/)[0];
    expect(budget, "expected an aws_budgets_budget resource").toBeDefined();
    expect(budget?.body).toMatch(/limit_amount\s*=\s*local\.[a-z0-9_]+/);
    expect(resolveLiteral(source, budget?.body ?? "", "limit_amount")).toBe("10");
    expect(budget?.body).toMatch(/limit_unit\s*=\s*"USD"/);
    expect(budget?.body).toMatch(/budget_type\s*=\s*"COST"/);
    expect(budget?.body).toMatch(/time_unit\s*=\s*"MONTHLY"/);
  });

  it("has exactly four notification blocks, subscribed to var.budget_alert_email only", () => {
    const source = strippedAws();
    const budget = extractBlocks(source, /resource\s+"aws_budgets_budget"\s+"[a-z0-9_]+"\s*(?=\{)/)[0];
    expect(budget, "expected an aws_budgets_budget resource").toBeDefined();
    const notifications = extractBlocks(budget?.body ?? "", /notification\s*(?=\{)/);
    expect(notifications).toHaveLength(4);
    for (const n of notifications) {
      expect(n.body).toMatch(/subscriber_email_addresses\s*=\s*\[\s*var\.budget_alert_email\s*\]/);
      expect(n.body).not.toMatch(/subscriber_sns_topic_arns/);
    }
    const kinds = notifications
      .map((n) => `${n.body.match(/notification_type\s*=\s*"([A-Z]+)"/)?.[1]}:${n.body.match(/threshold\s*=\s*(\d+)/)?.[1]}`)
      .sort();
    expect(kinds).toEqual(["ACTUAL:100", "ACTUAL:50", "ACTUAL:80", "FORECASTED:100"]);
  });

  it("contains no email address literal in any infra/aws/*.tf file", () => {
    for (const file of readAllTfFrom(awsDir)) {
      expect(stripHclComments(file.content), `${file.fileName} must not hold an email address`).not.toMatch(
        /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/,
      );
    }
  });

  it("variable budget_alert_email has no default, is sensitive, and validates the format", () => {
    const variable = extractBlock(strippedAws(), /variable\s+"budget_alert_email"\s*(?=\{)/);
    expect(variable, 'expected variable "budget_alert_email" { ... }').toBeDefined();
    expect(variable?.body).not.toMatch(/\bdefault\s*=/);
    expect(variable?.body).toMatch(/\bsensitive\s*=\s*true\b/);
    expect(variable?.body).toMatch(/\btype\s*=\s*string\b/);
    const validation = extractBlock(variable?.body ?? "", /validation\s*(?=\{)/);
    expect(validation, "expected a validation { ... } block").toBeDefined();
    expect(validation?.body).toMatch(/regex|can\(/);
  });
});

// Note: the existing "no access_key, secret_key or token anywhere under
// infra/" guard in bootstrap-hcl.test.ts already scans the whole of infraDir
// (tests/unit/infra/hcl.ts's walkFiles(infraDir)), so it covers infra/aws too
// once that directory exists; it is not duplicated here.
