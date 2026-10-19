// Tests for the `tofu plan` guard used by CI before any apply runs (PR A,
// infra/aws-pipeline-and-roles).
//
// Run with: node --test 'tests/ci/*.test.mjs'
// (a bare directory does not work with node --test; it must be a glob or file list)
//
// Tests only the exported function, never the CLI: no spawning of a process,
// no touching the filesystem or the environment.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { guardPlan } from "../../scripts/plan-guard.mjs";

const SECRET = "s3cr3t-value-do-not-print";

/** Builds a realistic `tofu show -json <planfile>` document. */
function planDoc({ resourceChanges, errored } = {}) {
  const doc = {
    format_version: "1.2",
    terraform_version: "1.13.1",
  };
  if (resourceChanges !== undefined) doc.resource_changes = resourceChanges;
  if (errored !== undefined) doc.errored = errored;
  return doc;
}

/** Builds one `resource_changes` entry. */
function change(address, actions, { mode = "managed", type = "aws_iam_role", name, before = null, after = null } = {}) {
  return {
    address,
    mode,
    type,
    name: name ?? address.split(".").pop(),
    change: { actions, before, after },
  };
}

function text(doc) {
  return JSON.stringify(doc);
}

describe("guardPlan: allowed actions pass", () => {
  it("{} with no resource_changes key at all is ok, no changes, no violations", () => {
    const result = guardPlan(text({ format_version: "1.2", terraform_version: "1.13.1" }));
    assert.deepEqual(result, { ok: true, error: null, changes: [], violations: [] });
  });

  it('{"resource_changes": []} is ok with empty arrays', () => {
    const result = guardPlan(text(planDoc({ resourceChanges: [] })));
    assert.deepEqual(result, { ok: true, error: null, changes: [], violations: [] });
  });

  it("a plan with only create, update, no-op and data-source read entries is ok", () => {
    const resourceChanges = [
      change("aws_iam_role.web[\"develop\"]", ["create"]),
      change("aws_iam_role_policy.web_bedrock_embeddings[\"develop\"]", ["create"]),
      change("aws_iam_role.web[\"production\"]", ["update"]),
      change("aws_iam_openid_connect_provider.vercel", ["no-op"]),
      change("data.aws_caller_identity.current", ["read"], { mode: "data", type: "aws_caller_identity" }),
    ];
    const result = guardPlan(text(planDoc({ resourceChanges })));

    assert.equal(result.ok, true);
    assert.equal(result.error, null);
    assert.equal(result.violations.length, 0);
    assert.equal(result.changes.length, resourceChanges.length);
  });

  it("ok is true iff error is null and violations is empty (positive case)", () => {
    const result = guardPlan(text(planDoc({ resourceChanges: [change("a", ["create"])] })));
    assert.equal(result.ok, result.error === null && result.violations.length === 0);
    assert.equal(result.ok, true);
  });
});

describe("guardPlan: disallowed action lists are violations", () => {
  const cases = [
    ["delete", ["delete"]],
    ["delete,create (replace)", ["delete", "create"]],
    ["create,delete (replace)", ["create", "delete"]],
    ["forget", ["forget"]],
    ["unknown action", ["frobnicate"]],
    ["empty actions list", []],
  ];

  for (const [label, actions] of cases) {
    it(`${label} is reported as a violation, not swallowed`, () => {
      const result = guardPlan(text(planDoc({ resourceChanges: [change("thing.x", actions)] })));
      assert.equal(result.ok, false);
      assert.equal(result.violations.length, 1);
      assert.equal(result.violations[0].address, "thing.x");
      assert.deepEqual(result.violations[0].actions, actions);
      assert.equal(result.changes.length, 1);
      assert.deepEqual(result.changes[0].actions, actions);
    });
  }
});

describe("guardPlan: a mixed plan reports exactly the disallowed entries, in input order", () => {
  it("create, update, delete, replace (delete,create), replace (create,delete)", () => {
    const resourceChanges = [
      change("aws_iam_role.web[\"develop\"]", ["create"]),
      change("aws_iam_role.web[\"production\"]", ["update"]),
      change("aws_iam_role_policy.web_bedrock_embeddings[\"develop\"]", ["delete"]),
      change("aws_iam_openid_connect_provider.vercel", ["delete", "create"]),
      change("aws_iam_role.other", ["create", "delete"]),
    ];
    const result = guardPlan(text(planDoc({ resourceChanges })));

    assert.equal(result.ok, false);
    assert.equal(result.changes.length, 5);
    assert.deepEqual(
      result.violations.map((v) => v.address),
      [
        "aws_iam_role_policy.web_bedrock_embeddings[\"develop\"]",
        "aws_iam_openid_connect_provider.vercel",
        "aws_iam_role.other",
      ],
    );
    assert.deepEqual(result.violations[0].actions, ["delete"]);
    assert.deepEqual(result.violations[1].actions, ["delete", "create"]);
    assert.deepEqual(result.violations[2].actions, ["create", "delete"]);
  });
});

describe("guardPlan: fails closed on malformed or error input", () => {
  const malformedCases = [
    ["empty string", ""],
    ["whitespace only", "   \n\t  "],
    ["non-JSON text", "not json at all"],
    ["JSON null", "null"],
    ["JSON array", "[]"],
    ["JSON number", "42"],
    ["JSON string", '"hello"'],
    [
      "resource_changes present but not an array",
      text({ format_version: "1.2", terraform_version: "1.13.1", resource_changes: { not: "an array" } }),
    ],
    [
      "entry without a string address",
      text(planDoc({ resourceChanges: [{ mode: "managed", type: "aws_iam_role", name: "x", change: { actions: ["create"] } }] })),
    ],
    [
      "entry without a change key",
      text(planDoc({ resourceChanges: [{ address: "a", mode: "managed", type: "aws_iam_role", name: "a" }] })),
    ],
    [
      "entry whose change.actions is not an array of strings",
      text(planDoc({ resourceChanges: [{ address: "a", mode: "managed", type: "aws_iam_role", name: "a", change: { actions: "create" } }] })),
    ],
    ["errored: true", text(planDoc({ resourceChanges: [change("a", ["create"])], errored: true }))],
    [
      "entry whose change.actions array contains a non-string element",
      text(planDoc({ resourceChanges: [{ address: "a", mode: "managed", type: "aws_iam_role", name: "a", change: { actions: ["create", 5] } }] })),
    ],
  ];

  for (const [label, input] of malformedCases) {
    it(`${label} => ok=false, non-null error, arrays still returned`, () => {
      const result = guardPlan(input);
      assert.equal(result.ok, false);
      assert.equal(typeof result.error, "string");
      assert.ok(result.error.length > 0);
      assert.ok(Array.isArray(result.changes));
      assert.ok(Array.isArray(result.violations));
    });
  }
});

describe("guardPlan: never echoes resource values", () => {
  it("a passing plan containing the secret in change.before/after does not leak it anywhere in the result", () => {
    const resourceChanges = [
      change("aws_iam_role.web[\"develop\"]", ["create"], { before: null, after: { description: SECRET } }),
    ];
    const result = guardPlan(text(planDoc({ resourceChanges })));

    assert.equal(result.ok, true);
    assert.ok(!JSON.stringify(result).includes(SECRET));
  });

  it("a failing (malformed-entry) case does not leak the secret via result.error either", () => {
    const input = text(
      planDoc({
        resourceChanges: [
          {
            // No string address: this entry is malformed and must fail closed,
            // but the surrounding before/after still carries the secret.
            mode: "managed",
            type: "aws_iam_role",
            name: "x",
            change: { actions: ["create"], before: null, after: { description: SECRET } },
          },
        ],
      }),
    );
    const result = guardPlan(input);

    assert.equal(result.ok, false);
    assert.ok(typeof result.error === "string" && !result.error.includes(SECRET));
    assert.ok(!JSON.stringify(result).includes(SECRET));
  });
});
