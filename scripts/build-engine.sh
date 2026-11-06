#!/usr/bin/env bash
# Build into an isolated checkout; original upstream / documents are untouched.
set -euo pipefail
project_dir="$(cd -- "$(dirname -- "$0")/.." && pwd)"
engine_dir="${1:?Usage: bash scripts/build-engine.sh /path/to/rhwp-checkout}"
engine_dir="$(cd -- "$engine_dir" && pwd)"
cd "$project_dir"
node --input-type=module - "$engine_dir" <<'JS'
import fs from 'node:fs';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
const lock=JSON.parse(fs.readFileSync('config/android-engine.json'));
const sha=crypto.createHash('sha256').update(fs.readFileSync(lock.patch)).digest('hex');
if(sha!==lock.patchSha256)throw new Error('Engine patch checksum mismatch');
if(execFileSync('git',['-C',process.argv[2],'rev-parse','HEAD'],{encoding:'utf8'}).trim()!==lock.commit)throw new Error('Upstream commit mismatch');
execFileSync('git',['-C',process.argv[2],'apply','--check',fs.realpathSync(lock.patch)],{stdio:'inherit'});
execFileSync('git',['-C',process.argv[2],'apply',fs.realpathSync(lock.patch)],{stdio:'inherit'});
JS
cd "$engine_dir"
cargo build --target wasm32-unknown-unknown --lib --release --locked
wasm-bindgen "${CARGO_TARGET_DIR:-target}/wasm32-unknown-unknown/release/rhwp.wasm" --target web --out-dir "$project_dir/.build/engine" --out-name rhwp
cd "$project_dir"
node scripts/install-engine.mjs .build/engine
