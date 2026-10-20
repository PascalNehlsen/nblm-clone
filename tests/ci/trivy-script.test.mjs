// Static test for scripts/trivy.sh: Trivy at exactly one pinned version, a
// release binary checked against a pinned sha256 before it is installed or run
// (mirror of scripts/gitleaks.sh and scripts/tofu.sh). Reads the script text
// only, runs nothing.
//
// Run with: node --test tests/ci/trivy-script.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const FILE = fileURLToPath(new URL("../../scripts/trivy.sh", import.meta.url));
const text = readFileSync(FILE, "utf8").replace(/\r/g, "");
const code = text
  .split("\n")
  .filter((l) => !l.trim().startsWith("#"))
  .join("\n");

describe("scripts/trivy.sh", () => {
  it("is a bash script with strict mode", () => {
    assert.match(text, /^#!\/usr\/bin\/env bash\n/);
    assert.match(code, /^set -euo pipefail$/m);
  });

  it("pins one semantic version", () => {
    assert.match(code, /^VERSION="\d+\.\d+\.\d+"$/m);
    assert.doesNotMatch(code, /\blatest\b/);
  });

  it("pins a sha256 per platform, including linux amd64, as 64 hex characters", () => {
    const block = code.match(/declare -A SHA256=\(([\s\S]*?)\n\)/);
    assert.ok(block, "no declare -A SHA256=( ... ) map");
    const entries = [...block[1].matchAll(/\[([A-Za-z0-9_-]+)\]="([^"]*)"/g)];
    assert.ok(entries.length >= 1, "no checksum entries");
    for (const [, key, value] of entries) {
      assert.match(value, /^[0-9a-f]{64}$/, `${key}: not a sha256`);
    }
    assert.ok(
      entries.some(([, key]) => /^(amd64|x64|x86_64|64bit|linux-64bit)$/i.test(key)),
      "no linux amd64 checksum",
    );
    const values = entries.map((e) => e[2]);
    assert.equal(new Set(values).size, values.length, "checksums must differ per platform");
  });

  it("downloads from the official aquasecurity/trivy GitHub release over https only", () => {
    assert.match(code, /https:\/\/github\.com\/aquasecurity\/trivy\/releases\/download\/v\$\{VERSION\}\//);
    assert.match(code, /curl[^\n]*--proto =https/);
    assert.doesNotMatch(code, /http:\/\//);
  });

  it("refuses unsupported platforms", () => {
    assert.match(code, /uname -m/);
    assert.match(code, /uname -s/);
    assert.match(code, /exit 1/);
  });

  it("verifies the checksum strictly before extracting, installing or executing", () => {
    const check = code.search(/sha256sum --check --strict/);
    assert.notEqual(check, -1, "no sha256sum --check --strict");
    assert.match(code, /\$\{SHA256\[\$arch\]\}/);
    const extract = code.search(/\btar\s/);
    const install = code.search(/\binstall\s+-m/);
    const exec = code.search(/^exec\s/m);
    assert.ok(exec > check, "exec must come after the checksum check");
    if (extract !== -1) assert.ok(check < extract, "checksum check must precede tar");
    if (install !== -1) assert.ok(check < install, "checksum check must precede install");
  });

  it("never pipes a download into a shell and ends by exec-ing the cached binary with the arguments", () => {
    assert.doesNotMatch(code, /\|\s*(ba)?sh\b/);
    assert.doesNotMatch(code, /\|\s*sudo\b/);
    assert.match(code, /^exec "\$bin" "\$@"\s*$/m);
    assert.match(code, /nblm-clone\/trivy-\$\{VERSION\}-\$\{arch\}/);
  });
});
