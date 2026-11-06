#!/usr/bin/env bash
set -euo pipefail
# Test dependency only. Never packaged with hwpxxx.
mkdir -p .qa
base='https://github.com/termux/termux-app/releases/download/v0.118.3'
name='termux-app_v0.118.3+github-debug_x86_64.apk'
sums='termux-app_v0.118.3+github-debug_sha256sums'
curl --fail --location --retry 3 "$base/termux-app_v0.118.3%2Bgithub-debug_x86_64.apk" -o ".qa/$name"
curl --fail --location --retry 3 "$base/termux-app_v0.118.3%2Bgithub-debug_sha256sums" -o ".qa/$sums"
(cd .qa && sha256sum --check --ignore-missing "$sums")
mv ".qa/$name" .qa/termux.apk
