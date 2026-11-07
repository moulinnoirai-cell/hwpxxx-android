"""Regression tests for the Opus/high review of PR #2 (F1, F8, F9, F11, F12, H5) in Chromium: the shipped page, the shipped
engine worker and the preview bridge (real file operations on a disposable copy; Termux is a documented mock here). Android
hardware, IME and the real WebView are covered by tests/android-emulator.cjs and tests/android-termux.cjs, not by this file."""
import json, os, re, subprocess, sys, time, urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
QA=ROOT/'.qa';QA.mkdir(exist_ok=True)
PORT=int(os.environ.get('REVIEW_UI_PORT','8793'));BASE=f'http://localhost:{PORT}'
server=subprocess.Popen(['node',str(ROOT/'tests/preview-server.mjs'),str(PORT)],cwd=ROOT,stdout=subprocess.PIPE,text=True)
server.stdout.readline()
for _ in range(50):
    try:urllib.request.urlopen(BASE+'/__mock.js').read();break
    except Exception:time.sleep(.1)
errors=[]
def fail(kind,value,tb):
    print('Browser errors:',errors)
    try:page.screenshot(path=str(QA/'review-failure.png'),full_page=True)
    except Exception:pass
    server.terminate();sys.__excepthook__(kind,value,tb)
sys.excepthook=fail
def scale(page):return page.locator('.page').first.bounding_box()['width']/793.7
def at(page,x,y):
    b=page.locator('.page').first.bounding_box();k=b['width']/793.7;return b['x']+x*k,b['y']+y*k
def pause(page,ms=250):page.wait_for_timeout(ms)
def until(page,fn,arg=None,timeout=8000):
    # The page's CSP forbids the eval Playwright's polling helper needs; poll page.evaluate (function form) instead.
    end=time.time()+timeout/1000
    while time.time()<end:
        if page.evaluate(fn,arg):return
        page.wait_for_timeout(100)
    raise AssertionError('timed out waiting for '+fn[:90])
def library(page,termux=False):
    urllib.request.urlopen(BASE+'/__grant?1').read();urllib.request.urlopen(BASE+('/__termux?1' if termux else '/__termux?0')).read()
    page.goto(BASE);page.locator('#search').wait_for();page.locator('#search').fill('');page.locator('.hw-doc').first.wait_for();pause(page,600)
    if page.locator('#sheet-title').filter(has_text='저장하지 못한 편집').count():page.locator('#sheet [data-action="close"]').click();page.locator('#overlay').wait_for(state='hidden')   # a leftover recovery offer is not what is tested here
def open_doc(page,name):
    page.locator('#search').fill(name);assert page.locator('[data-action="open"]').count()==1,name;page.locator('[data-action="open"]').click();page.locator('.page img').first.wait_for()
def start_edit(page):
    page.locator('[data-action="edit"]').click();page.locator('.reader.is-editing').wait_for()
def editor(page):return page.locator('#text-editor')
def value(page):return editor(page).input_value()
def click_para(page,x,y):
    page.locator('.reader-scroll').evaluate("e=>{e.scrollTop=0;}");pause(page,150)   # the memo jump scrolls its paragraph to the middle
    page.mouse.click(*at(page,x,y));editor(page).wait_for();pause(page,300)
P0=(120,135);P1=(200,160)

with sync_playwright() as pw:
    launch={'headless':True,'args':['--no-sandbox']}
    if os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE'):launch['executable_path']=os.environ['PLAYWRIGHT_CHROMIUM_EXECUTABLE']
    browser=pw.chromium.launch(**launch)
    ctx=browser.new_context(viewport={'width':1920,'height':1080},has_touch=True)
    page=ctx.new_page();page.on('pageerror',lambda e:errors.append(str(e)))

    # ---- F1 / H5 / F11 / F12: one document with a memo on paragraph 0 ----
    library(page);open_doc(page,'프로젝트 일정');start_edit(page)
    click_para(page,*P0);p0=value(page);p1_hint=None
    page.keyboard.press('Home');page.keyboard.press('Shift+ArrowRight');page.keyboard.press('Shift+ArrowRight')
    anchor=p0[:2]
    page.locator('[data-action="tb-memo"]').click();page.locator('[data-action="memo-new"]').click();page.locator('#memo-text').fill('점프 시험 메모');page.locator('#memo-text').press('Control+Enter')
    page.locator('#overlay').wait_for(state='hidden');page.locator('.memo-anchor').wait_for();pause(page,300)
    assert page.locator('.memo-box').count()==1 and page.locator('.memo-box').is_visible(),'wide layout shows the memo box beside the page'

    # F1a: text typed in another paragraph is still pending (80 ms commit timer) when the memo anchor is pressed in the same task
    click_para(page,*P1);p1=value(page);assert p1!=p0
    page.evaluate("""()=>{const t=document.querySelector('#text-editor');t.value=t.value+' PENDING';t.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('.memo-anchor').click();}""")
    until(page,"()=>!!document.querySelector('#text-editor') && !document.querySelector('#text-editor').value.includes('PENDING')")
    assert value(page)==p0,'the memo jump moved the editor to the memo paragraph'
    click_para(page,*P1);assert value(page)==p1+' PENDING',('pending text was lost by the memo jump',value(page))

    # F1b: a Hangul syllable is still composing: the jump must refuse (nothing lost, editor stays), then work after the composition ends
    editor(page).evaluate("""t=>{t.focus();t.setSelectionRange(t.value.length,t.value.length);t.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));t.value=t.value+'ㅎ';t.dispatchEvent(new Event('input',{bubbles:true}));}""")
    page.locator('.memo-anchor').click();pause(page,400)
    assert value(page)==p1+' PENDINGㅎ','the jump is refused while the syllable is composing; the typed text stays in the editor'
    assert '한글 입력을 마친 뒤' in page.locator('#announce').inner_text(),'the user is told why'
    assert page.locator('#overlay').is_hidden()
    editor(page).evaluate("t=>t.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}))")
    page.locator('.memo-anchor').click();until(page,"()=>!!document.querySelector('#text-editor') && !document.querySelector('#text-editor').value.includes('PENDING')")
    click_para(page,*P1);assert value(page)==p1+' PENDINGㅎ',('composed text was lost',value(page))

    # F17: typing in a document with a memo schedules the (slow) memo refresh for when typing pauses; the mark is redrawn afterwards, not lost
    click_para(page,*P1);editor(page).press('End');page.keyboard.insert_text('가')
    pause(page,1500);assert page.locator('.memo-box').count()==1 and page.locator('.memo-mark').count()>=1,'memo marks are redrawn after typing pauses'

    # H5: a click on the memo box beside the page is only the memo command (no page hit-test at x beyond the page, no error dialog)
    page.locator('.memo-box').click();pause(page,600)
    assert page.locator('#overlay').is_hidden(),'no error dialog from a stray hit-test: '+page.locator('#sheet').inner_text()[:80]
    sel=editor(page).evaluate("t=>t.value.slice(t.selectionStart,t.selectionEnd)")
    assert value(page)==p0 and sel==anchor,('memo box click selected the anchor',value(page),sel)

    # F11: Ctrl+Z / Ctrl+B inside a panel number field belong to the field, not the document
    click_para(page,*P1);base=value(page);editor(page).press('End');page.keyboard.insert_text(' FIELD');pause(page,500)
    assert value(page).endswith(' FIELD')
    page.locator('[data-action="tb-para"]').click();field=page.locator('#fmt-spacingBefore');field.wait_for();field.click();field.fill('4');pause(page,300)
    page.keyboard.press('Control+z');pause(page,700)
    assert editor(page).count()==1 and value(page).endswith(' FIELD'),'Ctrl+Z in the field did not undo the document'
    page.keyboard.press('Control+b');pause(page,500)
    assert page.locator('[data-action="tb-bold"]').get_attribute('aria-pressed')!='true' and page.locator('#overlay').is_hidden()
    # Ctrl+S still works from the field (Save is an application command)
    page.keyboard.press('Control+s');page.locator('[data-action="save-yes"]').wait_for(timeout=5000);page.locator('[data-action="close"]').click()
    page.locator('#overlay').wait_for(state='hidden')

    # F12: ArrowRight at the end of a paragraph while composing only commits the syllable; without composition it moves on
    click_para(page,*P0);t0=value(page)
    editor(page).evaluate("t=>{t.focus();t.setSelectionRange(t.value.length,t.value.length);}")
    editor(page).evaluate("t=>t.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',code:'ArrowRight',isComposing:true,keyCode:229,bubbles:true,cancelable:true}))")
    pause(page,500);assert value(page)==t0,'ArrowRight during composition did not leave the paragraph'
    editor(page).evaluate("t=>t.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',code:'ArrowRight',bubbles:true,cancelable:true}))")
    until(page,"t0=>document.querySelector('#text-editor').value!==t0",t0,5000)

    # ---- F-B: replacing the whole anchor of a memo inside a table cell removes the memo and says so (typing, then the spreadsheet paste) ----
    library(page);open_doc(page,'2026년 사업계획');start_edit(page)
    cell=lambda:(click_para(page,130,140),value(page))[1]
    original_cell=cell();assert original_cell=='표 셀 시험',original_cell
    page.keyboard.press('Home');page.keyboard.press('Shift+End')
    page.locator('[data-action="tb-memo"]').click();page.locator('[data-action="memo-new"]').click();page.locator('#memo-text').fill('칸 메모');page.locator('#memo-text').press('Control+Enter')
    page.locator('#overlay').wait_for(state='hidden');page.locator('.memo-anchor').wait_for();pause(page,300)
    cell();page.keyboard.press('Home');page.keyboard.press('Shift+End');page.keyboard.insert_text('바꾼 글')
    until(page,"()=>document.querySelector('#announce').textContent.includes('메모 1개')",None,8000)
    assert '함께 지웠어요' in page.locator('#announce').inner_text() and '실행 취소' in page.locator('#announce').inner_text()
    pause(page,700);assert page.locator('.memo-anchor').count()==0,'the memo went with its anchor'
    page.locator('[data-action="tb-undo"]').click();pause(page,900);page.locator('.memo-anchor').wait_for()
    assert cell()=='표 셀 시험','undo restores the cell text';assert page.locator('.memo-anchor').count()==1,'undo restores the memo'
    page.evaluate("document.querySelector('#announce').textContent=''")
    page.locator('[data-action="tb-table"]').click();page.locator('#grid-paste').wait_for();page.locator('#grid-paste').fill('가\t나\n다\t라');page.locator('[data-action="tb-grid-paste"]').click()
    until(page,"()=>document.querySelector('#announce').textContent.includes('4칸에 붙여넣었어요')",None,8000)
    note=page.locator('#announce').inner_text();assert '메모 1개' in note,('the grid paste notice also names the removed memo',note)
    page.locator('[data-action="cancel-edit"]').click()
    if page.locator('[data-action="cancel-yes"]').is_visible():page.locator('[data-action="cancel-yes"]').click()
    pause(page,300)

    # ---- F9: the touch pinch and Ctrl+wheel stop at the same minimum (50%) ----
    library(page)
    open_doc(page,'프로젝트 일정')
    def zoom():return page.locator('#pages').evaluate("e=>parseFloat(e.style.width)")
    def pinch(start,end):
        page.evaluate("""([a,b])=>{const sc=document.querySelector('.reader-scroll'),r=sc.getBoundingClientRect(),cx=r.left+r.width/2,cy=r.top+200;
          const T=(id,x)=>new Touch({identifier:id,target:sc,clientX:x,clientY:cy});
          const fire=(type,d)=>sc.dispatchEvent(new TouchEvent(type,{bubbles:true,cancelable:true,touches:type==='touchend'?[]:[T(1,cx-d/2),T(2,cx+d/2)],targetTouches:[],changedTouches:[T(1,cx-d/2),T(2,cx+d/2)]}));
          fire('touchstart',a);fire('touchmove',(a+b)/2);fire('touchmove',b);fire('touchend',b);}""",[start,end])
        pause(page,500)
    page.locator('[data-action="back"]').focus()   # shortcuts are handled for focus inside the app root
    pinch(400,20)                                   # fingers 20x closer: far below any minimum
    assert zoom()==50,('pinch minimum',zoom())
    page.keyboard.press('Control+0');pause(page,300);assert zoom()==100
    for _ in range(12):page.keyboard.press('Control+-')
    pause(page,300);assert zoom()==50,('Ctrl+- minimum',zoom())
    pinch(200,100);assert zoom()==50,'a pinch from 50% never jumps to 100%'
    page.locator('[data-action="back"]').focus();page.keyboard.press('Control+0');pause(page,300)
    pinch(100,400);assert 399<=zoom()<=400,('pinch maximum',zoom())
    page.locator('[data-action="back"]').focus();page.keyboard.press('Control+0')
    page.locator('[data-action="back"]').click();page.locator('#search').wait_for()

    # ---- F8: all-files access revoked while a Termux link is connected: stale shared documents leave the list ----
    library(page,termux=True)
    until(page,"()=>document.querySelectorAll('[data-action=open]').length>=6")
    shared=page.locator('[data-action="open"]').count();assert shared>=6
    assert page.locator('[data-action="open"][aria-label="termux-nested.hwpx 열기"]').count()==1
    urllib.request.urlopen(BASE+'/__grant?0').read();page.evaluate("window.NativeEvent('resume',true)")
    until(page,"()=>document.querySelectorAll('[data-action=open]').length===1")
    assert page.locator('[data-action="open"][aria-label="termux-nested.hwpx 열기"]').count()==1,'the Termux document stays'
    assert page.locator('.hw-onboarding').count()==0,'the Termux link keeps the library usable (no onboarding)'
    page.screenshot(path=str(QA/'review-revoked.png'))
    # the linked document still opens; a stale shared id would be refused
    page.locator('[data-action="open"]').click();page.locator('.page img').first.wait_for()
    page.locator('[data-action="back"]').click();page.locator('#search').wait_for()
    urllib.request.urlopen(BASE+'/__grant?1').read();page.evaluate("window.NativeEvent('resume',true)")
    until(page,"()=>document.querySelectorAll('[data-action=open]').length>=6")
    browser.close()
server.terminate()
assert not errors,errors
print('Passed: memo jump flush/composition/busy guard, memo box click, field shortcut guard, IME arrow guard, memo-removal notice (cell edit, grid paste), pinch/wheel minimum, revoked-permission list')
