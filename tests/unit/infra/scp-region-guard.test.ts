import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { bootstrapDir } from "./hcl";
import { isDenied, type ScpPolicy } from "./scp-evaluator";
import {
  BEDROCK_ACTIONS,
  BEDROCK_EU_REGIONS,
  DENY_OUTSIDE_EU_CENTRAL_1_NOT_ACTION,
  DENY_OUTSIDE_EU_CENTRAL_1_REGIONS,
  EXPECTED_SIDS,
  IDENTITY_CENTER_FAMILIES,
  US_EAST_1_GLOBAL_SERVICES_NOT_ACTION,
} from "./region-guard-fixtures";

const policyPath = path.join(bootstrapDir, "policies/scp-region-guard.json");

function loadPolicy(): ScpPolicy {
  const raw = fs.readFileSync(policyPath, "utf8");
  return JSON.parse(raw) as ScpPolicy;
}

function asSet(value: string | string[] | undefined): Set<string> {
  if (value === undefined) return new Set();
  return new Set(Array.isArray(value) ? value : [value]);
}

function statementBySid(policy: ScpPolicy, sid: string) {
  const statement = policy.Statement.find((candidate) => candidate.Sid === sid);
  if (!statement) throw new Error(`no statement with Sid ${sid}`);
  return statement;
}

describe("infra/bootstrap/policies/scp-region-guard.json: shape", () => {
  it("is valid JSON with Version 2012-10-17, minified under 5120 bytes, and only Deny/Resource \"*\" statements", () => {
    const policy = loadPolicy();

    expect(policy.Version).toBe("2012-10-17");
    expect(JSON.stringify(policy).length).toBeLessThanOrEqual(5120);
    expect(policy.Statement.length).toBeGreaterThan(0);

    const sids = policy.Statement.map((statement) => statement.Sid);
    expect(new Set(sids).size).toBe(sids.length);

    for (const statement of policy.Statement) {
      expect(statement.Effect).toBe("Deny");
      expect(statement.Resource).toBe("*");
      expect(statement.NotResource).toBeUndefined();
      const actions = asSet(statement.Action);
      expect(actions.has("*")).toBe(false);
    }
  });

  it("has exactly the three expected Sids", () => {
    const policy = loadPolicy();
    const sids = policy.Statement.map((statement) => statement.Sid);
    expect(new Set(sids)).toEqual(new Set(EXPECTED_SIDS));
    expect(sids).toHaveLength(EXPECTED_SIDS.length);
  });

  it("DenyOutsideEuCentral1: NotAction is exactly the 14 Bedrock actions (no Identity Center exemption), condition is StringNotEquals over {eu-central-1, unspecified, us-east-1}", () => {
    const policy = loadPolicy();
    const statement = statementBySid(policy, "DenyOutsideEuCentral1");

    expect(asSet(statement.NotAction)).toEqual(new Set(DENY_OUTSIDE_EU_CENTRAL_1_NOT_ACTION));
    expect(statement.Action).toBeUndefined();

    // Human decision for PR 1: Identity Center's home region is eu-central-1,
    // owned by the management account, so it gets no cross-region exemption.
    const notActionSet = asSet(statement.NotAction);
    for (const family of IDENTITY_CENTER_FAMILIES) {
      expect(notActionSet.has(family)).toBe(false);
    }

    const condition = statement.Condition?.StringNotEquals?.["aws:RequestedRegion"];
    expect(asSet(condition)).toEqual(new Set(DENY_OUTSIDE_EU_CENTRAL_1_REGIONS));
    expect(statement.Condition?.StringEquals).toBeUndefined();
  });

  it("UsEast1GlobalServicesOnly: NotAction equals the transcribed 135-entry list exactly, condition is StringEquals us-east-1", () => {
    const policy = loadPolicy();
    const statement = statementBySid(policy, "UsEast1GlobalServicesOnly");

    expect(US_EAST_1_GLOBAL_SERVICES_NOT_ACTION).toHaveLength(135);
    expect(asSet(statement.NotAction)).toEqual(new Set(US_EAST_1_GLOBAL_SERVICES_NOT_ACTION));

    const notActionSet = asSet(statement.NotAction);
    expect(notActionSet.has("iam:*")).toBe(true);
    expect(notActionSet.has("sts:*")).toBe(true);
    expect(notActionSet.has("signin:*")).toBe(true);
    expect(notActionSet.has("sso:*")).toBe(true);
    expect(notActionSet.has("organizations:*")).toBe(true);
    expect(notActionSet.has("account:*")).toBe(true);
    expect(notActionSet.has("budgets:*")).toBe(true);
    expect(notActionSet.has("ce:*")).toBe(true);
    expect(notActionSet.has("kms:*")).toBe(true);
    expect(notActionSet.has("support:*")).toBe(true);
    for (const action of notActionSet) {
      expect(action.toLowerCase().startsWith("bedrock")).toBe(false);
    }

    const condition = statement.Condition?.StringEquals?.["aws:RequestedRegion"];
    expect(asSet(condition)).toEqual(new Set(["us-east-1"]));
    expect(statement.Condition?.StringNotEquals).toBeUndefined();
  });

  it("BedrockInferenceEuOnly: Action is exactly the 14 Bedrock actions, condition is StringNotEquals over the 6 EU regions", () => {
    const policy = loadPolicy();
    const statement = statementBySid(policy, "BedrockInferenceEuOnly");

    expect(asSet(statement.Action)).toEqual(new Set(BEDROCK_ACTIONS));
    expect(statement.NotAction).toBeUndefined();

    const condition = statement.Condition?.StringNotEquals?.["aws:RequestedRegion"];
    expect(asSet(condition)).toEqual(new Set(BEDROCK_EU_REGIONS));
  });
});

describe("infra/bootstrap/policies/scp-region-guard.json: behaviour", () => {
  it("self-test: the evaluator denies an obviously denied case and allows an obviously allowed one, against a tiny inline policy", () => {
    const tinyPolicy: ScpPolicy = {
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "DenyS3OutsideEu",
          Effect: "Deny",
          NotAction: ["s3:*"],
          Resource: "*",
          Condition: { StringNotEquals: { "aws:RequestedRegion": ["eu-central-1"] } },
        },
      ],
    };

    // ec2:RunInstances outside eu-central-1 matches NotAction (it is not s3:*)
    // and the region condition holds, so it must be denied.
    expect(isDenied(tinyPolicy, "ec2:RunInstances", "us-east-1")).toBe(true);
    // s3:CreateBucket matches none of NotAction's complement logic: it *is*
    // s3:*, so the statement does not match, so it must be allowed.
    expect(isDenied(tinyPolicy, "s3:CreateBucket", "us-east-1")).toBe(false);
    // Inside eu-central-1 the region condition never holds, so everything is allowed.
    expect(isDenied(tinyPolicy, "ec2:RunInstances", "eu-central-1")).toBe(false);
  });

  it("allows the documented allowed cases", () => {
    const policy = loadPolicy();

    expect(isDenied(policy, "s3:CreateBucket", "eu-central-1")).toBe(false);
    expect(isDenied(policy, "kms:CreateKey", "eu-central-1")).toBe(false);
    expect(isDenied(policy, "ec2:RunInstances", "eu-central-1")).toBe(false);

    expect(isDenied(policy, "iam:CreateRole", "us-east-1")).toBe(false);
    expect(isDenied(policy, "sts:AssumeRoleWithWebIdentity", "us-east-1")).toBe(false);
    expect(isDenied(policy, "signin:AuthenticateCredentials", "us-east-1")).toBe(false);
    expect(isDenied(policy, "organizations:ListPolicies", "us-east-1")).toBe(false);
    expect(isDenied(policy, "budgets:ViewBudget", "us-east-1")).toBe(false);
    // sso:* is still in UsEast1GlobalServicesOnly's NotAction (the wizard's
    // global service list), so Identity Center in us-east-1 stays allowed
    // even without the DenyOutsideEuCentral1 exemption.
    expect(isDenied(policy, "sso:ListInstances", "us-east-1")).toBe(false);

    expect(isDenied(policy, "sts:GetCallerIdentity", "eu-central-1")).toBe(false);
    // Identity Center's home region: always allowed there regardless of any exemption.
    expect(isDenied(policy, "sso:ListInstances", "eu-central-1")).toBe(false);

    for (const region of BEDROCK_EU_REGIONS) {
      expect(isDenied(policy, "bedrock:InvokeModel", region)).toBe(false);
      expect(isDenied(policy, "bedrock:InvokeModelWithResponseStream", region)).toBe(false);
    }
  });

  it("denies the documented denied cases", () => {
    const policy = loadPolicy();

    for (const region of ["eu-north-1", "us-west-2", "us-east-1", "eu-west-1"]) {
      expect(isDenied(policy, "s3:CreateBucket", region)).toBe(true);
    }

    expect(isDenied(policy, "kms:CreateKey", "us-west-2")).toBe(true);
    expect(isDenied(policy, "ec2:RunInstances", "us-east-1")).toBe(true);

    for (const region of ["us-east-1", "us-west-2", "ap-northeast-1"]) {
      expect(isDenied(policy, "bedrock:InvokeModel", region)).toBe(true);
    }

    // eu-central-1 is fully allowed (BedrockInferenceEuOnly's region set
    // includes it), eu-west-1 is not.
    expect(isDenied(policy, "bedrock:CreateModelCustomizationJob", "eu-central-1")).toBe(false);
    expect(isDenied(policy, "bedrock:CreateModelCustomizationJob", "eu-west-1")).toBe(true);

    // Human decision for PR 1: no Identity Center exemption outside
    // eu-central-1 (its home region, owned by the management account).
    expect(isDenied(policy, "sso:ListInstances", "eu-north-1")).toBe(true);
    expect(isDenied(policy, "identitystore:ListUsers", "eu-north-1")).toBe(true);
    expect(isDenied(policy, "sso:ListInstances", "us-west-2")).toBe(true);
  });

  it("handles the 'unspecified' region (requests with no inferable region, e.g. global.* inference profiles)", () => {
    const policy = loadPolicy();

    // "unspecified" is in DenyOutsideEuCentral1's allowed set, but Bedrock
    // inference is still only allowed from the 6 EU regions in
    // BedrockInferenceEuOnly, which has no "unspecified" exception: this is
    // what blocks global.* inference profiles.
    expect(isDenied(policy, "bedrock:InvokeModel", "unspecified")).toBe(true);
    // A non-Bedrock, non-global action in "unspecified" is allowed, taken
    // over from the wizard's RegionFloor statement.
    expect(isDenied(policy, "s3:CreateBucket", "unspecified")).toBe(false);
  });

  it("allows the AWS Budgets actions in us-east-1 (the Budgets API endpoint) and eu-central-1", () => {
    const policy = loadPolicy();

    for (const action of ["budgets:CreateBudget", "budgets:ViewBudget", "budgets:ModifyBudget"]) {
      for (const region of ["us-east-1", "eu-central-1"]) {
        expect(isDenied(policy, action, region), `${action} in ${region}`).toBe(false);
      }
    }
  });

  it("us-west-2 is not a specially allowed region: nothing outside the Bedrock/global exceptions is allowed there", () => {
    const policy = loadPolicy();

    expect(isDenied(policy, "sso:ListInstances", "us-west-2")).toBe(true);
    expect(isDenied(policy, "kms:Decrypt", "us-west-2")).toBe(true);
  });
});
