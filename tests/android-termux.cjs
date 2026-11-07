// Real official Termux APK + system DocumentsUI + installed hwpxxx APK. No provider mocks.
const {chromium}=require('playwright');
const {execFileSync}=require('node:child_process');
const fs=require('node:fs'),assert=require('node:assert/strict');
const {waitForWindow,recoverSystemAnr,disableNetwork,start:startAnrGuard,check:anrCheck,finish:anrFinish,guardedKey}=require('./android-system.cjs');
const pkg='kr.offline.hwp.preview',home='/data/data/com.termux/files/home',project=home+'/hwpxxx-project',qa='.qa/android-termux-'+process.env.ANDROID_API;
fs.mkdirSync(qa,{recursive:true});let page,browser,lastXml='';const checks=[],errors=[];
const adb=(...args)=>execFileSync('adb',args,{encoding:'utf8',timeout:45000}).trim();
const sh=(...args)=>adb('shell',...args),pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,ms=30000){const end=Date.now()+ms;let error;while(Date.now()<end){try{const r=await fn();if(r)return r;}catch(e){error=e;}await pause(300);}throw error||new Error('Condition timed out');}
const a=name=>page.locator(`[data-action="${name}"]`),click=async name=>{await ensureConnection();await a(name).click();};
let anrGuard=null;
// Every scenario ends with a check of the focused window and the system log (CDP-only steps cannot see an ANR dialog).
async function check(name,fn){try{await fn();anrCheck();checks.push({name,passed:true});console.log('PASS TERMUX',name);screenshot(`${qa}/${checks.length}.png`);}catch(e){e.scenario=name;throw e;}}
function foreground(){return sh('dumpsys','activity','activities').split('\n').filter(l=>/ResumedActivity/.test(l)).join(' ');}
function screenshot(file){fs.writeFileSync(file,execFileSync('adb',['exec-out','screencap','-p'],{timeout:45000}));}
async function disconnect(){const old=browser;browser=null;if(old)await Promise.race([old.close().catch(()=>{}),pause(5000)]);}
async function connect(){
 const deadline=Date.now()+60000;let error;
 while(Date.now()<deadline)try{
  await disconnect();const pid=sh('pidof',pkg).split(/\s+/)[0];assert(pid,'App process is unavailable');adb('forward','tcp:9222','localabstract:webview_devtools_remote_'+pid);
  browser=await chromium.connectOverCDP('http://127.0.0.1:9222',{timeout:10000});page=browser.contexts()[0]?.pages()[0];if(!page)throw new Error('WebView target is not ready');page.setDefaultTimeout(20000);page.on('pageerror',e=>{errors.push(e.message);console.error('WEBVIEW_ERROR',e.message);});await page.locator('#search').waitFor();return;
 }catch(e){error=e;await disconnect();await pause(500);}
 throw error||new Error('Unable to connect to installed WebView');
}
async function start(){sh('am','start','-W','-n',`${pkg}/kr.offline.hwp.MainActivity`);await connect();}
async function restart(){sh('am','force-stop',pkg);await start();}
function privateHash(){return sh('run-as','com.termux','sha256sum',project+'/nested/termux-nested.hwpx').split(/\s/)[0];}
function privateWrite(name,src){const bytes=fs.readFileSync(src).toString('base64');adb('shell',`run-as com.termux sh -c 'printf %s ${bytes} | base64 -d > ${name}'`);assert.equal(sh('run-as','com.termux','stat','-c','%s',name),String(fs.statSync(src).size));}
function uiNodes(){recoverSystemAnr();sh('rm','-f','/sdcard/termux-ui.xml');sh('uiautomator','dump','--compressed','/sdcard/termux-ui.xml');lastXml=sh('cat','/sdcard/termux-ui.xml');return lastXml.match(/<node\b[^>]*>/g)||[];}
function uiMatch(nodes,regex){return nodes.find(n=>regex.test(n)&&!/enabled="false"/.test(n));}
function tapNode(n){const b=n.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);assert(b,n);console.log('TERMUX_NATIVE_TAP',n);sh('input','touchscreen','tap',String((+b[1]+ +b[3])/2|0),String((+b[2]+ +b[4])/2|0));}
async function uiTap(regex){await until(()=>{const n=uiMatch(uiNodes(),regex);if(!n)return false;tapNode(n);return true;});await pause(400);}
async function ensureConnection(){if(!page.isClosed())return;assert(sh('pidof',pkg),'Android app terminated unexpectedly');console.log('TERMUX_CDP_REATTACH_WITHOUT_APP_RELAUNCH');await disconnect();await connect();}
async function picker(){await click('settings');try{await click('connect-folder');}catch(e){if(!/closed/.test(e.message))throw e;}await until(()=>foreground().includes('documentsui'));await waitForWindow('documentsui');await pause(500);}
// The exact documents the library must list for the search "termux-" once the project is connected. Every scenario passes its own list:
// earlier scenarios delete termux-remove.hwp and the shared copy, so the fixture of the final scenario is just the nested document.
const BOTH=['termux-nested.hwpx','termux-remove.hwp'];
const visibleNames=async()=>(await page.locator('.hw-name').allInnerTexts()).sort();
async function chooseProject(expected=BOTH){
 // Do not assume that a root-row tap was delivered during a drawer transition.
 // Verify the provider's folder list, repeating only navigation if necessary.
 await until(async()=>{
  const nodes=uiNodes();if(uiMatch(nodes,/text="hwpxxx-project"/)||uiMatch(nodes,/text="nested"/))return true;
  const root=uiMatch(nodes,/text="Termux"/),drawer=uiMatch(nodes,/content-desc="(?:Show roots|Open navigation drawer)"/);
  if(root)tapNode(root);else if(drawer)tapNode(drawer);
  await pause(700);return false;
 },45000);
 // DocumentsUI can retain mouse selection mode after the preceding DeX suite.
 // Open the directory with a real mouse double-click if a touch only selects it.
 if(!uiMatch(uiNodes(),/text="nested"/))await uiTap(/text="hwpxxx-project"/);
 // Wait for directory navigation, rather than selecting the previous home tree
 // while DocumentsUI is still loading the clicked folder.
 let entered=false;try{entered=await until(()=>!!uiMatch(uiNodes(),/text="nested"/),4000);}catch{}
 if(!entered){const n=uiMatch(uiNodes(),/text="hwpxxx-project"/);assert(n,'Project folder row is missing');const b=n.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);assert(b,n);const x=String((+b[1]+ +b[3])/2|0),y=String((+b[2]+ +b[4])/2|0);sh('input','mouse','tap',x,y);sh('input','mouse','tap',x,y);await until(()=>!!uiMatch(uiNodes(),/text="nested"/));console.log('TERMUX_DIRECTORY_INPUT','mouse double-click');}
 console.log('TERMUX_DIRECTORY_CONFIRMED','hwpxxx-project/nested is visible');
 await uiTap(/text="(?:USE THIS FOLDER|Use this folder)"/i);await uiTap(/text="(?:ALLOW|Allow)"/i);
 await until(()=>foreground().includes(pkg+'/kr.offline.hwp.MainActivity'));await ensureConnection();await page.locator('#overlay').waitFor({state:'hidden'});const selected=await native('status');assert.equal(selected.data.connectedFolders[0]?.name,'Termux · hwpxxx-project','System picker connected the wrong tree');console.log('TERMUX_GRANTED_TREE',selected.data.connectedFolders[0].name);await page.locator('#search').fill('termux-');const want=JSON.stringify([...expected].sort());await until(async()=>JSON.stringify(await visibleNames())===want).catch(async e=>{throw new Error('Termux documents after connecting: expected '+want+' but the library shows '+JSON.stringify(await visibleNames()));});
}
async function open(name){await page.locator('#search').fill(name);await page.getByRole('button',{name:name+' 열기',exact:true}).click();await page.locator('.page img').first().waitFor();}
async function edit(){await click('edit');const p=page.locator('.page').first(),b=await p.boundingBox();await p.click({position:{x:b.width*120/794,y:b.width*135/794}});await page.locator('#text-editor').waitFor();}
async function library(){if(await a('cancel-edit').isVisible()){await click('cancel-edit');await until(async()=>await a('cancel-yes').isVisible()||await a('edit').isVisible());if(await a('cancel-yes').isVisible())await click('cancel-yes');await a('edit').waitFor();}if(await a('back').isVisible())await click('back');await page.locator('#search').waitFor();}
async function native(op,args={}){const r=await page.evaluate(({op,args})=>new Promise((resolve,reject)=>{const old=window.NativeReply,id=980000,timer=setTimeout(()=>{window.NativeReply=old;reject(new Error('Native test request timed out'));},15000);window.NativeReply=(rid,r)=>{if(rid===id){clearTimeout(timer);window.NativeReply=old;resolve(r);}else old(rid,r);};OfflineNative.postMessage(JSON.stringify({id,op,args}));}),{op,args});return r;}
(async()=>{
 try{
  assert.equal(adb('get-state'),'device');startAnrGuard();
  sh('settings','put','system','screen_off_timeout','2147483647');sh('svc','power','stayon','true');sh('input','keyevent','224');sh('wm','dismiss-keyguard');console.log('ANDROID_DISPLAY',sh('dumpsys','power').split('\n').filter(l=>/mWakefulness=|mIsPowered=|mStayOn=/.test(l)).join(' '));
  sh('wm','size','1920x1080');sh('wm','density','160');sh('settings','put','system','font_scale','1.0');sh('settings','put','secure','show_ime_with_hard_keyboard','0');
  console.log('TERMUX_SETUP install official APK');adb('install','-r','.qa/termux.apk');console.log('TERMUX_SETUP create private fixtures');
  sh('run-as','com.termux','mkdir','-p',project+'/nested',home+'/outside-project');
  privateWrite(project+'/nested/termux-nested.hwpx','tests/fixtures/문서.hwpx');privateWrite(project+'/termux-remove.hwp','tests/fixtures/문서.hwp');privateWrite(home+'/outside-project/outside-secret.hwpx','tests/fixtures/문서.hwpx');
  // Traps for the provider walk, made with the real Termux file system: a symlink loop, bulk/hidden folders and a chain deeper than the walk limit.
  // None of them may add a document to the library (the existing "2 documents" assertions below stay exactly as they were).
  sh('run-as','com.termux','ln','-s','..',project+'/nested/loop');
  sh('run-as','com.termux','mkdir','-p',project+'/node_modules/pkg',project+'/.hidden-notes');
  privateWrite(project+'/node_modules/pkg/inner-node-module.hwp','tests/fixtures/문서.hwp');privateWrite(project+'/.hidden-notes/hidden-note.hwpx','tests/fixtures/문서.hwpx');
  const chain=Array.from({length:70},(_,i)=>'d'+(i+1)).join('/');sh('run-as','com.termux','mkdir','-p',project+'/deep/'+chain);privateWrite(project+'/deep/'+chain+'/too-deep.hwpx','tests/fixtures/문서.hwpx');
  console.log('TERMUX_SETUP traps created: loop symlink, node_modules, dot folder, 70-level chain');
  const original=privateHash();console.log('TERMUX_SETUP fixtures verified');sh('pm','clear',pkg);sh('appops','set','--uid',pkg,'MANAGE_EXTERNAL_STORAGE','deny');disableNetwork();console.log('TERMUX_SETUP start preview');await start();console.log('TERMUX_SETUP WebView connected');
  await check('private projects stay hidden before connection; system picker cancellation returns safely',async()=>{
   assert.equal(await a('open').count(),0);await picker();guardedKey(()=>sh('input','keyevent','4'));await until(()=>foreground().includes(pkg+'/kr.offline.hwp.MainActivity'));await ensureConnection();await click('close');assert.equal(await a('open').count(),0);
  });
  await check('system picker grants only selected Termux project; nested HWP/HWPX are searchable',async()=>{
   await picker();await chooseProject();assert.equal(await a('open').count(),2);await page.locator('#search').fill('outside-secret');assert.equal(await a('open').count(),0);await page.locator('#search').fill('termux-nested');assert.equal(await a('open').count(),1);
  });
  await check('persisted tree survives process death without all-files permission; private document renders offline',async()=>{
   await restart();await open('termux-nested.hwpx');await edit();assert((await page.locator('#text-editor').inputValue()).length>0);await page.locator('#text-editor').press('End');await page.keyboard.insertText(' PERMISSION_REQUIRED');await until(()=>a('save').isEnabled());await page.keyboard.press('Control+s');await page.getByText('파일 접근이 필요해요',{exact:true}).waitFor();await click('close');assert((await page.locator('#text-editor').inputValue()).includes('PERMISSION_REQUIRED'));assert.equal(privateHash(),original);await library();
  });
  await check('connecting the same project twice does not duplicate results',async()=>{await picker();await chooseProject();assert.equal(await a('open').count(),2);const status=await native('status');assert.equal(status.data.connectedFolders.length,1);});
  await check('symlink loop, node_modules, dot folders and a 70-level chain add no documents; the scan ends without a limit and counts the skipped branch',async()=>{
   await page.locator('#search').fill('');const names=async()=>(await page.locator('.hw-name').allInnerTexts()).sort();
   const r=await native('scan');assert.equal(r.ok,true,r.error);assert.equal(r.data.cancelled,false);assert.equal(r.data.limited,false,'a loop must not exhaust the walk budget: '+JSON.stringify(r.data));
   assert(r.data.skipped>=1,'the 70-level chain is counted as a skipped branch: '+JSON.stringify(r.data));
   await until(async()=>(await names()).length===2);assert.deepEqual(await names(),['termux-nested.hwpx','termux-remove.hwp'],'no duplicate through loop/, nothing from node_modules, .hidden-notes or deep/');
   assert.equal(privateHash(),original);
  });
  await check('deleted private document reports an error and preserves usable library',async()=>{
   sh('run-as','com.termux','rm',project+'/termux-remove.hwp');await page.locator('#search').fill('termux-remove.hwp');await a('open').click();await page.getByText('작업을 완료하지 못했어요',{exact:true}).waitFor();await click('close');assert(await page.locator('#search').isVisible());
  });
  await check('Ctrl+S saves an edited shared copy, preserving private original bytes',async()=>{
   sh('appops','set','--uid',pkg,'MANAGE_EXTERNAL_STORAGE','allow');await restart();await open('termux-nested.hwpx');await edit();const t=page.locator('#text-editor');await t.press('End');await page.keyboard.insertText(' Termux 복사본😀');await until(()=>a('save').isEnabled());await page.keyboard.press('Control+s');await page.locator('#filename').fill('termux-export');await click('folder-confirm');await page.locator('#overlay').waitFor({state:'hidden'});assert.equal(privateHash(),original);assert(sh('ls','/sdcard').includes('termux-export.hwpx'));await library();await open('termux-export.hwpx');await edit();assert((await page.locator('#text-editor').inputValue()).includes('Termux 복사본😀'));await library();
  });
  await check('disconnect revokes saved access, removes search results and leaves Termux files intact',async()=>{
   await page.locator('#search').fill('termux-nested');const id=await a('open').getAttribute('data-id');await click('settings');await click('disconnect-folder');await page.locator('#overlay').waitFor({state:'hidden'});await until(async()=>await a('open').count()===0);assert.equal(privateHash(),original);const status=await native('status');assert.equal(status.data.connectedFolders.length,0);assert.equal((await native('read',{id})).ok,false);
  });
  await check('the process is killed while the system folder picker is open: the chosen folder is still connected afterwards',async()=>{
   // The earlier Save As scenario left termux-export.hwpx in shared storage; the picker scenario counts the two Termux documents by the "termux-" search.
   sh('rm','-f','/sdcard/termux-export.hwpx');
   await library();await picker();
   const before=sh('pidof',pkg).split(/\s+/)[0];assert(before,'app process');
   // `am kill` is Android's own background kill: the task and the picker request survive, the process does not.
   sh('am','kill',pkg);await until(()=>{try{return sh('pidof',pkg).split(/\s+/)[0]!==before;}catch{return true;}},20000);
   console.log('TERMUX_PICKER_PROCESS_KILLED',before);
   // At this point only the nested document is left: termux-remove.hwp was deleted by the earlier scenario and termux-export.hwpx was removed above.
   await chooseProject(['termux-nested.hwpx']);             // the result is delivered to a recreated activity that has no memory of the request
   const status=await native('status');assert.equal(status.data.connectedFolders.length,1);assert.equal(status.data.connectedFolders[0].name,'Termux · hwpxxx-project');
   assert.deepEqual(await visibleNames(),['termux-nested.hwpx'],'exactly the remaining Termux document, not a loose count');assert.equal(privateHash(),original);
  });
  assert.deepEqual(errors,[]);
 }catch(e){checks.push({name:e.scenario||'infrastructure',passed:false,error:e.stack});console.error(e);console.error('TERMUX_FOREGROUND',foreground());(()=>{try{screenshot(qa+'/failure.png');}catch{}})();if(page)console.error('TERMUX_PAGE',await page.locator('body').innerText().catch(()=>'<closed>'));process.exitCode=1;}
 finally{try{anrGuard=anrFinish([pkg,'com.termux']);}catch(e){anrGuard={error:e.message};checks.push({name:'ANR guard: no app/unknown ANR or crash dialog during the suite',passed:false,error:e.message});process.exitCode=1;console.error(e.message);}
  console.log('TERMUX_SUMMARY',JSON.stringify({api:process.env.ANDROID_API,anrGuard:anrGuard.error?anrGuard.error:{systemRecoveries:anrGuard.systemRecoveries,systemAnrInLogs:anrGuard.systemAnrInLogs,failures:anrGuard.failures},passed:checks.filter(c=>c.passed).length,failed:checks.filter(c=>!c.passed).length,errors}));fs.writeFileSync(qa+'/results.json',JSON.stringify({anrGuard,checks,errors,termux:'official GitHub v0.118.3 x86_64',provider:'com.termux.documents'},null,2));fs.writeFileSync(qa+'/native-ui.xml',lastXml);fs.writeFileSync(qa+'/logcat.txt',adb('logcat','-d','-t','1000'));await disconnect();process.exit(process.exitCode||0);}
})();
