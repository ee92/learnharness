#!/usr/bin/env bash
# Pull the latest CI-built standalone payload (rolling vps-latest release,
# built by .github/workflows/vps-build.yml) and swap it in atomically.
# Tokenless: the fork is public and release assets need no auth.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
URL="https://github.com/ee92/learnharness/releases/download/vps-latest/standalone.tar.gz"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

curl -fsSL --retry 3 "$URL" -o "$TMP/standalone.tar.gz"
tar -xzf "$TMP/standalone.tar.gz" -C "$TMP"
[ -f "$TMP/standalone/server.js" ] || { echo "fetch-build: payload has no server.js — refusing" >&2; exit 1; }

mkdir -p "$ROOT/.next"
rm -rf "$ROOT/.next/standalone.new"
mv "$TMP/standalone" "$ROOT/.next/standalone.new"
rm -rf "$ROOT/.next/standalone"
mv "$ROOT/.next/standalone.new" "$ROOT/.next/standalone"

# electron/chatgpt.cjs resolves jose from the repo root, not the payload —
# without this, token refresh fails and masquerades as an identity error.
if [ -d "$ROOT/.next/standalone/node_modules/jose" ]; then
	mkdir -p "$ROOT/node_modules"
	rm -rf "$ROOT/node_modules/jose"
	cp -r "$ROOT/.next/standalone/node_modules/jose" "$ROOT/node_modules/jose"
fi
echo "fetch-build: installed $(du -sh "$ROOT/.next/standalone" | cut -f1) payload into $ROOT/.next/standalone"
