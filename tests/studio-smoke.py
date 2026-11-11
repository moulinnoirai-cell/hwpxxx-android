"""STUB-HOST browser smoke of the real desktop Studio build (app/src/main/assets/studio) under the Android CSP.
NOT evidence for the real studio-host.js / MainActivity / WebView / DeX: the host here is tests/studio-host-stub.js, a minimal contract stub.
Serves /studio/* and the TEST host stub (/studio-host.js) from a local server, enforces the pinned CSP as a response header,
and fails on any external request, CSP violation or page error. Synthetic fixtures only (tests/fixtures).
  python tests/studio-smoke.py        (run `node scripts/build-studio.mjs` first)"""
import base64, json, os, sys, threading, http.server, socketserver, pathlib, re
from playwright.sync_api import sync_playwright

root = pathlib.Path(__file__).resolve().parent.parent
studio = pathlib.Path(os.environ.get('STUDIO_SMOKE_DIR') or (root / 'app/src/main/assets/studio')).resolve()   # default: the packaged bundle
csp = json.loads((root / 'config/android-studio.json').read_text())['csp']
stub = (root / 'tests/studio-host-stub.js').read_bytes()
qa = root / '.qa'; qa.mkdir(exist_ok=True)
MIME = {'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.json': 'application/json'}
requests = []

class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        path = self.path.split('?')[0]
        requests.append(self.path)
        if path == '/studio-host.js': body, mime = stub, 'text/javascript'
        elif path.startswith('/studio/'):
            rel = path[len('/studio/'):] or 'index.html'
            f = (studio / rel).resolve()
            if not str(f).startswith(str(studio.resolve())) or not f.is_file(): self.send_response(404); self.end_headers(); return
            body, mime = f.read_bytes(), MIME.get(f.suffix, 'text/plain')
        else: self.send_response(403); self.end_headers(); return
        self.send_response(200); self.send_header('Content-Type', mime); self.send_header('Content-Length', str(len(body)))
        self.send_header('Content-Security-Policy', csp); self.send_header('X-Content-Type-Options', 'nosniff'); self.send_header('Cache-Control', 'no-store'); self.end_headers(); self.wfile.write(body)

socketserver.TCPServer.allow_reuse_address = True
server = socketserver.ThreadingTCPServer(('127.0.0.1', 0), H); port = server.server_address[1]
threading.Thread(target=server.serve_forever, daemon=True).start()
base = f'http://127.0.0.1:{port}'
results = {}
# What the SERVED bundle contains decides which behaviours are mandatory: its own build-info.json (falls back to the repo lock).
_info = studio / 'build-info.json'
cfg_patches = (json.loads(_info.read_text()).get('pins', {}).get('androidPatches') if _info.exists() else None) or json.loads((root / 'config/android-studio.json').read_text())['androidPatches']
# The final bundle carries 0108 (streaming PNG print + visible refused saves): then those behaviours are MANDATORY, not informational.
REQUIRE_PERSIST = any(n.startswith('0109') for n in cfg_patches) or os.environ.get('STUDIO_SMOKE_REQUIRE_FINAL') == '1'
REQUIRE_FINAL = any(n.startswith('0108') for n in cfg_patches) or os.environ.get('STUDIO_SMOKE_REQUIRE_FINAL') == '1' or os.environ.get('STUDIO_SMOKE_REQUIRE_VISIBLE_REFUSAL') == '1'
def check(name, ok, detail=''):
    results[name] = {'ok': bool(ok), 'detail': str(detail)[:300]}
    print(('PASS ' if ok else 'FAIL ') + name + (' — ' + str(detail)[:200] if detail and not ok else ''))

def b64(p): return base64.b64encode(pathlib.Path(p).read_bytes()).decode()

with sync_playwright() as p:
    exe = os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE') or ('/usr/bin/chromium' if os.path.exists('/usr/bin/chromium') else None)
    browser = p.chromium.launch(executable_path=exe, args=['--no-sandbox'])
    ctx = browser.new_context(viewport={'width': 1280, 'height': 800}, accept_downloads=False)
    external = []
    ctx.route('**/*', lambda route: route.continue_() if route.request.url.startswith(base) or route.request.url.startswith(('data:', 'blob:')) else (external.append(route.request.url), route.abort())[1])
    page = ctx.new_page()
    cdp = ctx.new_cdp_session(page)
    import time
    def ev(expr, arg=None):
        # CDP Runtime.evaluate is not subject to the page CSP (page.evaluate would need unsafe-eval, which the policy rightly forbids)
        if arg is not None: expr = '(' + expr + ')(' + json.dumps(arg) + ')'
        r = cdp.send('Runtime.evaluate', {'expression': expr, 'awaitPromise': True, 'returnByValue': True})
        if 'exceptionDetails' in r: raise RuntimeError(r['exceptionDetails'].get('exception', {}).get('description', str(r['exceptionDetails'])))
        return r['result'].get('value')
    def call(fn_src):
        # ev() of a bare arrow function returns the function object (None over CDP) — a classic false positive. Always INVOKE it.
        return ev('(' + fn_src + ')()')
    PIXELS = '''() => [...document.querySelectorAll('canvas')].filter(c => c.id !== 'h-ruler' && c.id !== 'v-ruler' && c.width > 300 && c.height > 300).map(c => {
        const x = c.getContext('2d'); if (!x) return {w: c.width, h: c.height, ctx2d: false};
        const d = x.getImageData(0, 0, c.width, c.height).data; let ink = 0, translucent = 0, h = 17;
        // The page edge is a 1px anti-aliased frame (alpha 143/186/234): everything INSIDE it must be fully opaque.
        for (let i = 0; i < d.length; i += 4) { const px = (i / 4) % c.width, py = Math.floor(i / 4 / c.width); const edge = px === 0 || py === 0 || px === c.width - 1 || py === c.height - 1; if (!edge && d[i + 3] < 255) translucent++; if (d[i] < 245 || d[i + 1] < 245 || d[i + 2] < 245) ink++; }
        for (let i = 0; i < d.length; i += 61) h = (h * 31 + d[i]) | 0;
        return {w: c.width, h: c.height, ctx2d: true, ink, translucent, hash: h}; })'''
    def pixels(): return call(PIXELS)
    def wait(expr, timeout=30000):
        end = time.time() + timeout / 1000
        while time.time() < end:
            try:
                if ev(expr): return True
            except RuntimeError: pass
            time.sleep(0.15)
        raise TimeoutError(expr)
    errors, csp_hits, dialogs, downloads = [], [], [], []
    page.on('download', lambda d: downloads.append(d.suggested_filename))
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('console', lambda m: (csp_hits.append(m.text) if 'Content Security Policy' in m.text or 'Refused to' in m.text else None, errors.append('console.error: ' + m.text) if m.type == 'error' and 'Content Security Policy' not in m.text else None))
    page.on('dialog', lambda d: (dialogs.append(d.message), d.accept()))
    page.add_init_script("document.addEventListener('securitypolicyviolation', e => (window.__csp = window.__csp || []).push(e.violatedDirective + ' ' + e.blockedURI))")
    page.goto(base + '/studio/index.html')
    wait("window.rhwpStudio && window.rhwpStudio.android && window.rhwpStudio.android.getState().hasDocument", 60000)
    check('boot: Studio started and opened a blank document', True)
    check('host: onReady called after initialization', ev("window.__host.log.ready") == 1)
    st = ev("window.rhwpStudio.android.getState()")
    check('host: getState has fileName/dirty/encrypted/format/fileHandle keys', all(k in st for k in ['fileName', 'dirty', 'encrypted', 'format', 'fileHandle', 'hasDocument']), st)
    check('desktop UI present (menu bar, toolbars, canvas)', ev("!!document.querySelector('#menu-bar') && !!document.querySelector('#icon-toolbar') && document.querySelectorAll('canvas').length > 0"))
    inventory = json.loads((root / 'tests/studio-command-inventory.json').read_text())   # 168 desktop command IDs (provenance: docs of the PC 1.6.1 patched source)
    expected = sorted(i for ids in inventory.values() for i in ids)
    registered = ev("window.rhwpStudio.automation.listCommands().map(c => c.id)")
    menu = call("() => window.rhwpStudio.automation.getMenuModel().length")
    missing = [i for i in expected if i not in registered]
    check('desktop command registry: all 168 inventory IDs are registered in the running Android build (STRUCTURAL reuse only; says nothing about each command working on Android)', len(expected) == 168 and not missing and menu >= 8, missing[:10] or menu)
    check('no public wasm/dev objects exposed', ev("typeof window.__wasm === 'undefined' && typeof window.__documentState === 'undefined' && !('wasm' in window.rhwpStudio)"))
    page.wait_for_timeout(1200)
    page.screenshot(path=str(qa / 'studio-blank.png'))
    check('test helper self-check: a bare function expression is never read as a number (the old false positive), an invoked one is', ev('() => 1') in (None, {}) and call('() => 1') == 1, repr(ev('() => 1')))
    px = pixels()
    check('renderer is Canvas2D (a 2d context is obtainable from the page canvas) and the page is not SVG', isinstance(px, list) and len(px) >= 1 and all(c['ctx2d'] for c in px) and call("() => !document.querySelector('#scroll-container svg')") is True, px)
    check('blank page canvas is a valid opaque A4 bitmap (794x1123 CSS px, interior alpha 255 inside the 1px anti-aliased page edge; ink count is a number, not asserted >0)', len(px) >= 1 and px[0]['w'] == 794 and px[0]['h'] == 1123 and px[0]['translucent'] == 0 and isinstance(px[0]['ink'], int) and px[0]['ink'] >= 0, px)

    # open a real document through the standard launchQueue path (host handle) and save back through the adapter
    fx = root / 'tests/fixtures/문서.hwp'
    ev("([b]) => { const bin = atob(b); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); window.__host.put('문서.hwp', u); window.__host.open('문서.hwp'); }", [b64(fx)])
    try: wait("window.rhwpStudio.android.getState().fileName === '문서.hwp'", 20000)
    except TimeoutError:
        print('DEBUG consumerSet', ev('window.__host.log.consumerSet'), 'state', ev("window.rhwpStudio.android.getState()"), 'errors', errors, 'dialogs', dialogs, 'csp', csp_hits); page.screenshot(path=str(qa / 'studio-open-fail.png')); raise
    st = ev("({...window.rhwpStudio.android.getState(), handleName: window.rhwpStudio.android.getState().fileHandle?.name})")
    check('open: host File via launchQueue loads with its handle retained', st['handleName'] == '문서.hwp' and not st['dirty'] and st['format'] == 'hwp', st)
    page.wait_for_timeout(1500)
    opened = pixels()
    check('open: the real fixture paints ink on a Canvas2D page (numeric, > 300 non-white pixels, opaque)', isinstance(opened, list) and len(opened) >= 1 and all(c['ctx2d'] and c['translucent'] == 0 for c in opened) and max(c['ink'] for c in opened) > 300, opened)
    # ── recent documents through the host provider (patch 0109) ──────────────────────────────────────────────────────
    def toasts(): return call("() => document.body.innerText")
    if REQUIRE_PERSIST:
        wait("window.__host.log.recent.size >= 1", 15000)
        second = root / 'tests/fixtures/문서.hwpx'
        ev("([b]) => { const bin = atob(b); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); window.__host.put('문서.hwpx', u); window.__host.pickName = '문서.hwpx'; window.__host.open('문서.hwpx'); }", [b64(second)])
        wait("window.rhwpStudio.android.getState().fileName === '문서.hwpx'", 60000)
        wait("window.__host.log.recent.size === 2", 15000)
        idb = ev("indexedDB.databases ? indexedDB.databases().then(d => d.map(x => x.name)) : []")
        check('recent: entries live in the host provider (opaque ids, reopenable), not in IndexedDB', ev("[...window.__host.log.recent.values()].every(r => r.reopenable && /^r\\d+$/.test(r.id))") is True and 'rhwpStudioRecent' not in idb, [idb, ev("[...window.__host.log.recent.values()]")])
        first_id = ev("[...window.__host.log.recent.values()].find(r => r.fileName === '문서.hwp').id")
        second_id = ev("[...window.__host.log.recent.values()].find(r => r.fileName === '문서.hwpx').id")
        r1 = ev("window.rhwpStudio.automation.execute('file:open-recent', {id: '%s'})" % first_id)
        wait("window.rhwpStudio.android.getState().fileName === '문서.hwp'", 60000)
        check('recent: file:open-recent reopens through host.recent.open(id) with a fresh handle (standard open path)', ev("window.__host.log.recentCalls.some(c => c[0] === 'open' && c[1] === '%s')" % first_id) is True and ev("window.rhwpStudio.android.getState().fileHandle?.name") == '문서.hwp' and not ev("window.rhwpStudio.android.getState().dirty"), r1)
        # grant revoked: entry kept, user told, standard picker opens (never a silent dead command)
        picks = ev("window.__host.log.pickerCalls")
        ev("window.__host.failRecentOpen('NotAllowedError')")
        ev("window.rhwpStudio.automation.execute('file:open-recent', {id: '%s'})" % second_id)
        wait("window.__host.log.pickerCalls === %d" % (picks + 1), 15000)
        wait("window.rhwpStudio.android.getState().fileName === '문서.hwpx'", 60000)
        # (the re-picked file is added again by the host: same file => refreshed entry, so look it up by name, not by the old id)
        check('recent: revoked permission keeps the entry, tells the user and opens the picker so they can re-pick', ev("[...window.__host.log.recent.values()].some(r => r.fileName === '문서.hwpx')") is True and '다시 선택' in toasts(), toasts()[-200:])
        # file gone: entry removed
        first_id = ev("[...window.__host.log.recent.values()].find(r => r.fileName === '문서.hwp').id")   # ids are refreshed whenever the host re-adds a file
        ev("window.__host.failRecentOpen('NotFoundError')")
        ev("window.rhwpStudio.automation.execute('file:open-recent', {id: '%s'})" % first_id)
        wait("!window.__host.log.recent.has('%s')" % first_id, 15000)
        check('recent: a vanished file is removed from the host list with a notice', '목록에서 제거' in toasts())
        ev("window.__host.failRecentOpen(null)")
        # a non-reopenable (metadata-only) entry asks to re-pick, never dead
        ev("window.__host.log.recent.set('rX', {id: 'rX', fileName: '끌어온.hwp', sourceFormat: 'hwp', openedAt: 1, reopenable: false})")
        picks = ev("window.__host.log.pickerCalls")
        ev("window.rhwpStudio.automation.execute('file:open-recent', {id: 'rX'})")
        wait("window.__host.log.pickerCalls === %d" % (picks + 1), 15000)
        check('recent: a metadata-only entry asks the user to re-pick (no dead command)', True)
        ev("window.__host.log.recent.delete('rX')")
        ev("window.__host.open('문서.hwp')"); wait("window.rhwpStudio.android.getState().fileName === '문서.hwp'", 60000)
    else:
        print('INFO persistence (history/recent) checks skipped: the served bundle has no 0109 patch')
        results['info:persistence-skipped'] = {'ok': True, 'detail': 'no 0109 in the served bundle'}
    page.locator('#scroll-container').click(position={'x': 300, 'y': 200})
    page.keyboard.type('안드로이드 스모크')
    wait("window.rhwpStudio.android.getState().dirty === true", 10000)
    check('edit: typing through the desktop input handler dirties the document', True)
    page.wait_for_timeout(1200)
    typed = pixels()
    check('edit: the typed text is painted (Canvas2D pixels changed and ink grew)', typed[0]['hash'] != opened[0]['hash'] and typed[0]['ink'] > opened[0]['ink'], [opened[0], typed[0]])
    page.screenshot(path=str(qa / 'studio-edited.png'))
    st = ev("window.rhwpStudio.android.flushRecovery()")
    check('recovery: flushRecovery stores a draft only in the native store (no IndexedDB)', st.get('ok') is True and ev("window.__host.log.drafts.size") == 1 and ev("indexedDB.databases ? indexedDB.databases().then(d => d.filter(x => /Autosave/i.test(x.name)).length) : 0") == 0, st)
    # a failing native write must neither fall back to a download nor mark the document clean
    ev("window.__host.failWrites(true)")
    before = ev("window.__host.log.writes.length")
    dialogs.clear()
    page.keyboard.press('Control+s')
    page.wait_for_timeout(2500)
    st = ev("window.rhwpStudio.android.getState()")
    check('save: refused native write keeps the document dirty, performs no write and no download', st['dirty'] and ev("window.__host.log.writes.length") == before and not downloads, [dialogs, downloads])
    # Whether the user is TOLD about the refusal depends on the NotAllowedError handling (upstream treats it as a silent cancel);
    # reported separately: set STUDIO_SMOKE_REQUIRE_VISIBLE_REFUSAL=1 to make it a hard requirement.
    visible = len(dialogs) >= 1
    if REQUIRE_FINAL: check('save: refused native write is announced to the user (mandatory for the final bundle)', visible, dialogs)
    else:
        print('INFO refused native write announced to the user (NOT yet required: bundle has no 0108):', visible)
        results['info:refusal-visible'] = {'ok': True, 'detail': str(visible)}
    ev("window.__host.failWrites(false)")
    # the host save guard (external) can block a save too
    ev("window.rhwpStudio.android.setSaveGuard(() => { throw new Error('guard says no'); })")
    dialogs.clear(); page.keyboard.press('Control+s'); page.wait_for_timeout(1500)
    check('save guard: a throwing guard blocks the write', ev("window.__host.log.writes.length") == before and any('guard says no' in d for d in dialogs), dialogs)
    ev("window.rhwpStudio.android.setSaveGuard(null)")
    page.keyboard.press('Control+s')
    wait("window.__host.log.writes.length === %d" % (before + 1), 30000)
    wait("window.rhwpStudio.android.getState().dirty === false", 10000)
    wrote = ev("Array.from(window.__host.log.writes.at(-1).bytes.slice(0, 8))")
    check('save: verified export is written through the host handle (CFB/HWP signature), then clean', wrote[:4] == [0xD0, 0xCF, 0x11, 0xE0], wrote)
    check('save: clean document drops its recovery draft', ev("window.__host.log.drafts.size") == 0)
    out_b64 = ev("btoa(String.fromCharCode(...window.__host.log.writes.at(-1).bytes))")
    pathlib.Path(qa / 'studio-saved.hwp').write_bytes(base64.b64decode(out_b64))
    # print / PDF / export go to the host, never to iframes or downloads
    ev("window.rhwpStudio.automation.execute('file:print-to-pdf')")
    wait("window.__host.log.prints.length >= 1", 60000)
    pr = ev("window.__host.log.prints[0]")
    if pr['mode'] == 'stream':
        pg = pr['pages']
        check('pdf: file:print-to-pdf streams real rendered PNG pages (pageCount, renderPage(i)) with ink, abort signal and px sizes (intent pdf)', pr['intent'] == 'pdf' and pr['pageCount'] == len(pg) >= 1 and pr['hasSignal'] and all(p['signature'] == [0x89, 0x50, 0x4E, 0x47] and p['width'] > 100 and p['bitmap'][0] > 100 and p['ink'] > 300 for p in pg), pr)
    else:
        check('PNG print is mandatory for the final (0108) bundle; legacy SVG array accepted only before it', not REQUIRE_FINAL, pr)
        check('pdf (legacy array form): real SVG pages + px sizes to host.printPages (intent pdf)', pr['intent'] == 'pdf' and len(pr['pages']) >= 1 and pr['pages'][0]['width'] > 100 and '<svg' in pr['pages'][0]['svgHead'], pr)
    ev("window.rhwpStudio.automation.execute('file:print')")
    wait("window.__host.log.prints.length >= 2", 60000)
    check('print: file:print goes to host.printPages (intent print), no iframe/window', ev("window.__host.log.prints[1].intent") == 'print' and ev("window.__host.log.prints[1].mode") == pr['mode'] and call("() => document.querySelectorAll('iframe').length") == 0)
    ev("window.rhwpStudio.automation.execute('file:export-html')")
    wait("window.__host.log.exports.length >= 1", 30000)
    check('export: HTML export awaits host.exportFile(blob, name)', ev("window.__host.log.exports[0].name").lower().endswith('.html'), ev("window.__host.log.exports[0]"))
    if REQUIRE_PERSIST:
        # document history through the host provider (patch 0109): UTF-8 JSON snapshot, nothing in IndexedDB
        ev("window.rhwpStudio.automation.execute('edit:document-history', {}, {allowDialog: true})")
        page.wait_for_selector('.history-dialog', timeout=15000)
        page.locator('.history-dialog button.dialog-btn').first.click()
        wait("window.__host.log.history.size === 1", 30000)
        snap = ev("(() => { const r = [...window.__host.log.history.values()][0]; return {meta: r.meta, head: Array.from(r.data.slice(0, 1)), text: new TextDecoder().decode(r.data).slice(0, 1)}; })()")
        idb = ev("indexedDB.databases ? indexedDB.databases().then(d => d.map(x => x.name)) : []")
        check('history: a snapshot is stored through host.history.put as UTF-8 JSON (ir) and IndexedDB has no history database', snap['text'] == '{' and snap['meta']['storageKind'] == 'ir' and snap['meta']['byteLength'] > 10 and 'rhwpStudioDocHistory' not in idb and 'rhwpStudioRecent' not in idb, [snap['meta'], idb])
        listed = call("() => document.querySelector('.history-dialog').innerText")
        check('history: the dialog lists the stored snapshot by its label (read back through host.history.list)', bool(snap['meta']['label']) and snap['meta']['label'] in listed and ev("window.__host.log.historyCalls.includes('list')") is True, [snap['meta']['label'], listed[-200:]])
        page.locator('.history-dialog .dialog-close').click()
    # close: clean doc may leave; dirty doc asks (dialog) and a cancel keeps it
    check('close: confirmClose() true for a clean document', ev("window.rhwpStudio.android.confirmClose()") is True)
    page.locator('#scroll-container').click(position={'x': 300, 'y': 200}); page.keyboard.type('x')
    wait("window.rhwpStudio.android.getState().dirty === true")
    pending = ev("(window.__pc = window.rhwpStudio.android.confirmClose().then(v => { window.__closed = v; return v; }), 1)")
    page.wait_for_timeout(500)
    btns = ev("[...document.querySelectorAll('dialog button, .dialog-wrap button, .modal-overlay button, .dialog button')].map(b => b.textContent.trim()).filter(Boolean)")
    page.screenshot(path=str(qa / 'studio-unsaved-dialog.png'))
    check('close: dirty document shows the ordinary unsaved-changes dialog', len(btns) >= 2, btns)
    cancel = page.get_by_role('button', name=re.compile('취소|Cancel'))
    if cancel.count(): cancel.first.click()
    wait("window.__closed !== undefined", 10000)
    check('close: cancel returns false and keeps the document', ev("window.__closed") is False and ev("window.rhwpStudio.android.getState().dirty"))

    # encrypted fixture (built by tests/build-qa-fixtures.mjs): password open, encrypted private recovery draft
    locked = root / '.qa/fixtures/qa-locked.hwpx'
    if locked.exists():
        ev("([b]) => { const bin = atob(b); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); window.__host.put('암호.hwpx', u); }", [b64(locked)])
        ev("window.__discard = true")
        # discard the dirty document first
        ev("window.__host.open('암호.hwpx')")
        page.wait_for_timeout(600)
        disc = page.get_by_role('button', name=re.compile('저장 안 함|버리|Discard|Don'))
        if disc.count(): disc.first.click()
        page.wait_for_selector('input[type=password]', timeout=15000)
        page.locator('input[type=password]').first.fill('qa-only-2026'); page.keyboard.press('Enter')
        wait("window.rhwpStudio.android.getState().fileName === '암호.hwpx'", 30000)
        st = ev("window.rhwpStudio.android.getState()")
        check('encrypted: password open works and state says encrypted', st['encrypted'] is True, st)
        if REQUIRE_PERSIST:
            before_put = ev("window.__host.log.historyCalls.filter(c => c === 'put').length")
            ev("window.rhwpStudio.automation.execute('edit:document-history', {}, {allowDialog: true})")
            page.wait_for_selector('.history-dialog', timeout=15000)
            page.locator('.history-dialog button.dialog-btn').first.click()
            page.wait_for_timeout(2500)
            notice = call("() => document.querySelector('.history-dialog').innerText")
            check('history: a password-protected document is never sent to the host store (memory only, user is told)', ev("window.__host.log.historyCalls.filter(c => c === 'put').length") == before_put and '암호 문서' in notice, notice[-160:])
            page.locator('.history-dialog .dialog-close').click()
        page.wait_for_timeout(600)
        page.locator('#scroll-container').click(position={'x': 300, 'y': 200}); page.keyboard.type('암호 편집')
        wait("window.rhwpStudio.android.getState().dirty === true")
        r = ev("window.rhwpStudio.android.flushRecovery()")
        d = ev("[...window.__host.log.drafts.values()].map(x => ({encrypted: x.encrypted, fmt: x.sourceFormat, head: Array.from(x.data.slice(0, 4)), hasPlain: new TextDecoder('latin1').decode(x.data).includes('qa-only')}))")
        # Recovery follows upstream rhwp: the draft is sealed with a key derived from the document password (PBKDF2 + AES-GCM). The Android store keeps the envelope
        # packed in front of the ciphertext (magic 'RHENV1'); the password is never stored and the bytes hold no plaintext. The unlock round trip with the real cipher
        # is covered by rhwp-studio/tests/hwpxxx-android-save-safety.test.ts.
        check('encrypted: recovery draft is written encrypted-flagged as a sealed envelope (RHENV1 magic), never plaintext metadata', r.get('ok') is True and len(d) == 1 and d[0]['encrypted'] is True and d[0]['head'] == [0x52, 0x48, 0x45, 0x4E] and not d[0]['hasPlain'], [r, d])
        draft_b64 = ev("btoa(String.fromCharCode(...[...window.__host.log.drafts.values()][0].data))")
        draft_bytes = base64.b64decode(draft_b64)
        plain_marks = [draft_bytes.find(t.encode(enc)) for t in ('암호 편집', '문서', 'qa-only-2026') for enc in ('utf-16-le', 'utf-8')]
        check('encrypted: recovery draft is real ciphertext (no plaintext of the typed text, the document or the password in UTF-16/UTF-8; not an HWP/ZIP container)', all(m == -1 for m in plain_marks) and draft_bytes[:2] not in (b'PK', bytes([0xD0, 0xCF])) and len(draft_bytes) > 64, plain_marks)
        # encrypted save: the password dialog, verification with that password, encrypted bytes through the host handle, password kept for recovery afterwards
        n = ev("window.__host.log.writes.length")
        page.keyboard.press('Control+s')
        page.wait_for_selector('input[type=password]', timeout=15000)
        for i in range(page.locator('input[type=password]').count()): page.locator('input[type=password]').nth(i).fill('qa-only-2026')
        page.screenshot(path=str(qa / 'studio-save-password.png'))
        okbtn = page.get_by_role('button', name=re.compile('확인|저장|OK|Save'))
        okbtn.last.click()
        wait("window.__host.log.writes.length === %d" % (n + 1), 60000)
        wait("window.rhwpStudio.android.getState().dirty === false", 10000)
        eb = ev("Array.from(window.__host.log.writes.at(-1).bytes.slice(0, 4))")
        txt = ev("new TextDecoder('latin1').decode(window.__host.log.writes.at(-1).bytes).includes('qa-only-2026')")
        check('encrypted: Ctrl+S asks the password, verifies, writes ciphertext through the host handle and stays encrypted', eb[:2] in ([0x50, 0x4B], [0xD0, 0xCF]) and not txt and ev("window.rhwpStudio.android.getState().encrypted") is True, eb)
        page.locator('#scroll-container').click(position={'x': 300, 'y': 200}); page.keyboard.type('다시 편집')
        wait("window.rhwpStudio.android.getState().dirty === true", 10000)
        r2 = ev("window.rhwpStudio.android.flushRecovery()")
        check('encrypted: the password stays usable (in memory only) for recovery after a successful save', r2.get('ok') is True, r2)
    else:
        check('encrypted: fixture present (run node tests/build-qa-fixtures.mjs)', False, 'missing .qa/fixtures/qa-locked.hwpx')

    check('no external network requests', not external and all(r.startswith(('/studio/', '/studio-host.js')) for r in requests), external or [r for r in requests if not r.startswith(('/studio/', '/studio-host.js'))][:5])
    check('no CSP violations (strict policy incl. wasm-unsafe-eval only)', not csp_hits and not ev("window.__csp || []"), csp_hits or ev("window.__csp"))
    expected = ('guard says no', '저장 실패')   # console.error lines of the two refusals this test provokes on purpose
    unexpected = [e for e in errors if not any(x in e for x in expected)]
    check('no page errors', not unexpected, unexpected[:5])
    browser.close()
server.shutdown()
(qa / 'studio-smoke-results.json').write_text(json.dumps(results, ensure_ascii=False, indent=1))
bad = [k for k, v in results.items() if not v['ok']]
print(f"{len(results) - len(bad)}/{len(results)} passed")
sys.exit(1 if bad else 0)
