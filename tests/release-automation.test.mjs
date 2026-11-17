// Release automation gates: the signed-release job in .github/workflows/android.yml (text guards: secrets only in the release job,
// tag-only, environment, least privilege), scripts/sign-release.sh input refusals, and scripts/check-upstream.mjs on a local fixture
// "upstream" repository (no network). Run: node --test tests/release-automation.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {latestStable,compareStable,isoWeek,isRunWeek,parseTagList,cargoLockVersion,analyze,renderReport,main} from '../scripts/check-upstream.mjs';
const repo=path.resolve(new URL('..',import.meta.url).pathname);
const read=p=>fs.readFileSync(path.join(repo,p),'utf8');

/** Split a workflow into its top-level jobs (the workflows here are simple, 2-space-indented YAML). */
function jobs(text){
  const body=text.slice(text.indexOf('\njobs:\n')+7);const out={};let name=null;
  for(const line of body.split('\n')){const m=/^  ([a-z][\w-]*):\s*$/.exec(line);if(m){name=m[1];out[name]='';}else if(name)out[name]+=line+'\n';}
  return out;
}

test('android.yml: tag trigger and a release job guarded for tags only',()=>{
  const wf=read('.github/workflows/android.yml');
  assert.match(wf,/tags: \['v\*'\]/);
  const j=jobs(wf);assert.ok(j.release,'release job exists');
  assert.match(j.release,/if: startsWith\(github\.ref, 'refs\/tags\/v'\)/);
  assert.match(j.release,/needs: \[build, emulator, identity\]/);
  // public repository: the history is checked for personal author/committer addresses, and a release waits for that check
  assert.match(j.identity,/fetch-depth: 0/);assert.match(j.identity,/bash scripts\/check-commit-identity\.sh HEAD/);
  assert.doesNotMatch(j.identity,/secrets\./);
  assert.match(j.release,/environment: release/);
  assert.match(j.release,/permissions:\n\s+contents: write/);
  assert.match(j.release,/merge-base --is-ancestor/);
  assert.match(j.release,/EXPECTED_CERT_SHA256: d7763191854c02a1e2589dc69c92521f10f0eded2ebd310b07d65fb69cb7f4c8/);
  assert.match(j.release,/--verify-tag/);
});
test('android.yml: signing secrets appear only inside the release job and nothing else gets write access',()=>{
  const wf=read('.github/workflows/android.yml');const j=jobs(wf);
  for(const [name,text] of Object.entries(j)){
    if(name==='release')continue;
    assert.doesNotMatch(text,/secrets\./,`${name} must not use secrets`);
    assert.doesNotMatch(text,/contents: write/,`${name} must not have write access`);
  }
  assert.match(wf.split('\njobs:')[0],/permissions:\n  contents: read/,'workflow default is read-only');
  assert.doesNotMatch(wf,/pull_request_target/);
  // Secrets are never echoed or passed on a command line.
  assert.doesNotMatch(j.release,/echo[^\n]*\$\{?(KEYSTORE_PASSWORD|RELEASE_KEYSTORE_BASE64)/);
  assert.doesNotMatch(j.release,/--ks-pass pass:/);
});
test('upstream-check.yml: scheduled, read-only code, issue write only',()=>{
  const wf=read('.github/workflows/upstream-check.yml');
  assert.match(wf,/schedule:\n\s+- cron: '\d+ \d+ \* \* 1'/);
  assert.match(wf,/--scheduled/);
  assert.match(wf,/permissions:\n  contents: read\n  issues: write/);
  assert.doesNotMatch(wf,/secrets\./);
});

test('sign-release.sh refuses missing inputs and a missing password without printing anything secret',()=>{
  const r=spawnSync('bash',[path.join(repo,'scripts/sign-release.sh'),'/nonexistent.apk','/tmp/x.apk','/nonexistent.jks'],{encoding:'utf8',env:{...process.env,KEYSTORE_PASSWORD:'s3cret-value',APKSIGNER:'/bin/true'}});
  assert.notEqual(r.status,0);assert.doesNotMatch(r.stdout+r.stderr,/s3cret-value/);
  const r2=spawnSync('bash',[path.join(repo,'scripts/sign-release.sh'),'a','b','c'],{encoding:'utf8',env:{...process.env,KEYSTORE_PASSWORD:''}});
  assert.notEqual(r2.status,0);assert.match(r2.stderr,/KEYSTORE_PASSWORD/);
});

test('version and week helpers',()=>{
  assert.equal(latestStable(['v0.8.0','v0.9.0','v0.10.0','v0.9.0-rc1','nightly','v0.9.1']),'v0.10.0');
  assert.equal(latestStable(['foo']),null);
  assert.ok(compareStable('v0.9.1','v0.9.0')>0&&compareStable('v1.0.0','v0.99.99')>0&&compareStable('v0.9.0','v0.9.0')===0);
  assert.equal(isoWeek(new Date('2026-01-01T00:00:00Z')),1);
  assert.equal(isoWeek(new Date('2026-11-13T12:00:00Z')),46);
  assert.equal(isoWeek(new Date('2026-12-31T00:00:00Z')),53);
  // Two consecutive Mondays: exactly one of them is a run week.
  const a=new Date('2026-11-09T03:17:00Z'),b=new Date('2026-11-16T03:17:00Z');assert.notEqual(isRunWeek(a),isRunWeek(b));
  assert.deepEqual(parseTagList('abc\trefs/tags/v1.0.0\ndef\trefs/tags/v1.1.0\n'),['v1.0.0','v1.1.0']);
  assert.equal(cargoLockVersion('[[package]]\nname = "wasm-bindgen"\nversion = "0.2.127"\n','wasm-bindgen'),'0.2.127');
});

// ---- fixture upstream ----
const sh=(cwd,...args)=>{const r=spawnSync('git',args,{cwd,encoding:'utf8',env:{...process.env,GIT_AUTHOR_NAME:'t',GIT_AUTHOR_EMAIL:'t@t',GIT_COMMITTER_NAME:'t',GIT_COMMITTER_EMAIL:'t@t'}});assert.equal(r.status,0,r.stderr);return r.stdout;};
function fixture(){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'upstream-fixture-'));
  const up=path.join(dir,'up');fs.mkdirSync(path.join(up,'rhwp-studio'),{recursive:true});sh(dir,'init','-q',up);
  const w=(f,t)=>{fs.mkdirSync(path.dirname(path.join(up,f)),{recursive:true});fs.writeFileSync(path.join(up,f),t);};
  w('rhwp-studio/main.ts','line one\nline two\nline three\n');w('rhwp-studio/package-lock.json','{"v":1}\n');w('LICENSE','mit\n');
  w('Cargo.lock','[[package]]\nname = "wasm-bindgen"\nversion = "0.2.127"\n');
  sh(up,'add','-A');sh(up,'commit','-qm','v1');sh(up,'tag','v1.0.0');
  w('rhwp-studio/main.ts','line one\nline two\nline three\n');w('Cargo.lock','[[package]]\nname = "wasm-bindgen"\nversion = "0.2.130"\n');w('rhwp-studio/extra.ts','x\n');
  sh(up,'add','-A');sh(up,'commit','-qm','v1.1');sh(up,'tag','v1.1.0');
  w('rhwp-studio/main.ts','completely\ndifferent\ncontent\n');sh(up,'add','-A');sh(up,'commit','-qm','v2');sh(up,'tag','v2.0.0');
  // patch series authored against v1.0.0
  const pdir=path.join(dir,'patches');fs.mkdirSync(path.join(pdir,'features'),{recursive:true});fs.mkdirSync(path.join(pdir,'android'),{recursive:true});
  fs.writeFileSync(path.join(pdir,'features','0001-new.patch'),`diff --git a/rhwp-studio/new.ts b/rhwp-studio/new.ts\nnew file mode 100644\nindex 0000000..e69de29\n--- /dev/null\n+++ b/rhwp-studio/new.ts\n@@ -0,0 +1 @@\n+hello\n`);
  fs.writeFileSync(path.join(pdir,'android','0101-edit.patch'),`diff --git a/rhwp-studio/main.ts b/rhwp-studio/main.ts\n--- a/rhwp-studio/main.ts\n+++ b/rhwp-studio/main.ts\n@@ -1,3 +1,3 @@\n line one\n-line two\n+line 2\n line three\n`);
  fs.mkdirSync(path.join(dir,'config'));fs.writeFileSync(path.join(dir,'config','engine.json'),JSON.stringify({wasmBindgen:'0.2.127'}));
  const config={upstream:'x',upstreamTag:'v1.0.0',sourcePaths:['rhwp-studio','LICENSE','does-not-exist'],packageLockSha256:'0'.repeat(64),featurePatchDir:'patches/features',androidPatchDir:'patches/android',engineConfig:'config/engine.json'};
  const cfg=path.join(dir,'config','studio.json');fs.writeFileSync(cfg,JSON.stringify(config));
  return {dir,up,cfg,config};
}
test('check-upstream: patch series applies to a compatible newer tag and reports changed pins',()=>{
  const f=fixture();
  const r=analyze({repo:f.up,tag:'v1.1.0',config:f.config,root:f.dir});
  assert.deepEqual(r.missingSourcePaths,['does-not-exist']);
  assert.deepEqual(r.patches.map(p=>p.status),['applies','applies']);
  assert.equal(r.applies,false,'a missing source path alone makes the port need attention');
  assert.equal(r.wasmBindgen,'0.2.130');assert.equal(r.wasmBindgenChanged,true);assert.equal(r.packageLockChanged,true);
  f.config.sourcePaths=['rhwp-studio','LICENSE'];
  const ok=analyze({repo:f.up,tag:'v1.1.0',config:f.config,root:f.dir});assert.equal(ok.applies,true);
  const md=renderReport({current:'v1.0.0',latest:'v1.1.0',result:ok});assert.match(md,/applies cleanly/);assert.match(md,/0\.2\.130/);
});
test('check-upstream: a conflicting tag names the failing patch and skips the rest',()=>{
  const f=fixture();f.config.sourcePaths=['rhwp-studio','LICENSE'];
  const r=analyze({repo:f.up,tag:'v2.0.0',config:f.config,root:f.dir});
  assert.deepEqual(r.patches.map(p=>[p.name,p.status]),[['0001-new.patch','applies'],['0101-edit.patch','conflict']]);
  assert.equal(r.applies,false);assert.ok(r.patches[1].detail);
  assert.match(renderReport({current:'v1.0.0',latest:'v2.0.0',result:r}),/does NOT apply/);
});
test('check-upstream CLI: up-to-date, newer, and odd-week skip; the repository is never modified',()=>{
  const f=fixture();const out=path.join(f.dir,'rep.json');
  const run=(...a)=>{const logs=[];const w=process.stdout.write;process.stdout.write=s=>{logs.push(s);return true;};try{return {code:main(a,new Date('2026-11-16T03:17:00Z')),text:logs.join('')};}finally{process.stdout.write=w;}};
  // (isoWeek 47 = odd) -> skipped when --scheduled
  const skipped=run('--config',f.cfg,'--repo',f.up,'--scheduled','--json',out);assert.match(skipped.text,/Skipped/);assert.equal(JSON.parse(fs.readFileSync(out,'utf8')).skipped,true);
  const same=run('--config',f.cfg,'--repo',f.up,'--tag','v1.0.0','--json',out);assert.match(same.text,/Nothing to do/);assert.equal(JSON.parse(fs.readFileSync(out,'utf8')).newer,false);
  const newer=run('--config',f.cfg,'--repo',f.up,'--json',out);const j=JSON.parse(fs.readFileSync(out,'utf8'));
  assert.equal(j.latest,'v2.0.0');assert.equal(j.newer,true);assert.match(newer.text,/rhwp v2\.0\.0 is available/);
  assert.equal(sh(f.up,'status','--porcelain').trim(),'');
});
