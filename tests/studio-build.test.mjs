// Build-pipeline gates for the desktop Studio: the destructive-path guard of scripts/build-studio.mjs and the integrity gate
// scripts/verify-studio.mjs (Gradle verifyDesktopStudio). Everything here works on throwaway directories; no test ever
// deletes a protected path (the guard is exercised as a pure function and the CLI only with --check-paths, which never mutates).
//   node --test tests/studio-build.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {assertSafeBuildPaths,verifyStudio,verifyPatches,readConfig,sha256,DEFAULT_OUT,ENGINE_ASSETS,CONFIG} from '../scripts/studio-lib.mjs';
const repo=path.resolve(new URL('..',import.meta.url).pathname);
const config=readConfig(repo);

// ── destructive-path guard ────────────────────────────────────────────────────────────────────────────────────────
function fakeRepo(){
 const r=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'studio-guard-')));
 for(const d of ['.build/rhwp','.build/engine',ENGINE_ASSETS,DEFAULT_OUT,'config','scripts','tests','app/src/main/java'])fs.mkdirSync(path.join(r,d),{recursive:true});
 return r;
}
const guard=(r,over={})=>assertSafeBuildPaths({repo:r,upstream:path.join(r,'.build/rhwp'),core:path.join(r,ENGINE_ASSETS),work:path.join(r,'.build/studio-src'),out:path.join(r,DEFAULT_OUT),...over});
const refused=(r,over,re)=>assert.throws(()=>guard(r,over),re);

test('the default dedicated work directory and the generated asset directory are accepted',()=>{const r=fakeRepo();assert.doesNotThrow(()=>guard(r));});
test('a custom isolated work/out below .build is accepted',()=>{const r=fakeRepo();assert.doesNotThrow(()=>guard(r,{work:path.join(r,'.build/other-src'),out:path.join(r,'.build/other-out')}));});
test('--work . / the repository root / .build itself are refused',()=>{
 const r=fakeRepo();
 for(const work of [r,path.join(r,'.'),path.join(r,'.build'),path.dirname(r),'/'])refused(r,{work},/unsafe --work\/--out \(nothing was touched\)/);
});
test('work/out outside the repository (general absolute folders, home, tmp) are refused',()=>{
 const r=fakeRepo(),other=fs.mkdtempSync(path.join(os.tmpdir(),'elsewhere-'));
 refused(r,{work:other},/below .*\.build/);refused(r,{work:os.homedir()},/below .*\.build/);refused(r,{out:other},/must be app\/src\/main\/assets\/studio or a directory below/);
});
test('protected repository directories can neither be work nor out',()=>{
 const r=fakeRepo();
 for(const d of ['config','scripts','tests','app/src/main/java','app/src/main','app',ENGINE_ASSETS,'.build/engine','.git']){refused(r,{work:path.join(r,d)},/unsafe/);refused(r,{out:path.join(r,d)},/unsafe/);}
});
test('overlaps with the upstream checkout, the engine core, the output or each other are refused',()=>{
 const r=fakeRepo();
 refused(r,{work:path.join(r,'.build/rhwp')},/overlap/);                       // work == upstream
 refused(r,{work:path.join(r,'.build/rhwp/sub')},/overlap/);                    // work inside upstream
 refused(r,{out:path.join(r,'.build/rhwp')},/overlap/);                         // out == upstream
 refused(r,{out:path.join(r,'.build/studio-src/out')},/overlap/);               // out inside work
 refused(r,{work:path.join(r,'.build/x'),out:path.join(r,'.build/x')},/overlap/);
 refused(r,{work:path.join(r,'.build/x'),core:path.join(r,'.build/x/core')},/overlap/); // core inside work
 refused(r,{out:path.join(r,'.build')},/overlap|must be/);                      // out contains upstream
});
test('a symlink cannot smuggle work/out out of .build',()=>{
 const r=fakeRepo(),outside=fs.mkdtempSync(path.join(os.tmpdir(),'escape-target-'));
 fs.symlinkSync(outside,path.join(r,'.build/link'));
 refused(r,{work:path.join(r,'.build/link/x')},/below .*\.build/);               // parent symlink leaves .build
 refused(r,{work:path.join(r,'.build/link')},/unsafe/);                           // work itself a symlink
 fs.symlinkSync(r,path.join(r,'.build/to-root'));
 refused(r,{work:path.join(r,'.build/to-root')},/unsafe/);                        // symlink to the repository
 fs.symlinkSync(path.join(r,'config'),path.join(r,'.build/to-config'));
 refused(r,{out:path.join(r,'.build/to-config')},/unsafe/);
 assert.ok(fs.existsSync(outside),'the symlink target was never touched');
});
test('a reused node_modules directory may not sit inside a directory that is deleted',()=>{
 const r=fakeRepo();
 refused(r,{extra:[path.join(r,'.build/studio-src/rhwp-studio/node_modules')]},/overlap/);
 assert.doesNotThrow(()=>guard(r,{extra:[fs.mkdtempSync(path.join(os.tmpdir(),'nm-'))]}));
});
test('the CLI refuses --work . and friends in --check-paths mode without changing anything',()=>{
 const before=sha256(fs.readFileSync(path.join(repo,CONFIG)));
 for(const args of [['--work','.'],['--work','.build'],['--out','.'],['--out','app/src'],['--work','/tmp/definitely-not-below-build']]){
  const r=spawnSync(process.execPath,['scripts/build-studio.mjs','--check-paths',...args],{cwd:repo,encoding:'utf8'});
  assert.equal(r.status,1,args.join(' '));assert.match(r.stderr,/nothing was touched/,args.join(' '));
 }
 const ok=spawnSync(process.execPath,['scripts/build-studio.mjs','--check-paths'],{cwd:repo,encoding:'utf8'});
 assert.equal(ok.status,0);assert.match(ok.stdout,/no changes made/);
 assert.equal(sha256(fs.readFileSync(path.join(repo,CONFIG))),before);assert.ok(fs.existsSync(path.join(repo,'scripts/build-studio.mjs')));
});

// ── verifyStudio on a synthetic (small) bundle: every gate must trip on exactly its own defect ─────────────────────────
const ENGINE_FILES=['rhwp.js','rhwp_bg.wasm','rhwp.d.ts'];
function synthetic(){
 const r=fs.mkdtempSync(path.join(os.tmpdir(),'studio-verify-'));
 const put=(rel,data)=>{const f=path.join(r,rel);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,data);return f;};
 // config + patches (real files: their hashes are the pins)
 for(const f of [CONFIG,config.engineConfig])put(f,fs.readFileSync(path.join(repo,f)));
 for(const [dir,pins] of [[config.featurePatchDir,config.featurePatches],[config.androidPatchDir,config.androidPatches]])for(const n of Object.keys(pins))put(`${dir}/${n}`,fs.readFileSync(path.join(repo,dir,n)));
 // synthetic engine core with a build-info that repeats the engine lock
 const wasm=Buffer.concat([Buffer.from([0,0x61,0x73,0x6d,1,0,0,0]),Buffer.alloc(1_200_000,7)]);
 const glue=Buffer.from(['getMemoList(','insertMemo(','insertMemoByPath(','setMemoText(','removeMemo('].join('\n'));
 const core={'rhwp.js':glue,'rhwp_bg.wasm':wasm,'rhwp.d.ts':Buffer.from('export {}')};
 for(const n of ENGINE_FILES)put(`${ENGINE_ASSETS}/${n}`,core[n]);
 const lock=JSON.parse(fs.readFileSync(path.join(repo,config.engineConfig),'utf8'));
 const hashes=Object.fromEntries(ENGINE_FILES.map(n=>[n,sha256(core[n])]));
 put(`${ENGINE_ASSETS}/build-info.json`,JSON.stringify({...lock,hashes}));
 // synthetic Studio output
 const html=`<!doctype html><html><head>\n  <meta http-equiv="Content-Security-Policy" content="${config.csp}">\n  <script src="/studio-host.js"></script>\n<script type="module" crossorigin src="/studio/assets/index-AbC123.js"></script></head><body></body></html>`;
 const files={'index.html':Buffer.from(html),'assets/index-AbC123.js':Buffer.from('// js'),'assets/rhwp_bg-XyZ789.wasm':wasm,'fonts/NanumGothic-Regular.woff2':Buffer.from('font'),'LICENSE-rhwp.txt':Buffer.from('MIT'),'THIRD_PARTY_LICENSES-rhwp.md':Buffer.from('x')};
 for(const [n,b] of Object.entries(files))put(`${DEFAULT_OUT}/${n}`,b);
 const info={pins:config,core:hashes,files:Object.fromEntries(Object.entries(files).map(([n,b])=>[n,sha256(b)])),mainScript:'assets/index-AbC123.js'};
 put(`${DEFAULT_OUT}/build-info.json`,JSON.stringify(info));
 return {r,put,files,info,hashes,lock};
}
const errorsOf=r=>verifyStudio({repo:r}).errors.join('\n');
const rewriteInfo=(s,fn)=>{const f=path.join(s.r,DEFAULT_OUT,'build-info.json'),i=JSON.parse(fs.readFileSync(f,'utf8'));fn(i);fs.writeFileSync(f,JSON.stringify(i));};
const rewriteIndex=(s,fn)=>{const f=path.join(s.r,DEFAULT_OUT,'index.html'),h=fn(fs.readFileSync(f,'utf8'));fs.writeFileSync(f,h);rewriteInfo(s,i=>{i.files['index.html']=sha256(Buffer.from(h));});};

test('the checked-in lock is internally consistent (patch pins equal the patch files; commit equals the engine lock)',()=>{
 assert.deepEqual(verifyPatches(repo,config),[]);
 assert.equal(config.commit,JSON.parse(fs.readFileSync(path.join(repo,config.engineConfig),'utf8')).commit);
 assert.equal(config.upstreamTag,'v0.9.0');assert.equal(config.desktopVersion,undefined);assert.equal(config.desktopRepoCommit,undefined);
 assert.equal(Object.keys(config.featurePatches).length,2);assert.equal(Object.keys(config.androidPatches).length,7);
 assert.equal(config.env.RHWP_WITHOUT_AI,'1','the AI assistant (external network) stays out of the Android build');
 for(const p of ['rhwp-shared','vendor/npm/ajv','src/renderer/square_gradient.sksl'])assert.ok(config.sourcePaths.includes(p),p);
 assert.match(config.csp,/script-src 'self' 'wasm-unsafe-eval'/);assert.doesNotMatch(config.csp,/(^|[ ;])'unsafe-eval'/);assert.doesNotMatch(config.csp,/https?:|\*/);
});
test('the pinned CSP is exactly the policy MainActivity sends (the Studio may not need more than the shell allows)',()=>{
 const java=fs.readFileSync(path.join(repo,'app/src/main/java/kr/offline/hwp/MainActivity.java'),'utf8');
 assert.ok(java.includes(`"${config.csp}"`),'MainActivity Content-Security-Policy differs from config/android-studio.json csp');
});
test('a complete synthetic bundle verifies',()=>{const s=synthetic();assert.equal(errorsOf(s.r),'');});
test('a missing Studio fails with a clear instruction instead of packaging an inert UI',()=>{
 const s=synthetic();fs.rmSync(path.join(s.r,DEFAULT_OUT),{recursive:true});
 assert.match(errorsOf(s.r),/Missing .*build-info\.json: the desktop Studio frontend was not built\. Run: node scripts\/build-studio\.mjs/);
});
test('a tampered, extra or missing file is refused',()=>{
 let s=synthetic();fs.appendFileSync(path.join(s.r,DEFAULT_OUT,'assets/index-AbC123.js'),'//x');assert.match(errorsOf(s.r),/index-AbC123\.js does not match build-info\.json/);
 s=synthetic();s.put(`${DEFAULT_OUT}/assets/extra.js`,'x');assert.match(errorsOf(s.r),/extra\.js is not in build-info\.json/);
 s=synthetic();fs.rmSync(path.join(s.r,DEFAULT_OUT,'fonts/NanumGothic-Regular.woff2'));assert.match(errorsOf(s.r),/listed in build-info\.json but missing/);
});
test('a stale pin (patch set, lock, or engine core changed after the Studio was built) is refused',()=>{
 let s=synthetic();rewriteInfo(s,i=>{i.pins.androidPatches['0102-android-host-hooks.patch']='0'.repeat(64);});assert.match(errorsOf(s.r),/pin "androidPatches" differs/);
 s=synthetic();rewriteInfo(s,i=>{i.pins.upstreamTag='v0.8.7';});assert.match(errorsOf(s.r),/pin "upstreamTag" differs/);
 s=synthetic();rewriteInfo(s,i=>{i.core['rhwp_bg.wasm']='1'.repeat(64);});assert.match(errorsOf(s.r),/built on a different engine core/);
});
test('a modified patch file is refused even when build-info repeats the pins',()=>{
 const s=synthetic();fs.appendFileSync(path.join(s.r,config.androidPatchDir,'0102-android-host-hooks.patch'),'\n# tampered\n');assert.match(errorsOf(s.r),/0102-android-host-hooks\.patch does not match its pinned SHA-256/);
 const t=synthetic();t.put(`${config.androidPatchDir}/0999-extra.patch`,'x');assert.match(errorsOf(t.r),/holds .*0999-extra\.patch/);
});
test('the bundled WebAssembly must be the packaged engine, and only one copy may exist',()=>{
 let s=synthetic();const w=path.join(s.r,DEFAULT_OUT,'assets/rhwp_bg-XyZ789.wasm'),b=fs.readFileSync(w);b[b.length-1]^=1;fs.writeFileSync(w,b);rewriteInfo(s,i=>{i.files['assets/rhwp_bg-XyZ789.wasm']=sha256(b);});
 assert.match(errorsOf(s.r),/is not the packaged engine WebAssembly/);
 s=synthetic();s.put(`${DEFAULT_OUT}/rhwp_bg.wasm`,'x');rewriteInfo(s,i=>{i.files['rhwp_bg.wasm']=sha256(Buffer.from('x'));});assert.match(errorsOf(s.r),/stray public copy/);
});
test('index.html: pinned CSP, host script before the module, no external or non-/studio/ references',()=>{
 let s=synthetic();rewriteIndex(s,h=>h.replace(/content="[^"]*"/,`content="default-src * 'unsafe-eval'"`));assert.match(errorsOf(s.r),/CSP differs from the pinned policy/);
 s=synthetic();rewriteIndex(s,h=>h.replace('<meta http-equiv="Content-Security-Policy"','<meta name="x"'));assert.match(errorsOf(s.r),/no Content-Security-Policy meta/);
 s=synthetic();rewriteIndex(s,h=>{const host='<script src="/studio-host.js"></script>',mod=h.match(/<script type="module"[^>]*><\/script>/)[0];return h.replace(host,'').replace(mod,mod+host);});assert.match(errorsOf(s.r),/after the Studio module/);
 s=synthetic();rewriteIndex(s,h=>h.replace('<script src="/studio-host.js"></script>',''));assert.match(errorsOf(s.r),/does not load \/studio-host\.js/);
 s=synthetic();rewriteIndex(s,h=>h.replace('</head>','<link rel="stylesheet" href="https://cdn.example/x.css"></head>'));assert.match(errorsOf(s.r),/references outside \/studio\//);
 s=synthetic();rewriteIndex(s,h=>h.replace('</head>','<script src="/other.js"></script></head>'));assert.match(errorsOf(s.r),/references outside \/studio\//);
 s=synthetic();rewriteIndex(s,h=>h.replace('index-AbC123.js','index-Missing.js'));assert.match(errorsOf(s.r),/references missing \/studio\/assets\/index-Missing\.js/);
});
test('names the asset server would refuse and files that must not ship are refused',()=>{
 let s=synthetic();s.put(`${DEFAULT_OUT}/fonts/한글.woff2`,'x');rewriteInfo(s,i=>{i.files['fonts/한글.woff2']=sha256(Buffer.from('x'));});assert.match(errorsOf(s.r),/file name would be refused by the asset server/);
 s=synthetic();s.put(`${DEFAULT_OUT}/sw.js`,'x');rewriteInfo(s,i=>{i.files['sw.js']=sha256(Buffer.from('x'));});assert.match(errorsOf(s.r),/must not be shipped/);
 s=synthetic();s.put(`${DEFAULT_OUT}/assets/index.js.map`,'x');rewriteInfo(s,i=>{i.files['assets/index.js.map']=sha256(Buffer.from('x'));});assert.match(errorsOf(s.r),/must not be shipped/);
});
test('the engine gate is part of verifyStudio (a foreign engine fails the Studio gate too)',()=>{
 const s=synthetic();fs.appendFileSync(path.join(s.r,ENGINE_ASSETS,'rhwp.js'),'//x');assert.match(errorsOf(s.r),/engine: rhwp\.js does not match build-info\.json/);
});
