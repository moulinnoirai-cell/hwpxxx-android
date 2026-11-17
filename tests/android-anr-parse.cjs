// Pure parsers and policy for Android "not responding" evidence. No adb and no side effects, so the formats can be
// tested with authentic samples (tests/android-anr.test.mjs). Policy:
//   * Only the emulator's own System UI / Pixel Launcher "isn't responding" dialog may be recovered (real Wait button, bounded).
//   * Any other ANR (the app under test, Termux, DocumentsUI, Google services, system_server ...) is a test failure.
//   * Any "Application Error" (crash) dialog is a test failure.
const SYSTEM_PACKAGES=Object.freeze({
 'com.android.systemui':'System UI',
 'com.google.android.apps.nexuslauncher':'Pixel Launcher',
});
const isSystemPackage=pkg=>Object.prototype.hasOwnProperty.call(SYSTEM_PACKAGES,pkg);

// `dumpsys window` (Android 13): `mCurrentFocus=Window{8c3e2a1 u0 Application Not Responding: com.android.systemui}`,
// `mCurrentFocus=Window{4e5f6a7 u0 kr.offline.hwp.preview/kr.offline.hwp.MainActivity}`, `mCurrentFocus=null`.
function parseFocus(dumpsysWindow){
 const windows=[];
 for(const line of String(dumpsysWindow).split('\n')){
  const m=line.match(/\b(?:mCurrentFocus|mFocusedWindow)=(?:Window\{([0-9a-f]+) u(\d+) (.*)\}|null)\s*$/);
  if(!m)continue;
  const title=m[3]??null;windows.push({raw:line.trim(),title});
 }
 return windows;
}
// Returns the strongest finding among the focused windows: {kind,package,title,raw} with kind in
// none | system-anr | app-anr | unknown-anr | crash-dialog.
function classifyFocus(dumpsysWindow,appPackage='kr.offline.hwp'){
 let best={kind:'none',package:null,title:null,raw:''};
 const rank={none:0,'system-anr':1,'unknown-anr':2,'app-anr':3,'crash-dialog':3};
 for(const w of parseFocus(dumpsysWindow)){
  if(!w.title)continue;
  let kind='none',pkg=null;
  const anr=w.title.match(/^Application Not Responding: (\S+)$/),err=w.title.match(/^Application Error: (\S+)$/);
  if(anr){pkg=anr[1];kind=isSystemPackage(pkg)?'system-anr':pkg===appPackage||pkg.startsWith(appPackage+'.')||pkg.startsWith('kr.offline.hwp')?'app-anr':'unknown-anr';}
  else if(err){pkg=err[1];kind='crash-dialog';}
  if(rank[kind]>rank[best.kind])best={kind,package:pkg,title:w.title,raw:w.raw};
 }
 return best;
}
// uiautomator XML of the OS dialog: <node resource-id="android:id/message" text="System UI isn&apos;t responding" .../>
function decodeXml(xml){return String(xml).replaceAll('&apos;',"'").replaceAll('&quot;','"').replaceAll('&amp;','&');}
function systemDialogLabel(xml){
 const m=decodeXml(xml).match(/text="(System UI|Pixel Launcher) (?:isn't responding|is not responding)"/);
 return m?m[1]:null;
}
function hasAnyErrorDialog(xml){return /aerr_|isn(?:'|’|&apos;)t responding|is not responding|has stopped|keeps stopping/.test(String(xml));}
// The dialog text must name the same process the focused window belongs to (two queued ANRs must never be confused).
function dialogMatchesPackage(label,pkg){return !!label&&SYSTEM_PACKAGES[pkg]===label;}

// logcat -v threadtime. events buffer: `11-07 03:12:45.678  1583  1601 I am_anr  : [0,5123,kr.offline.hwp.preview,550026565,Input dispatching timed out (...)]`
// main/system buffers: `11-07 03:12:45.700  1583  1601 E ActivityManager: ANR in kr.offline.hwp.preview (kr.offline.hwp.preview/kr.offline.hwp.MainActivity)`
function parseAnrLog(text){
 const out=[];
 for(const line of String(text).split('\n')){
  let m=line.match(/\bam_anr\s*:\s*\[(-?\d+),(\d+),([^,\]]+),/);
  if(m){out.push({source:'am_anr',package:m[3],pid:Number(m[2]),line:line.trim()});continue;}
  m=line.match(/\bActivityManager\s*:\s*ANR in (\S+)/);
  if(m)out.push({source:'ANR in',package:m[1],line:line.trim()});
 }
 return out;
}
// Only the processes under test can fail the guard from the log: the app (all kr.offline.hwp* ids, release and .preview) and Termux.
// An ANR line of any other process (the emulator image's own Dialer, Google Play services, SystemUI, the launcher ...) is reported as
// `system` (informational): those apps are not ours, and on a loaded CI runner the image's stock apps ANR while the device boots.
const WATCHED_PACKAGES=Object.freeze(['kr.offline.hwp','com.termux']);
const isWatchedPackage=(pkg,watched=WATCHED_PACKAGES)=>watched.some(w=>pkg===w||String(pkg).startsWith(w+'.'));
function classifyAnrLog(text,watched=WATCHED_PACKAGES){
 const all=parseAnrLog(text),system=[],failures=[];
 for(const e of all)(isWatchedPackage(e.package,watched)?failures:system).push(e);
 return {all,system,failures};
}
// `logcat -b crash`: any fatal exception / native crash line of the packages under test.
function crashLines(text,pkg='kr.offline.hwp'){return String(text).split('\n').filter(l=>l.includes(pkg));}
module.exports={SYSTEM_PACKAGES,WATCHED_PACKAGES,isWatchedPackage,isSystemPackage,parseFocus,classifyFocus,systemDialogLabel,decodeXml,hasAnyErrorDialog,dialogMatchesPackage,parseAnrLog,classifyAnrLog,crashLines};
