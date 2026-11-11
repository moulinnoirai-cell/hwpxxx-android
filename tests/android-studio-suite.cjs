// Installed APK + REAL Android WebView + the shared Studio (default UI) + real OfflineNative: hwpxxx editor features.
// Counterpart of tests/studio-hwpxxx-features.py (Chromium + mock native), but through the real WebView and real native bridge.
// Only production-safe surfaces are used (the Studio build has no dev globals): DOM, #sb-page, the toolbar's active state, rhwpPerfSnapshot().
// IME is simulated with CDP Input.imeSetComposition (no real keyboard app in the emulator); the result is reported, not hidden, if CDP is unavailable.
const {chromium}=require('playwright');
const {execFileSync}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
console.log('UI_UNDER_TEST default shared Studio (no legacyUiForTests)');
const pkg='kr.offline.hwp.preview',qa='.qa/android-'+(process.env.ANDROID_API||'x'),results=[];
fs.mkdirSync(qa,{recursive:true});
const adb=(...a)=>execFileSync('adb',a,{encoding:'utf8',timeout:90000}).trim(),sh=(...a)=>adb('shell',...a);
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const shot=name=>{try{fs.writeFileSync(path.join(qa,`studio-${name}.png`),execFileSync('adb',['exec-out','screencap','-p'],{timeout:45000}));}catch{}};
let browser=null,page=null;const errors=[];
async function studioPage(timeout=90000){
 const end=Date.now()+timeout;
 while(Date.now()<end){
  try{
   const pid=sh('pidof',pkg).split(/\s+/)[0];if(pid){adb('forward','tcp:9222','localabstract:webview_devtools_remote_'+pid);
    if(!browser)browser=await chromium.connectOverCDP('http://127.0.0.1:9222',{timeout:10000});
    for(const ctx of browser.contexts())for(const p of ctx.pages()){
     if(p.isClosed())continue;
     const ready=await p.evaluate(()=>!!window.rhwpStudio?.android&&!!document.querySelector('#scroll-container')).catch(()=>false);
     if(ready){if(page!==p){page=p;page.setDefaultTimeout(20000);page.on('pageerror',e=>errors.push(e.message));}return page;}
    }}
  }catch(e){try{await browser?.close();}catch{};browser=null;}
  await pause(1000);
 }
 throw new Error('Studio page did not become ready');
}
// Playwright's waitForFunction evaluates in the page's main world, which the strict production CSP (no unsafe-eval) refuses: poll with page.evaluate instead.
const waitFn=async(fn,arg,timeout=20000)=>{const end=Date.now()+timeout;let last;while(Date.now()<end){try{if(await page.evaluate(fn,arg))return true;}catch(e){last=e;}await pause(250);}throw new Error('timed out waiting for a page condition'+(last?': '+String(last.message).slice(0,120):''));};
let cdp=null;
// The shell replaces the editor WebView right after start (workspace startup), which closes the first CDP target: re-attach and wait for a document before every scenario.
async function ensureStudio(){
 for(let attempt=0;attempt<3;attempt++){
  try{
   await studioPage(60000);
   await waitFn(()=>window.rhwpStudio?.android?.getState?.().hasDocument===true,null,60000);
   try{cdp=await page.context().newCDPSession(page);}catch(e){cdp=null;console.log('CDP session unavailable:',e.message);}
   return;
  }catch(e){console.log('re-attaching to Studio:',String(e.message).slice(0,120));try{await browser?.close();}catch{};browser=null;page=null;await pause(2000);}
 }
 throw new Error('Studio page with a document is not available');
}
async function scenario(name,fn){
 const t0=Date.now();
 try{await ensureStudio();}catch(e){results.push({name,passed:false,error:String(e.message||e).slice(0,300)});console.log('FAIL',name,e.message);return;}
 try{const r=await fn();if(r&&r.skipped){results.push({name,skipped:true,detail:r.skipped});console.log('SKIP',name,r.skipped);}
  else{results.push({name,passed:true,ms:Date.now()-t0,detail:r&&r.detail});console.log('PASS',name,r&&r.detail?JSON.stringify(r.detail):'');}}
 catch(e){results.push({name,passed:false,error:String(e.message||e).slice(0,500)});console.log('FAIL',name,String(e.message||e).slice(0,500));shot('fail-'+name.replace(/\W+/g,'-').slice(0,40));}
}
const pages=async()=>{const t=await page.locator('#sb-page').textContent();const m=/(\d+)\s*\/\s*(\d+)/.exec(t||'');assert(m,'status bar page text: '+t);return Number(m[2]);};
const boldActive=()=>page.evaluate(()=>document.querySelector('#btn-bold')?.classList.contains('active')===true);
async function focusDoc(){await page.click('#scroll-container');await page.keyboard.press('Control+Home');}
async function selectWord(fromEnd){await page.keyboard.press('Control+End');for(let i=0;i<fromEnd;i++)await page.keyboard.press('Control+ArrowLeft');await page.keyboard.press('Control+Shift+ArrowLeft');}
(async()=>{
 adb('install','-r','app/build/outputs/apk/debug/app-debug.apk');sh('pm','clear',pkg);
 sh('appops','set','--uid',pkg,'MANAGE_EXTERNAL_STORAGE','allow');
 sh('am','start','-W','-n',`${pkg}/kr.offline.hwp.MainActivity`);
 await studioPage();await pause(2000);shot('start');
 await scenario('Studio is the default UI and reports a document state',async()=>{const s=await page.evaluate(()=>window.rhwpStudio.android.getState());assert(s&&typeof s.hasDocument==='boolean');return {detail:{hasDocument:s.hasDocument}};});
 await scenario('IME composition overlay follows the pending bold and uses the resolved font stack',async()=>{
  if(!cdp)return {skipped:'no CDP session in this WebView mode'};
  await focusDoc();await page.keyboard.type('시작 ');await page.keyboard.press('Control+b');
  await cdp.send('Input.imeSetComposition',{text:'한',selectionStart:1,selectionEnd:1});
  await waitFn(()=>{const e=document.querySelector('.caret-composition');return !!e&&getComputedStyle(e).display!=='none'&&e.textContent.length>0;},null,8000);
  const o=await page.evaluate(()=>{const e=document.querySelector('.caret-composition'),c=getComputedStyle(e);return {family:c.fontFamily,size:parseFloat(c.fontSize),weight:Number(c.fontWeight)};});
  shot('composition');await page.keyboard.insertText('한');await pause(300);
  assert(o.family.includes(',')&&/(sans-)?serif\s*$/i.test(o.family),'font stack from the canvas-resolved path (document font first, generic fallback last): '+o.family);
  assert(o.weight>=600,'bold from the pending shape: '+o.weight);
  assert(o.size>1,'size '+o.size);
  const hidden=await page.evaluate(()=>{const e=document.querySelector('.caret-composition');return !e||getComputedStyle(e).display==='none';});assert(hidden,'overlay hides after commit');
  return {detail:o};});
 await scenario('Ctrl+Enter inserts a page break (plain key, then while Hangul is composing)',async()=>{
  await focusDoc();await page.keyboard.press('Control+End');
  let before=await pages();await page.keyboard.press('Control+Enter');await pause(800);let after=await pages();assert.equal(after,before+1,'plain Ctrl+Enter');
  if(!cdp)return {detail:{plain:true},skipped:undefined};
  await page.keyboard.type('다음 ');await cdp.send('Input.imeSetComposition',{text:'쪽',selectionStart:1,selectionEnd:1});await pause(200);
  before=await pages();
  await cdp.send('Input.dispatchKeyEvent',{type:'rawKeyDown',key:'Process',code:'Enter',windowsVirtualKeyCode:229,nativeVirtualKeyCode:229,modifiers:2});
  await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,modifiers:2});await pause(900);
  after=await pages();assert.equal(after,before+1,'Ctrl+Enter while composing');
  await cdp.send('Input.imeSetComposition',{text:'',selectionStart:0,selectionEnd:0}).catch(()=>{});
  return {detail:{plain:true,composing:true}};});
 await scenario('Alt+C: Enter confirms the dialog, the format can be pasted repeatedly, Esc releases it',async()=>{
  await focusDoc();await page.keyboard.press('Control+End');await page.keyboard.type(' alpha beta gamma');
  await selectWord(2);if(!await boldActive())await page.click('#btn-bold');await pause(300);assert(await boldActive(),'the first word is bold before Alt+C copies its format');
  await page.keyboard.press('Alt+c');await page.waitForSelector('.modal-overlay',{timeout:8000});
  assert(await page.evaluate(()=>!!document.querySelector('input[name=format-copy-continuous]')?.checked),'continuous is on by default');
  await page.evaluate(()=>document.querySelector('input[name=format-copy-body][value=char]')?.focus());
  await page.keyboard.press('Enter');await pause(400);
  assert.equal(await page.locator('.modal-overlay').count(),0,'Enter on a radio closes the dialog');
  for(const [i,label] of [[1,'second'],[0,'third']]){
   await selectWord(i);await page.keyboard.press('Alt+c');await pause(500);
   assert.equal(await page.locator('.modal-overlay').count(),0,label+': applied, no dialog');
   assert(await boldActive(),label+': bold applied');}
  await page.keyboard.press('Escape');await pause(300);
  await selectWord(1);await page.keyboard.press('Alt+c');
  await page.waitForSelector('.modal-overlay',{timeout:8000}); // released: Alt+C asks for a new copy again
  await page.keyboard.press('Escape');await pause(300);
  return {detail:{repeated:2}};});
 await scenario('typing and autosave performance snapshot is readable (informational numbers)',async()=>{
  await page.evaluate(()=>window.rhwpPerfReset&&window.rhwpPerfReset());
  await focusDoc();await page.keyboard.press('Control+End');
  for(let i=0;i<6;i++)await page.keyboard.type('성능 측정을 위한 문장입니다. '.repeat(4),{delay:0});
  await page.evaluate(()=>window.rhwpStudio.android.flushAutosave?window.rhwpStudio.android.flushAutosave('qa'):null).catch(()=>{});
  await pause(2000);
  const snap=await page.evaluate(()=>window.rhwpPerfSnapshot?window.rhwpPerfSnapshot():null);
  assert(snap&&snap.summary,'rhwpPerfSnapshot is exposed');
  fs.writeFileSync(path.join(qa,'studio-perf-snapshot.json'),JSON.stringify(snap,null,2));
  assert(snap.summary['input.afterEdit'],'input path recorded');
  return {detail:Object.fromEntries(Object.entries(snap.summary).map(([k,v])=>[k,{n:v.count,max:v.maxMs,p95:v.p95Ms}]))};});
 await scenario('tab limit is five (new tab control disables at five)',async()=>{
  const snapshot=async()=>{let max=0,disabled=false;for(const ctx of browser.contexts())for(const p of ctx.pages()){if(p.isClosed())continue;try{const r=await p.evaluate(()=>({n:document.querySelectorAll('.ws-tab').length,d:document.querySelector('[data-ws-action="new"]')?.getAttribute('aria-disabled')==='true'}));max=Math.max(max,r.n);disabled=disabled||r.d;}catch{}}return {max,disabled};};
  // Click the new-tab control of any WebView that shows an enabled one; each new tab brings up another WebView + WASM, so wait for the count to rise.
  const clickNew=async()=>{for(const ctx of browser.contexts())for(const p of ctx.pages()){if(p.isClosed())continue;try{const ok=await p.evaluate(()=>{const b=document.querySelector('[data-ws-action="new"]');if(!b||b.getAttribute('aria-disabled')==='true')return false;const r=b.getBoundingClientRect();return r.width>0&&r.height>0;});if(ok){await p.locator('[data-ws-action="new"]').click({timeout:5000});return true;}}catch{}}return false;};
  let state=await snapshot();
  for(let i=0;i<8&&state.max<5;i++){
   const before=state.max;
   if(!await clickNew()){await pause(3000);state=await snapshot();continue;}
   const end=Date.now()+45000;
   while(Date.now()<end){await pause(1500);state=await snapshot();if(state.max>before)break;}
   console.log('tabs after click',i+1,JSON.stringify(state));
  }
  shot('tabs');
  assert(state.max<=5,'never more than five tabs: '+state.max);
  assert(state.max===5&&state.disabled,'five tabs reached and the new-tab control is disabled: '+JSON.stringify(state));
  return {detail:state};});
 const real=results.filter(r=>!r.skipped);
 fs.writeFileSync(path.join(qa,'studio-suite.json'),JSON.stringify({results,pageErrors:errors.slice(0,10)},null,2));
 console.log('STUDIO_SUITE_RESULTS',JSON.stringify(results.map(r=>({n:r.name,ok:r.passed,skip:!!r.skipped}))));
 await browser?.close().catch(()=>{});
 process.exit(real.some(r=>!r.passed)?1:0);
})().catch(e=>{console.error('Studio suite aborted:',e.message);fs.writeFileSync(path.join(qa,'studio-suite.json'),JSON.stringify({aborted:e.message,results},null,2));process.exit(1);});
