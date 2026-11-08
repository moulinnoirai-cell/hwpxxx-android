"""Harness for tests/studio-workspace.py: one preview server (multi-session native MOCK) + several tagged real-Studio realms.

REAL   : production Studio bundle + WASM, real studio-host.js, the real workspace-tabs.mjs DOM (rendered in the real #menu-bar, real mouse drag),
         strict production CSP (no bypass_csp), real keyboard/mouse in Chromium, independent re-opening of saved files in a separate Node WASM instance.
MOCK   : OfflineNative (tests/preview-server.mjs, one session per view tag, synchronous workspaceEnabled() capability) and the workspace controller
         (tests/workspace-oracle.mjs). `?view=<id>` is a TEST-SHIM-ONLY device: the Android WebView never gets a query URI, native identifies the session itself.
UNPROVEN HERE (device only): Android native two-WebView attachment, EditorSession/WebView lifecycle, picker request routing, native crypto, physical Samsung DeX.
A pass is a browser-contract pass (JS + real Studio against a mock native), never an on-device pass.
Every page is driven with CDP Runtime.evaluate (exempt from the page CSP). page.wait_for_function would need unsafe-eval, which the product forbids.
"""
import json
import os
import shutil
import socket
import subprocess
import time
import urllib.parse
import urllib.request
import hashlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / 'tests/fixtures'
QA_FIXTURES = ROOT / '.qa/fixtures'
ASSETS = ROOT / 'app/src/main/assets'
PASSWORD = 'qa-only-2026'
# Opaque tab ids (canonical UUIDs like WorkspaceModel's) double as view tags.
TABS = {'A': 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', 'B': 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb', 'C': 'cccccccc-3333-4333-8333-cccccccccccc', 'D': 'dddddddd-4444-4444-8444-dddddddddddd'}
SEEDED = {
    'Documents/주간 업무회의록.hwp': '문서.hwp', 'Download/프로젝트 일정.hwpx': '문서.hwpx',
    'Download/업무자료/2026년 사업계획 검토 의견 최종본.hwp': 'table.hwp', 'Documents/업무 인수인계서.hwpx': 'table.hwpx', 'Download/회의 자료.hwp': 'blank.hwp',
}
INSPECT = '''import fs from 'node:fs'; import {initSync,HwpDocument} from './app/src/main/assets/engine/rhwp.js';
initSync({module:fs.readFileSync('app/src/main/assets/engine/rhwp_bg.wasm')});
const [file,password]=[process.argv[1],process.argv[2]];
const bytes=fs.readFileSync(file); let doc,opened='plain';
try{doc=new HwpDocument(bytes);}catch(e){ if(!password) {console.log(JSON.stringify({openError:String(e).slice(0,120)}));process.exit(0);} doc=HwpDocument.openWithPassword(bytes,password);opened='password'; }
try{console.log(JSON.stringify({opened,format:doc.getSourceFormat(),pages:doc.pageCount(),text:JSON.parse(doc.getTextFileUnicode())}));}finally{doc.free();}'''


def sha(data):
    return hashlib.sha256(data).hexdigest()


def inspect_file(path, password=''):
    """Open a file in a fresh WASM instance that has nothing to do with the page under test."""
    out = subprocess.check_output(['node', '--input-type=module', '-e', INSPECT, str(path), password], cwd=ROOT, text=True)
    return json.loads(out)


def workspace_module_present():
    """The module file AND its wiring into the host/Studio page (a stray file in the assets is not a deliverable)."""
    if not any(ASSETS.glob('**/workspace-tabs.mjs')):
        return False
    wired = [ASSETS / 'studio-host.js', ASSETS / 'studio/index.html']
    return any(p.is_file() and 'workspace-tabs' in p.read_text(errors='ignore') for p in wired)


class World:
    """The preview server + the shared file volume (WorkspaceServices/FileStore stand-in)."""

    def __init__(self):
        subprocess.run(['node', 'tests/build-qa-fixtures.mjs'], cwd=ROOT, check=True, stdout=subprocess.DEVNULL)
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', 0))
            self.port = int(os.environ.get('STUDIO_WORKSPACE_PORT') or probe.getsockname()[1])
        self.server = subprocess.Popen(['node', 'tests/preview-server.mjs', str(self.port)], cwd=ROOT, stdout=subprocess.PIPE, text=True)
        line = self.server.stdout.readline().strip()
        assert 'sandbox ' in line, line
        self.volume = Path(line.split('sandbox ', 1)[1])
        self.base = f'http://localhost:{self.port}'

    def ctl(self, path, data=None):
        request = urllib.request.Request(self.base + path, data=data, method='POST' if data is not None else 'GET')
        with urllib.request.urlopen(request, timeout=30) as response:
            body = response.read()
        return json.loads(body) if body[:1] in b'{[' else body.decode()

    def log(self, view=None):
        return self.ctl('/__log' + ('' if view is None else '?view=' + view))

    def ops(self, view, name=None):
        return [o for o in self.log(view)['ops'] if name is None or o['op'] == name]

    def reset(self, strict=True, extra=None):
        for rel, name in SEEDED.items():
            shutil.copyfile(FIXTURES / name, self.volume / rel)
        wanted = {'Documents/암호 문서.hwpx': QA_FIXTURES / 'qa-locked.hwpx', **{k: Path(v) for k, v in (extra or {}).items()}}
        for rel, src in wanted.items():
            if Path(src).is_file():
                (self.volume / rel).parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(src, self.volume / rel)
        keep = set(SEEDED) | {rel for rel, src in wanted.items() if Path(src).is_file()}
        for path in [p for p in self.volume.rglob('*') if p.is_file()]:  # everything a scenario created (saves, copies, backups) is removed
            if path.relative_to(self.volume).as_posix() not in keep:
                path.unlink()
        self.ctl('/__reset')
        self.ctl('/__config?strict=' + ('1' if strict else '0'))
        self.ctl('/__grant?1')

    def enable_workspace(self, *tags, split=False):
        return self.ctl('/__workspace?enable=1&tabs=' + ','.join(tags) + ('&split=1' if split else ''))

    def close(self):
        self.server.terminate()
        self.server.wait(timeout=10)


class Realm:
    """One EditorSession stand-in: its own browser context (own JS realm/WASM/storage) + its own native view tag. Nothing is filtered."""

    def __init__(self, browser, world, label, viewport=(960, 900), tag=None, inplace_open=False):
        # tag=None: the well-known tab id of `label`; an explicit tag plays a tab that the native root created later (workspaceNew/OpenRecent child).
        # inplace_open: in workspace mode Ctrl+O/Ctrl+N open a NEW TAB by design, so documents are loaded through the legacy in-place launch path instead.
        self.world, self.label, self.tag, self.viewport, self.inplace_open = world, label, tag or TABS[label], viewport, inplace_open
        self.context = browser.new_context(viewport={'width': viewport[0], 'height': viewport[1]}, permissions=['clipboard-read', 'clipboard-write'])
        self.page = self.context.new_page()
        self.cdp = self.context.new_cdp_session(self.page)
        self.console, self.page_errors, self.external, self.bad_http, self.dialogs = [], [], [], [], []
        self.page.on('console', lambda m: self.console.append((m.type, m.text)) if m.type in ('error', 'warning') else None)
        self.page.on('pageerror', lambda e: self.page_errors.append(str(e)))
        self.page.on('request', lambda r: self.external.append(r.url) if r.url.startswith(('http:', 'https:', 'ws:', 'wss:')) and not r.url.startswith(world.base + '/') else None)
        self.page.on('response', lambda r: self.bad_http.append((r.status, r.url)) if r.status >= 400 else None)
        self.page.add_init_script('addEventListener("securitypolicyviolation", e => (window.__cspViolations = window.__cspViolations || []).push(e.violatedDirective + " " + e.blockedURI));')
        self.page.on('dialog', lambda d: (self.dialogs.append((d.type, d.message)), d.dismiss()))

    # ---- driving
    def sleep(self, seconds):
        self.page.wait_for_timeout(int(seconds * 1000))

    def ev(self, expression):
        result = self.cdp.send('Runtime.evaluate', {'expression': expression, 'awaitPromise': True, 'returnByValue': True})
        if 'exceptionDetails' in result:
            details = result['exceptionDetails']
            raise RuntimeError(details.get('exception', {}).get('description') or str(details))
        return result['result'].get('value')

    def wait(self, expression, timeout=30, what=''):
        end, last = time.time() + timeout, None
        while time.time() < end:
            try:
                value = self.ev(expression)
                if value:
                    return value
            except RuntimeError as error:
                last = error
            self.sleep(0.1)
        raise AssertionError(f'[{self.label}] timed out waiting for {what or expression} (last error: {last})')

    def state(self):
        return self.ev('(() => { const s = window.rhwpStudio.android.getState(); return {...s, fileHandle: !!s.fileHandle}; })()')

    def wait_state(self, **expected):
        end = time.time() + 30
        while time.time() < end:
            current = self.state()
            if all(current.get(k) == v for k, v in expected.items()):
                return current
            self.sleep(0.1)
        raise AssertionError(f'[{self.label}] state never became {expected}; last {self.state()}')

    def boot(self, blank=True, extra_query=''):
        response = self.page.goto(f'{self.world.base}/studio/index.html?view={self.tag}{extra_query}')
        assert response.ok, response.status
        self.wait("window.rhwpStudio && window.rhwpStudio.android && window.AndroidStudioHost && window.AndroidStudioHost.startupState === 'ready' && !!document.querySelector('.android-host-config')", 120, 'Studio + host ready')
        if blank:
            self.wait_state(hasDocument=True, fileName='새 문서.hwp')
        return self

    def host_dialog(self):
        return self.page.locator('dialog.android-host-dialog')

    def studio_dialog(self):
        return self.page.locator('.dialog-wrap')

    def launch_doc(self, name, folder=None):
        """Legacy in-place open of a file on the shared volume (the path external-open/launchQueue uses; unchanged by the workspace)."""
        found = [p for p in self.world.volume.rglob('*') if p.is_file() and name in p.name and '_백업_' not in p.name and (not folder or folder in p.parent.as_posix())]
        assert len(found) == 1, ('launch_doc needs exactly one match', name, folder, found)
        p = found[0]
        meta = {'id': sha(str(p).encode()), 'name': p.name, 'path': str(p), 'folder': str(p.parent), 'size': p.stat().st_size, 'modified': 1, 'format': p.suffix[1:]}
        self.ev("AndroidStudioHost.request('scan').then(() => true)")  # registers the source handle in THIS session only
        self.ev(f"(() => {{ AndroidStudioHost.launch({json.dumps(meta)}); return true; }})()")

    def open_doc(self, name, key='Control+o', folder=None, wait=True):
        if self.inplace_open:
            self.launch_doc(name, folder)
        else:
            self.page.keyboard.press(key)
            self.page.get_by_role('searchbox', name='문서 이름 검색').fill(name)
            rows = self.page.locator('.android-host-list button').filter(has_text=name)
            (rows.filter(has_text=folder) if folder else rows).first.click()
        if not wait:
            return None
        self.wait("document.querySelectorAll('#scroll-container canvas').length > 0", 60, 'document canvas')
        self.wait_state(hasDocument=True)
        self.sleep(0.4)
        return self.state()

    def click_document(self, dy=120):
        box = self.page.locator('#scroll-container canvas').first.bounding_box()
        self.page.mouse.click(box['x'] + box['width'] / 2, box['y'] + dy)
        self.sleep(0.2)

    def caret_box(self):
        return self.ev("(() => { const r = document.querySelector('.caret').getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; })()")

    def take_alert(self, fragment, timeout=15):
        end = time.time() + timeout
        while time.time() < end:
            for index, (_, message) in enumerate(self.dialogs):
                if fragment in message:
                    del self.dialogs[index]
                    return message
            self.sleep(0.1)
        raise AssertionError(f'[{self.label}] no native alert containing {fragment!r}; saw {self.dialogs}')

    def take_console_error(self, fragment):
        for index, (kind, text) in enumerate(self.console):
            if kind == 'error' and fragment in text:
                del self.console[index]
                return text
        raise AssertionError(f'[{self.label}] no console error containing {fragment!r}; saw {self.console}')

    def confirm_studio_filename(self):
        self.studio_dialog().get_by_role('button', name='확인').click()

    def choose_destination(self, name, folders=()):
        dialog = self.host_dialog()
        dialog.get_by_role('heading', name='다른 이름으로 저장').wait_for(timeout=20000)
        dialog.locator('.android-host-path').filter(has_text='/').wait_for()
        for folder in folders:
            dialog.locator('.android-host-list button').filter(has_text='📁 ' + folder).click()
            dialog.locator('.android-host-path').filter(has_text=folder).wait_for()
        dialog.get_by_label('파일 이름').fill(name)
        dialog.get_by_role('button', name='저장', exact=True).click()
        dialog.wait_for(state='detached', timeout=20000)

    def type_marker(self, text, home=True):
        self.click_document()
        if home:
            self.page.keyboard.press('Control+Home')
        self.page.keyboard.type(text)
        self.wait_state(dirty=True)

    def assert_safe(self):
        violations = self.ev('window.__cspViolations || []')
        assert not self.page_errors, (self.label, 'page errors', self.page_errors)
        assert not self.external, (self.label, 'external requests', self.external)
        assert not self.bad_http, (self.label, 'HTTP >= 400 responses', self.bad_http)
        assert not violations, (self.label, 'CSP violations', violations)
        errors = [m for m in self.console if m[0] == 'error']
        assert not errors, (self.label, 'console errors', errors)
        assert not self.dialogs, (self.label, 'unexpected native alert/confirm/prompt dialogs', self.dialogs)

    def close(self):
        self.context.close()
