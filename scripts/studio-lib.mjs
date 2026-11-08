// Shared by build-studio.mjs / verify-studio.mjs / install-studio checks: pins, hashing and the output verifier.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {verifyEngine} from './verify-engine.mjs';

export const sha256=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
export const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const CONFIG='config/android-studio.json';
export const DEFAULT_OUT='app/src/main/assets/studio';
export const ENGINE_ASSETS='app/src/main/assets/engine';
// Same file-name rule as MainActivity.intercept (anything else would be answered 403 inside the APK).
export const ASSET_NAME=/^[A-Za-z0-9_./-]+$/;

export const readJson=p=>JSON.parse(fs.readFileSync(p,'utf8'));
export function* walk(dir,base=dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())yield* walk(p,base);else yield path.relative(base,p).split(path.sep).join('/');}}

/** The in-repository patch files are exactly the pinned ones (names, order, bytes). Returns error strings. */
export function verifyPatches(repo,config){
 const errors=[];
 for(const [dirKey,mapKey] of [['desktopPatchDir','desktopPatches'],['androidPatchDir','androidPatches']]){
  const dir=path.join(repo,config[dirKey]),pins=config[mapKey]||{};
  let present=[];try{present=fs.readdirSync(dir).filter(n=>n.endsWith('.patch')).sort();}catch{errors.push(`Missing patch directory ${config[dirKey]}`);continue;}
  const pinned=Object.keys(pins).sort();
  if(JSON.stringify(present)!==JSON.stringify(pinned))errors.push(`${config[dirKey]} holds ${JSON.stringify(present)} but ${CONFIG} ${mapKey} pins ${JSON.stringify(pinned)}`);
  for(const name of pinned){const f=path.join(dir,name);if(!fs.existsSync(f)){errors.push(`Missing patch ${config[dirKey]}/${name}`);continue;}if(sha256(fs.readFileSync(f))!==pins[name])errors.push(`Patch ${config[dirKey]}/${name} does not match its pinned SHA-256`);}
 }
 return errors;
}

export function readConfig(repo=root){
 const config=readJson(path.join(repo,CONFIG));
 for(const k of ['format','upstream','commit','desktopVersion','desktopRepoCommit','packageLockSha256','sourcePaths','desktopPatchDir','androidPatchDir','desktopPatches','androidPatches','base','env','csp','engineConfig'])if(config[k]===undefined)throw new Error(`${CONFIG} lacks "${k}"`);
 return config;
}

/**
 * Gate used by Gradle (verifyStudio) and the tests: the packaged Studio must be the one the pins describe, built on the packaged engine core.
 *   node scripts/verify-studio.mjs
 */
export function verifyStudio({repo=root,out=DEFAULT_OUT,engine=ENGINE_ASSETS}={}){
 const errors=[],at=p=>path.join(repo,p);
 let config;try{config=readConfig(repo);}catch(e){return {errors:[e.message]};}
 errors.push(...verifyPatches(repo,config));
 const engineCheck=verifyEngine({root:repo,assets:engine});
 if(engineCheck.errors.length)errors.push(...engineCheck.errors.map(e=>`engine: ${e}`));
 const engineLock=readJson(at(config.engineConfig));
 if(engineLock.commit!==config.commit)errors.push(`${CONFIG} commit ${config.commit} differs from ${config.engineConfig} commit ${engineLock.commit}`);
 const dir=at(out),infoFile=path.join(dir,'build-info.json');
 if(!fs.existsSync(infoFile)){errors.push(`Missing ${out}/build-info.json: the desktop Studio frontend was not built. Run: node scripts/build-studio.mjs --upstream .build/rhwp  (a Studio-less APK would ship an inert UI)`);return {errors,config};}
 let info;try{info=readJson(infoFile);}catch(e){return {errors:[...errors,`${out}/build-info.json is not valid JSON: ${e.message}`],config};}
 // 1. every pin of the lock is repeated by the build (stale or foreign Studio build otherwise)
 for(const k of Object.keys(config))if(JSON.stringify(info.pins?.[k])!==JSON.stringify(config[k]))errors.push(`build-info.json pin "${k}" differs from ${CONFIG} (stale Studio build: rebuild with scripts/build-studio.mjs)`);
 // 2. built on the packaged engine core
 const engineInfo=engineCheck.info;
 if(engineInfo)for(const n of ['rhwp.js','rhwp_bg.wasm','rhwp.d.ts'])if(info.core?.[n]!==engineInfo.hashes?.[n])errors.push(`Studio was built on a different engine core (${n}: ${String(info.core?.[n]).slice(0,12)} vs packaged ${String(engineInfo.hashes?.[n]).slice(0,12)}); rebuild Studio after the engine`);
 // 3. files on disk are the files that were built
 const files=info.files||{},onDisk=new Set(fs.existsSync(dir)?[...walk(dir)].filter(f=>f!=='build-info.json'):[]);
 for(const f of onDisk){if(!ASSET_NAME.test(f))errors.push(`${out}/${f}: file name would be refused by the asset server ([A-Za-z0-9_./-] only)`);if(!(f in files))errors.push(`${out}/${f} is not in build-info.json`);else if(sha256(fs.readFileSync(path.join(dir,f)))!==files[f])errors.push(`${out}/${f} does not match build-info.json`);}
 for(const f of Object.keys(files))if(!onDisk.has(f))errors.push(`${out}/${f} is listed in build-info.json but missing`);
 // 4. shape of the generated page
 const indexFile=path.join(dir,'index.html');
 if(!fs.existsSync(indexFile))errors.push(`Missing ${out}/index.html`);
 else{
  const html=fs.readFileSync(indexFile,'utf8');
  const meta=html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)"/);
  if(!meta)errors.push('index.html has no Content-Security-Policy meta');else if(meta[1]!==config.csp)errors.push('index.html CSP differs from the pinned policy');
  const host=html.indexOf('<script src="/studio-host.js"></script>'),mod=html.search(/<script type="module"/);
  if(host<0)errors.push('index.html does not load /studio-host.js');
  else if(mod>=0&&host>mod)errors.push('index.html loads /studio-host.js after the Studio module (it must run first)');
  if(mod<0)errors.push('index.html has no Studio module script');
  const bad=[...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(m=>m[1]).filter(u=>/^(?:[a-z]+:)?\/\//i.test(u)||(u.startsWith('/')&&!u.startsWith('/studio/')&&u!=='/studio-host.js'));
  if(bad.length)errors.push(`index.html references outside /studio/: ${bad.join(', ')}`);
  for(const m of html.matchAll(/(?:src|href)="(\/studio\/[^"#?]+)"/g)){const rel=m[1].slice('/studio/'.length);if(!onDisk.has(rel))errors.push(`index.html references missing ${m[1]}`);}
  if(/\bsrc="\/src\/|\.ts"/.test(html))errors.push('index.html still points at TypeScript sources (not a production build)');
 }
 for(const need of ['fonts/NanumGothic-Regular.woff2','LICENSE-rhwp.txt','THIRD_PARTY_LICENSES-rhwp.md'])if(!onDisk.has(need))errors.push(`${out}/${need} is missing`);
 const wasms=[...onDisk].filter(f=>/^assets\/rhwp_bg-[\w-]+\.wasm$/.test(f));
 if(wasms.length!==1)errors.push(`expected exactly one bundled assets/rhwp_bg-*.wasm, found ${wasms.length}`);
 else if(engineInfo&&files[wasms[0]]!==engineInfo.hashes?.['rhwp_bg.wasm'])errors.push(`${out}/${wasms[0]} is not the packaged engine WebAssembly`);
 if(onDisk.has('rhwp.js')||onDisk.has('rhwp_bg.wasm'))errors.push('stray public copy of the engine core in the Studio output');
 for(const f of onDisk)if(/\.(ts|map)$/.test(f)||f.startsWith('samples/')||f==='sw.js'||/^workbox/.test(f)||f.endsWith('.webmanifest'))errors.push(`${out}/${f} must not be shipped (type declarations, maps, upstream samples and PWA files are stripped)`);
 return {errors,info,config};
}

// ── Destructive-path guard ─────────────────────────────────────────────────────────────────────────────────────────
// build-studio.mjs deletes its work directory and its output directory before it writes them. Both must therefore be
// provably disposable: this runs BEFORE any mutation and refuses everything else (repository root, upstream checkout,
// engine core, overlaps, paths outside the repository's .build directory, symlink escapes). The generated asset
// directory (DEFAULT_OUT) is the only allowed location outside .build.
const within=(child,parent)=>{const r=path.relative(parent,child);return r===''||(!r.startsWith('..')&&!path.isAbsolute(r));};
const strictlyWithin=(child,parent)=>within(child,parent)&&path.relative(parent,child)!=='';
/** realpath of the deepest existing ancestor + the not yet existing remainder (so symlinked parents are resolved). */
export function resolveReal(p){
 let cur=path.resolve(p),rest=[];
 for(;;){try{return path.join(fs.realpathSync(cur),...rest.reverse());}catch(e){if(e.code!=='ENOENT'&&e.code!=='ENOTDIR')throw e;const up=path.dirname(cur);if(up===cur)return path.join(cur,...rest.reverse());rest.push(path.basename(cur));cur=up;}}
}
/** Throws (before anything is touched) unless work/out are disposable build locations. Returns the resolved real paths. */
export function assertSafeBuildPaths({repo=root,work,out,upstream,core,extra=[]}){
 const R=resolveReal(repo),buildDir=path.join(R,'.build'),defaultOut=path.join(R,DEFAULT_OUT);
 const p={work:resolveReal(work),out:resolveReal(out),upstream:resolveReal(upstream),core:resolveReal(core)};
 const problems=[];
 const lexical={work:path.resolve(work),out:path.resolve(out)};
 // 1. location: work only under <repo>/.build; out only the generated asset directory or under <repo>/.build
 if(!strictlyWithin(p.work,buildDir))problems.push(`--work ${work} must be a directory below ${buildDir} (it is deleted before every build)`);
 if(!(p.out===defaultOut||strictlyWithin(p.out,buildDir)))problems.push(`--out ${out} must be ${path.relative(R,defaultOut)} or a directory below ${buildDir} (it is deleted before every build)`);
 // 2. a symlinked work/out (or a symlinked parent that leaves the allowed area) is refused even if its target looks fine
 for(const [k,lex] of Object.entries(lexical)){if(p[k]!==lex&&resolveReal(lex)!==path.resolve(lex)&&!within(resolveReal(path.dirname(lex)),R))problems.push(`--${k} ${lex} resolves through a symlink to ${p[k]}`);try{if(fs.lstatSync(lex).isSymbolicLink())problems.push(`--${k} ${lex} is a symbolic link`);}catch{}}
 // 3. nothing may be, contain or sit inside anything else that the build reads or protects
 const named={'repository root':R,'upstream checkout':p.upstream,'engine core':p.core,'work directory':p.work,'output directory':p.out};
 for(const e of extra)named[`input ${e}`]=resolveReal(e);
 const entries=Object.entries(named);
 for(const [a,pa] of entries)for(const [b,pb] of entries){if(a>=b)continue;
  if(a==='repository root'||b==='repository root'){const other=a==='repository root'?pb:pa,name=a==='repository root'?b:a;if(other===R)problems.push(`${name} is the repository root`);continue;}
  if(!(a.startsWith('work')||a.startsWith('output')||b.startsWith('work')||b.startsWith('output')))continue; // only pairs involving a deleted directory matter
  if(within(pa,pb)||within(pb,pa))problems.push(`${a} (${pa}) and ${b} (${pb}) overlap`);}
 for(const [name,v] of Object.entries({work:p.work,out:p.out}))for(const protectedDir of ['.git','config','scripts','patches','tests','docs','app/src/main/java','app/src/main/assets/engine','.build/engine'])if(within(v,path.join(R,protectedDir)))problems.push(`--${name} points into protected ${protectedDir}`);
 if(problems.length)throw new Error('unsafe --work/--out (nothing was touched):\n - '+[...new Set(problems)].join('\n - '));
 return {...p,repo:R};
}
