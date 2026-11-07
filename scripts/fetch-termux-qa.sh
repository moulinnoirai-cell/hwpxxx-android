#!/usr/bin/env bash
set -euo pipefail
# Test dependency only. Never packaged with hwpxxx.
# The APK is verified against a SHA-256 that is pinned in this repository. The pinned value was checked on 2026-11-07 against
# (1) the official release's own checksum file, fetched over HTTPS from github.com/termux/termux-app, and
# (2) the SHA-256 of the downloaded x86_64 APK itself; both gave the same value. A re-published asset fails here until a person re-verifies it.
mkdir -p .qa
version='0.118.3'
expected_sha256='3550e61f4d9eb49b712fd1bd9519dc37085a4d8eb597c57a340f0a64859b7144'
base="https://github.com/termux/termux-app/releases/download/v${version}"
name="termux-app_v${version}+github-debug_x86_64.apk"
sums="termux-app_v${version}+github-debug_sha256sums"
fetch() { curl --fail --location --retry 3 --proto '=https' --tlsv1.2 "$1" -o "$2"; }
fetch "$base/termux-app_v${version}%2Bgithub-debug_x86_64.apk" ".qa/$name"
fetch "$base/termux-app_v${version}%2Bgithub-debug_sha256sums" ".qa/$sums"
# 1. the file is the pinned one
echo "${expected_sha256}  .qa/$name" | sha256sum --check --strict
# 2. the release's own checksum file names exactly this file and value (not --ignore-missing: a missing line is an error)
grep -Fx "${expected_sha256}  ${name}" ".qa/$sums" > /dev/null || { echo "The release checksum file does not list ${name} with the pinned SHA-256" >&2; exit 1; }
mv ".qa/$name" .qa/termux.apk
echo "Termux ${version} x86_64 APK verified: ${expected_sha256}"
