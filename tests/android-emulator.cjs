// Installed APK + real Android WebView / OfflineNative / filesystem. No bridge mocks.
const { _android:android }=require('playwright');
const {execFileSync}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const pkg='kr.offline.hwp.preview',dir='/sdcard/Download/hwpxxx-qa',qa='.qa/android-'+process.env.ANDROID_API;
fs.mkdirSync(qa,{recursive:true});
const adb=(...args)=>execFileSync('adb',args,{encoding:'utf8',timeout:60000}).trim();
const sh=(...args)=>adb('shell',...args);
const checks=[],errors=[];let permissionGrant='settings-switch',permissionRevocation='not-run';let page,device;
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,ms=20000){const end=Date.now()+ms;let err;while(Date.now()<end){try{const r=await fn();if(r)return r;}catch(e){err=e;}await pause(200);}throw err||new Error('Condition timed out');}
async function record(name,fn){const started=Date.now();try{await fn();}catch(e){e.scenario=name;throw e;}checks.push({name,passed:true,durationMs:Date.now()-started});console.log('PASS',name);await device.screenshot({path:`${qa}/${String(checks.length).padStart(2,'0')}.png`});}
async function connect(){
 for(let attempt=0;attempt<3;attempt++)try{page=await(await device.webView({pkg},{timeout:60000})).page();page.setDefaultTimeout(20000);page.on('pageerror',e=>{errors.push(e.message);console.error('WEBVIEW_ERROR',e.message);});await page.locator('#content').waitFor();return;}catch(e){if(!/closed/.test(e.message)||!appAlive()||attempt===2)throw e;console.log('CDP_ATTACH_RETRY',attempt+1);await Promise.race([device.close(),pause(5000)]);device=(await android.devices())[0];await pause(500);}
}
async function start(){sh('am','start','-W','-n',`${pkg}/kr.offline.hwp.MainActivity`);await connect();}
function foreground(){return sh('dumpsys','activity','activities').split('\n').filter(l=>/ResumedActivity/.test(l)).join(' ');}
async function settingsVisible(){await until(()=>foreground().includes('AppManageExternalStorageActivity'));await until(()=>sh('dumpsys','window').split('\n').some(l=>l.includes('mCurrentFocus')&&l.includes('AppManageExternalStorageActivity')));await pause(700);}
async function appVisible(){await until(()=>foreground().includes(pkg+'/kr.offline.hwp.MainActivity'));await until(()=>sh('dumpsys','window').split('\n').some(l=>l.includes('mCurrentFocus')&&l.includes(pkg)));}
async function returnFromSettings(){for(let i=0;i<3;i++){if(foreground().includes(pkg+'/kr.offline.hwp.MainActivity'))break;sh('input','keyevent','4');await pause(1000);}await appVisible();}
function appAlive(){try{return !!sh('pidof',pkg);}catch{return false;}}
async function regrantAndRestart(){sh('am','force-stop',pkg);sh('appops','set','--uid',pkg,'MANAGE_EXTERNAL_STORAGE','allow');await start();await a('open').first().waitFor();}
const a=name=>page.locator(`[data-action="${name}"]`);
async function click(name){await a(name).click();}
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
  const devices=await android.devices();assert(devices.length);device=devices[0];device.setDefaultTimeout(30000);
  sh('wm','size','2560x1600');sh('wm','density','320');
  sh('settings','put','secure','show_ime_with_hard_keyboard','0');await rotate(0);
  adb('install','-r','app/build/outputs/apk/debug/app-debug.apk');sh('pm','clear',pkg);sh('svc','wifi','disable');sh('svc','data','disable');
  sh('mkdir','-p',dir);for(const [src,dest] of [['문서.hwpx','qa-edit.hwpx'],['문서.hwp','qa-edit.hwp'],['table.hwpx','qa-table.hwpx'],['문서.hwpx','duplicate.hwpx']])adb('push',`tests/fixtures/${src}`,`${dir}/${dest}`);
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
   await open('qa-long.hwpx');assert(await page.locator('.page').count()>5);await edit();await page.keyboard.press('PageDown');await page.keyboard.press('Control+End');const value=await page.locator('#text-editor').inputValue();assert(value.length>0);await page.keyboard.press('Control+Home');assert((await page.locator('#text-editor').inputValue()).startsWith('1.'));await library();
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
  await record('Android input dispatcher types through the installed WebView',async()=>{await page.locator('#text-editor').click();sh('input','text','DEX_OS_KEYS');await until(async()=>(await page.locator('#text-editor').inputValue()).includes('DEX_OS_KEYS'));});
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
  await record('Home/background/resume preserves unsaved text',async()=>{const text=await page.locator('#text-editor').inputValue();sh('input','keyevent','3');await pause(500);sh('am','start','-W','-n',`${pkg}/kr.offline.hwp.MainActivity`);assert.equal(await page.locator('#text-editor').inputValue(),text);});
  await record('Android Back offers continue editing and discard without writing',async()=>{const old=await hash('qa-edit.hwpx');sh('input','keyevent','4');await a('exit-discard').waitFor();await click('close');assert(await page.locator('#text-editor').isVisible());sh('input','keyevent','4');await click('exit-discard');await page.locator('#search').waitFor();assert.equal(await hash('qa-edit.hwpx'),old);});
  await record('permission revocation preserves the source, including OS-forced termination',async()=>{
   await open('qa-edit.hwpx');await edit();await changed((await page.locator('#text-editor').inputValue())+' DENIED');const old=await hash('qa-edit.hwpx');
   sh('appops','set','--uid',pkg,'MANAGE_EXTERNAL_STORAGE','deny');await pause(500);
   if(page.isClosed()||!appAlive()){
    permissionRevocation='Android terminated the app';assert.equal(await hash('qa-edit.hwpx'),old);await start();await a('allow').waitFor();await regrantAndRestart();
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
   sh('settings','put','system','font_scale','1.5');await open('qa-table.hwpx');await edit();assert(await a('save-as').isVisible());sh('wm','size','1400x1000');await pause(1000);assert(await a('save-as').isVisible());assert(await page.locator('#text-editor').isVisible());sh('wm','size','2560x1600');sh('settings','put','system','font_scale','1.0');await pause(700);await library();
  });
  await record('saved documents persist after process death; unsaved bytes never touch disk',async()=>{
   await open('duplicate.hwpx');await edit();await changed((await page.locator('#text-editor').inputValue())+' SAVED');await save();const disk=await hash('duplicate.hwpx');
   await changed((await page.locator('#text-editor').inputValue())+' UNSAVED');sh('am','force-stop',pkg);assert.equal(await hash('duplicate.hwpx'),disk);await start();await page.locator('#search').fill('qa-edit.hwpx');assert.equal(await page.getByRole('button',{name:'qa-edit.hwpx 즐겨찾기 해제',exact:true}).getAttribute('aria-pressed'),'true');assert.equal(await page.locator('#hwp-app').getAttribute('data-theme'),'dark');await open('duplicate.hwpx');await edit();assert((await page.locator('#text-editor').inputValue()).includes('SAVED'));assert(!(await page.locator('#text-editor').inputValue()).includes('UNSAVED'));await library();
  });
  const crash=adb('logcat','-d','-b','crash');fs.writeFileSync(`${qa}/crash.txt`,crash);assert(!crash.includes(pkg),crash);assert.deepEqual(errors,[]);
 }catch(e){checks.push({name:e.scenario||'infrastructure failure',passed:false,error:e.stack});console.error(e);if(page)console.error('APP_DIAGNOSTIC',await page.evaluate(()=>({url:location.href,text:document.body.innerText.slice(0,5000),announce:document.querySelector('#announce')?.textContent})).catch(()=>({closed:true})));console.error('CRASH_DIAGNOSTIC',adb('logcat','-d','-b','crash'));console.error('WEBVIEW_DIAGNOSTIC',adb('logcat','-d','-t','500').split('\n').filter(l=>/FATAL|signal [0-9]|RenderProcessGone|renderer process|Killing.*offline|chromium.* E /i.test(l)).slice(-25).join('\n'));console.error('ANDROID_FOREGROUND',sh('dumpsys','activity','activities').split('\n').filter(l=>/ResumedActivity/.test(l)).join(' '));if(device)await device.screenshot({path:`${qa}/failure.png`}).catch(()=>{});if(page)fs.writeFileSync(`${qa}/page.html`,await page.content().catch(()=>''));process.exitCode=1;}
 finally{console.log('QA_SUMMARY',JSON.stringify({api:process.env.ANDROID_API,permissionGrant,permissionRevocation,passed:checks.filter(c=>c.passed).length,failed:checks.filter(c=>!c.passed).length,pageErrors:errors}));fs.writeFileSync(`${qa}/results.json`,JSON.stringify({api:process.env.ANDROID_API,checks,permissionGrant,permissionRevocation,pageErrors:errors,webview:sh('dumpsys','webviewupdate'),memory:sh('dumpsys','meminfo',pkg),limitations:['AOSP emulator: not Samsung DeX firmware or Bluetooth pairing','Force-stopping discards unsaved in-memory edits; saved original remains intact']},null,2));fs.writeFileSync(`${qa}/logcat.txt`,adb('logcat','-d','-t','1500'));if(device)await Promise.race([device.close(),pause(5000)]);process.exit(process.exitCode||0);}
})();
