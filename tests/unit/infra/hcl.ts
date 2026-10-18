// Small, dependency-free HCL text helpers shared by the infra/bootstrap unit
// tests. These are not test files themselves (no *.test.ts suffix), so vitest
// does not try to run them as suites.
//
// They do not parse HCL properly (no real parser dependency); they find a
// block header with a regex and then count braces to find the matching
// closing brace, which is enough for the small, hand-written .tf files this
// stack produces. It does not try to be brace-aware inside string literals,
// which is fine here because none of the expected blocks embed literal
// braces in a quoted value (JSON content is loaded via file(), not inlined).

import * as fs from "node:fs";
import * as path from "node:path";

export const repoRoot = path.resolve(import.meta.dirname, "../../..");
export const infraDir = path.join(repoRoot, "infra");
export const bootstrapDir = path.join(infraDir, "bootstrap");

export interface HclBlock {
  /** The raw header text, e.g. `provider "aws"` or `resource "aws_organizations_policy" "region_guard"`. */
  header: string;
  /** The block body, the text strictly between the outermost `{` and `}`. */
  body: string;
}

/**
 * Finds every top-level occurrence of `headerPattern` in `source` and returns
 * the header text together with the body of the `{ ... }` block that follows
 * it, using brace counting so nested blocks (e.g. `lifecycle { ... }`) are
 * captured whole.
 *
 * `headerPattern` must not itself include the opening brace.
 */
export function extractBlocks(source: string, headerPattern: RegExp): HclBlock[] {
  const blocks: HclBlock[] = [];
  const flags = headerPattern.flags.includes("g") ? headerPattern.flags : `${headerPattern.flags}g`;
  const global = new RegExp(headerPattern.source, flags);

  let match: RegExpExecArray | null;
  while ((match = global.exec(source)) !== null) {
    const headerStart = match.index;
    const headerEnd = match.index + match[0].length;
    const braceStart = source.indexOf("{", headerEnd);
    if (braceStart === -1) break;

    let depth = 0;
    let i = braceStart;
    for (; i < source.length; i++) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}") {
        depth--;
        if (depth === 0) {
          i++;
          break;
        }
      }
    }

    blocks.push({
      header: source.slice(headerStart, braceStart).trim(),
      body: source.slice(braceStart + 1, i - 1),
    });
    global.lastIndex = i;
  }

  return blocks;
}

/** Convenience wrapper for the common case of expecting exactly one match. */
export function extractBlock(source: string, headerPattern: RegExp): HclBlock | undefined {
  return extractBlocks(source, headerPattern)[0];
}

export function readBootstrapFile(relativePath: string): string {
  return fs.readFileSync(path.join(bootstrapDir, relativePath), "utf8");
}

export interface TfFile {
  fileName: string;
  content: string;
}

/** Reads every `*.tf` file directly under `infra/bootstrap` (non-recursive). */
export function readAllTf(): TfFile[] {
  const names = fs.readdirSync(bootstrapDir).filter((name) => name.endsWith(".tf"));
  return names.map((fileName) => ({
    fileName,
    content: fs.readFileSync(path.join(bootstrapDir, fileName), "utf8"),
  }));
}

/** All `*.tf` file contents under `infra/bootstrap` concatenated, for checks that may span files. */
export function concatTf(): string {
  return readAllTf()
    .map((file) => file.content)
    .join("\n");
}

/**
 * Strips HCL comments (`#` to end of line, `//` to end of line, `/* ... *\/`)
 * from `source`, while leaving the content of double-quoted string literals
 * untouched (so `//` inside a URL or ARN, or a `#` inside a quoted value,
 * survives). This is a plain character scan, not a full HCL lexer: it tracks
 * only "are we inside a double-quoted string" and honours a backslash escape
 * there, which is enough for the hand-written .tf files this stack produces.
 *
 * Used so assertions that check for a real `enforced = true` or
 * `method = method.aes_gcm.state` line are not satisfied by a commented-out
 * line (`# enforced = true`) left behind after the real one was deleted.
 */
export function stripHclComments(source: string): string {
  let result = "";
  let inString = false;
  let i = 0;

  while (i < source.length) {
    const ch = source[i];

    if (inString) {
      result += ch;
      if (ch === "\\" && i + 1 < source.length) {
        // Copy the escaped character verbatim so an escaped quote (`\"`)
        // does not end the string early.
        result += source[i + 1];
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i++;
      continue;
    }

    if (ch === '"') {
      inString = true;
      result += ch;
      i++;
      continue;
    }

    if (ch === "#") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }

    if (ch === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }

    if (ch === "/" && source[i + 1] === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i++;
      i += 2;
      continue;
    }

    result += ch;
    i++;
  }

  return result;
}

/** Recursively lists every file under `dir` (used for the "no secret-shaped literals anywhere in infra/" scan). */
export function walkFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(full));
    } else {
      files.push(full);
    }
  }
  return files;
}
