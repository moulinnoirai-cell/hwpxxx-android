"""PC chrome geometry and commands against the real Android assets/worker (preview native bridge)."""
import json, os, re, subprocess
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1];QA=ROOT/'.qa';QA.mkdir(exist_ok=True)
server=subprocess.Popen(['node','tests/preview-server.mjs','8795'],cwd=ROOT,stdout=subprocess.PIPE,text=True)
assert 'sandbox' in server.stdout.readline()
errors=[];results=[]
try:
 with sync_playwright() as p:
  browser=p.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE','/usr/bin/chromium'),args=['--no-sandbox'])
  for w,h in [(1920,1080),(1280,800),(700,500),(390,844)]:
   page=browser.new_page(viewport={'width':w,'height':h},has_touch=w==390,is_mobile=w==390);page.on('pageerror',lambda e:errors.append(str(e)))
   page.goto('http://localhost:8795/__grant?1');page.goto('http://localhost:8795');page.locator('#search').fill('프로젝트 일정')
   page.locator('[data-action=open]').click();page.locator('.page img').first.wait_for();page.locator('[data-action=edit]').click()
   page.locator('.studio-menu summary').first.click();assert page.locator('.studio-menu').first.get_attribute('open') is not None
   page.keyboard.press('Escape');assert page.locator('.studio-menu[open]').count()==0
   for index in range(8):
    page.locator('.studio-menu summary').nth(index).click();page.wait_for_timeout(30)
    bounds=page.locator('.studio-menu[open] .studio-dropdown').bounding_box()
    assert bounds['x']>=0 and bounds['x']+bounds['width']<=w+1,(w,index,bounds)
    page.keyboard.press('Escape')
   page.locator('.studio-menu summary').first.focus();page.keyboard.press('ArrowDown')
   assert page.locator('.studio-menu[open] button:focus').count()==1
   page.keyboard.press('Escape')
   assert page.locator('.studio-menu summary').all_text_contents()==['파일','편집','보기','입력','서식','쪽','표','도구']
   chrome=page.locator('.studio-chrome').bounding_box();paper=page.locator('.page').first.bounding_box()
   assert paper['y']>=chrome['y']+chrome['height'],(w,chrome,paper)
   assert page.locator('.reader-scroll').bounding_box()['width']==w
   assert page.locator('.studio-status').bounding_box()['y']>=h-50
   page.locator('[data-action=studio-toolbox]').click();assert page.locator('.edit-bottom').is_hidden()
   assert page.locator('.studio-chrome').bounding_box()['height']<chrome['height']
   page.locator('[data-action=studio-toolbox]').click();assert page.locator('.edit-bottom').is_visible()
   assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
   # Use a menu command, then change actual selected document text formatting.
   page.locator('.page').first.click(position={'x':paper['width']*120/794,'y':paper['width']*135/794})
   t=page.locator('#text-editor');t.wait_for();t.evaluate('(e)=>{e.focus();e.setSelectionRange(0,3);e.dispatchEvent(new Event("select",{bubbles:true}));}')
   page.locator('#studio-font-size').wait_for(state='visible');page.wait_for_timeout(300)
   page.locator('#studio-font-size').select_option('1400');page.wait_for_timeout(300)
   assert page.locator('[data-action=save]').is_enabled()
   assert page.locator('#studio-font-size').input_value()=='1400'
   page.locator('.studio-menu summary').nth(2).click();page.locator('[data-command=zoom-in]').click()
   assert page.locator('.studio-menu[open]').count()==0
   assert int(page.locator('#document-zoom').inner_text().rstrip('%'))>100
   page.locator('[data-action=zoom-reset]').click()
   page.screenshot(path=str(QA/f'desktop-{w}x{h}.png'))
   if w==1920:
    page.locator('[data-action=tb-char]').click();page.locator('[data-action=studio-close-panel]').click();assert page.locator('#edit-panel').is_hidden()
    page.locator('.studio-menu summary').nth(2).click();page.locator('.studio-menu[open] [data-command=settings]').click()
    page.locator('[data-action=set-theme][data-value=dark]').click();page.locator('[data-action=close]').click()
    assert page.locator('#hwp-app').get_attribute('data-theme')=='dark'
    page.wait_for_timeout(500);page.locator('.page img').first.evaluate('(e)=>e.decode()')
    page.screenshot(path=str(QA/'desktop-dark.png'))
   results.append({'width':w,'height':h,'chromeHeight':chrome['height'],'passed':True});page.close()
  browser.close()
 assert not errors,errors
 (QA/'desktop-ui-results.json').write_text(json.dumps({'viewports':results,'pageErrors':errors},indent=2))
 print('Passed: desktop menus/Escape, full-width workspace, paper inset, status bar, real font change, menu zoom at four sizes')
finally:server.terminate();server.wait(timeout=10)
