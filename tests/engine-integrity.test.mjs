// The engine gate (scripts/verify-engine.mjs, run by Gradle's verifyMemoEngine) refuses every engine that is not the pinned build (unmodified upstream rhwp with the Android WebView flags; the memo API comes with upstream).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {verifyEngine,verifyPins,sha256,HASHED} from '../scripts/verify-engine.mjs';
const repo=path.resolve(new URL('..',import.meta.url).pathname);
const ASSETS='app/src/main/assets/engine';
// A private copy of exactly what the gate reads (lock, engine files, build-info) that a test can damage.
function copy(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'engine-gate-'));
 for(const f of ['config/android-engine.json',...HASHED.map(n=>`${ASSETS}/${n}`),`${ASSETS}/build-info.json`]){fs.mkdirSync(path.dirname(path.join(root,f)),{recursive:true});fs.copyFileSync(path.join(repo,f),path.join(root,f));}
 return root;
}
const info=root=>JSON.parse(fs.readFileSync(path.join(root,ASSETS,'build-info.json'),'utf8'));
const writeInfo=(root,i)=>fs.writeFileSync(path.join(root,ASSETS,'build-info.json'),JSON.stringify(i,null,2));
const errorsOf=root=>verifyEngine({root}).errors;

test('the engine in this checkout is the pinned build (generated build-info.json, real hashes)',()=>{
 const {errors,info:i,pinned}=verifyEngine({root:repo});assert.deepEqual(errors,[]);
 for(const k of Object.keys(pinned))assert.deepEqual(i[k],pinned[k],k);
 for(const n of HASHED)assert.equal(i.hashes[n],sha256(fs.readFileSync(path.join(repo,ASSETS,n))),n);
});
test('CI and build script pins agree with the lock',()=>{assert.deepEqual(verifyPins({root:repo}).errors,[]);});
test('missing build-info.json is refused (a vendor engine that was never built by the pipeline)',()=>{
 const root=copy();fs.unlinkSync(path.join(root,ASSETS,'build-info.json'));
 assert.match(errorsOf(root).join('\n'),/Missing .*build-info\.json/);
});
test('a new glue next to a stale WebAssembly binary is refused',()=>{
 const root=copy(),wasm=path.join(root,ASSETS,'rhwp_bg.wasm'),bytes=fs.readFileSync(wasm);bytes[bytes.length-1]^=0xff;fs.writeFileSync(wasm,bytes);
 assert.match(errorsOf(root).join('\n'),/rhwp_bg\.wasm does not match build-info\.json/);
});
test('a tampered or old glue is refused, even when it still contains the memo method names',()=>{
 let root=copy();fs.appendFileSync(path.join(root,ASSETS,'rhwp.js'),'\n//x');assert.match(errorsOf(root).join('\n'),/rhwp\.js does not match build-info\.json/);
 // an old glue with matching recorded hashes: only the memo API check can catch it
 root=copy();const js=path.join(root,ASSETS,'rhwp.js'),old=fs.readFileSync(js,'utf8').replaceAll('getMemoList(','getMemoLis_(');fs.writeFileSync(js,old);
 const i=info(root);i.hashes['rhwp.js']=sha256(Buffer.from(old));writeInfo(root,i);
 assert.match(errorsOf(root).join('\n'),/lacks the memo API getMemoList\(\)/);
});
test('a different upstream commit or toolchain in build-info.json is refused',()=>{
 for(const [k,v] of [['commit','0'.repeat(40)],['rust','nightly-2025-01-01'],['wasmBindgen','0.2.1'],['rustFlags',''],['buildStd',false],['version','0.8.7']]){
  const root=copy(),i=info(root);i[k]=v;writeInfo(root,i);assert.match(errorsOf(root).join('\n'),new RegExp(`"${k}"`),k);
 }
});
test('the lock pins no engine patch (the engine is unmodified upstream)',()=>{
 const lock=JSON.parse(fs.readFileSync(path.join(repo,'config/android-engine.json'),'utf8'));
 assert.equal(lock.patch,undefined);assert.equal(lock.patchSha256,undefined);
 assert.equal(fs.existsSync(path.join(repo,'patches/rhwp-engine'))&&fs.readdirSync(path.join(repo,'patches/rhwp-engine')).some(n=>n.endsWith('.patch')),false);
});
test('missing or malformed hashes and non-WebAssembly binaries are refused',()=>{
 let root=copy(),i=info(root);delete i.hashes['rhwp_bg.wasm'];writeInfo(root,i);assert.match(errorsOf(root).join('\n'),/no SHA-256 for rhwp_bg\.wasm/);
 root=copy();i=info(root);i.hashes={};writeInfo(root,i);assert.match(errorsOf(root).join('\n'),/no SHA-256 for rhwp\.js/);
 root=copy();const wasm=path.join(root,ASSETS,'rhwp_bg.wasm');fs.writeFileSync(wasm,Buffer.alloc(2_000_000,1));i=info(root);i.hashes['rhwp_bg.wasm']=sha256(fs.readFileSync(wasm));writeInfo(root,i);assert.match(errorsOf(root).join('\n'),/not a WebAssembly/);
 root=copy();fs.writeFileSync(path.join(root,ASSETS,'build-info.json'),'{ not json');assert.match(errorsOf(root).join('\n'),/not valid JSON/);
 root=copy();fs.unlinkSync(path.join(root,ASSETS,'rhwp.d.ts'));assert.match(errorsOf(root).join('\n'),/Missing .*rhwp\.d\.ts/);
});
test('the Gradle gate has no skip switch and runs the verifier before every build',()=>{
 const gradle=fs.readFileSync(path.join(repo,'app/build.gradle'),'utf8');
 assert(/verifyMemoEngine/.test(gradle)&&/scripts\/verify-engine\.mjs/.test(gradle)&&/dependsOn 'verifyMemoEngine'/.test(gradle));
 assert(!/onlyIf|enabled\s*=\s*false|-x\s+verifyMemoEngine|skipEngine|skipVerify/i.test(gradle),'no way to switch the gate off in the build file');
 const wf=fs.readFileSync(path.join(repo,'.github/workflows/android.yml'),'utf8');assert(!/-x\s+verifyMemoEngine|skipEngine/.test(wf));
});
test('pin check fails when the workflow drifts from the lock',()=>{
 const root=copy();for(const f of ['.github/workflows/android.yml','scripts/build-engine.sh']){fs.mkdirSync(path.dirname(path.join(root,f)),{recursive:true});fs.copyFileSync(path.join(repo,f),path.join(root,f));}
 const wf=path.join(root,'.github/workflows/android.yml');fs.writeFileSync(wf,fs.readFileSync(wf,'utf8').replace(/ref: [0-9a-f]{40}/,'ref: '+'1'.repeat(40)));
 assert.match(verifyPins({root}).errors.join('\n'),/does not check out upstream/);
});
