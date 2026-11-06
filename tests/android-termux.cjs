// Real official Termux APK + system DocumentsUI + installed hwpxxx APK. No provider mocks.
const {_android:android}=require('playwright');
const {execFileSync}=require('node:child_process');
const fs=require('node:fs'),assert=require('node:assert/strict');
const pkg='kr.offline.hwp.preview',home='/data/data/com.termux/files/home',project=home+'/hwpxxx-project',qa='.qa/android-termux-'+process.env.ANDROID_API;
fs.mkdirSync(qa,{recursive:true});let page,device,lastXml='';const checks=[],errors=[];
const adb=(...args)=>execFileSync('adb',args,{encoding:'utf8',timeout:45000}).trim();
const sh=(...args)=>adb('shell',...args),pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,ms=30000){const end=Date.now()+ms;let error;while(Date.now()<end){try{const r=await fn();if(r)return r;}catch(e){error=e;}await pause(300);}throw error||new Error('Condition timed out');}
const a=name=>page.locator(`[data-action="${name}"]`),click=async name=>a(name).click();
async function check(name,fn){try{await fn();checks.push({name,passed:true});console.log('PASS TERMUX',name);await device.screenshot({path:`${qa}/${checks.length}.png`});}catch(e){e.scenario=name;throw e;}}
function foreground(){return sh('dumpsys','activity','activities').split('\n').filter(l=>/ResumedActivity/.test(l)).join(' ');}
async function connect(){for(let attempt=0;attempt<3;attempt++)try{page=await(await device.webView({pkg},{timeout:60000})).page();page.setDefaultTimeout(25000);page.on('pageerror',e=>errors.push(e.message));await page.locator('#search').waitFor();return;}catch(e){if(!/closed/.test(e.message)||attempt===2)throw e;console.log('TERMUX_CDP_ATTACH_RETRY',attempt+1);await Promise.race([device.close(),pause(5000)]);device=(await android.devices())[0];await pause(500);}}
async function start(){sh('am','start','-W','-n',`${pkg}/kr.offline.hwp.MainActivity`);await connect();}
async function restart(){sh('am','force-stop',pkg);await start();}
function privateHash(){return sh('run-as','com.termux','sha256sum',project+'/nested/termux-nested.hwpx').split(/\s/)[0];}
function privateWrite(name,src){execFileSync('adb',['exec-out','run-as','com.termux','sh','-c',`'cat > ${name}'`],{input:fs.readFileSync(src),timeout:45000});}
function uiNodes(){sh('rm','-f','/sdcard/termux-ui.xml');sh('uiautomator','dump','--compressed','/sdcard/termux-ui.xml');lastXml=sh('cat','/sdcard/termux-ui.xml');return lastXml.match(/<node\b[^>]*>/g)||[];}
function uiMatch(nodes,regex){return nodes.find(n=>regex.test(n)&&!/enabled="false"/.test(n));}
function tapNode(n){const b=n.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);assert(b,n);sh('input','tap',String((+b[1]+ +b[3])/2|0),String((+b[2]+ +b[4])/2|0));}
async function uiTap(regex){await until(()=>{const n=uiMatch(uiNodes(),regex);if(!n)return false;tapNode(n);return true;});await pause(400);}
async function picker(){await click('settings');await click('connect-folder');await until(()=>foreground().includes('documentsui'));await until(()=>sh('dumpsys','window').split('\n').some(l=>l.includes('mCurrentFocus')&&l.includes('documentsui')));await pause(500);}
async function chooseProject(){
 let nodes=await until(()=>{const n=uiNodes();return n.length?n:false;});
 if(!uiMatch(nodes,/text="hwpxxx-project"/)){
  const drawer=uiMatch(nodes,/content-desc="(?:Show roots|Open navigation drawer)"/);if(drawer){tapNode(drawer);await pause(400);}
  await uiTap(/text="Termux"/);
 }
 await uiTap(/text="hwpxxx-project"/);await uiTap(/text="(?:USE THIS FOLDER|Use this folder)"/i);await uiTap(/text="(?:ALLOW|Allow)"/i);
 await until(()=>foreground().includes(pkg+'/kr.offline.hwp.MainActivity'));await page.locator('#overlay').waitFor({state:'hidden'});await page.locator('#search').fill('termux-');await until(()=>a('open').count()===2);
}
async function open(name){await page.locator('#search').fill(name);await page.getByRole('button',{name:name+' 열기',exact:true}).click();await page.locator('.page img').first().waitFor();}
async function edit(){await click('edit');const p=page.locator('.page').first(),b=await p.boundingBox();await p.click({position:{x:b.width*120/794,y:b.width*135/794}});await page.locator('#text-editor').waitFor();}
async function library(){if(await a('cancel-edit').isVisible()){await click('cancel-edit');await until(async()=>await a('cancel-yes').isVisible()||await a('edit').isVisible());if(await a('cancel-yes').isVisible())await click('cancel-yes');await a('edit').waitFor();}if(await a('back').isVisible())await click('back');await page.locator('#search').waitFor();}
async function native(op,args={}){const r=await page.evaluate(({op,args})=>new Promise(resolve=>{const old=window.NativeReply,id=980000;window.NativeReply=(rid,r)=>{if(rid===id){window.NativeReply=old;resolve(r);}else old(rid,r);};OfflineNative.postMessage(JSON.stringify({id,op,args}));}),{op,args});return r;}
(async()=>{
 try{
  device=(await android.devices())[0];assert(device);device.setDefaultTimeout(30000);
  sh('wm','size','2560x1600');sh('wm','density','320');sh('settings','put','system','font_scale','1.0');sh('settings','put','secure','show_ime_with_hard_keyboard','0');
  adb('install','-r','.qa/termux.apk');
  sh('run-as','com.termux','mkdir','-p',project+'/nested',home+'/outside-project');
  privateWrite(project+'/nested/termux-nested.hwpx','tests/fixtures/문서.hwpx');privateWrite(project+'/termux-remove.hwp','tests/fixtures/문서.hwp');privateWrite(home+'/outside-project/outside-secret.hwpx','tests/fixtures/문서.hwpx');
  const original=privateHash();sh('pm','clear',pkg);sh('appops','set','--uid',pkg,'MANAGE_EXTERNAL_STORAGE','deny');sh('svc','wifi','disable');sh('svc','data','disable');await start();
  await check('private projects stay hidden before connection; system picker cancellation returns safely',async()=>{
   assert.equal(await a('open').count(),0);await picker();sh('input','keyevent','4');await until(()=>foreground().includes(pkg+'/kr.offline.hwp.MainActivity'));await click('close');assert.equal(await a('open').count(),0);
  });
  await check('system picker grants only selected Termux project; nested HWP/HWPX are searchable',async()=>{
   await picker();await chooseProject();assert.equal(await a('open').count(),2);await page.locator('#search').fill('outside-secret');assert.equal(await a('open').count(),0);await page.locator('#search').fill('termux-nested');assert.equal(await a('open').count(),1);
  });
  await check('persisted tree survives process death without all-files permission; private document renders offline',async()=>{
   await restart();await open('termux-nested.hwpx');await edit();assert((await page.locator('#text-editor').inputValue()).length>0);await page.locator('#text-editor').press('End');await page.keyboard.insertText(' PERMISSION_REQUIRED');await until(()=>a('save').isEnabled());await page.keyboard.press('Control+s');await page.getByText('파일 접근이 필요해요',{exact:true}).waitFor();await click('close');assert((await page.locator('#text-editor').inputValue()).includes('PERMISSION_REQUIRED'));assert.equal(privateHash(),original);await library();
  });
  await check('connecting the same project twice does not duplicate results',async()=>{await picker();await chooseProject();assert.equal(await a('open').count(),2);const status=await native('status');assert.equal(status.data.connectedFolders.length,1);});
  await check('deleted private document reports an error and preserves usable library',async()=>{
   sh('run-as','com.termux','rm',project+'/termux-remove.hwp');await page.locator('#search').fill('termux-remove.hwp');await a('open').click();await page.getByText('작업을 완료하지 못했어요',{exact:true}).waitFor();await click('close');assert(await page.locator('#search').isVisible());
  });
  await check('Ctrl+S saves an edited shared copy, preserving private original bytes',async()=>{
   sh('appops','set','--uid',pkg,'MANAGE_EXTERNAL_STORAGE','allow');await restart();await open('termux-nested.hwpx');await edit();const t=page.locator('#text-editor');await t.press('End');await page.keyboard.insertText(' Termux 복사본😀');await until(()=>a('save').isEnabled());await page.keyboard.press('Control+s');await page.locator('#filename').fill('termux-export');await click('folder-confirm');await page.locator('#overlay').waitFor({state:'hidden'});assert.equal(privateHash(),original);assert(sh('ls','/sdcard').includes('termux-export.hwpx'));await library();await open('termux-export.hwpx');await edit();assert((await page.locator('#text-editor').inputValue()).includes('Termux 복사본😀'));await library();
  });
  await check('disconnect revokes saved access, removes search results and leaves Termux files intact',async()=>{
   await page.locator('#search').fill('termux-nested');const id=await a('open').getAttribute('data-id');await click('settings');await click('disconnect-folder');await page.locator('#overlay').waitFor({state:'hidden'});await until(()=>a('open').count()===0);assert.equal(privateHash(),original);const status=await native('status');assert.equal(status.data.connectedFolders.length,0);assert.equal((await native('read',{id})).ok,false);
  });
  assert.deepEqual(errors,[]);
 }catch(e){checks.push({name:e.scenario||'infrastructure',passed:false,error:e.stack});console.error(e);console.error('TERMUX_FOREGROUND',foreground());if(device)await device.screenshot({path:qa+'/failure.png'}).catch(()=>{});if(page)console.error('TERMUX_PAGE',await page.locator('body').innerText().catch(()=>'<closed>'));process.exitCode=1;}
 finally{console.log('TERMUX_SUMMARY',JSON.stringify({api:process.env.ANDROID_API,passed:checks.filter(c=>c.passed).length,failed:checks.filter(c=>!c.passed).length,errors}));fs.writeFileSync(qa+'/results.json',JSON.stringify({checks,errors,termux:'official GitHub v0.118.3 x86_64',provider:'com.termux.documents'},null,2));fs.writeFileSync(qa+'/native-ui.xml',lastXml);fs.writeFileSync(qa+'/logcat.txt',adb('logcat','-d','-t','1000'));if(device)await Promise.race([device.close(),pause(5000)]);process.exit(process.exitCode||0);}
})();
