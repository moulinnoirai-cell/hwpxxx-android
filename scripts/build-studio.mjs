// Build the desktop Studio frontend (rhwp-studio + the 11 hwpxxx PC patches + Android patches) for the Android app.
//   node scripts/build-studio.mjs [--upstream .build/rhwp] [--core app/src/main/assets/engine] [--work .build/studio-src]
//        [--out app/src/main/assets/studio] [--node-modules <dir with a matching npm ci result>] [--run-tests] [--print-pins] [--check-paths]
// --work/--out are DELETED before each build, so they must be below .build/ (out may also be the generated asset directory); anything else is refused.
// Inputs are all pinned in config/android-studio.json: upstream commit, PC patch hashes, Android patch hashes, package-lock hash and the
// engine core (verified by scripts/verify-engine.mjs). Nothing generated is tracked; the output goes to app/src/main/assets/studio (ignored).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {root,sha256,readConfig,readJson,walk,verifyPatches,verifyStudio,assertSafeBuildPaths,CONFIG,DEFAULT_OUT,ENGINE_ASSETS} from './studio-lib.mjs';
import {verifyEngine} from './verify-engine.mjs';

const arg=(name,fallback)=>{const i=process.argv.indexOf(name);return i>0&&process.argv[i+1]&&!process.argv[i+1].startsWith('--')?process.argv[i+1]:fallback;};
const flag=name=>process.argv.includes(name);
const abs=p=>path.resolve(root,p);
const run=(cmd,args,opts={})=>execFileSync(cmd,args,{stdio:'inherit',...opts});
const out_=(cmd,args,opts={})=>execFileSync(cmd,args,{encoding:'utf8',...opts}).trim();
const fail=m=>{console.error('build-studio: '+m);process.exit(1);};

const config=readConfig();
if(flag('--write-pins')){// maintainers: after editing a patch, record the new hashes in the lock (review the diff!)
 const hashes=dir=>Object.fromEntries(fs.readdirSync(abs(dir)).filter(n=>n.endsWith('.patch')).sort().map(n=>[n,sha256(fs.readFileSync(path.join(abs(dir),n)))]));
 fs.writeFileSync(abs(CONFIG),JSON.stringify({...config,desktopPatches:hashes(config.desktopPatchDir),androidPatches:hashes(config.androidPatchDir)},null,2)+'\n');console.log('pins written');process.exit(0);
}
if(flag('--print-pins')){
 const hashes=dir=>Object.fromEntries(fs.readdirSync(abs(dir)).filter(n=>n.endsWith('.patch')).sort().map(n=>[n,sha256(fs.readFileSync(path.join(abs(dir),n)))]));
 console.log(JSON.stringify({desktopPatches:hashes(config.desktopPatchDir),androidPatches:hashes(config.androidPatchDir)},null,2));process.exit(0);
}
const upstream=abs(arg('--upstream','.build/rhwp')),core=abs(arg('--core',ENGINE_ASSETS)),work=abs(arg('--work','.build/studio-src')),out=abs(arg('--out',DEFAULT_OUT));
// Nothing below deletes anything until these paths are proven disposable (see assertSafeBuildPaths).
const reuseModules=arg('--node-modules');
try{assertSafeBuildPaths({work,out,upstream,core,extra:reuseModules?[path.resolve(reuseModules)]:[]});}catch(e){fail(e.message);}
if(flag('--check-paths')){console.log('paths ok (no changes made)');process.exit(0);}

// 1. Pins: patches, engine core, upstream commit.
const patchErrors=verifyPatches(root,config);if(patchErrors.length)fail('patch pins:\n - '+patchErrors.join('\n - '));
const engine=verifyEngine({root,assets:path.relative(root,core)});
if(engine.errors.length)fail('the engine core is not the pinned build (build the engine first: bash scripts/build-engine.sh .build/rhwp):\n - '+engine.errors.join('\n - '));
const engineLock=readJson(abs(config.engineConfig));
if(engineLock.commit!==config.commit)fail(`${CONFIG} commit differs from ${config.engineConfig}`);
const head=out_('git',['-C',upstream,'rev-parse','HEAD']);
if(head!==config.commit)fail(`upstream checkout ${upstream} is at ${head}, expected ${config.commit}`);

// 2. Clean source tree from the pinned commit (git archive, independent of working-tree edits such as the engine patch).
fs.rmSync(work,{recursive:true,force:true});fs.mkdirSync(work,{recursive:true});
const archive=execFileSync('git',['-C',upstream,'archive','--format=tar','HEAD',...config.sourcePaths],{maxBuffer:1<<30});
execFileSync('tar',['-x','-C',work],{input:archive});
// The work tree is its own tiny repository so `git apply` roots patches here, never in a parent checkout.
run('git',['init','-q',work]);run('git',['-C',work,'config','core.autocrlf','false']);
const studio=path.join(work,'rhwp-studio');
if(sha256(fs.readFileSync(path.join(studio,'package-lock.json')))!==config.packageLockSha256)fail('package-lock.json differs from the pinned packageLockSha256');

// 3. PC patches, then Android patches (hashes already verified above; apply --check first so a conflict names the patch).
const applied=[];
for(const [dir,pins] of [[config.desktopPatchDir,config.desktopPatches],[config.androidPatchDir,config.androidPatches]])for(const name of Object.keys(pins).sort()){
 const file=path.join(abs(dir),name);
 try{run('git',['-C',work,'apply','--check','--whitespace=nowarn',file]);run('git',['-C',work,'apply','--whitespace=nowarn',file]);}catch{fail(`patch does not apply: ${dir}/${name}`);}
 applied.push(`${dir}/${name}`);
}
console.log(`applied ${applied.length} patches`);

// 4. Public inputs like upstream's Pages build: engine core, real font files (the symlink points outside rhwp-studio), favicon.
const pkg=path.join(work,'pkg');fs.mkdirSync(pkg,{recursive:true});
for(const n of ['rhwp.js','rhwp.d.ts','rhwp_bg.wasm']){fs.copyFileSync(path.join(core,n),path.join(pkg,n));}
// (Upstream's Pages build also copies rhwp.js/rhwp_bg.wasm into public/; Studio imports the core through @wasm and bundles the WebAssembly
// into assets/, so the public copies were dead weight: ~14 MB twice more in the APK. Neither is copied here.)
const fonts=path.join(studio,'public/fonts');fs.rmSync(fonts,{recursive:true,force:true});fs.cpSync(path.join(work,'assets/fonts'),fonts,{recursive:true});
fs.copyFileSync(path.join(work,'assets/logo/favicon.ico'),path.join(studio,'public/favicon.ico'));

// 5. Node modules: a clean `npm ci` (network once) or a reused result whose hidden lockfile matches package-lock.json.
const modules=path.join(studio,'node_modules'),reuse=reuseModules;
if(reuse){
 const src=path.resolve(reuse),hidden=path.join(src,'.package-lock.json');
 if(!fs.existsSync(hidden))fail(`${src} has no .package-lock.json (not an npm ci result)`);
 const want=readJson(path.join(studio,'package-lock.json')).packages,have=readJson(hidden).packages;
 for(const [k,v] of Object.entries(have)){if(!want[k]||want[k].version!==v.version||want[k].integrity!==v.integrity)fail(`reused node_modules differ from package-lock.json at ${k}`);}
 for(const [k,v] of Object.entries(want)){if(k&&!v.optional&&!have[k])fail(`reused node_modules lack ${k}`);}
 fs.symlinkSync(src,modules,'dir');
}else run('npm',['ci','--no-audit','--no-fund'],{cwd:studio});

// 6. Type check, optional Studio unit tests for the Android surface, production build for /studio/.
const env={...process.env,...config.env};
run(process.execPath,[path.join(modules,'typescript/bin/tsc'),'--noEmit','-p',studio],{env});
if(flag('--run-tests')){
 // Exactly the Android-specific unit tests that the patches add (naming convention rhwp-studio/tests/hwpxxx-android-*.test.ts: host surface, save safety,
 // private history/recent, ...). Deliberately NOT the whole upstream suite: on the sparse source tree it has known baseline failures (missing Rust/scripts files).
 const tests=fs.readdirSync(path.join(studio,'tests')).filter(n=>/^hwpxxx-android-.+\.test\.ts$/.test(n)).sort().map(n=>'tests/'+n);
 if(!tests.length)fail('no Android unit tests (tests/hwpxxx-android-*.test.ts) found in the patched source');
 console.log('Android unit tests:',tests.join(' '));
 run(process.execPath,['--test',...tests],{cwd:studio,env});
}
fs.rmSync(path.join(studio,'dist'),{recursive:true,force:true});
run(process.execPath,[path.join(modules,'vite/bin/vite.js'),'build',`--base=${config.base}`],{cwd:studio,env});
const dist=path.join(studio,'dist');

// 7. Keep runtime files only; add notices (upstream licence, third-party list, licences of bundled npm packages).
for(const f of ['rhwp.d.ts','rhwp_bg.wasm.d.ts','rhwp.js','rhwp_bg.wasm'])fs.rmSync(path.join(dist,f),{force:true});// public/ copies (upstream tracks a stale rhwp.js there) are not used by Studio
fs.rmSync(path.join(dist,'samples'),{recursive:true,force:true});
fs.copyFileSync(path.join(work,'LICENSE'),path.join(dist,'LICENSE-rhwp.txt'));
fs.copyFileSync(path.join(work,'THIRD_PARTY_LICENSES.md'),path.join(dist,'THIRD_PARTY_LICENSES-rhwp.md'));
const pkgJson=readJson(path.join(studio,'package.json'));fs.mkdirSync(path.join(dist,'licenses'),{recursive:true});
for(const dep of Object.keys(pkgJson.dependencies||{})){
 const dir=path.join(modules,dep),lic=fs.readdirSync(dir).find(n=>/^(licen[cs]e|copying)/i.test(n));
 if(!lic)fail(`no licence file for bundled dependency ${dep}`);
 fs.copyFileSync(path.join(dir,lic),path.join(dist,'licenses',dep.replace(/[^A-Za-z0-9_.-]/g,'_')+'-LICENSE.txt'));
}
// The bundled WebAssembly must be the engine core, byte for byte (checked again by verify-studio).
const bundled=[...walk(dist)].filter(f=>/^assets\/rhwp_bg-[\w-]+\.wasm$/.test(f));
if(bundled.length!==1||sha256(fs.readFileSync(path.join(dist,bundled[0])))!==engine.info.hashes['rhwp_bg.wasm'])fail('the bundled WebAssembly is not the engine core');
// 8. Index: strict CSP (identical to MainActivity's header) and the host script that must run before the Studio module.
const indexFile=path.join(dist,'index.html');let html=fs.readFileSync(indexFile,'utf8');
if(!/<head>/.test(html))fail('unexpected index.html (no <head>)');
html=html.replace('<head>',`<head>\n  <meta http-equiv="Content-Security-Policy" content="${config.csp}">\n  <script src="/studio-host.js"></script>`);
fs.writeFileSync(indexFile,html);

// 9. Publish into the (ignored) asset directory together with build-info.json.
fs.rmSync(out,{recursive:true,force:true});fs.mkdirSync(out,{recursive:true});fs.cpSync(dist,out,{recursive:true});
const files={};for(const f of [...walk(out)].sort())files[f]=sha256(fs.readFileSync(path.join(out,f)));
const mainScript=Object.keys(files).find(f=>/^assets\/index-[\w-]+\.js$/.test(f));
const info={pins:config,core:engine.info.hashes,coreVersion:engine.info.version,mainScript,tools:{node:process.version,npm:out_('npm',['--version']),vite:readJson(path.join(modules,'vite/package.json')).version,typescript:readJson(path.join(modules,'typescript/package.json')).version},appliedPatches:applied,files};
fs.writeFileSync(path.join(out,'build-info.json'),JSON.stringify(info,null,2)+'\n');
const {errors}=verifyStudio({out:path.relative(root,out)});
if(errors.length)fail('the built Studio failed verification:\n - '+errors.join('\n - '));
console.log(`Studio built: ${out} (${Object.keys(files).length} files, main ${mainScript})`);
