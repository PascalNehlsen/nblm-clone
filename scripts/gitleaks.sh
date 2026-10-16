#!/usr/bin/env bash
# Runs gitleaks at exactly one pinned version, for pre-commit and CI alike.
#
# Why not the upstream pre-commit hook: it builds gitleaks from Go source, which
# needs proxy.golang.org. The Go module proxy fetches any module path on request,
# so allowing it in the agent sandbox opens an exfiltration channel. A release
# binary checked against a pinned checksum needs only GitHub.
#
# Usage: scripts/gitleaks.sh <gitleaks arguments>
set -euo pipefail

VERSION="8.30.1"
declare -A SHA256=(
  [x64]="551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb"
  [arm64]="e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080"
)

case "$(uname -m)" in
  x86_64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) echo "gitleaks.sh: unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac
[ "$(uname -s)" = "Linux" ] || { echo "gitleaks.sh: only Linux is supported" >&2; exit 1; }

cache="${XDG_CACHE_HOME:-$HOME/.cache}/nblm-clone/gitleaks-${VERSION}-${arch}"
bin="$cache/gitleaks"

if [ ! -x "$bin" ]; then
  mkdir -p "$cache"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  curl -sSfL -o "$tmp/gitleaks.tar.gz" \
    "https://github.com/gitleaks/gitleaks/releases/download/v${VERSION}/gitleaks_${VERSION}_linux_${arch}.tar.gz"
  echo "${SHA256[$arch]}  $tmp/gitleaks.tar.gz" | sha256sum --check --strict --quiet
  tar -xzf "$tmp/gitleaks.tar.gz" -C "$tmp" gitleaks
  install -m 0755 "$tmp/gitleaks" "$bin"
fi

exec "$bin" "$@"
