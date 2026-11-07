// "Not responding" guard for the emulator suites.
//  * Recovers ONLY the emulator OS's own System UI / Pixel Launcher dialog, with its real Wait button, at most 4 times.
//  * Fails the suite on every other ANR (the app under test, Termux, DocumentsUI, Google services, system_server ...) and on every
//    crash dialog, whether or not the scenario is driven over CDP, and keeps the original focus, UI XML, screenshot and logs.
//  * Never suppresses Android error reporting and never dismisses a dialog it is not allowed to recover.
// The policy and the parsers are in android-anr-parse.cjs and are covered with authentic samples by tests/android-anr.test.mjs;
// createGuard() takes its adb functions as parameters so the whole decision flow is exercised without a device.
const {execFileSync,execFile}=require('node:child_process');
const nodeFs=require('node:fs');
const parse=require('./android-anr-parse.cjs');

const sleepSync=ms=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms);

function createGuard({adb,adbBinary,adbAsync,fs=nodeFs,root,appPackage='kr.offline.hwp',maxRecoveries=4,sleep=sleepSync,log=console.log,now=()=>new Date()}){
 fs.mkdirSync(root,{recursive:true});
 const journal=root+'/recoveries.json',failureFile=root+'/anr-failures.json',summaryFile=root+'/anr-guard.json';
 const sh=(...a)=>adb('shell',...a);
 const read=file=>fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):[];
 const events=()=>read(journal),failures=()=>read(failureFile);
 const counters={checks:0,logChecks:0,systemAnrInLogs:0,watchdogPolls:0};
 let pending=null,timer=null;

 // Everything an investigator needs, captured BEFORE anything could change the screen.
 function snapshot(prefix,windowText,xmlText){
  const saved={};
  fs.writeFileSync(prefix+'.focus.txt',windowText.split('\n').filter(l=>/mCurrentFocus|mFocusedWindow|mFocusedApp/.test(l)).join('\n')+'\n');saved.focus=prefix+'.focus.txt';
  try{fs.writeFileSync(prefix+'.xml',xmlText??(sh('uiautomator','dump','--compressed','/sdcard/anr-guard.xml'),sh('cat','/sdcard/anr-guard.xml')));saved.xml=prefix+'.xml';}catch(e){fs.writeFileSync(prefix+'.xml.error.txt',String(e.message));}
  try{fs.writeFileSync(prefix+'.png',adbBinary(['exec-out','screencap','-p']));saved.png=prefix+'.png';}catch(e){fs.writeFileSync(prefix+'.png.error.txt',String(e.message));}
  try{fs.writeFileSync(prefix+'.logcat.txt',adb('logcat','-d','-b','all','-t','3000'));saved.logcat=prefix+'.logcat.txt';}catch(e){fs.writeFileSync(prefix+'.logcat.error.txt',String(e.message));}
  return saved;
 }
 function recordFailure(kind,detail,windowText,xmlText){
  const list=failures(),n=list.length+1,prefix=`${root}/failure-${n}`;
  const entry={n,at:now().toISOString(),kind,detail,focus:parse.classifyFocus(windowText,appPackage),evidence:snapshot(prefix,windowText,xmlText)};
  list.push(entry);fs.writeFileSync(failureFile,JSON.stringify(list,null,2));
  log('ANDROID_ANR_FAILURE',JSON.stringify({n,kind,detail,package:entry.focus.package,title:entry.focus.title}));
  return new Error(`Android ${kind}: ${detail}. Evidence kept in ${prefix}.* (focus, XML, screenshot, logcat); nothing was dismissed.`);
 }

 // Recover one System UI / Pixel Launcher dialog (focus + dialog text agree), or throw.
 function recover(focus,windowText){
  sh('rm','-f','/sdcard/anr-guard.xml');sh('uiautomator','dump','--compressed','/sdcard/anr-guard.xml');const xml=sh('cat','/sdcard/anr-guard.xml');
  const label=parse.systemDialogLabel(xml);
  if(!label){
   // WindowManager can retain the dismissed dialog's title for a few frames; a normal tree is not an ANR. Anything that still looks like an error dialog is.
   if(parse.hasAnyErrorDialog(xml))throw recordFailure('unexpected-error-dialog',`focus ${focus.title} but the dialog is not a System UI / Pixel Launcher ANR`,windowText,xml);
   return false;
  }
  if(!parse.dialogMatchesPackage(label,focus.package))throw recordFailure('mismatched-anr-dialog',`dialog "${label}" but focus is ${focus.package}`,windowText,xml);
  const records=events();
  if(records.length>=maxRecoveries)throw recordFailure('repeated-system-anr',`${records.length} OS ANRs were already recovered; refusing further recovery`,windowText,xml);
  const wait=(xml.match(/<node\b[^>]*>/g)||[]).find(n=>/resource-id="android:id\/aerr_wait"|text="Wait"/.test(n));
  const b=wait?.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
  if(!b)throw recordFailure('anr-without-wait-button','Android OS ANR Wait button is unavailable',windowText,xml);
  const number=records.length+1,prefix=`${root}/${number}`;
  const saved=snapshot(prefix,windowText,xml);
  const event={at:now().toISOString(),message:`${label} isn't responding`,focus:focus.raw,package:focus.package,action:'Wait',evidence:prefix,files:saved};
  records.push(event);fs.writeFileSync(journal,JSON.stringify(records,null,2));
  sh('input','touchscreen','tap',String((+b[1]+ +b[3])/2|0),String((+b[2]+ +b[4])/2|0));
  sleep(800);try{fs.writeFileSync(prefix+'.after.png',adbBinary(['exec-out','screencap','-p']));}catch{}
  log('ANDROID_SYSTEM_ANR_RECOVERED',JSON.stringify(event));return true;
 }

 // Look at the focused window now. Recoverable OS dialogs are recovered; everything else throws with evidence.
 function inspect(){
  counters.checks++;
  const windowText=sh('dumpsys','window'),focus=parse.classifyFocus(windowText,appPackage);
  if(focus.kind==='none')return false;
  if(focus.kind==='system-anr')return recover(focus,windowText);
  throw recordFailure(focus.kind,`${focus.title}`,windowText);
 }
 // ANRs that are over (dismissed by a timeout, another dialog, a key) still leave their lines in the system log.
 function inspectLogs(){
  counters.logChecks++;
  const text=[adb('logcat','-d','-b','events','-s','am_anr:I'),adb('logcat','-d','-b','main','-b','system','-s','ActivityManager:E')].join('\n');
  const result=parse.classifyAnrLog(text);// distinct OS processes that have an ANR line in the log (informational: they were or were not recovered through the dialog)
  counters.systemAnrInLogs=Math.max(counters.systemAnrInLogs,new Set(result.system.map(e=>e.package)).size);
  if(result.failures.length)throw recordFailure('anr-in-log',result.failures.map(e=>`${e.source}: ${e.package}`).join(', '),sh('dumpsys','window'));
  return result;
 }
 function check(){
  if(pending){const e=pending;pending=null;throw e;}
  inspect();inspectLogs();
 }
 // Background poll for CDP-only stretches: a dialog that appears and is gone before the next check is still caught.
 async function pollOnce(){
  counters.watchdogPolls++;
  let windowText;try{windowText=await adbAsync(['shell','dumpsys','window']);}catch{return;}
  const focus=parse.classifyFocus(windowText,appPackage);
  if(focus.kind==='none'||focus.kind==='system-anr')return;
  if(pending)return;
  pending=recordFailure(focus.kind,`${focus.title} (seen by the background watchdog)`,windowText);
 }
 function startWatchdog(ms=3000){if(timer)return;let busy=false;timer=setInterval(()=>{if(busy)return;busy=true;pollOnce().finally(()=>{busy=false;});},ms);timer.unref?.();}
 function stopWatchdog(){if(timer){clearInterval(timer);timer=null;}}
 function guardedKey(send){check();send();}
 // End of a suite: full buffers kept as files, then the strict assertions.
 function finish(packages=[appPackage]){
  stopWatchdog();
  const files={};
  for(const [name,args] of [['anr-events','-b events'],['anr-main-system','-b main -b system'],['crash','-b crash']])try{
   const text=adb('logcat','-d',...args.split(' '));fs.writeFileSync(`${root}/${name}.txt`,text);files[name]=`${root}/${name}.txt`;
  }catch(e){fs.writeFileSync(`${root}/${name}.error.txt`,String(e.message));}
  const crash=files.crash?[].concat(packages).flatMap(pkg=>parse.crashLines(fs.readFileSync(files.crash,'utf8'),pkg)):[];
  let error=null;
  try{check();}catch(e){error=e;}
  if(!error&&crash.length)error=recordFailure('crash-log',crash.slice(0,3).join(' | '),sh('dumpsys','window'));
  const summary={appPackage,crashPackages:[].concat(packages),systemRecoveries:events().length,systemAnrInLogs:counters.systemAnrInLogs,failures:failures().length,checks:counters.checks,logChecks:counters.logChecks,watchdogPolls:counters.watchdogPolls,files};
  fs.writeFileSync(summaryFile,JSON.stringify(summary,null,2));log('ANDROID_ANR_GUARD',JSON.stringify(summary));
  if(error)throw error;return summary;
 }
 function reset(){
  // A local re-run must not inherit an earlier run's recoveries (they count toward the cap) or evidence.
  for(const f of fs.readdirSync(root))fs.unlinkSync(root+'/'+f);
  try{adb('logcat','-c');}catch{}
 }
 return {inspect,inspectLogs,check,pollOnce,startWatchdog,stopWatchdog,guardedKey,finish,reset,events,failures,counters};
}

const root='.qa/android-system-'+process.env.ANDROID_API;
const adb=(...args)=>execFileSync('adb',args,{encoding:'utf8',timeout:45000,maxBuffer:64<<20}).trim();
const adbBinary=args=>execFileSync('adb',args,{timeout:45000,maxBuffer:64<<20});
const adbAsync=args=>new Promise((resolve,reject)=>execFile('adb',args,{encoding:'utf8',timeout:20000,maxBuffer:64<<20},(e,out)=>e?reject(e):resolve(out)));
const sh=(...args)=>adb('shell',...args);
const pause=ms=>new Promise(r=>setTimeout(r,ms));
let guard=null;
const real=()=>guard||(guard=createGuard({adb,adbBinary,adbAsync,root}));

function focus(){return sh('dumpsys','window').split('\n').filter(l=>l.includes('mCurrentFocus')).join(' ');}
// Kept for the suites: recovers an OS dialog if one is focused, throws for anything else.
function recoverSystemAnr(){return real().inspect();}
async function waitForWindow(component,timeout=45000){
 const end=Date.now()+timeout;
 while(Date.now()<end){recoverSystemAnr();const current=focus();if(!/Application Error|ApplicationError|Not Responding/i.test(current)&&current.includes(component))return;await pause(300);}
 throw new Error('Android window did not receive focus: '+component+'; '+focus());
}
function disableNetwork(){
 sh('svc','wifi','disable');
 if(!sh('service','check','phone').includes('not found'))sh('svc','data','disable');
 else console.log('ANDROID_OFFLINE','Wi-Fi disabled; this tablet image has no phone service');
}
// A suite process calls start() once. android-suites.cjs sets ANDROID_ANR_KEEP so the second suite keeps the first one's journal.
function start({watchdogMs=3000}={}){const g=real();if(!process.env.ANDROID_ANR_KEEP)g.reset();else try{adb('logcat','-c');}catch{}g.startWatchdog(watchdogMs);return g;}
module.exports={createGuard,start,reset:()=>real().reset(),recoverSystemAnr,waitForWindow,disableNetwork,events:()=>real().events(),failures:()=>real().failures(),check:()=>real().check(),finish:packages=>real().finish(packages),guardedKey:send=>real().guardedKey(send)};
