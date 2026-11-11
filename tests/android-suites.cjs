const {spawnSync}=require('node:child_process');
const system=require('./android-system.cjs');
let failed=false;
// One journal and one evidence directory for the whole run: both suites add to it (the suites do not clear it themselves when this flag is set).
system.reset();
const child={...process.env,ANDROID_ANR_KEEP:'1'};
for(const file of ['android-studio-suite.cjs','android-emulator.cjs','android-termux.cjs']){
 const result=spawnSync(process.execPath,['tests/'+file],{stdio:'inherit',timeout:12*60*1000,env:child});
 if(result.status!==0){failed=true;console.error('Android suite failed:',file,result.error?.message||result.signal||result.status);}
 spawnSync('python',['tests/print-qa-evidence.py'],{stdio:'inherit',timeout:60000});
}
const evidence=spawnSync('python',['tests/print-qa-evidence.py'],{stdio:'inherit',timeout:60000});
if(evidence.status!==0)console.error('Screenshot log preview unavailable; inspect original artifact PNGs.');
const recoveries=system.events(),anrFailures=system.failures();
console.log('ANDROID_SYSTEM_RECOVERIES',JSON.stringify(recoveries));
console.log('ANDROID_ANR_FAILURES',JSON.stringify(anrFailures));
// A recorded ANR failure fails the run even if a suite process swallowed the exception.
if(anrFailures.length){failed=true;console.error('App or unknown ANR / crash dialog was recorded; see the failure-*.{focus.txt,xml,png,logcat.txt} files next to recoveries.json');}
process.exitCode=failed?1:0;
