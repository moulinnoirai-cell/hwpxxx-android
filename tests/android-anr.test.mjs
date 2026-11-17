// The ANR guard of the emulator suites, tested without a device: authentic `dumpsys window`, `uiautomator` and `logcat` formats go
// through the real parser and the real decision flow (createGuard) with a fake adb. Policy under test: only the OS's System UI /
// Pixel Launcher dialog may be recovered (Wait, at most 4 times); every other ANR or crash dialog fails and its evidence is kept.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const parse=require('./android-anr-parse.cjs');
const {createGuard}=require('./android-system.cjs');

const APP='kr.offline.hwp.preview';
// ---- authentic samples (Android 13 / API 33 emulator) ----
const win=(focus,app='ActivityRecord{5a9b1c2 u0 com.google.android.apps.nexuslauncher/.NexusLauncherActivity t6}')=>`WINDOW MANAGER WINDOWS (dumpsys window windows)
  Window #0 Window{1f2e3d4 u0 StatusBar}:
    mDisplayId=0 rootTaskId=1 mSession=Session{4a5b6c7 1234:u0a10156} mClient=android.os.BinderProxy@8d9e0f1
  mCurrentFocus=${focus}
  mFocusedApp=${app}
  mFocusedWindow=${focus}
`;
const FOCUS={
 app:'Window{4e5f6a7 u0 kr.offline.hwp.preview/kr.offline.hwp.MainActivity}',
 settings:'Window{7c8d9e0 u0 com.android.settings/com.android.settings.Settings$AppManageExternalStorageActivity}',
 documentsui:'Window{9a8b7c6 u0 com.android.documentsui/com.android.documentsui.picker.PickActivity}',
 none:'null',
 systemUi:'Window{c1d2e3f u0 Application Not Responding: com.android.systemui}',
 launcher:'Window{d4e5f60 u0 Application Not Responding: com.google.android.apps.nexuslauncher}',
 appAnr:'Window{b1c2d3e u0 Application Not Responding: kr.offline.hwp.preview}',
 termuxAnr:'Window{b9c8d7e u0 Application Not Responding: com.termux}',
 gmsAnr:'Window{a7b6c5d u0 Application Not Responding: com.google.android.gms}',
 appCrash:'Window{e0f1a2b u0 Application Error: kr.offline.hwp.preview}',
};
const node=(attrs)=>`<node index="0" ${attrs} />`;
const dialogXml=(message,wait=true)=>`<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0"><node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="android" content-desc="" clickable="false" bounds="[0,0][1920,1080]"><node index="0" text="${message}" resource-id="android:id/message" class="android.widget.TextView" package="android" bounds="[560,300][1360,380]" />${wait?'<node index="1" text="Wait" resource-id="android:id/aerr_wait" class="android.widget.Button" package="android" clickable="true" enabled="true" bounds="[560,420][1360,520]" />':''}<node index="2" text="Close app" resource-id="android:id/aerr_close" class="android.widget.Button" package="android" clickable="true" bounds="[560,540][1360,640]" /></node></hierarchy>`;
const XML={
 systemUi:dialogXml('System UI isn&apos;t responding'),
 launcher:dialogXml('Pixel Launcher isn&apos;t responding'),
 app:dialogXml('hwpxxx isn&apos;t responding'),
 chrome:dialogXml('Chrome isn&apos;t responding'),
 normal:`<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0"><node index="0" text="Use this folder" resource-id="com.android.documentsui:id/button" class="android.widget.Button" package="com.android.documentsui" bounds="[100,100][300,160]" /></hierarchy>`,
 noWait:dialogXml('System UI isn&apos;t responding',false),
};
const LOG={
 eventsApp:'11-07 03:12:45.678  1583  1601 I am_anr  : [0,5123,kr.offline.hwp.preview,550026565,Input dispatching timed out (kr.offline.hwp.preview/kr.offline.hwp.MainActivity, 4f2d1a9 kr.offline.hwp.preview/kr.offline.hwp.MainActivity (server) is not responding. Waited 5001ms for MotionEvent)]',
 eventsSystemUi:'11-07 03:10:02.101  1583  1601 I am_anr  : [0,1801,com.android.systemui,818330949,Input dispatching timed out (Application does not have a focused window)]',
 mainApp:'11-07 03:12:45.700  1583  1601 E ActivityManager: ANR in kr.offline.hwp.preview (kr.offline.hwp.preview/kr.offline.hwp.MainActivity)',
 mainSystemUi:'11-07 03:10:02.140  1583  1601 E ActivityManager: ANR in com.android.systemui',
 mainLauncher:'11-07 03:10:12.140  1583  1601 E ActivityManager: ANR in com.google.android.apps.nexuslauncher (com.google.android.apps.nexuslauncher/.NexusLauncherActivity)',
 mainTermux:'11-07 03:14:00.000  1583  1601 E ActivityManager: ANR in com.termux (com.termux/.app.TermuxActivity)',
 eventsDialer:'11-13 04:22:13.949   491   530 I am_anr  : [0,2110,com.google.android.dialer,550026565,Input dispatching timed out (Waiting because no window has focus)]',
 mainGms:'11-13 04:22:14.000  1583  1601 E ActivityManager: ANR in com.google.android.gms (com.google.android.gms/.chimera.GmsIntentOperationService)',
 noise:'11-07 03:12:46.000  1583  1601 I ActivityManager: Start proc 5200:kr.offline.hwp.preview/u0a156 for top-activity {kr.offline.hwp.preview/kr.offline.hwp.MainActivity}',
};

// ---- fake adb: a device with a focused window, a dialog tree and logs ----
function device(root,{focus=FOCUS.app,xml=XML.normal,events='',main='',crash='',onTap=null}={}){
 const d={focus,xml,events,main,crash,taps:[],keys:[],commands:[]};
 const adb=(...a)=>{
  d.commands.push(a.join(' '));
  const [first,...rest]=a;
  if(first==='logcat'){
   if(rest.includes('-c'))return '';
   if(rest.includes('events')&&rest.includes('-s'))return d.events;
   if(rest.includes('main')&&rest.includes('-s'))return d.main;
   if(rest.includes('crash'))return d.crash;
   if(rest.includes('events'))return d.events;
   if(rest.includes('main'))return d.main;
   return [d.events,d.main,d.crash].join('\n');
  }
  if(first!=='shell')throw new Error('unexpected adb '+a.join(' '));
  const [cmd,...args]=rest;
  if(cmd==='dumpsys'&&args[0]==='window')return win(d.focus);
  if(cmd==='uiautomator')return '';
  if(cmd==='cat')return d.xml;
  if(cmd==='rm')return '';
  if(cmd==='input'&&args[0]==='touchscreen'){d.taps.push([+args[2],+args[3]]);if(onTap)onTap(d);return '';}
  if(cmd==='input'&&args[0]==='keyevent'){d.keys.push(args[1]);return '';}
  throw new Error('unexpected shell '+rest.join(' '));
 };
 const guard=createGuard({adb,adbBinary:()=>Buffer.from('PNGDATA'),adbAsync:async args=>adb(...args),root,appPackage:APP,sleep:()=>{},log:()=>{},now:()=>new Date('2026-11-07T03:00:00Z')});
 return {d,guard,adb};
}
const tmp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'anr-guard-'));

// ---- parsers ----
test('focus parser: normal windows and null are not findings',()=>{
 for(const f of [FOCUS.app,FOCUS.settings,FOCUS.documentsui,FOCUS.none])assert.equal(parse.classifyFocus(win(f),APP).kind,'none',f);
 assert.equal(parse.parseFocus(win(FOCUS.app)).length,2);assert.equal(parse.parseFocus(win(FOCUS.none)).length,2);
});
test('focus parser: the owner of an ANR/crash dialog decides the class',()=>{
 const c=f=>parse.classifyFocus(win(f),APP);
 assert.deepEqual([c(FOCUS.systemUi).kind,c(FOCUS.systemUi).package],['system-anr','com.android.systemui']);
 assert.deepEqual([c(FOCUS.launcher).kind,c(FOCUS.launcher).package],['system-anr','com.google.android.apps.nexuslauncher']);
 assert.equal(c(FOCUS.appAnr).kind,'app-anr');
 assert.equal(c('Window{b1c2d3e u0 Application Not Responding: kr.offline.hwp}').kind,'app-anr','the release id is the app too');
 for(const f of [FOCUS.termuxAnr,FOCUS.gmsAnr,'Window{1 u0 Application Not Responding: com.android.documentsui}','Window{2 u0 Application Not Responding: system_server}'])assert.equal(c(f).kind,'unknown-anr',f);
 assert.equal(c(FOCUS.appCrash).kind,'crash-dialog');
 // a window that merely has "systemui" in its name is not the OS dialog
 assert.equal(parse.classifyFocus(win('Window{3 u0 Application Not Responding: com.android.systemui.fake}'),APP).kind,'unknown-anr');
});
test('focus parser: the strongest finding wins when several windows are listed',()=>{
 const text=`  mCurrentFocus=${FOCUS.systemUi}\n  mFocusedWindow=${FOCUS.appAnr}\n`;
 assert.equal(parse.classifyFocus(text,APP).kind,'app-anr');
});
test('dialog parser: label from uiautomator XML, aerr markers, stale trees',()=>{
 assert.equal(parse.systemDialogLabel(XML.systemUi),'System UI');assert.equal(parse.systemDialogLabel(XML.launcher),'Pixel Launcher');
 assert.equal(parse.systemDialogLabel(XML.app),null);assert.equal(parse.systemDialogLabel(XML.chrome),null);assert.equal(parse.systemDialogLabel(XML.normal),null);
 assert.equal(parse.systemDialogLabel(dialogXml('System UI is not responding')),'System UI');
 assert(parse.hasAnyErrorDialog(XML.app)&&parse.hasAnyErrorDialog(XML.chrome)&&!parse.hasAnyErrorDialog(XML.normal));
 assert(parse.dialogMatchesPackage('System UI','com.android.systemui')&&!parse.dialogMatchesPackage('System UI','com.google.android.apps.nexuslauncher')&&!parse.dialogMatchesPackage(null,'com.android.systemui'));
});
test('log parser: only the app and Termux can fail the guard; other processes (the image\'s Dialer, GMS) are informational',()=>{
 const r=parse.classifyAnrLog([LOG.eventsDialer,LOG.mainGms,LOG.eventsSystemUi].join('\n'));
 assert.deepEqual(r.failures,[]);
 assert.deepEqual(r.system.map(e=>e.package).sort(),['com.android.systemui','com.google.android.dialer','com.google.android.gms']);
 const mixed=parse.classifyAnrLog([LOG.eventsDialer,LOG.mainTermux,LOG.eventsApp].join('\n'));
 assert.deepEqual(mixed.failures.map(e=>e.package),['com.termux','kr.offline.hwp.preview']);
 assert.ok(parse.isWatchedPackage('kr.offline.hwp')&&parse.isWatchedPackage('kr.offline.hwp.preview')&&parse.isWatchedPackage('com.termux')&&!parse.isWatchedPackage('com.termuxx')&&!parse.isWatchedPackage('kr.offline.hwpx'));
});
test('a Dialer ANR from the device boot does not fail the guard (the CI failure of the main run)',()=>{
 const root=tmp(),{guard}=device(root,{focus:FOCUS.none,events:LOG.eventsDialer,main:LOG.mainGms});
 assert.doesNotThrow(()=>guard.check());
 assert.equal(guard.finish([APP]).failures,0);
});
test('log parser: am_anr events and ActivityManager "ANR in" lines',()=>{
 const r=parse.classifyAnrLog([LOG.eventsApp,LOG.eventsSystemUi,LOG.mainApp,LOG.mainSystemUi,LOG.mainLauncher,LOG.mainTermux,LOG.noise].join('\n'));
 assert.deepEqual(r.failures.map(e=>[e.source,e.package]),[['am_anr','kr.offline.hwp.preview'],['ANR in','kr.offline.hwp.preview'],['ANR in','com.termux']]);
 assert.deepEqual(r.system.map(e=>e.package).sort(),['com.android.systemui','com.android.systemui','com.google.android.apps.nexuslauncher']);
 assert.equal(parse.parseAnrLog(LOG.noise).length,0,'ordinary ActivityManager lines are not ANRs');
 assert.equal(parse.parseAnrLog(LOG.eventsApp)[0].pid,5123);
});

// ---- guard decision flow ----
test('a CDP-only scenario that ends under an app ANR dialog fails, with the original focus, XML, screenshot and log kept and nothing dismissed',()=>{
 const root=tmp(),{d,guard}=device(root,{focus:FOCUS.appAnr,xml:XML.app,events:LOG.eventsApp,main:LOG.mainApp});
 // the scenario itself only talked to the page over CDP (no adb call) and "passed"; the per-scenario check is what notices
 assert.throws(()=>guard.check(),/app-anr[\s\S]*Evidence kept in[\s\S]*nothing was dismissed/);
 assert.deepEqual(d.taps,[],'no tap: the app ANR dialog was not touched');assert.deepEqual(d.keys,[],'no Back key either');
 const failures=guard.failures();assert.equal(failures.length,1);assert.equal(failures[0].kind,'app-anr');assert.equal(failures[0].focus.package,APP);
 assert.match(fs.readFileSync(root+'/failure-1.focus.txt','utf8'),/Application Not Responding: kr\.offline\.hwp\.preview/,'the original focus line is kept');
 assert.equal(fs.readFileSync(root+'/failure-1.xml','utf8'),XML.app);assert.equal(fs.readFileSync(root+'/failure-1.png').toString(),'PNGDATA');
 assert(fs.existsSync(root+'/failure-1.logcat.txt'));assert.equal(JSON.parse(fs.readFileSync(root+'/anr-failures.json','utf8')).length,1);
 assert.equal(guard.events().length,0,'an app ANR is never counted as an OS recovery');
});
test('unknown ANRs (Termux, DocumentsUI, Google services) and crash dialogs fail too',()=>{
 for(const [focus,xml,kind] of [[FOCUS.termuxAnr,dialogXml('Termux isn&apos;t responding'),'unknown-anr'],[FOCUS.gmsAnr,dialogXml('Google Play services isn&apos;t responding'),'unknown-anr'],[FOCUS.appCrash,dialogXml('hwpxxx keeps stopping'),'crash-dialog']]){
  const root=tmp(),{d,guard}=device(root,{focus,xml});assert.throws(()=>guard.inspect(),new RegExp(kind));assert.deepEqual(d.taps,[]);assert.equal(guard.failures()[0].kind,kind);
 }
});
test('System UI and Pixel Launcher dialogs are recovered with the real Wait button and the evidence is kept',()=>{
 for(const [focus,xml,label] of [[FOCUS.systemUi,XML.systemUi,'System UI'],[FOCUS.launcher,XML.launcher,'Pixel Launcher']]){
  const root=tmp(),{d,guard}=device(root,{focus,xml,onTap:dev=>{dev.focus=FOCUS.app;dev.xml=XML.normal;}});
  assert.equal(guard.inspect(),true);
  assert.deepEqual(d.taps,[[960,470]],'tap at the centre of the Wait button [560,420][1360,520], not Close app');
  const [event]=guard.events();assert.equal(guard.events().length,1);assert.equal(event.action,'Wait');assert.equal(event.message,`${label} isn't responding`);
  assert.match(event.focus,/Application Not Responding/,'the original focus is recorded');
  for(const f of ['1.xml','1.png','1.focus.txt','1.logcat.txt','1.after.png'])assert(fs.existsSync(`${root}/${f}`),f);
  assert.equal(fs.readFileSync(root+'/1.xml','utf8'),xml,'the XML kept is the one that was on screen before the tap');
  assert.equal(guard.inspect(),false,'the recovered dialog is gone');assert.equal(guard.failures().length,0);
 }
});
test('recovery is bounded: the fifth OS ANR is refused without a tap',()=>{
 const root=tmp(),{d,guard}=device(root,{focus:FOCUS.systemUi,xml:XML.systemUi});
 for(let i=1;i<=4;i++){assert.equal(guard.inspect(),true);assert.equal(guard.events().length,i);}
 assert.throws(()=>guard.inspect(),/repeated-system-anr/);assert.equal(d.taps.length,4);assert.equal(guard.events().length,4);assert.equal(guard.failures()[0].kind,'repeated-system-anr');
});
test('the dialog text must name the process that owns the focused window',()=>{
 const root=tmp(),{d,guard}=device(root,{focus:FOCUS.launcher,xml:XML.systemUi});
 assert.throws(()=>guard.inspect(),/mismatched-anr-dialog/);assert.deepEqual(d.taps,[]);
});
test('a focused OS dialog whose text is not a System UI / Launcher ANR is not tapped',()=>{
 for(const xml of [XML.chrome,XML.app]){const root=tmp(),{d,guard}=device(root,{focus:FOCUS.systemUi,xml});assert.throws(()=>guard.inspect(),/unexpected-error-dialog/);assert.deepEqual(d.taps,[]);}
 const root=tmp(),{d,guard}=device(root,{focus:FOCUS.systemUi,xml:XML.noWait});assert.throws(()=>guard.inspect(),/anr-without-wait-button/);assert.deepEqual(d.taps,[]);
});
test('a stale ANR window title over a normal tree is waited out, not tapped and not a failure',()=>{
 const root=tmp(),{d,guard}=device(root,{focus:FOCUS.systemUi,xml:XML.normal});
 assert.equal(guard.inspect(),false);assert.deepEqual(d.taps,[]);assert.equal(guard.failures().length,0);assert.equal(guard.events().length,0);
});
test('an ANR that is already gone is still found in the system log; OS ANRs in the log are only counted',()=>{
 let root=tmp(),{guard}=device(root,{focus:FOCUS.app,events:LOG.eventsApp});assert.throws(()=>guard.check(),/anr-in-log[\s\S]*kr\.offline\.hwp\.preview/);
 root=tmp();({guard}=device(root,{focus:FOCUS.app,main:LOG.mainTermux}));assert.throws(()=>guard.check(),/anr-in-log[\s\S]*com\.termux/);
 root=tmp();({guard}=device(root,{focus:FOCUS.app,events:[LOG.eventsSystemUi].join('\n'),main:[LOG.mainSystemUi,LOG.mainLauncher,LOG.noise].join('\n')}));
 assert.doesNotThrow(()=>guard.check());assert.equal(guard.failures().length,0);assert.equal(guard.counters.systemAnrInLogs,2);
});
test('the background watchdog catches a dialog that is gone before the next scenario check',async()=>{
 const root=tmp(),{d,guard}=device(root,{focus:FOCUS.appAnr,xml:XML.app});
 await guard.pollOnce();                              // seen between two CDP steps...
 d.focus=FOCUS.app;d.xml=XML.normal;                  // ...and dismissed by something else before check() looks
 assert.throws(()=>guard.check(),/app-anr[\s\S]*background watchdog/);
 assert.match(fs.readFileSync(root+'/failure-1.focus.txt','utf8'),/Application Not Responding: kr\.offline\.hwp\.preview/,'evidence was taken when the dialog was on screen');
 assert.equal(fs.readFileSync(root+'/failure-1.xml','utf8'),XML.app);
 const quiet=device(tmp(),{focus:FOCUS.systemUi,xml:XML.systemUi});await quiet.guard.pollOnce();
 assert.equal(quiet.d.taps.length,0,'the watchdog never taps; recovery happens in the checked, bounded path');assert.equal(quiet.guard.failures().length,0,'an OS dialog is not a watchdog failure');
});
test('Back is not sent while an app ANR dialog is up (Back could dismiss it unseen)',()=>{
 let root=tmp(),{d,guard}=device(root,{focus:FOCUS.appAnr,xml:XML.app});let sent=0;
 assert.throws(()=>guard.guardedKey(()=>{sent++;}),/app-anr/);assert.equal(sent,0);
 root=tmp();({d,guard}=device(root,{focus:FOCUS.app}));guard.guardedKey(()=>{sent++;});assert.equal(sent,1);
});
test('end of suite: crash buffer, journal, full log files and summary',()=>{
 let root=tmp(),{guard}=device(root,{focus:FOCUS.app,crash:'11-07 03:20:00.000  5123  5123 E AndroidRuntime: FATAL EXCEPTION: main\n11-07 03:20:00.001  5123  5123 E AndroidRuntime: Process: kr.offline.hwp.preview, PID: 5123'});
 assert.throws(()=>guard.finish([APP]),/crash-log/);assert(fs.existsSync(root+'/crash.txt')&&fs.existsSync(root+'/anr-events.txt')&&fs.existsSync(root+'/anr-main-system.txt'));assert(fs.existsSync(root+'/anr-guard.json'));
 root=tmp();({guard}=device(root,{focus:FOCUS.app}));const summary=guard.finish([APP,'com.termux']);
 assert.deepEqual([summary.failures,summary.systemRecoveries,summary.crashPackages],[0,0,[APP,'com.termux']]);
 root=tmp();({guard}=device(root,{focus:FOCUS.app,crash:'E AndroidRuntime: Process: com.termux, PID: 99'}));assert.throws(()=>guard.finish([APP,'com.termux']),/crash-log/);
 root=tmp();({guard}=device(root,{focus:FOCUS.app,main:LOG.mainApp}));assert.throws(()=>guard.finish([APP]),/anr-in-log/);assert.equal(guard.failures().length,1);
});
test('reset starts a run clean: no inherited recoveries or evidence',()=>{
 const root=tmp(),{guard}=device(root,{focus:FOCUS.systemUi,xml:XML.systemUi});
 for(let i=0;i<4;i++)guard.inspect();assert.equal(guard.events().length,4);guard.reset();assert.equal(guard.events().length,0);assert.deepEqual(fs.readdirSync(root),[]);assert.equal(guard.inspect(),true,'the cap counts from the start of this run');
});
test('the suites call the guard: every scenario, every Back key and the end of both suites',()=>{
 const src=f=>fs.readFileSync(new URL(f,import.meta.url),'utf8');
 const emu=src('android-emulator.cjs'),termux=src('android-termux.cjs'),suites=src('android-suites.cjs');
 assert(/await fn\(\);anrCheck\(\)/.test(emu)&&/await fn\(\);anrCheck\(\)/.test(termux),'the check runs after every scenario in both suites');
 assert(!/sh\('input','keyevent','4'\)/.test(emu.replace(/guardedKey\(\(\)=>sh\('input','keyevent','4'\)\)/g,''))&&!/sh\('input','keyevent','4'\)/.test(termux.replace(/guardedKey\(\(\)=>sh\('input','keyevent','4'\)\)/g,'')),'no unguarded Back key');
 assert(/anrFinish\(\[pkg\]\)/.test(emu)&&/anrFinish\(\[pkg,'com\.termux'\]\)/.test(termux),'both suites end with the strict log/crash assertions');
 assert(/startAnrGuard\(\)/.test(emu)&&/startAnrGuard\(\)/.test(termux));
 assert(/ANDROID_ANR_KEEP/.test(suites)&&/anrFailures\.length/.test(suites),'a recorded failure fails the run even if a suite swallowed it');
 // the OS-dialog recovery stays limited to the two OS processes
 assert.deepEqual(Object.keys(parse.SYSTEM_PACKAGES).sort(),['com.android.systemui','com.google.android.apps.nexuslauncher']);
});
