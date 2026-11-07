// Record and recover only known emulator OS dialogs, using their real Wait button.
// Never dismiss an ANR from the app under test or suppress Android error reporting.
const {execFileSync}=require('node:child_process');
const fs=require('node:fs');
const root='.qa/android-system-'+process.env.ANDROID_API;
fs.mkdirSync(root,{recursive:true});
const journal=root+'/recoveries.json';
const adb=(...args)=>execFileSync('adb',args,{encoding:'utf8',timeout:45000}).trim();
const sh=(...args)=>adb('shell',...args);
const pause=ms=>new Promise(r=>setTimeout(r,ms));
function events(){return fs.existsSync(journal)?JSON.parse(fs.readFileSync(journal,'utf8')):[];}
function focus(){return sh('dumpsys','window').split('\n').filter(l=>l.includes('mCurrentFocus')).join(' ');}
function recoverSystemAnr(){
 const current=focus();if(!/Application Error|ApplicationError|Not Responding/i.test(current))return false;
 sh('uiautomator','dump','--compressed','/sdcard/system-dialog.xml');const xml=sh('cat','/sdcard/system-dialog.xml'),decoded=xml.replaceAll('&apos;',"'");
 const message=decoded.match(/text="((?:System UI|Pixel Launcher) (?:isn't responding|is not responding))"/);
 if(!message){
  // WindowManager can retain the dismissed error-window title for a few frames.
  // Wait for real focus instead of treating a normal picker tree as a new ANR.
  if(/aerr_|isn(?:'|’|&apos;)t responding|is not responding/.test(decoded))throw new Error('Unexpected Android error dialog; not dismissed: '+current);
  return false;
 }
 const records=events();if(records.length>=4)throw new Error('Repeated emulator OS ANRs; refusing further recovery');
 const wait=(xml.match(/<node\b[^>]*>/g)||[]).find(n=>/resource-id="android:id\/aerr_wait"|text="Wait"/.test(n));
 const b=wait?.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);if(!b)throw new Error('Android OS ANR Wait button is unavailable');
 const number=records.length+1,prefix=root+'/'+number;
 fs.writeFileSync(prefix+'.xml',xml);fs.writeFileSync(prefix+'.png',execFileSync('adb',['exec-out','screencap','-p'],{timeout:45000}));
 fs.writeFileSync(prefix+'.logcat.txt',adb('logcat','-d','-t','1000'));
 const event={at:new Date().toISOString(),message:message[1],focus:current,action:'Wait',evidence:prefix};records.push(event);fs.writeFileSync(journal,JSON.stringify(records,null,2));
 sh('input','touchscreen','tap',String((+b[1]+ +b[3])/2|0),String((+b[2]+ +b[4])/2|0));
 console.log('ANDROID_SYSTEM_ANR_RECOVERED',JSON.stringify(event));return true;
}
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
module.exports={recoverSystemAnr,waitForWindow,events,disableNetwork};
