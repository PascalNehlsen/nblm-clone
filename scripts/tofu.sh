#!/usr/bin/env bash
# Runs OpenTofu at exactly one pinned version, in the sandbox, on the host and in CI.
#
# Same pattern as scripts/gitleaks.sh: a release binary from GitHub, checked
# against a pinned checksum. Provider downloads need registry.opentofu.org.
#
# Pinned one minor release behind the newest only when the newest is younger than
# two weeks (dependency cooldown). 1.13.1 was released 2026-10-01.
#
# Usage: scripts/tofu.sh <tofu arguments>
set -euo pipefail

VERSION="1.13.1"
declare -A SHA256=(
  [amd64]="378ada19d4bc70c43732004e8159be771b23b9a5afdf059e5f8a2b3fa2c70a69"
  [arm64]="9c1ef375aa1852db0b2888aa921b640c71f8140d4682aa4fec99378a64fa7dc3"
)

case "$(uname -m)" in
  x86_64) arch=amd64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) echo "tofu.sh: unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac
[ "$(uname -s)" = "Linux" ] || { echo "tofu.sh: only Linux is supported" >&2; exit 1; }

cache="${XDG_CACHE_HOME:-$HOME/.cache}/nblm-clone/tofu-${VERSION}-${arch}"
bin="$cache/tofu"

if [ ! -x "$bin" ]; then
  mkdir -p "$cache"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  curl --proto =https --tlsv1.2 -sSfL -o "$tmp/tofu.tar.gz" \
    "https://github.com/opentofu/opentofu/releases/download/v${VERSION}/tofu_${VERSION}_linux_${arch}.tar.gz"
  echo "${SHA256[$arch]}  $tmp/tofu.tar.gz" | sha256sum --check --strict --quiet
  tar -xzf "$tmp/tofu.tar.gz" -C "$tmp" tofu
  install -m 0755 "$tmp/tofu" "$bin"
fi

exec "$bin" "$@"
