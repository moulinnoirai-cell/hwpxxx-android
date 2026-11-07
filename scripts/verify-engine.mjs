// Engine integrity gate (run by Gradle's verifyMemoEngine before every build, and by tests/engine-integrity.test.mjs).
// The packaged engine must be the one config/android-engine.json describes: build-info.json (written by install-engine.mjs) must exist,
// repeat every pinned input of the lock, and its SHA-256 values must match the glue, the WebAssembly binary and the typings on disk.
//   node scripts/verify-engine.mjs            verify app/src/main/assets/engine against config/android-engine.json
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

export const MEMO_API=['getMemoList','insertMemo','insertMemoByPath','setMemoText','removeMemo'];
export const HASHED=['rhwp.js','rhwp_bg.wasm','rhwp.d.ts'];
export const sha256=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');

export function verifyEngine({root,assets='app/src/main/assets/engine',lock='config/android-engine.json'}={}){
 const errors=[],at=p=>path.join(root,p);
 const read=(p)=>{try{return fs.readFileSync(p);}catch{return null;}};
 const lockBytes=read(at(lock));if(!lockBytes)return {errors:[`Missing ${lock}`]};
 let pinned;try{pinned=JSON.parse(lockBytes);}catch(e){return {errors:[`${lock} is not valid JSON: ${e.message}`]};}
 for(const k of ['upstream','commit','version','patch','patchSha256','rust','wasmBindgen','rustFlags','buildStd'])if(pinned[k]===undefined)errors.push(`${lock} lacks "${k}"`);
 // 1. The patch that is in the repository is the pinned one.
 const patch=pinned.patch&&read(at(pinned.patch));
 if(!patch)errors.push(`Missing engine patch ${pinned.patch}`);else if(sha256(patch)!==pinned.patchSha256)errors.push(`Engine patch ${pinned.patch} does not match the pinned patchSha256`);
 // 2. build-info.json is required and carries the same pins.
 const infoBytes=read(at(assets+'/build-info.json'));
 if(!infoBytes){errors.push(`Missing ${assets}/build-info.json: the engine was not produced by scripts/build-engine.sh + install-engine.mjs. Build it first: bash scripts/build-engine.sh <rhwp-checkout>`);return {errors};}
 let info;try{info=JSON.parse(infoBytes);}catch(e){return {errors:[...errors,`build-info.json is not valid JSON: ${e.message}`]};}
 for(const [k,v] of Object.entries(pinned))if(JSON.stringify(info[k])!==JSON.stringify(v))errors.push(`build-info.json "${k}" is ${JSON.stringify(info[k])} but ${lock} pins ${JSON.stringify(v)} (stale or foreign engine build)`);
 // 3. The files that are packaged are the files that were built.
 const hashes=info.hashes||{};
 for(const name of HASHED){
  const bytes=read(at(`${assets}/${name}`));
  if(!bytes){errors.push(`Missing ${assets}/${name}`);continue;}
  if(!/^[0-9a-f]{64}$/.test(hashes[name]||''))errors.push(`build-info.json has no SHA-256 for ${name}`);
  else if(sha256(bytes)!==hashes[name])errors.push(`${name} does not match build-info.json (SHA-256 ${sha256(bytes)} on disk, ${hashes[name]} recorded): the glue and the WebAssembly binary must come from the same build`);
 }
 // 4. The glue has the memo API and the binary is WebAssembly.
 const glue=read(at(`${assets}/rhwp.js`));
 if(glue){const text=glue.toString('utf8');for(const m of MEMO_API)if(!text.includes(m+'('))errors.push(`rhwp.js lacks the memo API ${m}(): build the memo engine first`);}
 const wasm=read(at(`${assets}/rhwp_bg.wasm`));
 if(wasm&&(wasm.length<1_000_000||wasm.readUInt32BE(0)!==0x0061736d||wasm.readUInt32LE(4)!==1))errors.push('rhwp_bg.wasm is not a WebAssembly (version 1) binary of plausible size');
 return {errors,info,pinned};
}

// Pins that live outside the lock must agree with it (CI would otherwise build a different engine than the lock describes).
export function verifyPins({root,lock='config/android-engine.json',workflow='.github/workflows/android.yml',script='scripts/build-engine.sh'}={}){
 const errors=[],pinned=JSON.parse(fs.readFileSync(path.join(root,lock),'utf8'));
 const wf=fs.readFileSync(path.join(root,workflow),'utf8');
 if(!wf.includes(`ref: ${pinned.commit}`))errors.push(`${workflow} does not check out upstream ${pinned.commit}`);
 if(!wf.includes(`toolchain: '${pinned.rust}'`))errors.push(`${workflow} does not install ${pinned.rust}`);
 if(!wf.includes(`wasm-bindgen/releases/download/${pinned.wasmBindgen}/`))errors.push(`${workflow} does not install wasm-bindgen ${pinned.wasmBindgen}`);
 if(!wf.includes('verifyMemoEngine')&&!wf.includes('assembleDebug'))errors.push('the workflow no longer builds through Gradle (verifyMemoEngine)');
 const sh=fs.readFileSync(path.join(root,script),'utf8');
 if(!sh.includes(pinned.rustFlags))errors.push(`${script} does not use ${pinned.rustFlags}`);
 if(!/-Zbuild-std/.test(sh)!==!pinned.buildStd)errors.push(`${script} -Zbuild-std disagrees with the lock`);
 if(!/\+"\$engine_toolchain"|\+\$engine_toolchain/.test(sh))errors.push(`${script} must select the locked toolchain explicitly (upstream rust-toolchain.toml must not decide)`);
 return {errors};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
 const {errors,info}=verifyEngine({root});
 if(errors.length){console.error('Engine integrity check FAILED:\n - '+errors.join('\n - '));process.exit(1);}
 console.log(`Engine OK: ${info.version} (upstream ${info.commit.slice(0,10)}, patch ${info.patchSha256.slice(0,10)}); rhwp.js ${info.hashes['rhwp.js'].slice(0,12)}, rhwp_bg.wasm ${info.hashes['rhwp_bg.wasm'].slice(0,12)}`);
}
