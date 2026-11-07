"""DeX-style mouse and keyboard workflows in Chromium: real engine worker and WebView assets, preview bridge with real
file operations on a disposable copy of the fixtures. Android hardware, IME and DeX firmware remain separate checks."""
import hashlib, json, os, re, subprocess, sys, time, urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
QA=ROOT/'.qa';QA.mkdir(exist_ok=True)
PORT=int(os.environ.get('DEX_UI_PORT','8791'));BASE=f'http://localhost:{PORT}'
server=subprocess.Popen(['node',str(ROOT/'tests/preview-server.mjs'),str(PORT)],cwd=ROOT,stdout=subprocess.PIPE,text=True)
line=server.stdout.readline();SANDBOX=Path(re.search(r'sandbox (.+)$',line).group(1).strip())
for _ in range(50):
    try:urllib.request.urlopen(BASE+'/__mock.js').read();break
    except Exception:time.sleep(.1)
errors=[]
def native(page,op,**args):
    return page.request.post(BASE+'/__native',data=json.dumps({'id':1,'op':op,'args':args})).json()['reply']
def sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def fail(kind,value,tb):
    print('Browser errors:',errors)
    try:page.screenshot(path=str(QA/'dex-failure.png'),full_page=True)
    except Exception:pass
    server.terminate();sys.__excepthook__(kind,value,tb)
sys.excepthook=fail
SCALE=lambda box:box['width']/793.7
def at(page,x,y,index=0):
    box=page.locator('.page').nth(index).bounding_box();k=SCALE(box);return box['x']+x*k,box['y']+y*k
def library(page):
    page.goto(BASE+'/__grant?1');page.goto(BASE);page.locator('.hw-doc').first.wait_for()
def open_doc(page,name):
    page.locator('#search').fill(name);assert page.locator('[data-action="open"]').count()==1,name;page.locator('[data-action="open"]').click();page.locator('.page img').first.wait_for()
def start_edit(page):
    page.locator('[data-action="edit"]').click();page.locator('.reader.is-editing').wait_for()
def pause(page,ms=250):page.wait_for_timeout(ms)
def drag(page,a,b):
    page.mouse.move(*a);page.mouse.down();page.mouse.move((a[0]+b[0])/2,(a[1]+b[1])/2,steps=4);page.mouse.move(*b,steps=6);page.mouse.up()
def text_of(page):return page.locator('#text-editor').input_value()
with sync_playwright() as pw:
    launch={'headless':True,'args':['--no-sandbox']}
    if os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE'):launch['executable_path']=os.environ['PLAYWRIGHT_CHROMIUM_EXECUTABLE']
    browser=pw.chromium.launch(**launch)
    page=browser.new_page(viewport={'width':1920,'height':1080});page.on('pageerror',lambda e:errors.append(str(e)))
    library(page)

    # ---- 1. mouse drag across paragraphs: selection, formatting, delete/undo, typing over, Shift+click, Ctrl+A ----
    original=SANDBOX/'Download/프로젝트 일정.hwpx';before=sha(original)
    open_doc(page,'프로젝트 일정');start_edit(page)
    page.locator('.page').first.click(position={'x':120*SCALE(page.locator('.page').first.bounding_box()),'y':135*SCALE(page.locator('.page').first.bounding_box())})
    page.locator('#text-editor').wait_for();para0=text_of(page)
    drag(page,at(page,120,135),at(page,200,160));page.locator('#range-editor').wait_for()
    assert page.locator('.sel-mark').count()>=2,'engine rectangles cover both paragraphs'
    range_text=page.locator('#range-editor').input_value();assert '\n' in range_text and range_text.startswith('한글 문서 실')
    assert page.locator('#text-editor').count()==0
    # Ctrl+wheel zoom keeps the range (and does not change on plain clicks)
    box=page.locator('.page').first.bounding_box();page.mouse.move(box['x']+300,box['y']+300)
    marks=page.locator('.sel-mark').count();page.keyboard.down('Control');page.mouse.wheel(0,-120);page.keyboard.up('Control');pause(page)
    assert page.locator('#range-editor').count()==1 and page.locator('.sel-mark').count()==marks
    page.keyboard.press('Control+0');pause(page)
    page.keyboard.press('Control+b');pause(page,400)
    assert page.locator('[data-action="tb-bold"]').get_attribute('aria-pressed')=='true'
    assert page.locator('#range-editor').count()==1 and page.locator('[data-action="save"]').is_enabled()
    page.keyboard.press('Control+z');pause(page,400)
    assert page.locator('[data-action="tb-bold"]').get_attribute('aria-pressed')=='false' and page.locator('#range-editor').count()==1
    page.keyboard.press('Delete');page.locator('#text-editor').wait_for();pause(page)
    assert page.locator('#range-editor').count()==0 and '한글 문서 실' not in text_of(page)
    merged=text_of(page)
    page.keyboard.press('Control+z');page.locator('#range-editor').wait_for();assert page.locator('#range-editor').input_value()==range_text
    page.keyboard.type('새글');page.locator('#text-editor').wait_for();pause(page,400)
    assert text_of(page).startswith('새글'),text_of(page)
    for _ in range(3):
        if page.locator('#range-editor').count():break
        page.keyboard.press('Control+z');pause(page,400)   # typing after the replacement is its own undo step
    page.locator('#range-editor').wait_for()
    page.keyboard.press('Escape');page.locator('#text-editor').wait_for();assert page.locator('#range-editor').count()==0
    # Shift+click extends from the caret in the current paragraph to another paragraph
    page.locator('.page').first.click(position={'x':120*SCALE(box),'y':135*SCALE(box)});page.locator('#text-editor').wait_for();pause(page,500)
    page.keyboard.down('Shift');page.mouse.click(*at(page,200,160));page.keyboard.up('Shift');page.locator('#range-editor').wait_for()
    assert '\n' in page.locator('#range-editor').input_value()
    page.keyboard.press('ArrowRight');page.locator('#text-editor').wait_for()
    # Ctrl+A: the first press selects the paragraph (browser), the second the whole section
    page.keyboard.press('Control+a');page.keyboard.press('Control+a');page.locator('#range-editor').wait_for()
    assert re.search(r'선택한 \d+개 문단',page.locator('#range-editor').get_attribute('aria-label'))
    page.keyboard.press('Delete');page.locator('#text-editor').wait_for();pause(page,400)
    assert page.locator('[data-action="save"]').is_enabled()
    assert sha(original)==before,'editing never touches the document before Save'
    page.screenshot(path=str(QA/'dex-range.png'))
    page.keyboard.press('Control+z');page.locator('#range-editor').wait_for()
    # Highlighter mode applies its colour to the whole range as one command
    before_src=page.locator('.page img').first.get_attribute('src')
    page.locator('[data-action="tb-highlight"]').click();pause(page,800)
    assert page.locator('.page img').first.get_attribute('src')!=before_src and page.locator('#overlay').is_hidden()
    page.keyboard.press('Escape');page.keyboard.press('Escape');pause(page,300)
    page.locator('#text-editor').click() if page.locator('#text-editor').count() else None
    page.keyboard.press('Control+a');page.keyboard.press('Control+a');page.locator('#range-editor').wait_for()
    # Save keeps the formatting applied to the whole range
    page.keyboard.press('Control+i');pause(page,400)
    page.keyboard.press('Control+s');page.locator('[data-action="save-yes"]').click();page.locator('#overlay').wait_for(state='hidden');pause(page)
    assert sha(original)!=before and page.locator('[data-action="save"]').is_disabled()
    page.locator('[data-action="back"]').click() if page.locator('[data-action="back"]').is_visible() else page.keyboard.press('Escape')
    pause(page,400)

    # ---- 2. spreadsheet text into table cells ----
    page.goto(BASE);page.locator('.hw-doc').first.wait_for();open_doc(page,'2026년 사업계획');start_edit(page)
    cell=lambda x,y:page.locator('.page').first.click(position={'x':x*SCALE(page.locator('.page').first.bounding_box()),'y':y*SCALE(page.locator('.page').first.bounding_box())})
    cell(130,140);page.locator('#text-editor').wait_for();page.locator('[data-action="tb-table"]').click();page.locator('#grid-paste').wait_for()
    page.locator('#grid-paste').fill('가\t나\n다\t라😀');page.locator('[data-action="tb-grid-paste"]').click();pause(page,600)
    assert page.locator('#overlay').is_hidden(),'no error dialog'
    values=[]
    for x,y in [(130,140),(420,140),(130,158),(420,158)]:
        cell(x,y);page.locator('#text-editor').wait_for();pause(page,200);values.append(text_of(page))
    assert values==['가','나','다','라😀'],values
    page.locator('[data-action="tb-undo"]').click();pause(page,500);cell(130,140);pause(page,200);assert text_of(page)=='표 셀 시험'
    page.locator('[data-action="cancel-edit"]').click();page.locator('[data-action="cancel-yes"]').click() if page.locator('[data-action="cancel-yes"]').is_visible() else None
    pause(page,300);page.locator('[data-action="back"]').click();page.locator('#search').wait_for()

    # ---- 3. recovery after the app was killed during an unsaved edit ----
    page.goto(BASE);page.locator('.hw-doc').first.wait_for();open_doc(page,'주간 업무회의록');start_edit(page)
    weekly=SANDBOX/'Documents/주간 업무회의록.hwp';weekly_hash=sha(weekly)
    page.locator('.page').first.click(position={'x':120*SCALE(page.locator('.page').first.bounding_box()),'y':135*SCALE(page.locator('.page').first.bounding_box())})
    page.locator('#text-editor').fill('복구 시험 문장 😀');deadline=time.time()+15
    while time.time()<deadline and not native(page,'listDrafts')['data']:time.sleep(.3)
    drafts=native(page,'listDrafts')['data'];assert len(drafts)==1 and drafts[0]['name']=='주간 업무회의록.hwp' and drafts[0]['format']=='hwp',drafts
    assert sha(weekly)==weekly_hash,'the draft is separate from the document'
    page.reload();page.locator('.hw-doc').first.wait_for()          # process killed and restarted: only the draft survives
    page.locator('[data-action="draft-open"]').wait_for();assert '저장하지 못한 편집 내용' in page.locator('#sheet-title').inner_text()
    page.screenshot(path=str(QA/'dex-recovery-dialog.png'))
    page.locator('[data-action="draft-open"]').click();page.locator('.reader.is-editing').wait_for();pause(page,500)
    page.locator('.page').first.click(position={'x':120*SCALE(page.locator('.page').first.bounding_box()),'y':135*SCALE(page.locator('.page').first.bounding_box())});page.locator('#text-editor').wait_for()
    assert '복구 시험 문장 😀' in text_of(page)
    assert page.locator('[data-action="save"]').is_enabled(),'a recovered edit can be saved'
    page.locator('[data-action="save"]').click();pause(page,400)
    assert page.locator('#sheet-title').inner_text()=='폴더 선택','recovered edits are saved as a copy through the folder picker'
    page.locator('#filename').fill('복구본');page.locator('[data-action="folder-confirm"]').click();page.locator('#overlay').wait_for(state='hidden',timeout=15000)
    assert (weekly.parent/'복구본.hwp').is_file() and sha(weekly)==weekly_hash,'copy written; original untouched'
    assert native(page,'listDrafts')['data']==[],'draft removed after the copy was saved'
    page.locator('[data-action="back"]').click() if page.locator('[data-action="back"]').is_visible() else None
    pause(page,300)

    # ---- 3b. continuous editing (never a 4 s pause) still produces a recoverable draft within the maximum wait ----
    # A keystroke every second for ~38 s: the pause-only debounce would never fire. The draft must appear once DRAFT_MAX_WAIT_MS (30 s) after the
    # first unsaved edit has passed (and not before: no draft at 15 s proves it is the maximum wait and not a pause), while typing continues.
    page.goto(BASE);page.locator('.hw-doc').first.wait_for();open_doc(page,'주간 업무회의록');start_edit(page)
    weekly_hash=sha(weekly)
    page.locator('.page').first.click(position={'x':120*SCALE(page.locator('.page').first.bounding_box()),'y':135*SCALE(page.locator('.page').first.bounding_box())})
    page.locator('#text-editor').wait_for();base_text=text_of(page);assert native(page,'listDrafts')['data']==[]
    typed=0;started=time.time();first_draft=None;longest_gap=0;last_key=started;checked_early=False
    while time.time()-started<40:
        page.keyboard.insert_text('가');typed+=1;now=time.time();longest_gap=max(longest_gap,now-last_key);last_key=now
        elapsed=now-started
        if elapsed>15 and not checked_early:
            checked_early=True;assert native(page,'listDrafts')['data']==[],'no draft yet after 15 s of continuous typing: the maximum wait, not a pause, writes it'
        if first_draft is None and native(page,'listDrafts')['data']:first_draft=(elapsed,typed)
        if first_draft is not None and typed>=first_draft[1]+3:break          # typing went on after the draft was written
        pause(page,900)
    assert longest_gap<3,f'typing never paused for 4 s ({longest_gap:.1f} s)'
    assert first_draft is not None,'a draft was written during continuous typing'
    assert 28<=first_draft[0]<=38,f'draft appeared {first_draft[0]:.1f} s after the first edit (maximum wait 30 s)'
    drafts=native(page,'listDrafts')['data'];assert len(drafts)==1 and drafts[0]['name']=='주간 업무회의록.hwp',drafts
    assert sha(weekly)==weekly_hash,'the document on disk is never touched by a draft'
    page.reload();page.locator('.hw-doc').first.wait_for()                      # the process dies in the middle of the input
    page.locator('[data-action="draft-open"]').wait_for();page.locator('[data-action="draft-open"]').click();page.locator('.reader.is-editing').wait_for();pause(page,500)
    page.locator('.page').first.click(position={'x':120*SCALE(page.locator('.page').first.bounding_box()),'y':135*SCALE(page.locator('.page').first.bounding_box())});page.locator('#text-editor').wait_for()
    recovered=text_of(page);got=recovered.count('가')-base_text.count('가')
    # What is recoverable is the last successful snapshot: at least what was typed when it was taken, never more than was typed in total.
    assert first_draft[1]-2<=got<=typed,f'recovered {got} of {typed} typed characters (snapshot taken after about {first_draft[1]})'
    print(f'DRAFT_CONTINUOUS typed={typed} snapshot_after~{first_draft[1]} recovered={got} first_draft_at={first_draft[0]:.1f}s longest_key_gap={longest_gap:.1f}s',flush=True)
    assert sha(weekly)==weekly_hash,'recovery never touches the original'
    page.goto(BASE);page.locator('.hw-doc').first.wait_for();page.locator('[data-action="draft-discard"]').first.click();page.locator('[data-action="draft-discard-yes"]').click();pause(page,400)
    assert native(page,'listDrafts')['data']==[];page.locator('#sheet-title').count();pause(page,200)
    if page.locator('#overlay').is_visible():page.locator('[data-action="close"]').click()

    # ---- 3c. a draft that falls due DURING a slow save that then fails (external change) is written right after it, without a new edit ----
    # finishSave takes ~7 s; the 4 s pause timer is due in the middle of the save. While saving nothing is written (checked at 6 s). When the save fails
    # with the external-change conflict, the draft must appear by itself (no keystroke, no visibilitychange), the external bytes stay untouched, and
    # reload -> recover and reload -> discard both work.
    delay=lambda op,ms:urllib.request.urlopen(f'{BASE}/__delay?op={op}&ms={ms}').read()
    page.goto(BASE);page.locator('.hw-doc').first.wait_for();open_doc(page,'프로젝트 일정');start_edit(page)
    plan=SANDBOX/'Download/프로젝트 일정.hwpx'
    page.locator('.page').first.click(position={'x':120*SCALE(page.locator('.page').first.bounding_box()),'y':135*SCALE(page.locator('.page').first.bounding_box())})
    page.locator('#text-editor').wait_for();assert native(page,'listDrafts')['data']==[]
    marker_text=' N1복구시험';page.locator('#text-editor').fill(text_of(page)+marker_text);pause(page,700)
    external=plan.read_bytes()+b'\0';plan.write_bytes(external);external_hash=sha(plan)         # another app changed the file
    delay('finishSave',7000);started=time.time()
    page.keyboard.press('Control+s');page.locator('[data-action="save-yes"]').click()
    pause(page,5500);assert time.time()-started>5.4
    assert native(page,'listDrafts')['data']==[],'the pause timer was due during the save, yet nothing is written while the save runs'
    page.locator('#sheet-title').filter(has_text='다른 앱에서 문서가 바뀌었어요').wait_for(timeout=15000);saved_failed_at=time.time()
    delay('finishSave',0)
    deadline=time.time()+10
    while time.time()<deadline and not native(page,'listDrafts')['data']:time.sleep(.25)
    drafts=native(page,'listDrafts')['data'];assert len(drafts)==1 and drafts[0]['name']=='프로젝트 일정.hwpx',('draft after the failed save, with no new edit',drafts)
    assert plan.read_bytes()==external and sha(plan)==external_hash,'the externally changed original is never overwritten'
    assert not list(plan.parent.glob('프로젝트 일정_백업_*')),'no backup for a refused save'
    page.reload();page.locator('.hw-doc').first.wait_for();page.locator('[data-action="draft-open"]').wait_for()
    assert '저장하지 못한 편집 내용' in page.locator('#sheet-title').inner_text()
    page.locator('[data-action="draft-open"]').click();page.locator('.reader.is-editing').wait_for();pause(page,500)
    page.locator('.page').first.click(position={'x':120*SCALE(page.locator('.page').first.bounding_box()),'y':135*SCALE(page.locator('.page').first.bounding_box())});page.locator('#text-editor').wait_for()
    assert marker_text.strip() in text_of(page),'the draft holds the edit that was being saved'
    assert plan.read_bytes()==external,'recovering never touches the original'
    page.reload();page.locator('.hw-doc').first.wait_for();page.locator('[data-action="draft-discard"]').first.click();page.locator('[data-action="draft-discard-yes"]').click();pause(page,400)
    assert native(page,'listDrafts')['data']==[],'discard removes the draft';assert plan.read_bytes()==external
    if page.locator('#overlay').is_visible():page.locator('[data-action="close"]').click()
    plan.write_bytes(external[:-1])                                                              # restore the sandbox copy for the following sections

    # ---- 4. an external change blocks the in-place save and offers Save As ----
    page.goto(BASE);page.locator('.hw-doc').first.wait_for();open_doc(page,'회의 자료');start_edit(page)
    meeting=SANDBOX/'Download/회의 자료.hwp'
    page.locator('.page').first.click(position={'x':120*SCALE(page.locator('.page').first.bounding_box()),'y':135*SCALE(page.locator('.page').first.bounding_box())})
    page.locator('#text-editor').fill('충돌 시험');pause(page,300)
    external=meeting.read_bytes()+b'\0';meeting.write_bytes(external)    # another app changed the file
    page.keyboard.press('Control+s');page.locator('[data-action="save-yes"]').click();page.locator('#sheet-title').filter(has_text='다른 앱에서 문서가 바뀌었어요').wait_for()
    assert page.locator('#sheet [data-action="save-as"]').is_visible(),'the dialog offers Save As directly'
    assert meeting.read_bytes()==external,'the externally changed file is never overwritten'
    assert not list(meeting.parent.glob('회의 자료_백업_*')),'no backup is made for a refused save'

    # ---- 5. encrypted document to PDF from the library ----
    page.goto(BASE);page.locator('.hw-doc').first.wait_for()
    page.locator('#search').fill('암호 문서');locked=page.locator('[data-action="open"]').first;locked.click(button='right')
    page.locator('[data-action="pdf"]').click();page.locator('[data-action="folder-confirm"]').click()
    page.locator('#doc-password').wait_for();assert '암호가 걸리지 않아요' in page.locator('#sheet').inner_text()
    page.locator('#doc-password').fill('틀린 암호');page.locator('[data-action="pdf-pw-go"]').click();page.locator('#operation-error').filter(has_text='암호가 맞지 않아요').wait_for()
    assert not (SANDBOX/'Documents/암호 문서.pdf').exists(),'nothing is written for a wrong password'
    page.locator('#doc-password').fill('qa-only-2026');page.locator('[data-action="pdf-pw-go"]').click();page.locator('#overlay').wait_for(state='hidden',timeout=30000)
    assert (SANDBOX/'Documents/암호 문서.pdf').read_bytes().startswith(b'%PDF-')
    assert page.locator('#doc-password').count()==0,'the password field is gone'
    assert not list(SANDBOX.rglob('*.tmp'))
    browser.close()
server.terminate()
assert not errors,errors
print('Passed: drag/Shift+click/Ctrl+A ranges, range formatting/delete/typing/undo, cell grid paste, crash recovery, conflict dialog, encrypted PDF export')
