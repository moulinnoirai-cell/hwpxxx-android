// Installed APK + real Android WebView / OfflineNative / filesystem. No bridge mocks.
const { _android:android }=require('playwright');
const {execFileSync}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const pkg='kr.offline.hwp.preview',dir='/sdcard/Download/hwpxxx-qa',qa='.qa/android-'+process.env.ANDROID_API;
fs.mkdirSync(qa,{recursive:true});
const adb=(...args)=>execFileSync('adb',args,{encoding:'utf8',timeout:60000}).trim();
const sh=(...args)=>adb('shell',...args);
const checks=[],errors=[];let page,device;
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,ms=20000){const end=Date.now()+ms;let err;while(Date.now()<end){try{const r=await fn();if(r)return r;}catch(e){err=e;}await pause(200);}throw err||new Error('Condition timed out');}
async function record(name,fn){await fn();checks.push({name,passed:true});console.log('PASS',name);await device.screenshot({path:`${qa}/${String(checks.length).padStart(2,'0')}.png`});}
async function connect(){page=await(await device.webView({pkg},{timeout:60000})).page();page.setDefaultTimeout(20000);page.on('pageerror',e=>errors.push(e.message));await page.locator('#content').waitFor();}
async function start(){sh('am','start','-W','-n',`${pkg}/kr.offline.hwp.MainActivity`);await connect();}
const a=name=>page.locator(`[data-action="${name}"]`);
async function click(name){await a(name).click();}
async function closed(){await page.locator('#overlay').waitFor({state:'hidden'});}
async function library(){
 if(await a('cancel-edit').isVisible()){await click('cancel-edit');if(await a('cancel-yes').isVisible())await click('cancel-yes');}
 if(await a('back').isVisible())await click('back');
 await page.locator('#search').waitFor();
}
async function open(name){await page.locator('#search').fill(name);await page.getByRole('button',{name:`${name} 열기`,exact:true}).click();await page.locator('.page img').first().waitFor();}
async function edit(){await click('edit');const p=page.locator('.page').first(),b=await p.boundingBox();await p.click({position:{x:b.width*120/794,y:b.width*135/794}});await page.locator('#text-editor').waitFor();}
async function changed(text){const t=page.locator('#text-editor');await t.fill(text);await until(()=>a('save').isEnabled());}
async function save(){await click('save');await click('save-yes');await until(async()=>await page.locator('#overlay').isHidden()||await a('close').isVisible());if(await a('close').isVisible())await click('close');await closed();assert(await a('save').isDisabled());}
async function hash(name){return sh('sha256sum',`${dir}/${name}`).split(/\s/)[0];}
async function rotate(n){sh('settings','put','system','accelerometer_rotation','0');sh('settings','put','system','user_rotation',String(n));await pause(1000);}
(async()=>{
 try{
  const devices=await android.devices();assert(devices.length);device=devices[0];device.setDefaultTimeout(30000);
  sh('wm','size','2560x1600');sh('wm','density','320');
  sh('settings','put','secure','show_ime_with_hard_keyboard','0');await rotate(0);
  adb('install','-r','app/build/outputs/apk/debug/app-debug.apk');sh('pm','clear',pkg);sh('svc','wifi','disable');sh('svc','data','disable');
  sh('mkdir','-p',dir);for(const [src,dest] of [['문서.hwpx','qa-edit.hwpx'],['문서.hwp','qa-edit.hwp'],['table.hwpx','qa-table.hwpx'],['문서.hwpx','duplicate.hwpx']])adb('push',`tests/fixtures/${src}`,`${dir}/${dest}`);
  fs.writeFileSync(`${qa}/corrupt.hwpx`,'not a ZIP or HWP document');adb('push',`${qa}/corrupt.hwpx`,`${dir}/qa-corrupt.hwpx`);
  await start();
  await record('fresh install: access denied shows onboarding, not files',async()=>{await a('allow').waitFor();assert.equal(await a('open').count(),0);});
  await record('permission settings can be cancelled and revisited',async()=>{await click('allow');await pause(700);sh('input','keyevent','4');await a('allow').waitFor();});
  await record('grant all-files access through Android settings',async()=>{
   await click('allow');await pause(800);sh('uiautomator','dump','/sdcard/window.xml');const xml=sh('cat','/sdcard/window.xml');
   const nodes=xml.match(/<node\b[^>]*>/g)||[];const sw=nodes.find(n=>/class="android.widget.Switch"|resource-id="[^"]*switch_widget"/.test(n));assert(sw,'Permission switch missing: '+xml);
   const b=sw.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);assert(b);sh('input','tap',String((+b[1]+ +b[3])/2|0),String((+b[2]+ +b[4])/2|0));sh('input','keyevent','4');await until(()=>a('open').count());
  });
  await record('offline corrupt file error returns to a usable library',async()=>{await page.locator('#search').fill('qa-corrupt');await a('open').first().click();await page.locator('#sheet-title').filter({hasText:'작업을 완료하지 못했어요'}).waitFor();await click('close');await page.locator('#search').fill('');});
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
  await open('qa-edit.hwpx');await edit();
  await record('DeX: clicking text never zooms; Ctrl+wheel zooms only document',async()=>{
   const before=await page.locator('#pages').evaluate(e=>parseFloat(e.style.width));await page.locator('#text-editor').click();assert.equal(await page.locator('#pages').evaluate(e=>parseFloat(e.style.width)),before);
   const p=await page.locator('.page').first().boundingBox();await page.mouse.move(p.x+200,p.y+150);await page.keyboard.down('Control');await page.mouse.wheel(0,-120);await page.keyboard.up('Control');
   await until(async()=>await page.locator('#pages').evaluate(e=>parseFloat(e.style.width))>before);assert.equal(await page.evaluate(()=>visualViewport.scale),1);
   await page.keyboard.press('Control+0');assert.equal(await page.locator('#pages').evaluate(e=>parseFloat(e.style.width)),100);
   await page.keyboard.press('Control+-');assert(await page.locator('#pages').evaluate(e=>parseFloat(e.style.width))<100);await page.keyboard.press('Control+0');
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
  await record('permission revoked during editing refuses save and preserves source',async()=>{
   await open('qa-edit.hwpx');await edit();await changed((await page.locator('#text-editor').inputValue())+' DENIED');const old=await hash('qa-edit.hwpx');
   sh('appops','set',pkg,'MANAGE_EXTERNAL_STORAGE','deny');await click('save');await click('save-yes');await page.locator('#sheet-title').filter({hasText:'작업을 완료하지 못했어요'}).waitFor();assert.equal(await hash('qa-edit.hwpx'),old);await click('close');assert(await a('save').isEnabled());
   sh('appops','set',pkg,'MANAGE_EXTERNAL_STORAGE','allow');await library();
  });
  await record('external modification is never overwritten by stale save',async()=>{
   await open('qa-edit.hwpx');await edit();await changed((await page.locator('#text-editor').inputValue())+' CONFLICT');
   adb('push','tests/fixtures/blank.hwpx',`${dir}/qa-edit.hwpx`);const external=await hash('qa-edit.hwpx');await click('save');await click('save-yes');await page.getByText(/다른 앱에서 문서가 바뀌었어요/).waitFor();assert.equal(await hash('qa-edit.hwpx'),external);await click('close');await library();
  });
  await record('rename rejects invalid names and collisions without losing files',async()=>{
   await page.locator('#search').fill('duplicate');await a('open').first().click({button:'right'});await click('rename');await page.locator('#rename').fill('../bad');await click('rename-confirm');assert(await page.locator('#operation-error').innerText());await page.locator('#rename').fill('qa-edit');await click('rename-confirm');await until(async()=>!!(await page.locator('#operation-error').innerText()));assert(sh('ls',dir).includes('duplicate.hwpx'));await click('close');
  });
  await record('font scale and small DeX-like window retain controls',async()=>{
   sh('settings','put','system','font_scale','1.5');await open('qa-table.hwpx');await edit();assert(await a('save-as').isVisible());sh('wm','size','1400x1000');await pause(1000);assert(await a('save-as').isVisible());assert(await page.locator('#text-editor').isVisible());sh('wm','size','2560x1600');sh('settings','put','system','font_scale','1.0');await pause(700);await library();
  });
  await record('saved documents persist after process death; unsaved bytes never touch disk',async()=>{
   await open('duplicate.hwpx');await edit();await changed((await page.locator('#text-editor').inputValue())+' SAVED');await save();const disk=await hash('duplicate.hwpx');
   await changed((await page.locator('#text-editor').inputValue())+' UNSAVED');sh('am','force-stop',pkg);assert.equal(await hash('duplicate.hwpx'),disk);await start();await open('duplicate.hwpx');await edit();assert((await page.locator('#text-editor').inputValue()).includes('SAVED'));assert(!(await page.locator('#text-editor').inputValue()).includes('UNSAVED'));await library();
  });
  const crash=adb('logcat','-d','-b','crash');fs.writeFileSync(`${qa}/crash.txt`,crash);assert(!crash.includes(pkg),crash);assert.deepEqual(errors,[]);
 }catch(e){checks.push({name:'failure',passed:false,error:e.stack});console.error(e);if(device)await device.screenshot({path:`${qa}/failure.png`}).catch(()=>{});if(page)fs.writeFileSync(`${qa}/page.html`,await page.content().catch(()=>''));process.exitCode=1;}
 finally{fs.writeFileSync(`${qa}/results.json`,JSON.stringify({api:process.env.ANDROID_API,checks,pageErrors:errors,limitations:['AOSP emulator: not Samsung DeX firmware or Bluetooth pairing','Force-stopping discards unsaved in-memory edits; saved original remains intact']},null,2));fs.writeFileSync(`${qa}/logcat.txt`,adb('logcat','-d','-t','1500'));if(device)await device.close();}
})();
