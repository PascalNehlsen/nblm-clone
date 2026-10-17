// Mini evaluator for the subset of AWS SCP semantics the region-guard policy
// uses: `Deny` statements only, with `Action`/`NotAction`, a `Resource` of
// "*", and a single region condition (`StringEquals` or `StringNotEquals` on
// `aws:RequestedRegion`). Not a general IAM policy evaluator.
//
// Semantics implemented, matching the task description: a request is denied
// if any statement matches. A statement matches when the action matches
// `Action`, or when it matches none of `NotAction` (glob `*`, case
// insensitive), AND the region condition holds.

export interface ScpStatement {
  Sid: string;
  Effect: "Allow" | "Deny";
  Action?: string | string[];
  NotAction?: string | string[];
  Resource?: string | string[];
  NotResource?: string | string[];
  Condition?: {
    StringEquals?: Record<string, string | string[]>;
    StringNotEquals?: Record<string, string | string[]>;
  };
}

export interface ScpPolicy {
  Version: string;
  Statement: ScpStatement[];
}

function toArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

function matchesAnyAction(action: string, patterns: string[]): boolean {
  return patterns.some((pattern) => globToRegExp(pattern).test(action));
}

function regionConditionHolds(condition: ScpStatement["Condition"], region: string): boolean {
  if (!condition) return true;

  const equalsValue = condition.StringEquals?.["aws:RequestedRegion"];
  if (equalsValue !== undefined) {
    return toArray(equalsValue).includes(region);
  }

  const notEqualsValue = condition.StringNotEquals?.["aws:RequestedRegion"];
  if (notEqualsValue !== undefined) {
    return !toArray(notEqualsValue).includes(region);
  }

  return true;
}

/** Returns true when `action` performed in `region` is denied by `policy`. */
export function isDenied(policy: ScpPolicy, action: string, region: string): boolean {
  return policy.Statement.some((statement) => {
    if (statement.Effect !== "Deny") return false;

    const actionList = toArray(statement.Action);
    const notActionList = toArray(statement.NotAction);

    let actionMatches: boolean;
    if (actionList.length > 0) {
      actionMatches = matchesAnyAction(action, actionList);
    } else if (notActionList.length > 0) {
      actionMatches = !matchesAnyAction(action, notActionList);
    } else {
      // Neither Action nor NotAction present: not used by this policy, but
      // an unconditional statement would apply to every action.
      actionMatches = true;
    }

    if (!actionMatches) return false;
    return regionConditionHolds(statement.Condition, region);
  });
}
