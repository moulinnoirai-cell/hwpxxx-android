#!/usr/bin/env node
// Check whether upstream rhwp has a newer stable release than the one pinned in config/android-studio.json and, if so, whether the hwpxxx patch
// series still applies to it. Nothing in the repository is modified; the result goes to stdout, to --report <file.md> and to --json <file.json>.
//   node scripts/check-upstream.mjs [--tag vX.Y.Z] [--repo <url|path>] [--config <file>] [--report <md>] [--json <json>] [--scheduled]
// --scheduled makes the run a no-op in odd ISO weeks (the workflow fires weekly; this gives the two-week cadence).
// Exit code: 0 = checked (read the report: up-to-date / update-applies / update-conflicts), 2 = the check itself failed.
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const STABLE=/^v(\d+)\.(\d+)\.(\d+)$/;
export function parseStable(tag){const m=STABLE.exec(tag);return m?[+m[1],+m[2],+m[3]]:null;}
export function compareStable(a,b){const x=parseStable(a),y=parseStable(b);for(let i=0;i<3;i++){if(x[i]!==y[i])return x[i]-y[i];}return 0;}
/** Newest stable (vX.Y.Z) tag among the given names, or null. */
export function latestStable(tags){return tags.filter(t=>parseStable(t)).sort(compareStable).pop()??null;}
/** ISO-8601 week number of a date (UTC). */
export function isoWeek(date){const d=new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),date.getUTCDate()));const day=d.getUTCDay()||7;d.setUTCDate(d.getUTCDate()+4-day);const y0=Date.UTC(d.getUTCFullYear(),0,1);return Math.ceil(((d-y0)/86400000+1)/7);}
/** The two-week cadence: only even ISO weeks run. */
export function isRunWeek(date){return isoWeek(date)%2===0;}
export function parseTagList(lsRemote){return lsRemote.split('\n').map(l=>l.split('\t')[1]?.replace(/^refs\/tags\//,'')).filter(Boolean);}
export function cargoLockVersion(lock,name){const m=new RegExp(`\\[\\[package\\]\\]\\nname = "${name}"\\nversion = "([^"]+)"`).exec(lock);return m?m[1]:null;}

const git=(args,opts={})=>execFileSync('git',args,{encoding:'utf8',maxBuffer:1<<30,stdio:['ignore','pipe','pipe'],...opts});
const sha256=buf=>createHash('sha256').update(buf).digest('hex');

function listPatches(dir){return existsSync(dir)?readdirSync(dir).filter(n=>n.endsWith('.patch')).sort():[];}

/** Try the patch series on `tag` of `repo`. Returns the structured result; never throws for a patch conflict. */
export function analyze({repo,tag,config,root}){
  const tmp=mkdtempSync(join(tmpdir(),'check-upstream-'));
  try{
    const up=join(tmp,'up'),work=join(tmp,'work');
    git(['init','-q',up]);
    git(['-C',up,'fetch','-q','--depth','1',repo,`refs/tags/${tag}:refs/tags/${tag}`]);
    const commit=git(['-C',up,'rev-parse',`${tag}^{commit}`]).trim();
    const present=new Set(git(['-C',up,'ls-tree','--name-only','-r',commit,'--',...config.sourcePaths,'Cargo.lock'],{}).split('\n').filter(Boolean));
    const missing=config.sourcePaths.filter(p=>![...present].some(f=>f===p||f.startsWith(p+'/')));
    const result={tag,commit,missingSourcePaths:missing,patches:[],packageLockSha256:null,packageLockChanged:null,wasmBindgen:null,wasmBindgenPinned:null,wasmBindgenChanged:null};
    git(['init','-q',work]);git(['-C',work,'config','core.autocrlf','false']);
    const archive=execFileSync('git',['-C',up,'archive','--format=tar',commit,...config.sourcePaths.filter(p=>!missing.includes(p)),...(present.has('Cargo.lock')?['Cargo.lock']:[])],{maxBuffer:1<<30});
    execFileSync('tar',['-x','-C',work],{input:archive});
    const lockPath=join(work,'rhwp-studio','package-lock.json');
    if(existsSync(lockPath)){result.packageLockSha256=sha256(readFileSync(lockPath));result.packageLockChanged=result.packageLockSha256!==config.packageLockSha256;}
    const cargoLock=join(work,'Cargo.lock');
    if(existsSync(cargoLock)){
      const engine=JSON.parse(readFileSync(resolve(root,config.engineConfig),'utf8'));
      result.wasmBindgen=cargoLockVersion(readFileSync(cargoLock,'utf8'),'wasm-bindgen');
      result.wasmBindgenPinned=engine.wasmBindgen;result.wasmBindgenChanged=result.wasmBindgen!==null&&result.wasmBindgen!==engine.wasmBindgen;
    }
    let broken=false;
    for(const dirKey of ['featurePatchDir','androidPatchDir']){
      const dir=resolve(root,config[dirKey]);
      for(const name of listPatches(dir)){
        const file=join(dir,name);
        if(broken){result.patches.push({name,status:'skipped'});continue;}
        try{git(['-C',work,'apply','--check','--whitespace=nowarn',file]);git(['-C',work,'apply','--whitespace=nowarn',file]);result.patches.push({name,status:'applies'});}
        catch(e){broken=true;result.patches.push({name,status:'conflict',detail:String(e.stderr||e.message).trim().split('\n').slice(0,8).join('\n')});}
      }
    }
    result.applies=!broken&&missing.length===0;
    return result;
  }finally{rmSync(tmp,{recursive:true,force:true});}
}

export function renderReport({current,latest,result}){
  const L=[];
  if(!latest)return 'rhwp: no stable release tag found upstream.\n';
  if(compareStable(latest,current)<=0){return `rhwp ${current} is the latest stable release (upstream latest: ${latest}). Nothing to do.\n`;}
  L.push(`## rhwp ${latest} is available (pinned: ${current})`,'');
  L.push(`Upstream commit: \`${result.commit}\``,'');
  L.push(result.applies?'**The patch series applies cleanly.** Port steps: update `config/android-studio.json` (`upstreamTag`, `commit`, `packageLockSha256`) and the engine pin, rebuild the engine and Studio, run the suites.'
                       :'**The patch series does NOT apply cleanly** — the patches need to be regenerated against the new upstream.','');
  L.push('| patch | result |','|---|---|');
  for(const p of result.patches)L.push(`| ${p.name} | ${p.status} |`);
  for(const p of result.patches.filter(p=>p.detail))L.push('',`\`${p.name}\`:`,'```',p.detail,'```');
  if(result.missingSourcePaths.length)L.push('',`Source paths missing upstream (update \`sourcePaths\`): ${result.missingSourcePaths.map(p=>`\`${p}\``).join(', ')}`);
  L.push('','### Pins');
  L.push(`- package-lock.json sha256: \`${result.packageLockSha256??'n/a'}\` (${result.packageLockChanged===null?'unknown':result.packageLockChanged?'changed':'unchanged'})`);
  if(result.wasmBindgen)L.push(`- wasm-bindgen: upstream ${result.wasmBindgen}, pinned ${result.wasmBindgenPinned} (${result.wasmBindgenChanged?'changed — update config/android-engine.json':'same'})`);
  return L.join('\n')+'\n';
}

function parseArgs(argv){const o={};for(let i=0;i<argv.length;i++){const a=argv[i];if(a==='--scheduled')o.scheduled=true;else if(a.startsWith('--')){o[a.slice(2)]=argv[++i];if(o[a.slice(2)]===undefined)throw new Error(`missing value for ${a}`);}else throw new Error(`unexpected argument ${a}`);}return o;}

export function main(argv=process.argv.slice(2),now=new Date()){
  const o=parseArgs(argv);
  const configPath=resolve(o.config??join(dirname(fileURLToPath(import.meta.url)),'..','config','android-studio.json'));
  const root=dirname(dirname(configPath)); // <root>/config/<file>.json
  const config=JSON.parse(readFileSync(configPath,'utf8'));
  const out={checked:false};
  const emit=(md,json)=>{process.stdout.write(md);if(o.report)writeFileSync(o.report,md);if(o.json)writeFileSync(o.json,JSON.stringify(json,null,2)+'\n');};
  if(o.scheduled&&!isRunWeek(now)){emit(`Skipped: ISO week ${isoWeek(now)} is odd (the check runs every second week).\n`,{...out,skipped:true});return 0;}
  const repo=o.repo??config.upstream+'.git';
  const latest=o.tag??latestStable(parseTagList(git(['ls-remote','--tags','--refs',repo])));
  const current=config.upstreamTag;
  if(!latest||compareStable(latest,current)<=0){emit(renderReport({current,latest,result:null}),{checked:true,current,latest,newer:false});return 0;}
  const result=analyze({repo,tag:latest,config,root});
  emit(renderReport({current,latest,result}),{checked:true,current,latest,newer:true,...result});
  return 0;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{process.exit(main());}catch(e){console.error(`check-upstream failed: ${e.message}`);process.exit(2);}
}
