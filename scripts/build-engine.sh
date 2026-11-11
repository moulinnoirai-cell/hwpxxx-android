#!/usr/bin/env bash
# Build unmodified upstream rhwp (the pinned commit) for the Android WebView; original upstream / documents are untouched.
set -euo pipefail
project_dir="$(cd -- "$(dirname -- "$0")/.." && pwd)"
engine_dir="${1:?Usage: bash scripts/build-engine.sh /path/to/rhwp-checkout}"
engine_dir="$(cd -- "$engine_dir" && pwd)"
cd "$project_dir"
node --input-type=module - "$engine_dir" <<'JS'
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
const lock=JSON.parse(fs.readFileSync('config/android-engine.json'));
if(execFileSync('git',['-C',process.argv[2],'rev-parse','HEAD'],{encoding:'utf8'}).trim()!==lock.commit)throw new Error('Upstream commit mismatch');
JS
engine_toolchain="$(node -p 'JSON.parse(require("fs").readFileSync("config/android-engine.json")).rust')"
cd "$engine_dir"
# The stock API 30 WebView cannot execute multivalue/externref Wasm.
# Rebuild std too: precompiled std retains newer target features.
export RUSTFLAGS="-Ctarget-cpu=mvp"
cargo +"$engine_toolchain" build -Zbuild-std=std,panic_abort --target wasm32-unknown-unknown --lib --release --locked
wasm-bindgen "${CARGO_TARGET_DIR:-target}/wasm32-unknown-unknown/release/rhwp.wasm" --target web --out-dir "$project_dir/.build/engine" --out-name rhwp
cd "$project_dir"
node scripts/install-engine.mjs .build/engine
