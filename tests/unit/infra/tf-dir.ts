// Directory-parameterised variants of the `infra/bootstrap`-only readers in
// ./hcl.ts (readBootstrapFile, readAllTf, concatTf, bootstrapDir), for the new
// infra/aws stack (PR A, infra/aws-pipeline-and-roles). hcl.ts is left
// unchanged: extractBlock(s) and stripHclComments already take `source` as a
// plain string argument, so they work unmodified against infra/aws content
// read through the helpers below.
//
// Not a test file itself (no *.test.ts suffix), so vitest does not try to run
// it as a suite.

import * as fs from "node:fs";
import * as path from "node:path";

export const repoRoot = path.resolve(import.meta.dirname, "../../..");
export const infraDir = path.join(repoRoot, "infra");
export const awsDir = path.join(infraDir, "aws");

export interface TfFile {
  fileName: string;
  content: string;
}

/** Reads every `*.tf` file directly under `dir` (non-recursive). */
export function readAllTfFrom(dir: string): TfFile[] {
  const names = fs.readdirSync(dir).filter((name) => name.endsWith(".tf"));
  return names.map((fileName) => ({
    fileName,
    content: fs.readFileSync(path.join(dir, fileName), "utf8"),
  }));
}

/** All `*.tf` file contents under `dir` concatenated, for checks that may span files. */
export function concatTfFrom(dir: string): string {
  return readAllTfFrom(dir)
    .map((file) => file.content)
    .join("\n");
}

export function readFileFrom(dir: string, relativePath: string): string {
  return fs.readFileSync(path.join(dir, relativePath), "utf8");
}
