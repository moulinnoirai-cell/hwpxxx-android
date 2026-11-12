// Installed APK + real Android WebView / OfflineNative / filesystem. No bridge mocks.
const {chromium}=require('playwright');
const {execFileSync}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {waitForWindow,disableNetwork,start:startAnrGuard,check:anrCheck,finish:anrFinish,guardedKey}=require('./android-system.cjs');
// DEBUG-only opt-in: the default app UI is now the shared desktop Studio. These suites drive the OLD library UI, so they
// explicitly request the debug legacy fallback. They are LEGACY-FALLBACK results and never a pass for the new default Studio.
const LEGACY_UI=['--ez','legacyUiForTests','true'];console.log('UI_UNDER_TEST legacy-fallback (debug legacyUiForTests); NOT the default shared Studio');
const pkg='kr.offline.hwp.preview',dir='/sdcard/Download/hwpxxx-qa',qa='.qa/android-'+process.env.ANDROID_API;
fs.mkdirSync(qa,{recursive:true});
const adb=(...args)=>execFileSync('adb',args,{encoding:'utf8',timeout:60000}).trim();
const sh=(...args)=>adb('shell',...args);
const checks=[],errors=[];let permissionGrant='settings-switch',permissionRevocation='not-run',backInputDismissals=0;let page,browser;
const pause=ms=>new Promise(r=>setTimeout(r,ms));
// Waits were 20 s; the legacy editor now boots the larger rhwp v0.9.0 engine (27 MB WASM) on a 2-core CI emulator, so scenarios were timing out one at a time.
async function until(fn,ms=45000){const end=Date.now()+ms;let err;while(Date.now()<end){try{const r=await fn();if(r)return r;}catch(e){err=e;}await pause(200);}throw err||new Error('Condition timed out');}
let anrGuard=null,textZoomProbe=null;
// After every scenario (also the ones driven only over CDP, which keep passing while an ANR dialog covers the screen) the focused window and the system log are checked.
async function record(name,fn){const started=Date.now();try{await fn();anrCheck();}catch(e){e.scenario=name;throw e;}checks.push({name,passed:true,durationMs:Date.now()-started});console.log('PASS',name);screenshot(`${qa}/${String(checks.length).padStart(2,'0')}.png`);}
function screenshot(file){fs.writeFileSync(file,execFileSync('adb',['exec-out','screencap','-p'],{timeout:45000}));}
async function disconnect(){const old=browser;browser=null;if(old)await Promise.race([old.close().catch(()=>{}),pause(5000)]);}
async function connect(){
 const deadline=Date.now()+60000;let error;
 while(Date.now()<deadline)try{
  await disconnect();const pid=sh('pidof',pkg).split(/\s+/)[0];assert(pid,'App process is unavailable');adb('forward','tcp:9222','localabstract:webview_devtools_remote_'+pid);
  browser=await chromium.connectOverCDP('http://127.0.0.1:9222',{timeout:10000});page=browser.contexts()[0]?.pages()[0];if(!page)throw new Error('WebView target is not ready');page.setDefaultTimeout(45000);page.on('pageerror',e=>{errors.push(e.message);console.error('WEBVIEW_ERROR',e.message);});await page.locator('#content').waitFor();return;
 }catch(e){error=e;await disconnect();await pause(500);}
 throw error||new Error('Unable to connect to installed WebView');
}
let recoveryOffersDismissed=0;
async function dismissRecovery(){
 // Drafts of edits that were still unsaved when a scenario killed the app are offered again at every start. The offer must appear
 // (listDrafts is the app's own record); a scenario that is not about recovery dismisses it with the real button.
 const drafts=await nativeCall('listDrafts').catch(()=>[]);if(!drafts.length)return;
 await page.locator('#sheet-title').filter({hasText:'저장하지 못한 편집 내용'}).waitFor({timeout:20000});recoveryOffersDismissed++;await click('close');await closed();
}
async function start(recovery='dismiss'){sh('am','start','-W','-n',`${pkg}/kr.offline.hwp.MainActivity`,...LEGACY_UI);await connect();await pause(1500);if(page.isClosed()){console.log('CDP_STARTUP_TARGET_CHANGED');await disconnect();await connect();}if(recovery==='dismiss')await dismissRecovery();}
function foreground(){return sh('dumpsys','activity','activities').split('\n').filter(l=>/ResumedActivity/.test(l)).join(' ');}
async function settingsVisible(){await until(()=>foreground().includes('com.android.settings'));await waitForWindow('com.android.settings');await pause(700);}
async function appVisible(){await until(()=>foreground().includes(pkg+'/kr.offline.hwp.MainActivity'));await waitForWindow(pkg);}
async function returnFromSettings(){for(let i=0;i<3;i++){if(foreground().includes(pkg+'/kr.offline.hwp.MainActivity'))break;guardedKey(()=>sh('input','keyevent','4'));await pause(1000);}await appVisible();await ensureConnection();}
async function ensureConnection(){if(!page.isClosed())return;assert(appAlive(),'Android app terminated unexpectedly');console.log('CDP_REATTACH_WITHOUT_APP_RELAUNCH');await disconnect();await connect();}
function appAlive(){try{return !!sh('pidof',pkg);}catch{return false;}}
async function regrantAndRestart(){sh('am','force-stop',pkg);sh('appops','set','--uid',pkg,'MANAGE_EXTERNAL_STORAGE','allow');await start();await a('open').first().waitFor();}
const a=name=>page.locator(`[data-action="${name}"]`);
async function click(name){
 await ensureConnection();
 try{await a(name).click();}catch(e){
  if(name!=='allow'||!/closed/.test(e.message))throw e;
  await pause(500);
  // A startup target replacement can close CDP before the permission click is
  // delivered. Retry this idempotent action only while our onboarding is on top.
  if(foreground().includes(pkg+'/kr.offline.hwp.MainActivity')){
   await ensureConnection();console.log('CDP_PERMISSION_CLICK_REATTACHED');
   try{await a(name).click();}catch(retry){if(!/closed/.test(retry.message))throw retry;}
  }
  await settingsVisible();console.log('CDP_DETACHED_DURING_NATIVE_SETTINGS');
 }
}
async function backPrompt(){guardedKey(()=>sh('input','keyevent','4'));await pause(700);if(!await a('exit-discard').isVisible()){assert(foreground().includes(pkg),'Back left the editor without a confirmation');backInputDismissals++;console.log('BACK_DISMISSED_INPUT_UI_FIRST');guardedKey(()=>sh('input','keyevent','4'));}await a('exit-discard').waitFor();}
async function closed(){await page.locator('#overlay').waitFor({state:'hidden'});}
async function library(){
 if(await a('cancel-edit').isVisible()){
  await click('cancel-edit');await until(async()=>await a('cancel-yes').isVisible()||await a('edit').isVisible());
  if(await a('cancel-yes').isVisible())await click('cancel-yes');await a('edit').waitFor();
 }
 if(await a('back').isVisible())await click('back');
 await page.locator('#search').waitFor();
}
async function open(name){await page.locator('#search').fill(name);await page.getByRole('button',{name:`${name} 열기`,exact:true}).click();await page.locator('.page img').first().waitFor();}
async function edit(){await click('edit');const p=page.locator('.page').first(),b=await p.boundingBox();await p.click({position:{x:b.width*120/794,y:b.width*135/794}});await page.locator('#text-editor').waitFor();}
async function changed(text){const t=page.locator('#text-editor');await t.fill(text);await until(()=>a('save').isEnabled());}
async function save(){
 await click('save');await click('save-yes');
 await until(()=>page.evaluate(()=>document.querySelector('#overlay').hidden||['저장했어요','작업을 완료하지 못했어요'].includes(document.querySelector('#sheet-title')?.textContent)));
 if(await page.locator('#overlay').isVisible()){
  assert.equal(await page.locator('#sheet-title').innerText(),'저장했어요',await page.locator('#sheet').innerText());await click('close');
 }
 await closed();assert(await a('save').isDisabled());
}
async function nativeCall(op,args={}){
 const r=await page.evaluate(({op,args})=>new Promise((resolve,reject)=>{const id=900100+(window.__qaSeq=(window.__qaSeq||0)+1),old=window.NativeReply;const timer=setTimeout(()=>{window.NativeReply=old;reject(new Error('Native test request timed out'));},15000);window.NativeReply=(rid,r)=>{if(rid===id){clearTimeout(timer);window.NativeReply=old;resolve(r);}else old(rid,r);};OfflineNative.postMessage(JSON.stringify({id,op,args}));}),{op,args});
 if(!r.ok)throw new Error(r.error);return r.data;
}
async function hash(name){return sh('sha256sum',`${dir}/${name}`).split(/\s/)[0];}
async function rotate(n){sh('settings','put','system','accelerometer_rotation','0');sh('settings','put','system','user_rotation',String(n));await pause(1000);}
(async()=>{
 try{
  assert.equal(adb('get-state'),'device');startAnrGuard();
  sh('settings','put','system','screen_off_timeout','2147483647');sh('svc','power','stayon','true');sh('input','keyevent','224');sh('wm','dismiss-keyguard');console.log('ANDROID_DISPLAY',sh('dumpsys','power').split('\n').filter(l=>/mWakefulness=|mIsPowered=|mStayOn=/.test(l)).join(' '));
  sh('wm','size','1920x1080');sh('wm','density','160');
  sh('settings','put','secure','show_ime_with_hard_keyboard','0');await rotate(0);
  // Let initial launcher/taskbar work finish after configuring the tablet display.
  await pause(15000);
  adb('install','-r','app/build/outputs/apk/debug/app-debug.apk');sh('pm','clear',pkg);disableNetwork();
  // sys.boot_completed can precede the emulated shared-storage FUSE mount.
  await until(()=>{try{sh('mkdir','-p',dir);sh('touch',dir+'/.ready');sh('rm',dir+'/.ready');return true;}catch{return false;}},60000);console.log('ANDROID_SHARED_STORAGE_READY');
  for(const [src,dest] of [['문서.hwpx','qa-edit.hwpx'],['문서.hwp','qa-edit.hwp'],['table.hwpx','qa-table.hwpx'],['문서.hwpx','duplicate.hwpx'],['문서.hwpx','qa-range.hwpx'],['문서.hwpx','qa-memo.hwpx']])adb('push',`tests/fixtures/${src}`,`${dir}/${dest}`);
  for(const f of fs.readdirSync('.qa/fixtures'))adb('push',`.qa/fixtures/${f}`,`${dir}/${f}`);
  sh('touch',`${dir}/qa-empty.hwpx`);sh('dd','if=/dev/zero',`of=${dir}/qa-oversize.hwp`,'bs=1048576','count=33');
  fs.writeFileSync(`${qa}/corrupt.hwpx`,'not a ZIP or HWP document');adb('push',`${qa}/corrupt.hwpx`,`${dir}/qa-corrupt.hwpx`);
  await start();
  await record('fresh install: access denied shows onboarding, not files',async()=>{await a('allow').waitFor();assert.equal(await a('open').count(),0);});
  await record('permission settings can be cancelled and revisited',async()=>{await click('allow');await settingsVisible();await returnFromSettings();await a('allow').waitFor();});
  await record('grant all-files access through Android settings',async()=>{
   await click('allow');await settingsVisible();
   let sw;for(let i=0;i<2&&!sw;i++)try{sh('rm','-f','/sdcard/window.xml');sh('uiautomator','dump','--compressed','/sdcard/window.xml');const xml=sh('cat','/sdcard/window.xml');sw=(xml.match(/<node\b[^>]*>/g)||[]).find(n=>/class="android.widget.Switch"|resource-id="[^"]*switch_widget"/.test(n));}catch{}
   if(sw){const b=sw.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);assert(b);sh('input','tap',String((+b[1]+ +b[3])/2|0),String((+b[2]+ +b[4])/2|0));}
   else{permissionGrant='adb-appops; Settings navigation verified, UiAutomator root unavailable';sh('appops','set','--uid',pkg,'MANAGE_EXTERNAL_STORAGE','allow');}
   let mode=sh('appops','get',pkg,'MANAGE_EXTERNAL_STORAGE');
   if(!mode.includes('allow')){permissionGrant+='; switch did not grant, normalized with adb-appops';sh('appops','set','--uid',pkg,'MANAGE_EXTERNAL_STORAGE','allow');mode=sh('appops','get',pkg,'MANAGE_EXTERNAL_STORAGE');}
   console.log('PERMISSION_OS',mode);await returnFromSettings();
   const nativeStatus=await page.evaluate(()=>new Promise(resolve=>{const old=window.NativeReply,id=900001;const timer=setTimeout(()=>{window.NativeReply=old;resolve('native status timeout');},5000);window.NativeReply=(rid,r)=>{if(rid===id){clearTimeout(timer);window.NativeReply=old;resolve(r);}else old(rid,r);};OfflineNative.postMessage(JSON.stringify({id,op:'status',args:{}}));}));console.log('PERMISSION_NATIVE',JSON.stringify(nativeStatus));
   await until(()=>a('open').count());
  });
  await record('offline corrupt file error returns to a usable library',async()=>{await page.locator('#search').fill('qa-corrupt');await a('open').first().click();await page.locator('#sheet-title').filter({hasText:'작업을 완료하지 못했어요'}).waitFor();await click('close');await page.locator('#search').fill('');});
  await record('empty and over-32MB documents fail gracefully without hanging',async()=>{for(const name of ['qa-empty.hwpx','qa-oversize.hwp']){await page.locator('#search').fill(name);await a('open').first().click();await page.getByText(/빈 파일이거나 32MB/).waitFor();await click('close');assert(await page.locator('#search').isVisible());}});
  for(const format of ['hwp','hwpx'])await record(`${format}: password cancel, wrong password, correct password and encrypted save`,async()=>{
   const name=`qa-locked.${format}`;await page.locator('#search').fill(name);await a('open').first().click();await page.locator('#doc-password').waitFor();await click('close');
   await a('open').first().click();await page.locator('#doc-password').fill('wrong');await click('pw-open');await page.getByText('암호가 맞지 않아요. 다시 입력해 주세요.').waitFor();
   await page.locator('#doc-password').fill('qa-only-2026');await click('pw-open');await page.locator('.page img').first().waitFor();await edit();await changed((await page.locator('#text-editor').inputValue())+' ENCRYPTED');await save();await library();
   await a('open').first().click();await page.locator('#doc-password').waitFor();assert.equal(await page.locator('#doc-password').inputValue(),'');await page.locator('#doc-password').fill('qa-only-2026');await click('pw-open');await page.locator('.page img').first().waitFor();await edit();assert((await page.locator('#text-editor').inputValue()).includes('ENCRYPTED'));await library();
  });
  await record('long document: lazy pages, PageDown and Ctrl+End after editing',async()=>{
   await open('qa-long.hwpx');assert(await page.locator('.page').count()>5);await edit();await page.keyboard.press('PageDown');await page.keyboard.press('Control+End');await until(async()=>(await page.locator('#text-editor').inputValue()).startsWith('30.'));await page.keyboard.press('Control+Home');await until(async()=>(await page.locator('#text-editor').inputValue()).startsWith('1.'));await library();
  });
  await record('search miss, clear search and favorite survive restart',async()=>{
   await page.locator('#search').fill('no-such-document');assert.equal(await a('open').count(),0);await click('clear');
   const f=page.getByRole('button',{name:'qa-edit.hwpx 즐겨찾기 추가',exact:true});await f.click();assert.equal(await page.getByRole('button',{name:'qa-edit.hwpx 즐겨찾기 해제',exact:true}).getAttribute('aria-pressed'),'true');
  });
  let savedText;
  for(const fmt of ['hwpx','hwp']){
   await record(`${fmt}: physical keyboard text, cancel and native save/reopen`,async()=>{
    const name=`qa-edit.${fmt}`,original=await hash(name);await open(name);await edit();const t=page.locator('#text-editor'),before=await t.inputValue();
    await t.press('End');await page.keyboard.insertText(' DeX 한글😀');await until(()=>a('save').isEnabled());assert.equal(await hash(name),original);
    await click('cancel-edit');await click('close');assert((await t.inputValue()).includes('DeX 한글😀'));await save();assert.notEqual(await hash(name),original);
    savedText=await t.inputValue();await library();await open(name);await edit();assert.equal(await page.locator('#text-editor').inputValue(),savedText);
    await library();if(fmt==='hwp')assert(sh('ls',dir).includes('qa-edit_백업_'));
   });
  }
  await record('memo keyboard confirmation, native disk roundtrip and deletion',async()=>{
   await open('qa-edit.hwpx');await edit();const t=page.locator('#text-editor');await t.press('Home');await t.press('Shift+ArrowRight');await t.press('Shift+ArrowRight');
   await click('tb-memo');await click('memo-new');await page.locator('#memo-text').fill('DeX 메모 <script>😀');await page.locator('#memo-text').press('Control+Enter');await closed();assert.equal(await page.locator('.memo-card').count(),1);await save();await library();
   await open('qa-edit.hwpx');await edit();await click('tb-memo');assert((await page.locator('.memo-card').innerText()).includes('DeX 메모 <script>😀'));
   await click('memo-remove');await click('close');assert.equal(await page.locator('.memo-card').count(),1);await click('memo-remove');await click('memo-delete');await closed();assert.equal(await page.locator('.memo-card').count(),0);await save();await library();
  });
  await record('memo jump keeps pending and composing edits; panel fields keep their own shortcuts; the saved file holds the edit',async()=>{
   // Review P1 (F1): the jump used to replace the editor before the pending text was committed. Real WebView, real worker, real file.
   const name='qa-memo.hwpx',original=await hash(name);await open(name);await edit();const t=page.locator('#text-editor');
   const p0=await t.inputValue();await t.press('Home');await t.press('Shift+ArrowRight');await t.press('Shift+ArrowRight');
   await click('tb-memo');await click('memo-new');await page.locator('#memo-text').fill('점프 메모');await page.locator('#memo-text').press('Control+Enter');await closed();await page.locator('.memo-anchor').waitFor();
   const toTop=async()=>{await page.locator('.reader-scroll').evaluate(e=>{e.scrollTop=0;});await pause(200);};
   const clickPara=async(x,y)=>{await toTop();const box=await page.locator('.page').first().boundingBox(),k=box.width/793.7;await page.mouse.click(box.x+x*k,box.y+y*k);await t.waitFor();await pause(400);};
   await clickPara(200,160);const p1=await t.inputValue();assert.notEqual(p1,p0);
   // (a) text typed in the same task as the jump is still waiting for its commit timer
   await page.evaluate(()=>{const e=document.querySelector('#text-editor');e.value=e.value+' PENDING';e.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('.memo-anchor').click();});
   await until(async()=>(await t.inputValue())===p0);await clickPara(200,160);assert.equal(await t.inputValue(),p1+' PENDING','the pending text survived the memo jump');
   // (b) a syllable that is still composing: the jump is refused, nothing is lost, and it works once the composition has ended
   await t.evaluate(e=>{e.focus();e.setSelectionRange(e.value.length,e.value.length);e.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));e.value=e.value+'ㅎ';e.dispatchEvent(new Event('input',{bubbles:true}));});
   await page.locator('.memo-anchor').click();await pause(500);assert.equal(await t.inputValue(),p1+' PENDINGㅎ');assert(/한글 입력을 마친 뒤/.test(await page.locator('#announce').innerText()));
   await t.evaluate(e=>e.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true})));await page.locator('.memo-anchor').click();await until(async()=>(await t.inputValue())===p0);
   await clickPara(200,160);assert.equal(await t.inputValue(),p1+' PENDINGㅎ');
   // (c) Ctrl+Z / Ctrl+B in a paragraph-panel number field act on the field, never on the document
   await click('tb-para');const field=page.locator('#fmt-spacingBefore');await field.waitFor();await field.click();await field.fill('3');await page.keyboard.press('Control+z');await pause(600);
   assert.equal(await t.inputValue(),p1+' PENDINGㅎ','Ctrl+Z in the field did not undo the document');await page.keyboard.press('Control+b');await pause(400);assert.notEqual(await a('tb-bold').getAttribute('aria-pressed'),'true');
   // (d) the saved FILE (not the screen) holds the edit and the memo
   assert.equal(await hash(name),original);await clickPara(200,160);await save();assert.notEqual(await hash(name),original);await library();
   await open(name);await edit();await clickPara(200,160);assert.equal(await t.inputValue(),p1+' PENDINGㅎ','reopened from disk');await click('tb-memo');assert.equal(await page.locator('.memo-card').count(),1);await library();
  });
  await record('Ctrl+Shift+S, duplicate-name refusal and native save-as',async()=>{
   await open('qa-edit.hwpx');await edit();await changed((await page.locator('#text-editor').inputValue())+' COPY');const old=await hash('qa-edit.hwpx');await page.keyboard.press('Control+Shift+s');
   await page.locator('#filename').fill('duplicate');await click('folder-confirm');await page.getByText(/같은 이름의 파일/).waitFor();assert.equal(await hash('qa-edit.hwpx'),old);
   await page.locator('#filename').fill('qa-copy');await click('folder-confirm');await closed();assert(sh('ls',dir).includes('qa-copy.hwpx'));assert.equal(await hash('qa-edit.hwpx'),old);await library();
  });
  await record('native PDF creation and folder creation/move preserve the document',async()=>{
   await page.locator('#search').fill('qa-copy');await a('open').first().click({button:'right'});await click('pdf');await page.locator('#filename').fill('qa-output');await click('folder-confirm');await closed();assert(sh('head','-c','5',`${dir}/qa-output.pdf`).startsWith('%PDF-'));
   const old=await hash('qa-copy.hwpx');await a('open').first().click({button:'right'});await click('move');await click('folder-new');await page.locator('#new-folder').fill('moved');await click('folder-create');await page.getByText('moved',{exact:true}).first().waitFor();await click('folder-confirm');await closed();assert.equal(await hash('moved/qa-copy.hwpx'),old);assert(!sh('ls',dir).split('\n').includes('qa-copy.hwpx'));
  });
  await record('dark theme applies and remains usable with mouse',async()=>{await click('settings');await page.locator('[data-action="set-theme"][data-value="dark"]').click();await click('close');assert.equal(await page.locator('#hwp-app').getAttribute('data-theme'),'dark');});
  await open('qa-edit.hwpx');await edit();
  await record('Android input dispatcher types through the installed WebView',async()=>{
   const t=page.locator('#text-editor');await t.click();
   // Wait for the keyboard/viewport transition before computing a native tap. The tap is computed from the editor's bounds, which move while the soft
   // keyboard animates in, so a tap can miss on a slow emulator: recompute and tap again (up to three times) before judging the focus.
   const nativeTap=async()=>{await pause(1000);const b=await t.boundingBox(),dpr=await page.evaluate(()=>devicePixelRatio),view=sh('dumpsys','activity','top').split('\n').find(l=>l.includes('android.webkit.WebView{')),frame=view?.match(/\s(-?\d+),(-?\d+)-(-?\d+),(-?\d+)/);
    if(frame){sh('input','mouse','tap',String(Math.round(+frame[1]+(b.x+b.width/2)*dpr)),String(Math.round(+frame[2]+(b.y+b.height/2)*dpr)));console.log('INPUT_FOCUS_METHOD','Android mouse tap using native WebView bounds');}else console.log('INPUT_FOCUS_METHOD','CDP mouse focus; Android key dispatcher');};
   await nativeTap();
   for(let attempt=1;attempt<=3;attempt++){try{await until(()=>t.evaluate(t=>document.activeElement===t),attempt<3?12000:45000);break;}catch(e){if(attempt===3)throw e;console.log('INPUT_FOCUS_RETRY',attempt);await t.click().catch(()=>{});await nativeTap();}}
   await pause(1000);
   const before=await t.evaluate(t=>({text:t.value,start:t.selectionStart,end:t.selectionEnd}));
   sh('input','text','DEX_OS_KEYS');
   try{await until(async()=>(await t.inputValue())===before.text.slice(0,before.start)+'DEX_OS_KEYS'+before.text.slice(before.end));}catch(e){console.error('NATIVE_INPUT_DIAGNOSTIC',JSON.stringify({before,after:await t.evaluate(t=>({text:t.value,start:t.selectionStart,end:t.selectionEnd,active:document.activeElement===t,connected:t.isConnected}))}));throw e;}
  });
  await record('DeX: clicking text never zooms; Ctrl+wheel zooms only document',async()=>{
   const before=await page.locator('#pages').evaluate(e=>parseFloat(e.style.width));await page.locator('#text-editor').click();assert.equal(await page.locator('#pages').evaluate(e=>parseFloat(e.style.width)),before);
   const p=await page.locator('.page').first().boundingBox();await page.mouse.move(p.x+200,p.y+150);await page.keyboard.down('Control');await page.mouse.wheel(0,-120);await page.keyboard.up('Control');
   await until(async()=>await page.locator('#pages').evaluate(e=>parseFloat(e.style.width))>before);assert.equal(await page.evaluate(()=>visualViewport.scale),1);
   await page.keyboard.press('Control+0');assert.equal(await page.locator('#pages').evaluate(e=>parseFloat(e.style.width)),100);
   await page.keyboard.press('Control+-');assert(await page.locator('#pages').evaluate(e=>parseFloat(e.style.width))<100);await page.keyboard.press('Control+0');
  });
  await record('mouse word selection and Ctrl+C/V/X/Z preserve Unicode text',async()=>{
   const t=page.locator('#text-editor'),original=await t.inputValue();await t.dblclick({position:{x:12,y:12}});assert(await t.evaluate(t=>t.selectionEnd>t.selectionStart));
   await t.press('Home');for(let i=0;i<3;i++)await t.press('Shift+ArrowRight');const selected=await t.evaluate(t=>t.value.slice(t.selectionStart,t.selectionEnd));
   await page.keyboard.press('Control+c');await t.press('End');const insertion=await t.evaluate(t=>t.selectionStart);await page.keyboard.press('Control+v');await until(async()=>(await t.inputValue())!==original);assert.equal(await t.inputValue(),original.slice(0,insertion)+selected+original.slice(insertion));await until(()=>a('save').isEnabled());await page.keyboard.press('Control+z');await until(async()=>(await t.inputValue())===original);
   await t.press('Home');for(let i=0;i<2;i++)await t.press('Shift+ArrowRight');await page.keyboard.press('Control+x');await until(async()=>(await t.inputValue()).length<original.length);await page.keyboard.press('Control+z');await until(async()=>(await t.inputValue())===original);
  });
  await record('keyboard paragraph navigation, forward Delete and undo/redo',async()=>{
   await page.keyboard.press('Control+Home');const t=page.locator('#text-editor'),original=await t.inputValue();await t.press('Home');await t.press('ArrowRight');await t.press('ArrowRight');const cut=await t.evaluate(t=>t.selectionStart);assert(cut>0&&cut<original.length);
   await t.press('Enter');await until(async()=>(await t.inputValue())===original.slice(cut));await page.keyboard.press('Control+ArrowUp');await until(async()=>(await t.inputValue())===original.slice(0,cut));
   await page.keyboard.press('Control+ArrowDown');await until(async()=>(await t.inputValue())===original.slice(cut));await page.keyboard.press('Control+ArrowUp');await until(async()=>(await t.inputValue())===original.slice(0,cut));await t.press('End');await t.press('Delete');await until(async()=>(await t.inputValue())===original);
   await page.keyboard.press('Control+z');await until(async()=>(await t.inputValue())===original.slice(0,cut));await page.keyboard.press('Control+y');await until(async()=>(await t.inputValue())===original);
  });
  await record('mouse range, Ctrl+B/Z/Y and plain wheel scrolling',async()=>{
   const t=page.locator('#text-editor');await t.press('Home');await t.press('Shift+ArrowRight');await t.press('Shift+ArrowRight');await page.keyboard.press('Control+b');await until(()=>a('save').isEnabled());
   await page.keyboard.press('Control+z');await page.keyboard.press('Control+y');const before=await page.locator('.reader-scroll').evaluate(e=>e.scrollTop);await page.mouse.wheel(0,500);await until(async()=>await page.locator('.reader-scroll').evaluate(e=>e.scrollTop)>before);await page.keyboard.press('Control+Home');
  });
  await record('rotation with unsaved input preserves text and live editor',async()=>{
   const t=page.locator('#text-editor');await changed((await t.inputValue())+' ROTATION');const value=await t.inputValue();await t.evaluate(t=>t.dataset.survival='same');
   await rotate(1);assert.equal(await t.inputValue(),value);assert.equal(await t.getAttribute('data-survival'),'same');await rotate(0);assert(await a('save').isVisible());
  });
  await record('Home/background/resume preserves unsaved text',async()=>{const text=await page.locator('#text-editor').inputValue();sh('input','keyevent','3');await pause(500);sh('am','start','-W','-n',`${pkg}/kr.offline.hwp.MainActivity`,...LEGACY_UI);await ensureConnection();assert.equal(await page.locator('#text-editor').inputValue(),text);});
  await record('Android Back offers continue editing and discard without writing',async()=>{const old=await hash('qa-edit.hwpx');await backPrompt();await click('close');assert(await page.locator('#text-editor').isVisible());await backPrompt();await click('exit-discard');await page.locator('#search').waitFor();assert.equal(await hash('qa-edit.hwpx'),old);});
  await record('permission revocation preserves the source, including OS-forced termination',async()=>{
   await open('qa-edit.hwpx');await edit();await changed((await page.locator('#text-editor').inputValue())+' DENIED');const old=await hash('qa-edit.hwpx');
   sh('appops','set','--uid',pkg,'MANAGE_EXTERNAL_STORAGE','deny');await pause(500);
   if(page.isClosed()||!appAlive()){
    permissionRevocation=appAlive()?'WebView unavailable; app process alive':'Android terminated the app';assert.equal(await hash('qa-edit.hwpx'),old);await start();await a('allow').waitFor();await regrantAndRestart();
   }else{
    permissionRevocation='In-app denial';await click('save');await click('save-yes');await page.locator('#sheet-title').filter({hasText:'작업을 완료하지 못했어요'}).waitFor();assert.equal(await hash('qa-edit.hwpx'),old);await click('close');assert(await a('save').isEnabled());sh('appops','set','--uid',pkg,'MANAGE_EXTERNAL_STORAGE','allow');await library();
   }
  });
  await record('revoking permission during an upload still permits abort and immediate retry',async()=>{
   await page.locator('#search').fill('qa-edit.hwpx');const id=await a('open').first().getAttribute('data-id'),before=await hash('qa-edit.hwpx');
   const source=await nativeCall('read',{id});await nativeCall('release',{token:source.token});const args={id,target:source.meta.path,sha:source.sha,length:source.meta.size,replace:true,backup:false};
   const token=await nativeCall('beginSave',args);await nativeCall('saveChunk',{token,seq:0,base64:'UEsDBAoA'});sh('appops','set','--uid',pkg,'MANAGE_EXTERNAL_STORAGE','deny');await pause(500);if(page.isClosed()||!appAlive()){await regrantAndRestart();}else{await nativeCall('abortSave',{token});sh('appops','set','--uid',pkg,'MANAGE_EXTERNAL_STORAGE','allow');}
   const retry=await nativeCall('beginSave',args);await nativeCall('abortSave',{token:retry});assert.equal(await hash('qa-edit.hwpx'),before);
  });
  await record('external modification is never overwritten by stale save',async()=>{
   await open('qa-edit.hwpx');await edit();await changed((await page.locator('#text-editor').inputValue())+' CONFLICT');
   adb('push','tests/fixtures/blank.hwpx',`${dir}/qa-edit.hwpx`);const external=await hash('qa-edit.hwpx');await click('save');await click('save-yes');await page.getByText(/다른 앱에서 문서가 바뀌었어요/).waitFor();assert.equal(await hash('qa-edit.hwpx'),external);await click('close');await library();
  });
  await record('rename rejects invalid names and collisions without losing files',async()=>{
   await page.locator('#search').fill('duplicate');await a('open').first().click({button:'right'});await click('rename');await page.locator('#rename').fill('../bad');await click('rename-confirm');assert(await page.locator('#operation-error').innerText());await page.locator('#rename').fill('qa-edit');await click('rename-confirm');await page.locator('#operation-error').filter({hasText:/같은 이름/}).waitFor();assert(sh('ls',dir).includes('duplicate.hwpx'));await click('close');
  });
  await record('font scale and small DeX-like window retain controls',async()=>{
   sh('settings','put','system','font_scale','1.5');await open('qa-table.hwpx');await edit();assert(await a('save-as').isVisible());sh('wm','size','700x500');await pause(1000);assert(await a('save-as').isVisible());assert(await page.locator('#text-editor').isVisible());await click('save-as');await page.locator('#filename').waitFor();await click('close');assert(await page.locator('#text-editor').isVisible());sh('wm','size','1920x1080');sh('settings','put','system','font_scale','1.0');await pause(700);await library();
  });
  await record('large system font: the editor text keeps the size and alignment it has at normal font size (WebView text zoom)',async()=>{
   // Hypothesis H4 of the review: WebView text zoom scales the px font of the overlay textarea so it no longer matches the rendered page.
   // The page measures a 100px probe and divides the overlay by that factor; the visual size of the overlay text must not depend on the font scale.
   const visual=()=>page.locator('#text-editor').evaluate(t=>{const probe=css=>{const p=document.createElement('div');p.style.cssText='position:absolute;visibility:hidden;left:-9999px;display:inline-block;margin:0;padding:0;border:0;white-space:nowrap;'+css;p.textContent='M';document.body.appendChild(p);const h=p.getBoundingClientRect().height;p.remove();return h;};
    return {fontPx:parseFloat(t.style.fontSize),lineCss:t.style.lineHeight,font:probe(`font:${t.style.fontSize}/1 sans-serif`),line:probe(`font:10px/${t.style.lineHeight} sans-serif`),probe100:probe('font:100px/1 sans-serif'),probeLine100:probe('font:100px/100px sans-serif')};});
   const measure=async scale=>{sh('settings','put','system','font_scale',scale);await pause(1200);await ensureConnection();await open('qa-table.hwpx');await edit();const m=await visual();await library();return m;};
   const normal=await measure('1.0'),large=await measure('1.5');textZoomProbe={normal,large};console.log('TEXT_ZOOM_PROBE',JSON.stringify(textZoomProbe));
   assert(Math.abs(normal.probe100-100)<=2&&Math.abs(normal.probeLine100-100)<=2,'normal font scale: no text zoom');
   assert(Math.abs(large.font-normal.font)/normal.font<=.06,`the overlay font is ${large.font}px at 1.5x but ${normal.font}px at 1.0x`);
   assert(Math.abs(large.line-normal.line)/normal.line<=.06,`the overlay line height is ${large.line} at 1.5x but ${normal.line} at 1.0x`);
   sh('settings','put','system','font_scale','1.0');await pause(700);
  });
  await record('mouse drag over two paragraphs: Delete, undo, typing over the range and no disk write before Save',async()=>{
   const name='qa-range.hwpx',original=await hash(name);await open(name);await click('edit');
   const box=await page.locator('.page').first().boundingBox(),k=box.width/793.7,pt=(x,y)=>[box.x+x*k,box.y+y*k];
   await page.mouse.click(...pt(120,135));await page.locator('#text-editor').waitFor();
   await page.mouse.move(...pt(120,135));await page.mouse.down();await page.mouse.move(...pt(160,150),{steps:4});await page.mouse.move(...pt(200,160),{steps:6});await page.mouse.up();
   await page.locator('#range-editor').waitFor();const joined=await page.locator('#range-editor').inputValue();assert(joined.includes('\n'));assert((await page.locator('.sel-mark').count())>=2);
   await page.keyboard.press('Delete');await page.locator('#text-editor').waitFor();await until(()=>a('save').isEnabled());assert(!(await page.locator('#text-editor').inputValue()).includes('한글 문서 실'));
   await page.keyboard.press('Control+z');await page.locator('#range-editor').waitFor();assert.equal(await page.locator('#range-editor').inputValue(),joined);
   await page.keyboard.press('Control+b');await until(async()=>(await a('tb-bold').getAttribute('aria-pressed'))==='true');
   await page.keyboard.insertText('범위 교체');await until(async()=>(await page.locator('#text-editor').inputValue()).startsWith('범위 교체'));
   assert.equal(await hash(name),original);await library();assert.equal(await hash(name),original);
  });
  await record('table cells are filled from spreadsheet text and undo restores them',async()=>{
   await open('qa-table.hwpx');await click('edit');const box=await page.locator('.page').first().boundingBox(),k=box.width/793.7,cell=async(x,y)=>{await page.mouse.click(box.x+x*k,box.y+y*k);await page.locator('#text-editor').waitFor();await pause(300);return page.locator('#text-editor').inputValue();};
   await cell(130,140);await click('tb-table');await page.locator('#grid-paste').fill('가\t나\n다\t라');await click('tb-grid-paste');await pause(800);assert(await page.locator('#overlay').isHidden());
   assert.equal(await cell(130,140),'가');assert.equal(await cell(420,158),'라');await click('tb-undo');await pause(600);assert.equal(await cell(130,140),'표 셀 시험');await library();
  });
  await record('encrypted document exports a PDF from the library only after the password is entered',async()=>{
   await page.locator('#search').fill('qa-locked.hwpx');await a('open').first().click({button:'right'});await click('pdf');await page.locator('#filename').fill('qa-locked-out');await click('folder-confirm');
   await page.locator('#doc-password').waitFor();assert(/암호가 걸리지 않아요/.test(await page.locator('#sheet').innerText()));
   await page.locator('#doc-password').fill('wrong');await click('pdf-pw-go');await page.getByText('암호가 맞지 않아요. 다시 입력해 주세요.').waitFor();assert(!sh('ls',dir).includes('qa-locked-out.pdf'));
   await page.locator('#doc-password').fill('qa-only-2026');await click('pdf-pw-go');await closed();assert(sh('head','-c','5',`${dir}/qa-locked-out.pdf`).startsWith('%PDF-'));await page.locator('#search').fill('');
  });
  await record('saved documents persist after process death; the unsaved edit is recovered from the private draft, never from the original',async()=>{
   await open('duplicate.hwpx');await edit();await changed((await page.locator('#text-editor').inputValue())+' SAVED');await save();const disk=await hash('duplicate.hwpx');
   await changed((await page.locator('#text-editor').inputValue())+' UNSAVED');
   // The draft is written a few seconds after the edit; wait for the app's own record of it before the process is killed.
   await until(async()=>(await nativeCall('listDrafts')).some(d=>d.name==='duplicate.hwpx'),30000);
   sh('am','force-stop',pkg);assert.equal(await hash('duplicate.hwpx'),disk,'the document on disk is exactly the last saved state');
   await start('keep');
   await page.locator('#sheet-title').filter({hasText:'저장하지 못한 편집 내용'}).waitFor({timeout:20000});await page.locator('.draft-row').filter({hasText:'duplicate.hwpx'}).locator('[data-action="draft-open"]').click();
   await page.locator('.reader.is-editing').waitFor();{const p=page.locator('.page').first(),b=await p.boundingBox();await p.click({position:{x:b.width*120/794,y:b.width*135/794}});}await page.locator('#text-editor').waitFor();
   const recovered=await page.locator('#text-editor').inputValue();assert(recovered.includes('SAVED')&&recovered.includes('UNSAVED'),recovered);assert.equal(await hash('duplicate.hwpx'),disk);
   await click('save-as');await page.locator('#filename').fill('qa-recovered');await click('folder-confirm');await closed();assert(sh('ls',dir).includes('qa-recovered.hwpx'));assert.equal(await hash('duplicate.hwpx'),disk,'recovery never overwrites the original');
   assert.equal((await nativeCall('listDrafts')).filter(d=>d.name==='duplicate.hwpx').length,0,'the draft is removed once its copy is saved');
   await library();await page.locator('#search').fill('qa-edit.hwpx');assert.equal(await page.getByRole('button',{name:'qa-edit.hwpx 즐겨찾기 해제',exact:true}).getAttribute('aria-pressed'),'true');assert.equal(await page.locator('#hwp-app').getAttribute('data-theme'),'dark');
   await open('duplicate.hwpx');await edit();assert((await page.locator('#text-editor').inputValue()).includes('SAVED'));assert(!(await page.locator('#text-editor').inputValue()).includes('UNSAVED'));await library();
  });
  await record('continuous typing without a 4 s pause leaves a recoverable draft within the maximum wait; the original stays byte-identical',async()=>{
   // One keystroke per second for as long as it takes: the pause-only debounce (4 s) can never fire here, only the 30 s maximum wait can.
   await open('duplicate.hwpx');await edit();const disk=await hash('duplicate.hwpx');const base=await page.locator('#text-editor').inputValue();
   const has=async()=>(await nativeCall('listDrafts')).some(d=>d.name==='duplicate.hwpx');assert.equal(await has(),false,'no draft before the edit');
   const began=Date.now();let typed=0,draftAt=null,snapshotTyped=0,longestGap=0,last=began,earlyChecked=false;
   while(Date.now()-began<80000){
    await page.keyboard.insertText('가');typed++;const now=Date.now();longestGap=Math.max(longestGap,now-last);last=now;
    if(!earlyChecked&&now-began>15000){earlyChecked=true;assert.equal(await has(),false,'still no draft after 15 s of continuous typing: the maximum wait, not a pause, writes it');}
    if(draftAt===null&&await has()){draftAt=Date.now()-began;snapshotTyped=typed;}
    if(draftAt!==null&&typed>=snapshotTyped+3)break;
    await pause(800);
   }
   assert(longestGap<3500,'typing never paused for 4 s: '+longestGap);assert.notEqual(draftAt,null,'a draft was written during continuous typing');assert(draftAt>=28000&&draftAt<=70000,'draft after '+draftAt+' ms (maximum wait 30 s)');
   console.log('DRAFT_CONTINUOUS',JSON.stringify({typed,snapshotTyped,draftAtMs:draftAt,longestGapMs:longestGap}));
   sh('am','force-stop',pkg);assert.equal(await hash('duplicate.hwpx'),disk,'the document on disk is exactly the last saved state');
   await start('keep');
   await page.locator('#sheet-title').filter({hasText:'저장하지 못한 편집 내용'}).waitFor({timeout:20000});await page.locator('.draft-row').filter({hasText:'duplicate.hwpx'}).locator('[data-action="draft-open"]').click();
   await page.locator('.reader.is-editing').waitFor();{const p=page.locator('.page').first(),b=await p.boundingBox();await p.click({position:{x:b.width*120/794,y:b.width*135/794}});}await page.locator('#text-editor').waitFor();
   const recovered=await page.locator('#text-editor').inputValue(),got=recovered.split('가').length-base.split('가').length;
   // The draft is the last successful snapshot: what was typed up to it, not the tail typed after it.
   assert(got>=snapshotTyped-2&&got<=typed,`recovered ${got} of ${typed} typed characters (snapshot taken after about ${snapshotTyped})`);assert.equal(await hash('duplicate.hwpx'),disk);
   await click('save-as');await page.locator('#filename').fill('qa-continuous');await click('folder-confirm');await closed();assert.equal(await hash('duplicate.hwpx'),disk,'recovery never overwrites the original');
   assert.equal((await nativeCall('listDrafts')).filter(d=>d.name==='duplicate.hwpx').length,0);await library();
  });
  const crash=adb('logcat','-d','-b','crash');fs.writeFileSync(`${qa}/crash.txt`,crash);assert(!crash.includes(pkg),crash);assert.deepEqual(errors,[]);
 }catch(e){checks.push({name:e.scenario||'infrastructure failure',passed:false,error:e.stack});console.error(e);if(page)console.error('APP_DIAGNOSTIC',await page.evaluate(()=>({url:location.href,text:document.body.innerText.slice(0,5000),announce:document.querySelector('#announce')?.textContent,ua:navigator.userAgent,layout:['#content','.reader','.reader-scroll','#pages','.page','.page img'].map(s=>{const e=document.querySelector(s);if(!e)return {selector:s,missing:true};const r=e.getBoundingClientRect(),c=getComputedStyle(e);return {selector:s,x:r.x,y:r.y,width:r.width,height:r.height,display:c.display,visibility:c.visibility,inline:e.getAttribute('style')};})})).catch(()=>({closed:true})));console.error('CRASH_DIAGNOSTIC',adb('logcat','-d','-b','crash'));console.error('WEBVIEW_DIAGNOSTIC',adb('logcat','-d','-t','500').split('\n').filter(l=>/FATAL|signal [0-9]|RenderProcessGone|renderer process|Killing.*offline|chromium.* E /i.test(l)).slice(-25).join('\n'));console.error('ANDROID_FOREGROUND',sh('dumpsys','activity','activities').split('\n').filter(l=>/ResumedActivity/.test(l)).join(' '));(()=>{try{screenshot(`${qa}/failure.png`);}catch{}})();if(page)fs.writeFileSync(`${qa}/page.html`,await page.content().catch(()=>''));process.exitCode=1;}
 finally{try{anrGuard=anrFinish([pkg]);}catch(e){anrGuard={error:e.message};checks.push({name:'ANR guard: no app/unknown ANR or crash dialog during the suite',passed:false,error:e.message});process.exitCode=1;console.error(e.message);}
  console.log('QA_SUMMARY',JSON.stringify({uiUnderTest:'legacy-fallback (debug legacyUiForTests); not the default shared Studio',api:process.env.ANDROID_API,anrGuard:anrGuard.error?anrGuard.error:{systemRecoveries:anrGuard.systemRecoveries,systemAnrInLogs:anrGuard.systemAnrInLogs,failures:anrGuard.failures},recoveryOffersDismissed,permissionGrant,permissionRevocation,backInputDismissals,passed:checks.filter(c=>c.passed).length,failed:checks.filter(c=>!c.passed).length,pageErrors:errors}));fs.writeFileSync(`${qa}/results.json`,JSON.stringify({api:process.env.ANDROID_API,anrGuard,recoveryOffersDismissed,checks,permissionGrant,permissionRevocation,backInputDismissals,pageErrors:errors,textZoomProbe,webview:sh('dumpsys','webviewupdate'),memory:sh('dumpsys','meminfo',pkg),limitations:['AOSP emulator: not Samsung DeX firmware or Bluetooth pairing','Force-stopping discards unsaved in-memory edits; saved original remains intact']},null,2));fs.writeFileSync(`${qa}/logcat.txt`,adb('logcat','-d','-t','1500'));await disconnect();process.exit(process.exitCode||0);}
})();
