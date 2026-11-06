"""Real worker + WebView assets in Chromium. Android hardware is a separate check."""
import base64, hashlib, json, mimetypes, os, sys
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
ASSETS=ROOT/'app/src/main/assets'
QA=ROOT/'.qa';QA.mkdir(exist_ok=True)
errors=[]
def failure(kind,value,traceback):
    print('Browser errors:',errors)
    try:page.screenshot(path=str(QA/'tablet-failure.png'),full_page=True)
    except Exception:pass
    sys.__excepthook__(kind,value,traceback)
sys.excepthook=failure
with sync_playwright() as pw:
    launch={'headless':True,'args':['--no-sandbox']}
    if os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE'):launch['executable_path']=os.environ['PLAYWRIGHT_CHROMIUM_EXECUTABLE']
    browser=pw.chromium.launch(**launch)
    for width,height in [(1280,800),(1600,1000),(800,1280),(390,844)]:
        page=browser.new_page(viewport={'width':width,'height':height})
        page.on('pageerror',lambda error:errors.append(str(error)))
        body=(ROOT/'tests/fixtures/문서.hwpx').read_bytes()
        meta={'id':'test','name':'시험.hwpx','path':'/storage/시험.hwpx','folder':'/storage','format':'hwpx','size':len(body),'modified':1700000000000}
        def route(req):
            from urllib.parse import urlparse
            path=urlparse(req.request.url).path
            if path=='/__native':
                message=json.loads(req.request.post_data);op=message['op'];events=[]
                data=True
                if op=='status':data={'permission':True,'version':'0.3.0','volumes':[{'path':'/storage','name':'내장 저장공간'}]}
                elif op=='scan':events=[['scanBatch',[meta]]];data={'cancelled':False,'limited':False,'skipped':0}
                elif op=='read':data={'url':'/document/test','token':'test','sha':hashlib.sha256(body).hexdigest(),'meta':meta}
                elif op not in ['release','cancelScan','exit']:raise AssertionError('Unexpected native call '+op)
                req.fulfill(json={'reply':{'ok':True,'data':data},'events':events});return
            if path=='/document/test':req.fulfill(body=body,content_type='application/octet-stream');return
            f=ASSETS/path.lstrip('/')
            req.fulfill(status=200 if f.is_file() else 404,body=f.read_bytes() if f.is_file() else b'',content_type='text/javascript' if f.suffix in ['.js','.mjs'] else mimetypes.guess_type(str(f))[0] or 'application/octet-stream')
        page.route('https://appassets.androidplatform.net/**',route)
        page.add_init_script("""window.OfflineNative={postMessage(raw){const m=JSON.parse(raw);fetch('/__native',{method:'POST',body:raw}).then(r=>r.json()).then(r=>{for(const [n,d] of r.events)window.NativeEvent?.(n,d);window.NativeReply(m.id,r.reply);});}};""")
        page.goto('https://appassets.androidplatform.net/index.html')
        page.locator('[data-action="open"]').first.click()
        page.locator('.page img').first.wait_for()
        page.locator('[data-action="edit"]').click()
        box=page.locator('.page').first.bounding_box()
        page.locator('.page').first.click(position={'x':box['width']*120/794,'y':box['width']*135/794})
        editor=page.locator('#text-editor');editor.wait_for()
        editor.evaluate('(t)=>{t.focus();t.setSelectionRange(0,3);t.dispatchEvent(new Event("select",{bubbles:true}));}')
        page.wait_for_timeout(180)
        def click(a):page.locator('[data-action="'+a+'"]').click()
        # DeX input: actual mouse wheel and physical-key events, no viewport magnification.
        z=page.locator('#pages')
        old_zoom=z.evaluate('(e)=>parseFloat(e.style.width)')
        editor.click()
        assert z.evaluate('(e)=>parseFloat(e.style.width)')==old_zoom
        b=page.locator('.page').first.bounding_box();page.mouse.move(b['x']+100,b['y']+100)
        page.keyboard.down('Control');page.mouse.wheel(0,-120);page.keyboard.up('Control');page.wait_for_timeout(100)
        assert z.evaluate('(e)=>parseFloat(e.style.width)')>old_zoom
        assert page.evaluate('visualViewport.scale')==1
        page.keyboard.press('Control+0');assert z.evaluate('(e)=>parseFloat(e.style.width)')==100
        page.keyboard.press('Control+-');assert z.evaluate('(e)=>parseFloat(e.style.width)')<100
        page.keyboard.press('Control+0')
        editor.evaluate('(t)=>{t.focus();t.setSelectionRange(0,3);t.dispatchEvent(new Event("select",{bubbles:true}));}')
        page.wait_for_timeout(180)
        click('tb-italic');page.wait_for_timeout(250)
        click('tb-char')
        page.locator('#fmt-spacings').fill('3');page.locator('#fmt-ratios').fill('95');click('tb-char-metrics')
        click('tb-para');page.locator('#fmt-spacingBefore').fill('10');page.locator('#fmt-spacingAfter').fill('6');click('tb-para-spacing')
        page.wait_for_timeout(250)
        assert page.locator('[data-action="save"]').is_enabled()
        click('tb-highlight');assert page.locator('[data-action="tb-highlight"]').get_attribute('aria-pressed')=='true'
        page.wait_for_timeout(350)
        previous=page.locator('.page img').first.get_attribute('src')
        editor.evaluate('(t)=>{t.focus();t.setSelectionRange(3,6);document.dispatchEvent(new Event("selectionchange"));}')
        page.wait_for_timeout(650)
        assert page.locator('.page img').first.get_attribute('src')!=previous
        page.keyboard.press('Escape');assert page.locator('[data-action="tb-highlight"]').get_attribute('aria-pressed')=='false'
        click('tb-memo');click('memo-new')
        page.locator('#memo-author').fill('태블릿')
        page.locator('#memo-text').fill('가로 화면 메모 <script> & 테스트')
        click('memo-save');page.locator('#overlay').wait_for(state='hidden')
        assert page.locator('.memo-card').count()==1
        assert '<script>' in page.locator('.memo-card').inner_text()
        assert page.locator('.memo-mark').count()>0
        click('tb-undo');page.wait_for_timeout(200);assert page.locator('.memo-card').count()==0
        click('tb-redo');page.wait_for_timeout(200);assert page.locator('.memo-card').count()==1
        # Rotate while editing: same live textarea and unsaved content must survive.
        old=editor.input_value();editor.evaluate('(t)=>t.dataset.rotationProbe="same"')
        page.set_viewport_size({'width':height,'height':width});page.wait_for_timeout(150)
        assert editor.get_attribute('data-rotation-probe')=='same' and editor.input_value()==old
        page.set_viewport_size({'width':width,'height':height});page.wait_for_timeout(150)
        if width>=1000 and width>height:
            scroll=page.locator('.reader-scroll').bounding_box();panel=page.locator('.edit-bottom').bounding_box()
            assert scroll['x']+scroll['width']<=panel['x']+1
            assert panel['width']>=280
            # Simulate keyboard opening in landscape.
            page.set_viewport_size({'width':width,'height':340});page.wait_for_timeout(100)
            assert page.locator('[data-action="save"]').is_visible()
            assert editor.get_attribute('data-rotation-probe')=='same'
            page.set_viewport_size({'width':width,'height':height})
        page.screenshot(path=str(QA/f'tablet-{width}x{height}.png'),full_page=True)
        assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
        page.close()
    browser.close()
assert not errors,errors
print('Passed: four viewport sizes, formatting, memo CRUD/history, rotation, landscape keyboard layout')
