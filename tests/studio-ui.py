#!/usr/bin/env python3
"""End-to-end checks of the PRODUCTION shared desktop Studio bundle (app/src/main/assets/studio/**).

What is REAL here : the generated production bundle + MVP WASM, real keyboard/mouse events in Chromium, the real
                    studio-host.js, the strict production CSP (no bypass_csp), independent re-opening of every saved file in a
                    separate WASM instance (never through the page under test).
What is MOCKED    : OfflineNative (tests/preview-server.mjs: Node model of MainActivity's op protocol incl. its slots/limits).
What is NOT shown : Android WebView, MainActivity/FileStore/ExportStore native code (JVM tests), Samsung IME / Bluetooth / DeX hardware.
A pass here is a browser-contract pass, never an on-device pass.

  python3 tests/studio-ui.py [--only name,name] [--keep-going]
Failure artifacts (screenshot + console/page-error/native-log JSON) go to .qa/studio-ui-failures/.
Assertions are never relaxed to get a pass: a failing scenario stays failing and is reported as such.
"""
import argparse
import base64
import io
import zipfile
import xml.etree.ElementTree as ET
import hashlib
import json
import os
import shutil
import socket
import subprocess
import sys
import time
import traceback
import urllib.parse
import urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
QA = ROOT / '.qa'
FAIL_DIR = QA / 'studio-ui-failures'
FIXTURES = ROOT / 'tests/fixtures'
QA.mkdir(exist_ok=True)
FAIL_DIR.mkdir(exist_ok=True)
for old in FAIL_DIR.glob('*'):
    old.unlink()
ap = argparse.ArgumentParser()
ap.add_argument('--only', default='')
ap.add_argument('--keep-going', action='store_true', default=True)
ARGS = ap.parse_args()
assert (ROOT / 'app/src/main/assets/studio/index.html').is_file(), 'Build the shared Studio first: node scripts/build-studio.mjs'

PASSWORD = 'qa-only-2026'
SEEDED = {
    'Documents/주간 업무회의록.hwp': '문서.hwp', 'Download/프로젝트 일정.hwpx': '문서.hwpx',
    'Download/업무자료/2026년 사업계획 검토 의견 최종본.hwp': 'table.hwp', 'Documents/업무 인수인계서.hwpx': 'table.hwpx', 'Download/회의 자료.hwp': 'blank.hwp',
}
EXTRA = {'Documents/암호 문서.hwpx': ROOT / '.qa/fixtures/qa-locked.hwpx', 'Documents/암호 문서.hwp': ROOT / '.qa/fixtures/qa-locked.hwp',
         'Documents/긴 문서.hwpx': ROOT / '.qa/fixtures/qa-long.hwpx', 'Documents/두 구역.hwpx': FIXTURES / 'two-sections.hwpx', 'Documents/글꼴 시험.hwpx': ROOT / '.qa/fixtures/qa-font-probe.hwpx'}
HWPX_NAME, HWP_NAME = '프로젝트 일정.hwpx', '주간 업무회의록.hwp'
HWPX, HWP = 'Download/' + HWPX_NAME, 'Documents/' + HWP_NAME

# ------------------------------------------------------------------ server / fixtures
subprocess.run(['node', 'tests/build-qa-fixtures.mjs'], cwd=ROOT, check=True, stdout=subprocess.DEVNULL)
# A document whose two paragraphs ('i'*24 and 'W'*24) name the family 'QA Probe' (made by a separate WASM instance, not by Studio): the only way a
# host font changes the rendering is when a document names the family, so this is the independent pixel probe for the font pipeline.
PROBE_MAKER = '''import fs from 'node:fs'; import {initSync,HwpDocument} from './app/src/main/assets/engine/rhwp.js';
initSync({module:fs.readFileSync('app/src/main/assets/engine/rhwp_bg.wasm')});
const d=new HwpDocument(fs.readFileSync('tests/fixtures/blank.hwpx'));
d.insertText(0,0,0,'i'.repeat(24)); d.splitParagraph(0,0,24); d.insertText(0,1,0,'W'.repeat(24)); d.deleteText(0,1,24,6);
const id=d.findOrCreateFontId('QA Probe'); for (const p of [0,1]) d.applyCharFormat(0,p,0,24,JSON.stringify({fontId:id}));
fs.writeFileSync('.qa/fixtures/qa-font-probe.hwpx',d.exportHwpx()); d.free();'''
subprocess.run(['node', '--input-type=module', '-e', PROBE_MAKER], cwd=ROOT, check=True)
with socket.socket() as probe:
    probe.bind(('127.0.0.1', 0))
    PORT = int(os.environ.get('STUDIO_UI_PORT') or probe.getsockname()[1])
server = subprocess.Popen(['node', 'tests/preview-server.mjs', str(PORT)], cwd=ROOT, stdout=subprocess.PIPE, text=True)
line = server.stdout.readline().strip()
assert 'sandbox ' in line, line
VOLUME = Path(line.split('sandbox ', 1)[1])  # the server already prints the storage volume itself
BASE = f'http://localhost:{PORT}'


def ctl(path, data=None):
    request = urllib.request.Request(BASE + path, data=data, method='POST' if data is not None else 'GET')
    with urllib.request.urlopen(request, timeout=30) as response:
        body = response.read()
    return json.loads(body) if body[:1] in b'{[' else body.decode()


def native_log():
    return ctl('/__log')['ops']


def reset_world(strict=True):
    for rel, name in SEEDED.items():
        shutil.copyfile(FIXTURES / name, VOLUME / rel)
    for rel, src in EXTRA.items():
        if src.is_file():
            shutil.copyfile(src, VOLUME / rel)
    for folder in ['Documents', 'Download', 'Pictures']:
        for path in (VOLUME / folder).iterdir():
            if path.is_file() and ('_백업_' in path.name or path.name.startswith('qa-')):
                path.unlink()
    ctl('/__reset')
    ctl('/__config?strict=' + ('1' if strict else '0'))
    ctl('/__grant?1')


def sha(data):
    return hashlib.sha256(data).hexdigest()


INSPECT = '''import fs from 'node:fs'; import {initSync,HwpDocument} from './app/src/main/assets/engine/rhwp.js';
initSync({module:fs.readFileSync('app/src/main/assets/engine/rhwp_bg.wasm')});
const [file,password,probes]=[process.argv[1],process.argv[2],JSON.parse(process.argv[3])];
const bytes=fs.readFileSync(file); let doc,opened='plain';
try{doc=new HwpDocument(bytes);}catch(e){ if(!password) {console.log(JSON.stringify({openError:String(e).slice(0,120)}));process.exit(0);} doc=HwpDocument.openWithPassword(bytes,password);opened='password'; }
try{const pick=o=>{const p=JSON.parse(doc.getCharPropertiesAt(...o));return {bold:p.bold,italic:p.italic,underline:p.underline,font:p.fontFamily,size:p.fontSize,color:p.textColor};};
console.log(JSON.stringify({opened,format:doc.getSourceFormat(),pages:doc.pageCount(),text:JSON.parse(doc.getTextFileUnicode()),chars:probes.map(pick),
 controls:JSON.parse(doc.getControls()).map(c=>c.ctrlId),memos:JSON.parse(doc.getMemoList())}));}finally{doc.free();}'''


def inspect_file(path, password='', probes=()):
    out = subprocess.check_output(['node', '--input-type=module', '-e', INSPECT, str(path), password, json.dumps([list(p) for p in probes])], cwd=ROOT, text=True)
    return json.loads(out)


# ------------------------------------------------------------------ scenario machinery
RESULTS = {'environment': 'Chromium + production Studio bundle/WASM + strict CSP + mocked OfflineNative (not Android WebView, not native Java, not DeX)',
           'scenarios': [], 'skipped': [], 'studioBuild': json.loads((ROOT / 'app/src/main/assets/studio/build-info.json').read_text())}
playwright_ctx = sync_playwright().start()
browser = playwright_ctx.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE', '/usr/bin/chromium'), args=['--no-sandbox'])


class Session:
    """One fresh browser context + page with global safety collectors. Nothing is filtered: any page error fails the scenario."""

    def __init__(self, name, viewport=(1920, 1080)):
        self.name = name
        self.viewport = viewport
        self.context = browser.new_context(viewport={'width': viewport[0], 'height': viewport[1]}, permissions=['clipboard-read', 'clipboard-write'])
        self.page = self.context.new_page()
        self.cdp = self.context.new_cdp_session(self.page)
        self.console, self.page_errors, self.external, self.bad_http, self.csp = [], [], [], [], []
        self.page.on('console', lambda m: self.console.append((m.type, m.text)) if m.type in ('error', 'warning') else None)
        self.page.on('pageerror', lambda e: self.page_errors.append(str(e)))
        self.page.on('request', lambda r: self.external.append(r.url) if r.url.startswith(('http:', 'https:', 'ws:', 'wss:')) and not r.url.startswith(BASE + '/') else None)
        self.page.on('response', lambda r: self.bad_http.append((r.status, r.url)) if r.status >= 400 else None)
        self.page.add_init_script('addEventListener("securitypolicyviolation", e => (window.__cspViolations = window.__cspViolations || []).push(e.violatedDirective + " " + e.blockedURI));')
        self.dialogs = []
        self.page.on('dialog', lambda d: (self.dialogs.append((d.type, d.message)), d.dismiss()))

    # CDP Runtime.evaluate is exempt from the page CSP; page.wait_for_function would need unsafe-eval, which the product rightly forbids.
    def sleep(self, seconds):
        # Playwright's sync API only dispatches page events (dialogs, console, responses) while it is being called into.
        self.page.wait_for_timeout(int(seconds * 1000))

    def ev(self, expression):
        result = self.cdp.send('Runtime.evaluate', {'expression': expression, 'awaitPromise': True, 'returnByValue': True})
        if 'exceptionDetails' in result:
            details = result['exceptionDetails']
            raise RuntimeError(details.get('exception', {}).get('description') or str(details))
        return result['result'].get('value')

    def wait(self, expression, timeout=30, what=''):
        end = time.time() + timeout
        last = None
        while time.time() < end:
            try:
                value = self.ev(expression)
                if value:
                    return value
            except RuntimeError as error:
                last = error
            self.sleep(0.1)
        raise AssertionError(f'timed out waiting for {what or expression} (last error: {last})')

    def state(self):
        return self.ev('(() => { const s = window.rhwpStudio.android.getState(); return {...s, fileHandle: !!s.fileHandle}; })()')

    def wait_state(self, **expected):
        def matches():
            current = self.state()
            return all(current.get(key) == value for key, value in expected.items())
        end = time.time() + 30
        while time.time() < end:
            if matches():
                return self.state()
            self.sleep(0.1)
        raise AssertionError(f'state never became {expected}; last {self.state()}')

    def boot(self, blank=True):
        ctl_get = self.page.goto(BASE + '/studio/index.html')
        assert ctl_get.ok, ctl_get.status
        self.wait("window.rhwpStudio && window.rhwpStudio.android && window.AndroidStudioHost && window.AndroidStudioHost.startupState === 'ready' && !!document.querySelector('.android-host-config')", 120, 'Studio + host ready')
        if blank:  # the desktop starts on an untitled blank document (initialised asynchronously); with pending recovery drafts it asks first
            self.wait_state(hasDocument=True, fileName='새 문서.hwp')
        return self

    def relaunch(self):
        """Simulate the app process being killed and started again (Android has no reload): earlier incarnation must already be clean."""
        self.assert_safe()
        self.context.close()
        ctl('/__restart')
        Session.__init__(self, self.name, self.viewport)
        return self.boot(blank=False)

    def host_dialog(self):
        return self.page.locator('dialog.android-host-dialog')

    def studio_dialog(self):
        return self.page.locator('.dialog-wrap')

    def open_doc(self, name, key='Control+o'):
        self.page.keyboard.press(key)
        self.page.get_by_role('searchbox', name='문서 이름 검색').fill(name)
        self.page.locator('.android-host-list button').filter(has_text=name).first.click()
        self.wait("document.querySelectorAll('#scroll-container canvas').length > 0", 60, 'document canvas')
        self.wait_state(hasDocument=True)
        self.sleep(0.4)
        return self.state()

    def caret_box(self):
        return self.ev("(() => { const r = document.querySelector('.caret').getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; })()")

    def click_document(self, dy=120):
        box = self.page.locator('#scroll-container canvas').first.bounding_box()
        self.page.mouse.click(box['x'] + box['width'] / 2, box['y'] + dy)
        self.sleep(0.2)

    def choose_destination(self, name, folders=()):
        dialog = self.host_dialog()
        dialog.get_by_role('heading', name='다른 이름으로 저장').wait_for(timeout=20000)
        dialog.locator('.android-host-path').filter(has_text='/').wait_for()
        # The dialog starts in the document's folder, the last save folder or Documents: walk up to the storage root first.
        up, where = dialog.get_by_role('button', name='상위 폴더'), dialog.locator('.android-host-path')
        while up.is_enabled():
            before = where.inner_text()
            up.click()
            self.wait("document.querySelector('dialog.android-host-dialog .android-host-path').textContent !== " + json.dumps(before), 15, 'parent folder listed')
        for folder in folders:
            dialog.locator('.android-host-list button').filter(has_text='📁 ' + folder).click()
            dialog.locator('.android-host-path').filter(has_text=folder).wait_for()
        dialog.get_by_label('파일 이름').fill(name)
        dialog.get_by_role('button', name='저장', exact=True).click()
        dialog.wait_for(state='detached', timeout=20000)

    def confirm_studio_filename(self):
        """Studio's own 'save as' dialog (file name + 암호 설정) precedes the host destination picker."""
        self.studio_dialog().get_by_role('button', name='확인').click()

    def button(self, name):
        return self.page.get_by_role('button', name=name, exact=True)

    def take_alert(self, fragment, timeout=15):
        """Studio reports save failures with a native alert() that MainActivity maps to a local Android dialog. Exactly one is expected."""
        end = time.time() + timeout
        while time.time() < end:
            for index, (_, message) in enumerate(self.dialogs):
                if fragment in message:
                    del self.dialogs[index]
                    return message
            self.sleep(0.1)
        raise AssertionError(f'no native alert containing {fragment!r}; saw {self.dialogs}')

    def take_console_error(self, fragment):
        for index, (kind, text) in enumerate(self.console):
            if kind == 'error' and fragment in text:
                del self.console[index]
                return text
        raise AssertionError(f'no console error containing {fragment!r}; saw {self.console}')

    def screenshot(self, label):
        path = FAIL_DIR.parent / f'studio-ui-{self.name}-{label}.png'
        self.page.screenshot(path=str(path))
        return path

    def assert_safe(self):
        violations = self.ev('window.__cspViolations || []')
        assert not self.page_errors, ('page errors', self.page_errors)
        assert not self.external, ('external requests', self.external)
        assert not self.bad_http, ('HTTP >= 400 responses', self.bad_http)
        assert not violations, ('CSP violations', violations)
        errors = [m for m in self.console if m[0] == 'error']
        assert not errors, ('console errors', errors)
        assert not self.dialogs, ('native window.alert/confirm/prompt dialogs', self.dialogs)

    def close(self):
        self.context.close()


SCENARIOS = []


def wait_for_file(path, session, timeout=30):
    end = time.time() + timeout
    while time.time() < end and not path.exists():
        session.sleep(0.2)
    assert path.exists(), f'{path.name} was never written'


def scenario(function):
    SCENARIOS.append(function)
    return function


def fresh(name, viewport=(1920, 1080), strict=True):
    reset_world(strict)
    return Session(name, viewport).boot()


def run_all():
    wanted = {x for x in ARGS.only.split(',') if x}
    failed = 0
    for function in SCENARIOS:
        name = function.__name__
        if wanted and name not in wanted:
            continue
        started = time.time()
        holder = {}
        try:
            function(holder)
            if 'session' in holder:
                holder['session'].assert_safe()
            RESULTS['scenarios'].append({'name': name, 'passed': True, 'seconds': round(time.time() - started, 1), 'doc': (function.__doc__ or '').strip()})
            print(f'PASS: {name} - {(function.__doc__ or "").strip()}', flush=True)
        except BaseException as error:  # noqa: BLE001 - report every kind of failure, then continue with the next scenario
            failed += 1
            session = holder.get('session')
            artifact = {'error': ''.join(traceback.format_exception_only(type(error), error)).strip(), 'trace': traceback.format_exc()}
            if session:
                try:
                    session.page.screenshot(path=str(FAIL_DIR / f'{name}.png'))
                    artifact.update(console=session.console, pageErrors=session.page_errors, external=session.external, badHttp=session.bad_http,
                                    nativeLog=native_log()[-60:], nativeDialogs=session.dialogs,
                                    visibleDialogs=session.ev("[...document.querySelectorAll('dialog[open], .dialog-wrap, [role=alert]')].map(d => d.innerText.slice(0, 300))"))
                except Exception as inner:  # noqa: BLE001
                    artifact['artifactError'] = str(inner)
            (FAIL_DIR / f'{name}.json').write_text(json.dumps(artifact, ensure_ascii=False, indent=2))
            RESULTS['scenarios'].append({'name': name, 'passed': False, 'seconds': round(time.time() - started, 1), 'error': artifact['error'], 'doc': (function.__doc__ or '').strip()})
            print(f'FAIL: {name}: {artifact["error"]}', flush=True)
        finally:
            if holder.get('session'):
                try:
                    holder['session'].close()
                except Exception:  # noqa: BLE001
                    pass
    return failed


# ================================================================== scenarios
@scenario
def boot_production_surface(h):
    """Production bundle boots: eight desktop menus, no DEV/wasm globals, strict CSP, host ready, no network"""
    s = h['session'] = fresh('boot')
    s.wait("document.querySelectorAll('#menu-bar > .menu-item').length === 8", 30, 'eight menus')
    leaked = s.ev("['__wasm','__eventBus','__documentState','__autosaveManager','__theme','__localFonts','__studio'].filter(k => k in window)")
    assert leaked == [], f'DEV globals exposed in production: {leaked}'
    assert 'wasm' not in s.ev('Object.keys(window.rhwpStudio)')
    api = s.ev('Object.keys(window.rhwpStudio.android).sort()')
    for name in ['close', 'confirmClose', 'flushRecovery', 'getState', 'setSaveGuard']:
        assert name in api, (name, api)
    csp = s.ev("document.querySelector('meta[http-equiv=Content-Security-Policy]')?.content || ''")
    assert "script-src 'self' 'wasm-unsafe-eval'" in csp and 'unsafe-eval' not in csp.replace('wasm-unsafe-eval', '') and "frame-src 'none'" in csp and "connect-src 'self'" in csp, csp
    assert s.ev('window.AndroidStudioHost === window.rhwpAndroidHost') is True
    initial = s.state()
    assert initial == {'hasDocument': True, 'fileName': '새 문서.hwp', 'dirty': False, 'encrypted': False, 'format': 'hwp', 'fileHandle': False}, initial
    s.sleep(1)
    s.screenshot('boot')


@scenario
def command_inventory_parity(h):
    """Every desktop command id of the pinned PC inventory is registered in the Android bundle (no decorative or missing commands)"""
    inventory = Path(os.environ.get('STUDIO_COMMAND_INVENTORY', str(ROOT / 'tests/studio-command-inventory.json')))
    assert inventory.is_file(), f'Pinned desktop command inventory missing: {inventory}'
    wanted = json.loads(inventory.read_text())
    wanted_ids = sorted({i for ids in wanted.values() for i in ids})
    s = h['session'] = fresh('inventory')
    have = set(s.ev('window.rhwpStudio.automation.listCommands().map(c => c.id)'))
    missing = [i for i in wanted_ids if i not in have]
    assert len(wanted_ids) >= 150, len(wanted_ids)
    assert not missing, f'desktop commands missing in the Android bundle: {missing}'
    RESULTS['commandParity'] = {'desktop': len(wanted_ids), 'android': len(have), 'extraInAndroid': sorted(have - set(wanted_ids))}


@scenario
def open_edit_save_independent_reopen(h):
    """Ctrl+O -> real keyboard typing, Shift+arrow selection, Ctrl+B, undo/redo -> Ctrl+S; reopened independently: text+bold, backup of ORIGINAL, SHA baseline"""
    s = h['session'] = fresh('edit-save')
    original = (VOLUME / HWPX).read_bytes()
    state = s.open_doc('프로젝트 일정')
    assert state['fileName'] == HWPX_NAME and state['format'] == 'hwpx' and not state['dirty'], state
    s.click_document()
    s.page.keyboard.press('Control+Home')
    s.page.keyboard.type('DeX ')
    s.page.keyboard.insert_text('입력 ')
    s.wait_state(dirty=True)
    s.page.keyboard.press('Control+Home')
    for _ in range(3):
        s.page.keyboard.press('Shift+ArrowRight')
    s.page.keyboard.press('Control+b')
    s.wait("document.querySelector('#btn-bold').classList.contains('active')", 10, 'bold active on selection')
    s.page.keyboard.press('Control+z')
    s.wait("!document.querySelector('#btn-bold').classList.contains('active')", 10, 'undo clears bold')
    s.page.keyboard.press('Control+Shift+z')
    s.wait("document.querySelector('#btn-bold').classList.contains('active')", 10, 'redo restores bold')
    s.page.keyboard.press('Control+s')
    s.wait_state(dirty=False)
    saved = inspect_file(VOLUME / HWPX, probes=[(0, 0, 0), (0, 0, 2), (0, 0, 5)])
    assert saved['text'].startswith('DeX 입력 '), saved['text'][:60]
    assert saved['format'] == 'hwpx' and saved['pages'] == 1, saved
    assert [c['bold'] for c in saved['chars']] == [True, True, False], saved['chars']
    backups = list((VOLUME / 'Download').glob('*_백업_*.hwpx'))
    assert len(backups) == 1 and backups[0].read_bytes() == original, 'original backup missing or not byte-identical'
    begin = [o for o in native_log() if o['op'] == 'beginSave']
    assert begin[0]['args']['replace'] is True and begin[0]['args']['studio'] is True and begin[0]['args']['sha'] == sha(original), begin[0]
    # second save uses the new baseline; both edits survive a second independent reopen
    after_first = sha((VOLUME / HWPX).read_bytes())
    s.page.keyboard.press('Control+End')
    s.page.keyboard.type(' 끝')
    s.wait_state(dirty=True)
    s.page.keyboard.press('Control+s')
    s.wait_state(dirty=False)
    again = inspect_file(VOLUME / HWPX)
    assert again['text'].startswith('DeX 입력 ') and again['text'].rstrip().endswith('끝'), again['text']
    second = [o for o in native_log() if o['op'] == 'beginSave'][1]
    assert second['args']['replace'] is True and second['args']['sha'] == after_first != sha(original), 'second save must be conditional on the FIRST save\'s hash'


@scenario
def mouse_keyboard_selection_and_tooltips(h):
    """Mouse double-click/drag selection, caret keys and hover tooltips with shortcut text behave like the desktop"""
    s = h['session'] = fresh('mouse')
    s.open_doc('프로젝트 일정')
    for button, shortcut in [('#btn-bold', 'Ctrl+B'), ('#btn-italic', 'Ctrl+I'), ('#btn-underline', 'Ctrl+U')]:
        s.page.locator(button).hover()
        tip = s.page.get_by_role('tooltip')
        tip.wait_for(timeout=5000)
        assert shortcut in tip.inner_text(), (button, tip.inner_text())
        s.page.mouse.move(5, 5)
        tip.wait_for(state='hidden', timeout=5000)
    s.click_document()
    s.page.keyboard.press('Control+Home')
    x, y, _, height = s.caret_box()
    mid = y + height / 2
    s.page.mouse.move(x + 1, mid)
    s.page.mouse.down()
    s.page.mouse.move(x + 40, mid, steps=8)
    s.page.mouse.up()  # physical drag selection over the first characters
    s.page.keyboard.press('Control+b')
    s.page.mouse.click(x + 1, mid)  # collapse, then Shift+click extends the selection (mouse + keyboard modifier)
    s.page.keyboard.down('Shift')
    s.page.mouse.click(x + 70, mid)
    s.page.keyboard.up('Shift')
    s.page.keyboard.press('Control+i')
    s.page.keyboard.press('Control+s')
    s.wait_state(dirty=False)
    saved = inspect_file(VOLUME / HWPX, probes=[(0, 0, i) for i in range(0, 7)])
    bold = [c['bold'] for c in saved['chars']]
    italic = [c['italic'] for c in saved['chars']]
    assert bold[0] is True and bold[-1] is False, ('drag selection should bold only the dragged leading characters', bold)
    assert italic[0] is True and italic[-1] is False and sum(italic) > sum(bold), ('Shift+click should extend the selection further than the drag', italic, bold)


@scenario
def desktop_shortcuts_open_real_dialogs(h):
    """Physical shortcuts reach the real desktop commands (Alt+L, Alt+T, F7, Ctrl+F, Ctrl+F2, Alt+G, Ctrl+Enter page break)"""
    s = h['session'] = fresh('shortcuts')
    s.open_doc('프로젝트 일정')
    s.click_document()
    # Alt+L / Alt+T act on a selection exactly like the desktop (the command returns without one)
    overlay = "document.querySelectorAll('.modal-overlay, .find-dialog, .dialog-wrap').length"
    needed_cancel_button, focus_lost_after = [], []

    def select_three():
        s.click_document()
        s.page.keyboard.press('Control+Home')
        for _ in range(3):
            s.page.keyboard.press('Shift+ArrowRight')
    for combo, title in [('Alt+l', '글자 모양'), ('Alt+t', '문단 모양'), ('F7', '편집 용지'), ('Control+f', '찾기'), ('Control+F2', '찾아 바꾸기'), ('Alt+g', '찾아가기')]:
        select_three()
        s.page.keyboard.press(combo)
        try:
            s.wait(f"[...document.querySelectorAll('.modal-overlay, .find-dialog, .dialog-wrap')].some(d => d.innerText.includes({json.dumps(title)}))", 8, f'{combo} -> {title}')
        finally:
            s.sleep(0.5)
            s.page.keyboard.press('Escape')
            s.sleep(0.5)
        if s.ev(f"{overlay} > 0"):
            # Upstream desktop behaviour (identical code in the PC build): 문단 모양 etc. listen for Escape on the dialog itself, so it only closes
            # when focus is inside it. The user path is the 취소 button; record it instead of hiding it.
            needed_cancel_button.append(title)
            s.page.locator('.modal-overlay').get_by_role('button', name='취소').click()
        s.wait(f"{overlay} === 0", 8, f'{title} closed')
        if s.ev("document.activeElement.tagName") == 'BODY':
            focus_lost_after.append(title)  # inherited desktop behaviour: the next shortcut needs a click into the document first
    RESULTS['dialogsClosedOnlyByCancelButton'] = needed_cancel_button
    RESULTS['dialogsLeavingFocusOnBody'] = focus_lost_after
    s.click_document()
    before = s.ev("document.getElementById('sb-page').innerText")
    s.page.keyboard.press('Control+Home')
    s.page.keyboard.press('Control+Enter')
    s.wait_state(dirty=True)
    s.wait(f"document.getElementById('sb-page').innerText !== {json.dumps(before)}", 15, 'page break adds a page')


@scenario
def save_as_copy_and_format_conversion(h):
    """Save As (Ctrl+Shift+S) writes a NEW copy and retargets Ctrl+S to it; HWPX->HWP conversion is a new HWP file; originals untouched"""
    s = h['session'] = fresh('save-as')
    original = (VOLUME / HWPX).read_bytes()
    s.open_doc('프로젝트 일정')
    s.click_document()
    s.page.keyboard.press('Control+Home')
    s.page.keyboard.type('복사본 ')
    s.page.keyboard.press('Control+Shift+s')
    s.confirm_studio_filename()
    s.choose_destination('qa-사본.hwpx', ['Documents'])
    s.wait_state(dirty=False)
    copy = VOLUME / 'Documents/qa-사본.hwpx'
    assert copy.is_file() and (VOLUME / HWPX).read_bytes() == original, 'original must be untouched by Save As'
    assert inspect_file(copy)['text'].startswith('복사본 ')
    copy_bytes = copy.read_bytes()
    assert s.state()['fileName'] == 'qa-사본.hwpx', s.state()
    s.page.keyboard.type('더 ')
    s.page.keyboard.press('Control+s')  # now retargeted: replaces the copy with its own baseline and original backup
    s.wait_state(dirty=False)
    text = inspect_file(copy)['text']
    assert '더 ' in text and '복사본 ' in text, text
    saves = [o for o in native_log() if o['op'] == 'beginSave']
    assert saves[0]['args']['replace'] is False and saves[1]['args']['replace'] is True and saves[1]['args']['sha'] == sha(copy_bytes), saves
    assert (VOLUME / HWPX).read_bytes() == original
    # explicit conversion HWPX -> HWP
    s.page.locator('#menu-bar > .menu-item').first.click()
    s.page.locator('.md-item[data-cmd="file:save-as-hwp"]').click()
    s.confirm_studio_filename()
    s.choose_destination('qa-변환.hwp', ['Documents'])
    s.wait_state(dirty=False)
    converted = inspect_file(VOLUME / 'Documents/qa-변환.hwp')
    assert converted['format'] == 'hwp' and '복사본' in converted['text'], converted
    assert (VOLUME / HWPX).read_bytes() == original


@scenario
def new_document_and_unsaved_guard(h):
    """Alt+N creates a document; saving a new doc creates a file; with unsaved changes Alt+N asks (Cancel keeps, Don't save discards, Save saves first)"""
    s = h['session'] = fresh('new-doc')
    s.page.locator('body').click()
    s.page.keyboard.press('Alt+n')
    s.wait_state(hasDocument=True)
    s.click_document(60)
    s.page.keyboard.type('새 문서 본문')
    s.wait_state(dirty=True)
    s.page.keyboard.press('Control+s')
    s.choose_destination('qa-new.hwp', ['Documents'])
    s.wait_state(dirty=False)
    assert '새 문서 본문' in inspect_file(VOLUME / 'Documents/qa-new.hwp')['text']
    new_ids = [o for o in native_log() if o['op'] == 'newDocument']
    assert new_ids, 'a native-issued new-document identity is required for the first save'
    # unsaved guard: Cancel
    s.page.keyboard.type('수정1')
    s.wait_state(dirty=True)
    s.page.keyboard.press('Alt+n')
    dialog = s.studio_dialog()
    dialog.get_by_text('저장하지 않은 변경사항').wait_for(timeout=10000)
    dialog.get_by_role('button', name='취소').click()
    assert s.state()['dirty'] is True and s.state()['fileName'] == 'qa-new.hwp'
    # Save
    s.page.keyboard.press('Alt+n')
    s.studio_dialog().get_by_role('button', name='저장', exact=True).click()
    s.wait("window.rhwpStudio.android.getState().fileName !== 'qa-new.hwp' && !window.rhwpStudio.android.getState().dirty", 30, 'saved then replaced by a new document')
    assert '수정1' in inspect_file(VOLUME / 'Documents/qa-new.hwp')['text']
    # Don't save
    s.click_document(60)
    s.page.keyboard.type('버릴내용')
    s.page.keyboard.press('Alt+n')
    s.studio_dialog().get_by_role('button', name='저장 안 함').click()
    s.wait_state(dirty=False)
    assert '버릴내용' not in inspect_file(VOLUME / 'Documents/qa-new.hwp')['text']


@scenario
def close_confirm_and_android_back(h):
    """Android Back / confirmClose: clean exits; dirty asks; Cancel stays; Save saves then exits; Discard exits and removes the recovery draft; failed save never exits"""
    s = h['session'] = fresh('back')
    exits = lambda: len([o for o in native_log() if o['op'] == 'exit'])  # noqa: E731
    s.open_doc('프로젝트 일정')
    s.ev('window.AppBack(), true')
    s.sleep(0.5)
    assert exits() == 1, 'clean document: Back leaves the app'
    s.click_document()
    s.page.keyboard.type('Back ')
    s.wait_state(dirty=True)
    s.ev('window.__back = window.AppBack(), true')
    s.studio_dialog().get_by_text('저장하지 않은 변경사항').wait_for(timeout=10000)
    s.studio_dialog().get_by_role('button', name='취소').click()
    s.wait('window.__back.then(() => true)')
    assert exits() == 1 and s.state()['dirty'] is True
    # failed save inside the guard: stays, native error visible once, no exit
    ctl('/__fail?op=finishSave&message=' + urllib.parse.quote('디스크 오류') + '&times=1')
    s.ev('window.__back = window.AppBack(), true')
    s.studio_dialog().get_by_role('button', name='저장', exact=True).click()
    assert '디스크 오류' in s.take_alert('디스크 오류'), 'the native failure message must reach the user exactly once'
    s.take_console_error('저장 실패')
    s.sleep(0.5)
    assert not s.dialogs, ('failure must be reported once', s.dialogs)
    assert exits() == 1 and s.state()['dirty'] is True and (VOLUME / HWPX).read_bytes() == (FIXTURES / '문서.hwpx').read_bytes()
    # discard
    s.ev('window.rhwpStudio.android.flushRecovery()')
    assert any(o['op'] == 'finishDraft' for o in native_log()), 'draft written before discard'
    s.ev('window.__back = window.AppBack(), true')
    s.studio_dialog().get_by_role('button', name='저장 안 함').click()
    s.wait('window.__back.then(() => true)')
    s.sleep(0.5)
    assert exits() == 2
    drafts = s.ev("AndroidStudioHost.request('listDrafts').then(rows => rows.length)")
    assert drafts == 0, 'discarding the document must delete its recovery draft'


@scenario
def failed_and_conflicting_saves_stay_dirty(h):
    """Native write failure and external-change conflict keep the document dirty, show the native message once, never touch the file; Save As copy then works"""
    s = h['session'] = fresh('save-fail')
    original = (VOLUME / HWPX).read_bytes()
    s.open_doc('프로젝트 일정')
    s.click_document()
    s.page.keyboard.type('실패시험 ')
    ctl('/__fail?op=finishSave&message=' + urllib.parse.quote('저장 공간이 부족해요') + '&times=1')
    s.page.keyboard.press('Control+s')
    s.take_alert('저장 공간이 부족해요')
    s.take_console_error('저장 실패')
    assert s.state()['dirty'] is True and (VOLUME / HWPX).read_bytes() == original
    s.page.keyboard.press('Control+s')  # retry succeeds
    s.wait_state(dirty=False)
    assert '실패시험' in inspect_file(VOLUME / HWPX)['text']
    external = b'changed by another app'
    (VOLUME / HWPX).write_bytes(external)
    s.page.keyboard.type('충돌 ')
    s.wait_state(dirty=True)
    s.page.keyboard.press('Control+s')
    s.take_alert('다른 앱')
    s.take_console_error('저장 실패')
    assert s.state()['dirty'] is True and (VOLUME / HWPX).read_bytes() == external, 'conflict must never overwrite the other app\'s file'
    s.page.keyboard.press('Control+Shift+s')
    s.confirm_studio_filename()
    s.choose_destination('qa-conflict-copy.hwpx', ['Documents'])
    s.wait_state(dirty=False)
    assert '충돌' in inspect_file(VOLUME / 'Documents/qa-conflict-copy.hwpx')['text'] and (VOLUME / HWPX).read_bytes() == external


@scenario
def private_recovery_restore_and_discard(h):
    """Edits are flushed to the private native store as an HWP draft, restored after a reload (saved only as a copy), and deleted on discard/save"""
    s = h['session'] = fresh('recovery')
    original = (VOLUME / HWPX).read_bytes()
    s.open_doc('프로젝트 일정')
    s.click_document()
    s.page.keyboard.type('복구시험 ')
    s.wait_state(dirty=True)
    assert s.ev('window.rhwpStudio.android.flushRecovery()') == {'ok': True}
    drafts = ctl('/__log')['ops']
    begin = [o for o in drafts if o['op'] == 'beginDraft'][-1]['args']
    assert begin['docId'].startswith('studio:') and begin['format'] == 'hwp' and begin['folder'] == 'hwpx' and begin['encrypted'] is False, begin
    s.relaunch()
    s.studio_dialog().locator('.dialog-title').filter(has_text='문서 복구').wait_for(timeout=30000)
    s.studio_dialog().get_by_role('button', name='복구', exact=True).click()
    s.wait_state(hasDocument=True, dirty=True)
    s.page.keyboard.press('Control+s')
    s.confirm_studio_filename() if s.studio_dialog().count() else None
    s.choose_destination('qa-복구본.hwp', ['Documents'])
    s.wait_state(dirty=False)
    assert '복구시험' in inspect_file(VOLUME / 'Documents/qa-복구본.hwp')['text'] and (VOLUME / HWPX).read_bytes() == original
    remaining = s.ev("AndroidStudioHost.request('listDrafts').then(rows => rows.length)")
    assert remaining == 0, 'saving the restored document must remove the draft'
    # discard path
    s.page.keyboard.type('또 ')
    s.wait_state(dirty=True)
    s.ev('window.rhwpStudio.android.flushRecovery()')
    s.relaunch()
    s.studio_dialog().locator('.dialog-title').filter(has_text='문서 복구').wait_for(timeout=30000)
    s.studio_dialog().get_by_role('button', name='삭제').click()
    s.sleep(0.5)
    assert s.ev("AndroidStudioHost.request('listDrafts').then(rows => rows.length)") == 0


@scenario
def recovery_with_three_drafts(h):
    """Startup recovery lists ALL drafts when three exist (native allows two read buffers) and restores a chosen one"""
    s = h['session'] = fresh('recovery3')
    hwp_bytes = [(FIXTURES / n).read_bytes() for n in ['문서.hwp', 'table.hwp', 'blank.hwp']]
    s.page.evaluate("""async bytes => { for (let i = 0; i < bytes.length; i++) await AndroidStudioHost.recovery.saveDraft({id: 'qa-' + i, fileName: 'draft' + i + '.hwp', sourceFormat: 'hwp', savedAt: Date.now() + i, byteLength: bytes[i].length, data: Uint8Array.from(bytes[i])}); }""", [list(b) for b in hwp_bytes])
    s.relaunch()
    s.studio_dialog().locator('.dialog-title').filter(has_text='문서 복구').wait_for(timeout=30000)
    names = s.ev("[...document.querySelectorAll('.recovery-draft-title')].map(e => e.textContent)")
    assert sorted(names) == ['draft0.hwp', 'draft1.hwp', 'draft2.hwp'], names
    s.studio_dialog().get_by_role('button', name='복구', exact=True).first.click()
    s.wait_state(hasDocument=True)


@scenario
def table_and_memo_roundtrip(h):
    """Table cell edit (keyboard) and memo insertion through the real menus survive Ctrl+S and an independent reopen"""
    s = h['session'] = fresh('table-memo')
    s.open_doc('업무 인수인계서')
    before = inspect_file(VOLUME / 'Documents/업무 인수인계서.hwpx')
    assert 'tbl' in before['controls'], before['controls']
    s.click_document(160)
    s.page.keyboard.press('Control+Home')
    s.page.keyboard.type('앞글 ')
    for _ in range(2):
        s.page.keyboard.press('Shift+ArrowLeft')
    s.page.locator('#menu-bar > .menu-item').nth(3).click()  # 입력 > 메모 삽입
    s.page.get_by_text('메모 삽입').first.click()
    memo = s.page.locator('textarea[placeholder^="메모 내용"]')
    memo.wait_for(timeout=10000)
    memo.fill('QA 메모 내용')
    s.page.get_by_role('button', name='삽입', exact=True).click()
    s.wait("document.body.innerText.includes('QA 메모 내용')", 10, 'memo listed in the memo panel')
    box = s.page.locator('#scroll-container canvas').first.bounding_box()
    s.page.mouse.click(box['x'] + 537, box['y'] + 145)  # right-hand table cell, real mouse
    s.page.keyboard.type('셀입력')
    s.page.keyboard.press('Control+s')
    s.wait_state(dirty=False)
    saved = inspect_file(VOLUME / 'Documents/업무 인수인계서.hwpx')
    assert 'tbl' in saved['controls'] and '표 셀 시험' in saved['text'], saved
    assert '앞글' in saved['text'] and '셀입력' in saved['text'], saved['text']
    assert len(saved['memos']) == 1 and 'QA 메모 내용' in json.dumps(saved['memos'], ensure_ascii=False), saved['memos']
    s.screenshot('table-memo')


@scenario
def encrypted_document_open_save_recovery_failclosed(h):
    """Password-protected HWPX: wrong password refused, right password opens, edit+save keeps it encrypted (reopen needs the password), no plaintext recovery draft"""
    s = h['session'] = fresh('encrypted')
    locked = VOLUME / 'Documents/암호 문서.hwpx'
    assert inspect_file(locked)['openError'], 'fixture must really be encrypted'
    s.page.keyboard.press('Control+o')
    s.page.get_by_role('searchbox', name='문서 이름 검색').fill('암호 문서')
    s.page.locator('.android-host-list button').filter(has_text='암호 문서.hwpx').first.click()
    s.studio_dialog().first.wait_for(timeout=30000)
    s.screenshot('password-prompt')
    s.page.locator('.dialog-wrap input[type=password]').first.fill('wrong-password')
    s.page.keyboard.press('Enter')
    s.sleep(1.5)
    assert s.state()['fileName'] == '새 문서.hwp', ('wrong password must not open the document', s.state())
    s.page.locator('.dialog-wrap input[type=password]').first.fill(PASSWORD)
    s.page.keyboard.press('Enter')
    # A blank document is already open, so hasDocument is true at once: wait for the encrypted document itself (opening derives the session
    # recovery key from the password, which takes a moment).
    s.wait_state(encrypted=True)
    assert s.state()['encrypted'] is True, s.state()
    s.click_document()
    s.page.keyboard.type('암호편집 ')
    s.wait_state(dirty=True)
    flush = s.ev('window.rhwpStudio.android.flushRecovery()')
    plain_drafts = [o for o in native_log() if o['op'] == 'beginDraft' and not o['args']['encrypted']]
    assert not plain_drafts, 'an encrypted document must never produce a plaintext draft'
    drafts = s.ev("AndroidStudioHost.recovery.listDrafts().then(ds => ds.map(d => ({encrypted: d.encrypted, data: Array.from(d.data)})))")
    if drafts:  # an encrypted recovery draft is allowed ONLY as real ciphertext that needs the document password
        probe = QA / 'tmp-encrypted-draft.hwp'
        for draft in drafts:
            probe.write_bytes(bytes(draft['data']))
            assert draft['encrypted'] is True and inspect_file(probe)['openError'], 'draft marked/stored as encrypted must really be ciphertext'
            # Recovery follows upstream rhwp: the draft is sealed with a key derived from the document password (PBKDF2 + AES-GCM envelope),
            # not an HWP file the password opens. It must hold no plaintext of the edit in any common encoding; unlocking it needs the password
            # (round trip covered by tests/hwpxxx-android-save-safety.test.ts with the real cipher).
            raw = bytes(draft['data'])
            for encoding in ('utf-16-le', 'utf-8'):
                assert '암호편집'.encode(encoding) not in raw, ('plaintext of the edit found in the encrypted draft', encoding)
        probe.unlink()
        RESULTS['encryptedRecovery'] = 'sealed ciphertext draft (session recovery key)'
    else:
        assert flush.get('ok') is not True, flush
        RESULTS['encryptedRecovery'] = 'blocked (fail-closed): ' + json.dumps(flush)
    # the encrypted save asks for the password to protect the output with (never stored); plaintext is not an option here
    s.page.keyboard.press('Control+s')
    prompt = s.studio_dialog().filter(has_text='문서 암호 설정')
    prompt.wait_for(timeout=15000)
    prompt.locator('input[type=password]').nth(0).fill(PASSWORD)
    prompt.locator('input[type=password]').nth(1).fill(PASSWORD)
    prompt.get_by_role('button', name='확인').click()
    s.wait_state(dirty=False)
    assert inspect_file(locked)['openError'], 'saved file must still need the password'
    reopened = inspect_file(locked, PASSWORD)
    assert reopened['opened'] == 'password' and '암호편집' in reopened['text'], reopened


FONT_FILE = Path('/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf')
MONO_FILE = Path('/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf')


def import_font(s, family, file=FONT_FILE):
    ctl('/__pickfont?family=' + urllib.parse.quote(family), file.read_bytes())
    s.page.get_by_role('button', name='Android · 글꼴').click()
    s.host_dialog().get_by_role('button', name='글꼴 가져오기').click()
    s.host_dialog().get_by_text(family).wait_for(timeout=15000)
    s.page.keyboard.press('Escape')
    s.host_dialog().wait_for(state='detached', timeout=10000)
    s.wait("(() => { const f = window.rhwpStudio.fonts.getState(); return f.active && f.count >= 1 && f.lastError === null; })()", 20, 'font registered with Studio (active, face counted, no error)')


@scenario
def private_font_import_registers_and_deletes(h):
    """Android font manager imports a TTF into the native catalog (opaque URL/release, bytes verified), Studio registers it, deletion unregisters it"""
    s = h['session'] = fresh('fonts-import')
    s.open_doc('프로젝트 일정')
    import_font(s, '맑은 고딕')  # the document's own font family: the renderer must now pull the imported face through the opaque URL
    end = time.time() + 30
    while time.time() < end and not any(o['op'] == 'fontRead' for o in native_log()):
        s.sleep(0.3)
    log = native_log()
    reads = [o for o in log if o['op'] == 'fontRead']
    assert reads and all(o['ok'] for o in reads), ('the renderer never read the imported face', [o['op'] for o in log][-12:])
    s.sleep(1)
    releases = [o for o in native_log() if o['op'] == 'release']
    assert len(releases) >= len(reads), 'every font blob token must be released'
    s.page.get_by_role('button', name='Android · 글꼴').click()
    s.host_dialog().get_by_role('button', name='삭제').click()
    s.host_dialog().get_by_text('가져온 글꼴이 없어요.').wait_for(timeout=10000)
    s.page.keyboard.press('Escape')
    s.wait("window.rhwpStudio.fonts.getState().count === 0", 20, 'font unregistered after deletion')
    assert s.state()['dirty'] is False, 'font management must not touch the document model'
    # The mouse-opened host manager must restore editor focus for physical shortcuts.
    s.page.keyboard.press('Control+o')
    s.page.get_by_role('searchbox', name='문서 이름 검색').wait_for(timeout=10000)
    s.page.keyboard.press('Escape')
    s.host_dialog().wait_for(state='detached', timeout=10000)
    assert s.state()['fileName'] == HWPX_NAME and not s.state()['dirty']


def line_ink_widths(s):
    """Ink width in px of each text line of the first page (real screenshot pixels of the page canvas)."""
    import io
    import numpy as np
    from PIL import Image
    box = s.page.locator('#scroll-container canvas').first.bounding_box()
    shot = s.page.screenshot(clip={'x': box['x'] + 60, 'y': box['y'] + 100, 'width': box['width'] - 120, 'height': 70})
    dark = np.array(Image.open(io.BytesIO(shot)).convert('L')) < 150
    rows = np.where(dark.any(axis=1))[0]
    groups = [g for g in np.split(rows, np.where(np.diff(rows) > 3)[0] + 1) if len(g) > 3]
    return [int(np.ptp(np.where(dark[g[0]:g[-1] + 1].any(axis=0))[0]) + 1) for g in groups]


def independent_width_ratio(font_file):
    """Advance-width ratio of 24x'i' to 24x'W' measured with the SFNT bytes in a separate, unrelated page (no Studio, no host)."""
    import base64
    page = browser.new_page()
    try:
        page.set_content('<canvas id=c></canvas>')
        widths = page.evaluate("""async ([b64]) => { const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0)); const face = new FontFace('IndependentSFNT', bytes.buffer);
            await face.load(); document.fonts.add(face); const c = document.getElementById('c').getContext('2d'); c.font = '100px IndependentSFNT';
            return [c.measureText('i'.repeat(24)).width, c.measureText('W'.repeat(24)).width]; }""", [base64.b64encode(font_file.read_bytes()).decode()])
    finally:
        page.close()
    return widths[0] / widths[1]


@scenario
def imported_font_renders_documents_naming_it_with_its_own_metrics(h):
    """A document naming a host family renders with the imported SFNT (monospace metrics match an independent measurement of the same bytes); deleting the font returns to the fallback"""
    s = h['session'] = fresh('font-render')
    s.open_doc('글꼴 시험')
    s.sleep(1.5)
    before = line_ink_widths(s)
    assert len(before) == 2 and before[0] / before[1] < 0.6, ('probe document must start in a proportional fallback', before)
    import_font(s, 'QA Probe', MONO_FILE)
    expected = independent_width_ratio(MONO_FILE)
    assert abs(expected - 1.0) < 0.01, expected  # a monospace face: 'i' as wide as 'W'
    end = time.time() + 25
    after = before
    while time.time() < end:
        after = line_ink_widths(s)
        if len(after) == 2 and after[0] / after[1] > 0.9:
            break
        s.sleep(0.5)
    assert len(after) == 2 and abs(after[0] / after[1] - expected) < 0.08, ('rendered width ratio must match the SFNT\'s own advance ratio', before, after, expected)
    assert any(o['op'] == 'fontRead' and o['ok'] for o in native_log())
    s.page.get_by_role('button', name='Android · 글꼴').click()
    s.host_dialog().get_by_role('button', name='삭제').click()
    s.host_dialog().get_by_text('가져온 글꼴이 없어요.').wait_for(timeout=10000)
    s.page.keyboard.press('Escape')
    end = time.time() + 25
    gone = after
    while time.time() < end:
        gone = line_ink_widths(s)
        if len(gone) == 2 and gone[0] / gone[1] < 0.6:
            break
        s.sleep(0.5)
    assert len(gone) == 2 and gone[0] / gone[1] < 0.6, ('deleting the imported font must stop its rendering', gone)
    assert s.state()['dirty'] is False


def font_picker_names(s, category):
    s.page.locator('#font-name').click()
    s.page.get_by_role('tab', name=category, exact=True).click()
    names = s.ev("[...document.querySelectorAll('.font-picker-option')].map(o => o.textContent)")
    return names


def delete_imported_font(s, family):
    s.page.get_by_role('button', name='Android · 글꼴').click()
    row = s.host_dialog().locator('.android-host-list > div').filter(has_text=family)
    row.get_by_role('button', name='삭제', exact=True).click()
    s.wait(f"!document.querySelector('dialog.android-host-dialog .android-host-list').textContent.includes({json.dumps(family)})", 15, 'font deleted from native catalog')
    s.page.keyboard.press('Escape')
    s.host_dialog().wait_for(state='detached', timeout=10000)


@scenario
def imported_font_is_selectable_in_font_picker_and_saved(h):
    """Imported fonts appear in system/all and Alt+L; applying the mono face changes actual pixels, independent reopen keeps its family; deletion removes unused choices and preserves the document family"""
    s = h['session'] = fresh('fonts-apply')
    s.open_doc('글꼴 시험')
    s.sleep(1.5)
    before = line_ink_widths(s)
    assert len(before) == 2 and before[0] / before[1] < 0.6, ('probe must start with proportional fallback', before)
    family, unused = '큐에이 글꼴', '큐에이 미사용 글꼴'
    import_font(s, family, MONO_FILE)
    import_font(s, unused, FONT_FILE)
    for category in ['시스템 글꼴', '모든 글꼴']:
        offered = font_picker_names(s, category)
        assert family in offered and unused in offered, (category, offered)
        s.page.keyboard.press('Escape')
        s.wait("!document.querySelector('.font-picker-menu')", 8, 'font menu closed')
    s.click_document()
    s.page.keyboard.press('Control+Home')
    s.page.keyboard.press('Control+a')
    s.page.keyboard.press('Alt+l')
    dialog = s.page.locator('.modal-overlay').filter(has_text='글자 모양')
    dialog.wait_for(timeout=10000)
    offered = s.ev("[...document.querySelectorAll('.modal-overlay select option')].map(o => o.value)")
    assert family in offered and unused in offered, ('Alt+L must offer both imported families', offered)
    dialog.get_by_role('button', name='취소', exact=True).click()
    s.click_document()
    s.page.keyboard.press('Control+Home')
    s.page.keyboard.press('Control+a')
    offered = font_picker_names(s, '시스템 글꼴')
    assert family in offered
    s.page.get_by_role('option', name=family, exact=True).click()
    s.wait_state(dirty=True)
    s.page.keyboard.press('ArrowRight')  # collapse the selection so the screenshot measures glyph ink, not selection highlighting
    expected = independent_width_ratio(MONO_FILE)
    assert abs(expected - 1.0) < 0.01, expected
    end = time.time() + 25
    after = before
    while time.time() < end:
        after = line_ink_widths(s)
        if len(after) == 2 and abs(after[0] / after[1] - expected) < 0.08:
            break
        s.sleep(0.5)
    assert len(after) == 2 and abs(after[0] / after[1] - expected) < 0.08, ('UI-applied font pixels must match independent SFNT metrics', before, after, expected)
    s.page.keyboard.press('Control+s')
    s.wait_state(dirty=False)
    saved_path = VOLUME / 'Documents/글꼴 시험.hwpx'
    saved = inspect_file(saved_path, probes=[(0, 0, 0), (0, 1, 0)])
    assert [char['font'] for char in saved['chars']] == [family, family], saved['chars']
    assert any(op['op'] == 'fontRead' and op['ok'] for op in native_log()), 'actual renderer must read imported SFNT bytes'
    s.screenshot('applied-mono')
    delete_imported_font(s, unused)
    # Ctrl+O immediately after mouse-driven font deletion must work without a document click.
    # Reopening an unrelated document also proves deletion is not hidden by document-font retention.
    s.open_doc('프로젝트 일정')
    for category in ['시스템 글꼴', '모든 글꼴']:
        offered = font_picker_names(s, category)
        assert unused not in offered and family in offered, (category, offered)
        s.page.keyboard.press('Escape')
    s.click_document()
    s.open_doc('글꼴 시험')
    delete_imported_font(s, family)
    s.wait("window.rhwpStudio.fonts.getState().count === 0", 15, 'all native host fonts removed')
    offered = font_picker_names(s, '모든 글꼴')
    assert family in offered and unused not in offered, ('used document family remains a document choice after host deletion', offered)
    s.page.keyboard.press('Escape')
    assert [char['font'] for char in inspect_file(saved_path, probes=[(0, 0, 0), (0, 1, 0)])['chars']] == [family, family]
    assert not s.state()['dirty'], 'removing host fonts must not edit persisted family properties'
    RESULTS['appliedFontMetrics'] = {'beforeInkWidths': before, 'appliedInkWidths': after, 'independentAdvanceRatio': expected,
                                    'savedFamilies': [char['font'] for char in saved['chars']]}


@scenario
def export_html_pdf_and_print(h):
    """HTML export, PDF save and print go through native new-file/print paths with verified content"""
    s = h['session'] = fresh('export')
    s.open_doc('프로젝트 일정')
    s.page.locator('#menu-bar > .menu-item').first.click()
    s.page.locator('.md-item[data-cmd="file:export-html"]').click()
    s.choose_destination('qa-내보내기.html', ['Documents'])
    wait_for_file(VOLUME / 'Documents/qa-내보내기.html', s)
    html = (VOLUME / 'Documents/qa-내보내기.html').read_text(encoding='utf8')
    assert html.lstrip().lower().startswith(('<!doctype html', '<html')) and '한글' in html or '문서' in html
    s.page.locator('#menu-bar > .menu-item').first.click()
    s.page.locator('.md-item[data-cmd="file:print-to-pdf"]').click()
    s.choose_destination('qa-문서.pdf', ['Documents'])
    wait_for_file(VOLUME / 'Documents/qa-문서.pdf', s, 60)
    assert (VOLUME / 'Documents/qa-문서.pdf').read_bytes().startswith(b'%PDF')
    s.click_document()  # focus is on BODY after menu/host-dialog use (inherited), exactly as a user would click back into the page
    s.page.keyboard.press('Control+p')
    deadline = time.time() + 60
    while time.time() < deadline and not ctl('/__log')['printed']:
        s.sleep(0.3)
    printed = ctl('/__log')['printed']
    assert printed and printed[0]['pages'] and all(p['bytes'] > 100 for p in printed[0]['pages']), printed
    assert any(o['op'] == 'beginPrintPdf' for o in native_log())


@scenario
def clipboard_keyboard_and_menu(h):
    """Ctrl+C/Ctrl+V keyboard path duplicates text and a plain-text copy stays on the WebView clipboard (no native adapter use)"""
    s = h['session'] = fresh('clipboard')
    s.open_doc('프로젝트 일정')
    s.click_document()
    s.page.keyboard.press('Control+Home')
    for _ in range(3):
        s.page.keyboard.press('Shift+ArrowRight')
    s.page.keyboard.press('Control+c')
    s.page.keyboard.press('Control+End')
    s.page.keyboard.press('Control+v')
    s.wait_state(dirty=True)
    s.page.keyboard.press('Control+s')
    s.wait_state(dirty=False)
    saved = inspect_file(VOLUME / HWPX)
    original = inspect_file(FIXTURES / '문서.hwpx')
    assert len(saved['text']) == len(original['text']) + 3, (len(saved['text']), len(original['text']))
    # NOTE: menu Copy of TEXT uses document.execCommand('copy') (the WebView's own clipboard), so the native clipboard adapter is correctly not
    # involved; image/table copies go through navigator.clipboard.write -> the adapter (next scenario).
    assert not any(o['op'] in ('beginClipboardImage', 'clipboardWrite') for o in native_log()), 'a plain-text keyboard copy must not use the native adapter'


def make_png(width=48, height=32):
    import struct
    import zlib
    rows = b''.join(b'\x00' + b''.join(bytes([(x * 5) % 256, (y * 7) % 256, 160]) for x in range(width)) for y in range(height))

    def chunk(kind, data):
        body = kind + data
        return struct.pack('>I', len(data)) + body + struct.pack('>I', zlib.crc32(body) & 0xffffffff)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b'')


@scenario
def picture_insert_via_picker_and_image_clipboard(h):
    """Insert a picture through the SAF image picker (menu 입력>그림), copy the selected picture: text+html+PNG reach the native clipboard as ONE clip; the saved file keeps the picture"""
    s = h['session'] = fresh('picture')
    png = make_png()
    s.open_doc('프로젝트 일정')
    s.click_document()
    ctl('/__pick?name=' + urllib.parse.quote('그림.png') + '&kind=image', png)
    s.page.locator('#menu-bar > .menu-item').nth(3).click()
    s.page.locator('.md-item').filter(has_text='그림').first.click()
    end = time.time() + 15
    while time.time() < end and not any(o['op'] == 'pickFile' for o in native_log()):
        s.sleep(0.2)
    assert [o for o in native_log() if o['op'] == 'pickFile'][-1]['args']['kind'] == 'image'
    s.sleep(1.5)
    box = s.page.locator('#scroll-container canvas').first.bounding_box()  # Studio enters picture placement mode: a real mouse drag places it
    s.page.mouse.move(box['x'] + 150, box['y'] + 250)
    s.page.mouse.down()
    s.page.mouse.move(box['x'] + 330, box['y'] + 370, steps=6)
    s.page.mouse.up()
    s.wait_state(dirty=True)
    s.sleep(1)
    s.page.mouse.click(box['x'] + 240, box['y'] + 310)  # select the picture object with the mouse
    s.sleep(0.5)
    s.page.locator('#menu-bar > .menu-item').nth(1).click()
    s.page.locator('.md-item[data-cmd="edit:copy"]').click()
    end = time.time() + 15
    while time.time() < end and not ctl('/__log')['clipboard']['imageBytes']:
        s.sleep(0.3)
    clip = ctl('/__log')['clipboard']
    assert clip['imageBytes'] > 8 and clip['text'] and clip['html'], ('selected picture copy must publish image+text+html through the adapter', clip)
    s.page.locator('#menu-bar > .menu-item').first.click()
    s.page.locator('.md-item[data-cmd="file:save"]').click()
    s.wait_state(dirty=False)
    saved = inspect_file(VOLUME / HWPX)
    assert any(c.strip() in ('gso', 'pic') for c in saved['controls']), ('the inserted picture must be in the saved file', saved['controls'])


@scenario
def scroll_zoom_resize_layout(h):
    """Long document: mouse wheel scrolls pages, Ctrl+wheel zooms, workspace resizes at DeX window sizes without overflow"""
    s = h['session'] = fresh('layout')
    s.open_doc('긴 문서')
    pages_text = s.wait("(() => { const t = document.getElementById('sb-page').innerText; return t.includes('/ 15') ? t : ''; })()", 20, 'the 15-page fixture is paginated; status shows: ' + str(s.ev("document.getElementById('sb-page').innerText + ' | ' + window.rhwpStudio.android.getState().fileName")))
    box = s.page.locator('#scroll-container').bounding_box()
    s.page.mouse.move(box['x'] + box['width'] / 2, box['y'] + box['height'] / 2)
    top = s.ev("document.getElementById('scroll-container').scrollTop")
    s.page.mouse.wheel(0, 1500)
    s.wait(f"document.getElementById('scroll-container').scrollTop > {top}", 10, 'wheel scroll')
    zoom = s.ev("document.getElementById('sb-zoom-val').innerText")
    s.page.keyboard.down('Control')
    s.page.mouse.wheel(0, -400)
    s.page.keyboard.up('Control')
    s.wait(f"document.getElementById('sb-zoom-val').innerText !== {json.dumps(zoom)}", 10, 'ctrl+wheel zoom')
    for width, height in [(1920, 1080), (1280, 800), (900, 600)]:
        s.page.set_viewport_size({'width': width, 'height': height})
        s.sleep(0.4)
        assert s.ev('document.documentElement.scrollWidth <= innerWidth + 1'), width
        assert s.page.locator('#status-bar').is_visible() and s.page.locator('#menu-bar').is_visible()
        s.screenshot(f'{width}x{height}')


@scenario
def open_other_document_with_unsaved_guard_and_recent(h):
    """Opening another document while dirty asks first (Cancel keeps the edit); recent-documents works with host handles"""
    s = h['session'] = fresh('open-second')
    s.open_doc('프로젝트 일정')
    s.click_document()
    s.page.keyboard.type('첫문서 ')
    s.page.keyboard.press('Control+o')
    s.studio_dialog().get_by_text('저장하지 않은 변경사항').wait_for(timeout=10000)
    s.studio_dialog().get_by_role('button', name='취소').click()
    assert s.state()['fileName'] == HWPX_NAME and s.state()['dirty'] is True
    s.page.keyboard.press('Control+o')
    s.studio_dialog().get_by_role('button', name='저장 안 함').click()
    s.page.get_by_role('searchbox', name='문서 이름 검색').fill('업무 인수인계서')
    s.page.locator('.android-host-list button').filter(has_text='업무 인수인계서.hwpx').first.click()
    s.wait_state(fileName='업무 인수인계서.hwpx', dirty=False)
    assert (VOLUME / HWPX).read_bytes() == (FIXTURES / '문서.hwpx').read_bytes()
    s.page.locator('#menu-bar > .menu-item').first.click()
    s.page.locator('.md-sub').filter(has_text='최근 문서').hover()
    recent = s.page.locator('.md-item[data-cmd="file:open-recent"]').filter(has_text=HWPX_NAME)
    assert recent.count() == 1, 'recent documents must list the previously opened file'
    recent.click()
    s.wait_state(fileName=HWPX_NAME, dirty=False)


@scenario
def new_document_with_table_saves_as_hwp_and_hwpx(h):
    """A NEW document with a table (menu 표>표 만들기) saves as HWP and as HWPX; both reopen independently with the table and the typed cell text"""
    s = h['session'] = fresh('new-table')
    s.page.locator('body').click()
    s.page.keyboard.press('Alt+n')
    s.sleep(1)
    s.click_document(60)
    s.page.locator('#menu-bar > .menu-item').nth(6).click()  # 표
    s.page.locator('.md-item[data-cmd="table:create"]').click()
    s.sleep(0.5)
    s.page.mouse.move(354, 128)   # the table-size grid popup: hover/click the cell for 2 rows x 2 columns with the real mouse
    s.sleep(0.3)
    s.screenshot('table-grid')
    s.page.mouse.click(354, 128)
    s.wait_state(dirty=True)
    s.page.keyboard.type('표셀내용')
    s.page.keyboard.press('Control+s')
    s.choose_destination('qa-table.hwp', ['Documents'])
    s.wait_state(dirty=False)
    hwp = inspect_file(VOLUME / 'Documents/qa-table.hwp')
    assert hwp['format'] == 'hwp' and 'tbl' in hwp['controls'] and '표셀내용' in hwp['text'], hwp
    s.page.locator('#menu-bar > .menu-item').first.click()
    s.page.locator('.md-item[data-cmd="file:save-as-hwpx"]').click()
    s.confirm_studio_filename()
    s.choose_destination('qa-table.hwpx', ['Documents'])
    s.wait_state(dirty=False)
    hwpx = inspect_file(VOLUME / 'Documents/qa-table.hwpx')
    assert hwpx['format'] == 'hwpx' and 'tbl' in hwpx['controls'] and '표셀내용' in hwpx['text'], hwpx
    assert inspect_file(VOLUME / 'Documents/qa-table.hwp')['text'] == hwp['text'], 'saving a copy as HWPX must not change the HWP file'


@scenario
def incoming_shared_file_opens_through_unsaved_guard_and_saves_as_copy(h):
    """A file another app opens with / shares to the app (native queue) opens like Ctrl+O: asks first when dirty, is read-only as a source (Save creates a copy)"""
    s = h['session'] = fresh('incoming')
    shared = (FIXTURES / 'table.hwpx').read_bytes()
    s.open_doc('프로젝트 일정')
    s.click_document()
    s.page.keyboard.type('작업중 ')
    s.wait_state(dirty=True)
    ctl('/__openrequest?name=' + urllib.parse.quote('공유받음.hwpx'), shared)
    s.ev("window.NativeEvent('openRequest', true), true")
    s.studio_dialog().get_by_text('저장하지 않은 변경사항').wait_for(timeout=15000)
    s.studio_dialog().get_by_role('button', name='취소').click()
    assert s.state()['fileName'] == HWPX_NAME and s.state()['dirty'] is True, 'an incoming file must never replace a dirty document silently'
    ctl('/__openrequest?name=' + urllib.parse.quote('공유받음.hwpx'), shared)
    s.ev("window.NativeEvent('openRequest', true), true")
    s.studio_dialog().get_by_role('button', name='저장 안 함').click()
    s.wait_state(fileName='공유받음.hwpx', dirty=False)
    s.click_document()
    s.page.keyboard.type('공유편집 ')
    s.page.keyboard.press('Control+s')
    s.choose_destination('qa-공유사본.hwpx', ['Documents'])  # a shared (content://) source is never overwritten
    s.wait_state(dirty=False)
    copy = inspect_file(VOLUME / 'Documents/qa-공유사본.hwpx')
    assert '공유편집' in copy['text'] and 'tbl' in copy['controls'], copy
    assert (VOLUME / HWPX).read_bytes() == (FIXTURES / '문서.hwpx').read_bytes(), 'discarded edits must not reach the first document'
    begin = [o for o in native_log() if o['op'] == 'beginSave'][-1]['args']
    assert begin['replace'] is False and begin['id'].startswith('saf:'), begin


HEADER_XML_INSPECT = """import fs from 'node:fs'; import {initSync,HwpDocument} from './app/src/main/assets/engine/rhwp.js';
initSync({module:fs.readFileSync('app/src/main/assets/engine/rhwp_bg.wasm')});
const doc=new HwpDocument(fs.readFileSync(process.argv[1]));
try {const report=doc.exportHwpxWithReport();try {process.stdout.write(Buffer.from(report.takeBytes()).toString('base64'));}finally{report.free();}}finally{doc.free();}"""


def inspect_header_fields(path):
    """Independent saved-file reopen: inspect actual header XML field kinds, not displayed page-number text or mere control presence."""
    data = subprocess.check_output(['node', '--input-type=module', '-e', HEADER_XML_INSPECT, str(path)], cwd=ROOT)
    headers = []
    with zipfile.ZipFile(io.BytesIO(base64.b64decode(data))) as archive:
        for name in sorted(archive.namelist()):
            if not name.startswith('Contents/section') or not name.endswith('.xml'):
                continue
            section = ET.fromstring(archive.read(name))
            for header in section.iter():
                if header.tag.rsplit('}', 1)[-1] != 'header':
                    continue
                fields = [node.attrib.get('numType') for node in header.iter() if node.tag.rsplit('}', 1)[-1] == 'autoNum']
                texts = [node.text or '' for node in header.iter() if node.tag.rsplit('}', 1)[-1] == 't']
                headers.append({'section': name, 'applyPageType': header.attrib.get('applyPageType'), 'numberFieldKinds': fields, 'text': ''.join(texts)})
    return headers


def header_flow(s, doc_name, rel, item, typed=None):
    """쪽>머리말>양쪽>{item}, optionally type text into the header, leave header mode, Ctrl+S."""
    s.open_doc(doc_name)
    s.click_document()
    s.page.locator('#menu-bar > .menu-item').nth(5).click()  # 쪽
    s.page.locator('.md-sub:visible').filter(has_text='머리말').first.hover()
    s.page.get_by_text('양쪽', exact=True).locator('visible=true').first.hover()
    s.page.get_by_text(item, exact=True).locator('visible=true').first.click()
    s.page.get_by_text('머리말 · 양쪽 편집 중').wait_for(timeout=10000)  # header editing mode: leave it with its own 닫기 button
    if typed:
        s.page.keyboard.type(typed)
    s.page.locator('#icon-toolbar').get_by_text('닫기', exact=True).locator('visible=true').first.click()
    s.wait("!document.body.innerText.includes('편집 중')", 10, 'header editing mode closed')
    s.click_document()
    s.page.keyboard.press('Control+s')
    s.wait_state(dirty=False)
    return inspect_file(VOLUME / rel)


@scenario
def find_replace_and_alignment_edits_survive_save(h):
    """Find & Replace all (Ctrl+F2) and paragraph alignment through the real UI survive Ctrl+S and an independent reopen"""
    s = h['session'] = fresh('replace')
    s.open_doc('프로젝트 일정')
    s.click_document()
    s.page.keyboard.press('Control+F2')
    dialog = s.page.locator('.find-dialog')
    dialog.wait_for(timeout=10000)
    inputs = dialog.locator('input[type=text], input:not([type])')
    inputs.nth(0).fill('편집')
    inputs.nth(1).fill('수정')
    dialog.get_by_role('button', name='모두 바꾸기').click()
    s.wait_state(dirty=True)
    dialog.get_by_role('button', name='×').click()
    s.click_document()
    s.page.keyboard.press('Control+Home')
    s.page.keyboard.press('Alt+Shift+c')  # 가운데 정렬
    s.page.keyboard.press('Control+s')
    s.wait_state(dirty=False)
    saved = inspect_file(VOLUME / HWPX)
    original = inspect_file(FIXTURES / '문서.hwpx')
    assert '수정' in saved['text'] and '편집' not in saved['text'], saved['text']
    assert saved['text'].count('수정') == original['text'].count('편집'), (saved['text'], original['text'])


@scenario
def header_with_text_saves_hwpx(h):
    """A typed page header (쪽>머리말>양쪽>빈 머리말) in an HWPX document saves and reopens with the header"""
    s = h['session'] = fresh('header-text')
    saved = header_flow(s, '프로젝트 일정', HWPX, '빈 머리말', typed='머리글QA')
    assert any('head' in c for c in saved['controls']), saved['controls']
    headers = inspect_header_fields(VOLUME / HWPX)
    assert any('머리글QA' in header['text'] for header in headers), headers


@scenario
def header_page_number_saves_hwpx(h):
    """A page-number header (쪽>머리말>양쪽>가운데 쪽 번호) in an HWPX document must not be refused by the save verifier"""
    s = h['session'] = fresh('header-pagenum-hwpx')
    saved = header_flow(s, '프로젝트 일정', HWPX, '가운데 쪽 번호')
    assert any('head' in c for c in saved['controls']), saved['controls']
    headers = inspect_header_fields(VOLUME / HWPX)
    assert any('PAGE' in header['numberFieldKinds'] for header in headers), ('reopened HWPX must retain a PAGE auto-number field', headers)
    RESULTS.setdefault('headerFieldSemantics', {})['hwpx'] = headers


@scenario
def header_page_number_saves_hwp(h):
    """The same page-number header in an HWP document saves and reopens with the header"""
    s = h['session'] = fresh('header-pagenum-hwp')
    saved = header_flow(s, '주간 업무회의록', HWP, '가운데 쪽 번호')
    assert any('head' in c for c in saved['controls']), saved['controls']
    headers = inspect_header_fields(VOLUME / HWP)
    assert any('PAGE' in header['numberFieldKinds'] for header in headers), ('reopened HWP must retain a PAGE auto-number field', headers)
    RESULTS.setdefault('headerFieldSemantics', {})['hwp'] = headers


def close_history(s):
    """The history panel is a floating compare-dialog: it has its own × (Escape does not close it, as on the desktop)."""
    s.page.locator('.history-list').locator("xpath=ancestor::*[.//button[normalize-space()='×']][1]").get_by_role('button', name='×').click()
    s.wait("[...document.querySelectorAll('.history-list')].every(e => !e.offsetParent)", 8, 'history dialog closed')


def recent_names(s):
    s.page.locator('#menu-bar > .menu-item').first.click()
    s.page.locator('.md-sub').filter(has_text='최근 문서').first.wait_for(state='visible', timeout=8000)
    s.page.locator('.md-sub').filter(has_text='최근 문서').hover()
    names = s.ev("[...document.querySelectorAll('.md-item[data-cmd=\"file:open-recent\"]')].map(e => e.textContent.trim())")
    import re
    return [re.sub(r'(HWPX|HWP|HML)$', '', n) for n in names]  # the menu appends a format badge


def no_browser_storage(s):
    """Android mode must never use IndexedDB/localStorage for history/recent/recovery."""
    stores = s.ev("(async () => ({dbs: (await indexedDB.databases()).map(d => d.name), ls: Object.keys(localStorage)}))()")
    bad = [n for n in stores['dbs'] if n and any(k in n.lower() for k in ('history', 'recent', 'autosave', 'recovery'))]
    bad += [k for k in stores['ls'] if any(w in k.lower() for w in ('recent', 'history', 'autosave', 'recovery'))]
    assert not bad, ('browser storage used for private state', stores)


@scenario
def history_and_recent_persist_across_process_restart(h):
    """Document history snapshot (private native store) and recent documents survive a process restart; reopening resolves a fresh handle; revoked/missing sources behave as specified; no IndexedDB/localStorage"""
    s = h['session'] = fresh('history-recent')
    s.open_doc('프로젝트 일정')
    s.click_document()
    s.page.keyboard.type('이력용 ')
    s.page.keyboard.press('Control+s')
    s.wait_state(dirty=False)
    s.open_doc('업무 인수인계서')
    # history: take a snapshot through the real dialog
    s.click_document()
    s.page.keyboard.press('Control+Shift+h')
    s.page.get_by_placeholder('메모 (비우면 시각 기본값)').fill('QA 스냅샷')
    s.page.get_by_role('button', name='현재 문서 저장').click()
    s.wait("document.querySelector('.history-list')?.innerText.includes('QA 스냅샷')", 15, 'snapshot listed')
    ops = [o['op'] for o in native_log()]
    assert 'beginHistory' in ops and 'finishHistory' in ops, ops[-12:]
    assert len(ctl('/__log')['historyIds']) == 1
    no_browser_storage(s)
    close_history(s)
    before_restart = recent_names(s)
    assert set(before_restart) >= {HWPX_NAME, '업무 인수인계서.hwpx'}, before_restart
    s.page.keyboard.press('Escape')
    # process restart: native ephemeral ids are gone, persisted state stays
    s.relaunch()
    if s.studio_dialog().count():
        s.page.keyboard.press('Escape')
    names = recent_names(s)
    assert set(names) >= {HWPX_NAME, '업무 인수인계서.hwpx'}, ('recent list must survive the restart', names)
    s.page.locator('.md-item[data-cmd="file:open-recent"]').filter(has_text=HWPX_NAME).click()
    s.wait_state(fileName=HWPX_NAME, dirty=False)
    # the reopened document is a fresh handle with a real baseline: a save is conditional on the file's hash
    s.click_document()
    s.page.keyboard.type('재시작후 ')
    s.page.keyboard.press('Control+s')
    s.wait_state(dirty=False)
    begin = [o for o in native_log() if o['op'] == 'beginSave'][-1]['args']
    assert begin['replace'] is True and len(begin['sha']) == 64 and begin['target'].endswith(HWPX), begin
    assert '재시작후' in inspect_file(VOLUME / HWPX)['text']
    # source gone -> NotFound: visible notice, entry removed
    (VOLUME / 'Documents/업무 인수인계서.hwpx').unlink()
    s.page.locator('#menu-bar > .menu-item').first.click()
    s.page.locator('.md-sub').filter(has_text='최근 문서').hover()
    s.page.locator('.md-item[data-cmd="file:open-recent"]').filter(has_text='업무 인수인계서.hwpx').click()
    s.sleep(1)
    assert '업무 인수인계서.hwpx' not in recent_names(s), 'a vanished source must be removed from the recent list'
    s.page.keyboard.press('Escape')
    assert s.state()['fileName'] == HWPX_NAME and not s.dialogs, (s.state(), s.dialogs)
    # revoked access -> NotAllowed: the entry is KEPT and the standard picker opens so the user can re-pick (never a dead command)
    ctl('/__grant?0')
    s.click_document()
    s.page.locator('#menu-bar > .menu-item').first.click()
    s.page.locator('.md-sub').filter(has_text='최근 문서').hover()
    s.page.locator('.md-item[data-cmd="file:open-recent"]').filter(has_text='프로젝트 일정.hwpx').click()
    s.host_dialog().get_by_role('heading', name='문서 열기').wait_for(timeout=15000)
    s.page.keyboard.press('Escape')
    s.host_dialog().wait_for(state='detached')
    ctl('/__grant?1')
    assert '프로젝트 일정.hwpx' in recent_names(s), 'a revoked grant must keep the entry'
    s.page.keyboard.press('Escape')
    no_browser_storage(s)


@scenario
def history_and_recent_fail_closed_on_private_store_errors_and_encrypted_docs(h):
    """A failing private history store is reported and never falls back to browser storage; password-protected documents never reach the native history store"""
    s = h['session'] = fresh('history-errors')
    s.open_doc('프로젝트 일정')
    s.click_document()
    ctl('/__fail?op=beginHistory&message=' + urllib.parse.quote('기록 저장소 오류') + '&times=1')
    s.page.keyboard.press('Control+Shift+h')
    s.page.get_by_placeholder('메모 (비우면 시각 기본값)').fill('실패 시험')
    s.page.get_by_role('button', name='현재 문서 저장').click()
    s.sleep(1.5)
    visible = s.ev("document.body.innerText.includes('기록 저장소 오류')") or any('기록 저장소 오류' in m for _, m in s.dialogs)
    assert visible, 'a failing private history store must be reported to the user'
    s.dialogs[:] = [d for d in s.dialogs if '기록 저장소 오류' not in d[1]]
    s.console[:] = [c for c in s.console if '기록 저장소 오류' not in c[1] and 'istory' not in c[1] and '이력' not in c[1]]
    assert ctl('/__log')['historyIds'] == [], 'nothing may be stored when the provider failed'
    no_browser_storage(s)
    close_history(s)
    # encrypted document: snapshot stays in memory, never sent to native
    s.click_document()
    s.page.keyboard.press('Control+o')
    s.page.get_by_role('searchbox', name='문서 이름 검색').fill('암호 문서')
    s.page.locator('.android-host-list button').filter(has_text='암호 문서.hwpx').first.click()
    s.page.locator('.dialog-wrap input[type=password]').first.fill(PASSWORD)
    s.page.keyboard.press('Enter')
    s.wait_state(fileName='암호 문서.hwpx')
    s.click_document()
    s.page.keyboard.press('Control+Shift+h')
    s.page.get_by_placeholder('메모 (비우면 시각 기본값)').fill('암호 스냅샷')
    s.page.get_by_role('button', name='현재 문서 저장').click()
    s.sleep(1.5)
    assert ctl('/__log')['historyIds'] == [], 'protected document history must never be persisted natively'
    assert sum(1 for o in native_log() if o['op'] == 'beginHistory' and o['ok']) == 0
    no_browser_storage(s)


if __name__ == '__main__':
    failed = 0
    try:
        failed = run_all()
    finally:
        RESULTS['failed'] = failed
        (QA / 'studio-ui-results.json').write_text(json.dumps(RESULTS, ensure_ascii=False, indent=2))
        browser.close()
        playwright_ctx.stop()
        server.terminate()
        server.wait(timeout=10)
    total = len(RESULTS['scenarios'])
    print(f'\n{total - failed}/{total} scenarios passed; skipped (not passes): {[x["name"] for x in RESULTS["skipped"]]}; failures in {FAIL_DIR}')
    sys.exit(1 if failed else 0)
