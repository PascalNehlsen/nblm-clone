#!/usr/bin/env bash
# Runs trivy at exactly one pinned version, for CI and local runs alike (IaC scan of infra/).
#
# A release binary checked against a pinned checksum, not trivy-action or setup-trivy: those
# and trivy 0.69.4 were compromised in March 2026 (GHSA-69fq-xp46-6x23). 0.75.0 has no open
# advisory. Run with --skip-check-update so the checks built into the binary are used and
# nothing is downloaded at scan time.
#
# Usage: scripts/trivy.sh <trivy arguments>
set -euo pipefail

VERSION="0.75.0"
declare -A SHA256=(
  [64bit]="c6e65abddb348e25f10549df887045629cf28cc72453cd1c63acb717316b3f3f"
  [ARM64]="a1ee9f6ffb7d112b64ff726a2a0717c21175c1114361391f4a132956751a13b3"
)

case "$(uname -m)" in
  x86_64) arch=64bit ;;
  aarch64 | arm64) arch=ARM64 ;;
  *) echo "trivy.sh: unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac
[ "$(uname -s)" = "Linux" ] || { echo "trivy.sh: only Linux is supported" >&2; exit 1; }

cache="${XDG_CACHE_HOME:-$HOME/.cache}/nblm-clone/trivy-${VERSION}-${arch}"
bin="$cache/trivy"

if [ ! -x "$bin" ]; then
  mkdir -p "$cache"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  curl --proto =https -sSfL -o "$tmp/trivy.tar.gz" \
    "https://github.com/aquasecurity/trivy/releases/download/v${VERSION}/trivy_${VERSION}_Linux-${arch}.tar.gz"
  echo "${SHA256[$arch]}  $tmp/trivy.tar.gz" | sha256sum --check --strict --quiet
  tar -xzf "$tmp/trivy.tar.gz" -C "$tmp" trivy
  install -m 0755 "$tmp/trivy" "$bin"
fi

# No call home for a newer version: the version is pinned above.
export TRIVY_SKIP_VERSION_CHECK=true
exec "$bin" "$@"
