#!/usr/bin/env python3
"""Save lifecycle races in the REAL patched Studio with the REAL studio-host.js (Chromium, recording OfflineNative stub; not a device).

  python3 tests/studio-save-lifecycle.py --studio-root <patched tree>/rhwp-studio

Question under test: a Save of document A is slow (native write, export check). Document C is opened meanwhile. A's write may finish
safely, but C must keep its own name, handle and clean/dirty state, the next Ctrl+S of C must write C to C's target, and bytes made
from A must never be written through C's handle.
"""
import argparse
import base64
import json
import pathlib
import re
import sys

from playwright.sync_api import sync_playwright

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import studio_harness as harness  # noqa: E402

here = pathlib.Path(__file__).resolve().parent
parser = argparse.ArgumentParser()
parser.add_argument('--studio-root', required=True)
args = parser.parse_args()
doc_a = (here / 'fixtures/문서.hwp').read_bytes()
doc_b = (here / 'fixtures/blank.hwp').read_bytes()
META = {
    'idA': {'id': 'idA', 'name': 'A.hwp', 'path': '/sdcard/Documents/A.hwp', 'folder': '/sdcard/Documents', 'size': len(doc_a), 'modified': 1, 'format': 'hwp'},
    'idB': {'id': 'idB', 'name': 'B.hwp', 'path': '/sdcard/Documents/B.hwp', 'folder': '/sdcard/Documents', 'size': len(doc_b), 'modified': 1, 'format': 'hwp'},
}
STUB = r"""
(() => {
  const bytesOf = {idA: Uint8Array.from(atob(%(a)s), c => c.charCodeAt(0)), idB: Uint8Array.from(atob(%(b)s), c => c.charCodeAt(0))};
  const meta = %(meta)s;
  const sha = id => (id === 'idA' ? 'a' : 'b').repeat(64);
  window.__ops = []; window.__pendingOpens = [meta.idA]; window.__holdFinish = false; window.__held = null;
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (u, o) => { const m = /^\/document\/doc-(id[AB])$/.exec(String(u)); return m ? Promise.resolve(new Response(bytesOf[m[1]])) : nativeFetch(u, o); };
  let begin = {};
  window.OfflineNative = {postMessage(message) {
    const {id, op, args} = JSON.parse(message); window.__ops.push({op, args});
    const ok = data => setTimeout(() => window.NativeReply(id, {ok: true, data}), 0);
    switch (op) {
      case 'status': return ok({permission: true, connectedFolders: [], volumes: [{path: '/sdcard', name: '내장 저장공간'}], version: 't', engine: 't'});
      case 'listDrafts': return ok([]);
      case 'fontList': return ok({revision: '0'.repeat(64), faces: []});
      case 'takeOpenRequests': { const list = window.__pendingOpens; window.__pendingOpens = []; return ok(list); }
      case 'read': return ok({url: '/document/doc-' + args.id, token: 'doc-' + args.id, sha: sha(args.id), meta: meta[args.id]});
      case 'beginSave': begin = args; return ok('save-token');
      case 'finishSave': {
        const result = {meta: {...meta[begin.id], path: begin.target, id: begin.id, modified: 2}, sha: 'c'.repeat(64), backup: {name: 'backup.hwp'}};
        if (window.__holdFinish) { window.__holdFinish = false; window.__held = () => { window.__held = null; ok(result); }; return; }
        return ok(result);
      }
      case 'beginDraft': return ok('draft-token');
      case 'finishDraft': return ok({key: 'k1'});
      default: return ok(true);
    }
  }};
})();
""" % {'a': json.dumps(base64.b64encode(doc_a).decode()), 'b': json.dumps(base64.b64encode(doc_b).decode()), 'meta': json.dumps(META)}

checks = []
def check(name, ok, detail=None):
    checks.append({'name': name, 'ok': bool(ok), 'detail': detail})

with harness.vite_server(args.studio_root) as url, sync_playwright() as pw:
    browser = pw.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox', '--disable-dev-shm-usage'])
    page = browser.new_page(viewport={'width': 1280, 'height': 800})
    errors, alerts = [], []
    page.on('pageerror', lambda e: errors.append(str(e)))
    def on_dialog(dialog):
        alerts.append(dialog.message); dialog.accept()
    page.on('dialog', on_dialog)
    harness.serve_host_assets(page)
    page.add_init_script(STUB + harness.host_source())
    page.goto(url + '/index.html')
    page.wait_for_function('!!window.rhwpStudio?.android', timeout=90000)
    ev = page.evaluate
    state = lambda: ev("(() => { const s = window.rhwpStudio.android.getState(); return {name: s.fileName, dirty: s.dirty, handle: s.fileHandle?.name || null, has: s.hasDocument}; })()")
    page.wait_for_function("window.rhwpStudio.android.getState().hasDocument && window.rhwpStudio.android.getState().fileName === 'A.hwp'", timeout=60000)
    page.wait_for_timeout(1500)
    saves = lambda mark: [o['args'] for o in ev("window.__ops")[mark:] if o['op'] == 'beginSave']

    def type_text(text):
        page.click('#scroll-container'); page.keyboard.type(text)
        page.wait_for_function("window.rhwpStudio.android.getState().dirty", timeout=10000)

    def open_other(meta_id, discard=True):
        ev("(id) => AndroidStudioHost.launch(%s[id])" % json.dumps(META), meta_id)
        if discard:
            page.wait_for_selector('.modal-overlay', timeout=15000)
            labels = ev("Array.from(document.querySelectorAll('.modal-overlay button')).map(b => b.textContent.trim())")
            print('unsaved dialog buttons:', labels)
            # Studio's own dialog: [primary save] [cancel] [discard] (labels depend on the locale); discard is the one that is neither.
            discard = next((i for i, text in enumerate(labels) if re.search(r'discard|저장\s*안|저장하지|버리|아니', text, re.I)), None)
            if discard is None:
                raise RuntimeError('no discard button among ' + repr(labels))
            page.locator('.modal-overlay button').nth(discard).click()

    # ---- 1. A's native write finishes AFTER B was opened ----
    type_text('A edits')
    ev("window.__holdFinish = true")
    page.keyboard.press('Control+s')
    page.wait_for_function("!!window.__held", timeout=30000)
    check('A save reached the native write and is held there', saves(0)[-1]['id'] == 'idA' and saves(0)[-1]['target'] == META['idA']['path'], saves(0)[-1:])
    open_other('idB')
    page.wait_for_function("(() => { const s = window.rhwpStudio.android.getState(); return s.fileName === 'B.hwp' && !!s.fileHandle && !s.dirty; })()", timeout=60000)
    check('B replaced A while the write was pending (dirty A was discarded on purpose)', state()['name'] == 'B.hwp' and state()['dirty'] is False, state())
    ev("window.__held()")
    page.wait_for_timeout(1500)
    after = state()
    check('A\'s finished write did not rename B, change its handle or mark it dirty/clean', after == {'name': 'B.hwp', 'dirty': False, 'handle': 'B.hwp', 'has': True}, after)
    check('no error alert after A\'s safe write; the user is told it was the previous document', not alerts and 'A.hwp' in (ev("document.body.innerText") or ''), alerts)
    mark = ev("window.__ops.length")
    type_text('B edits')
    page.keyboard.press('Control+s')
    page.wait_for_function("window.rhwpStudio.android.getState().dirty === false", timeout=30000)
    second = saves(mark)
    check('next Ctrl+S of B writes B to B\'s own file (never A\'s path or A\'s source id)', len(second) == 1 and second[0]['id'] == 'idB' and second[0]['target'] == META['idB']['path'] and second[0]['sha'] == 'b' * 64, second)

    # ---- 2. B opened while A's bytes are still being checked: the write must not happen ----
    type_text('more B')
    ev("""() => { window.__gateEntered = false; window.rhwpStudio.android.setSaveGuard(async () => { window.__gateEntered = true; await new Promise(resolve => { window.__openGate = resolve; }); }); }""")
    mark = ev("window.__ops.length")
    page.keyboard.press('Control+s')
    page.wait_for_function("window.__gateEntered === true", timeout=30000)
    open_other('idA')
    page.wait_for_function("(() => { const s = window.rhwpStudio.android.getState(); return s.fileName === 'A.hwp' && !!s.fileHandle && !s.dirty; })()", timeout=60000)
    alerts.clear()
    ev("window.__openGate()")
    page.wait_for_timeout(2500)
    check('bytes made from B are NOT written after A was opened: no native save at all', saves(mark) == [], saves(mark))
    check('the stopped save is reported visibly', len(alerts) == 1 and '저장하는 동안 다른 문서가 열려' in alerts[0], alerts)
    final = state()
    check('A keeps its own name/handle and stays clean', final == {'name': 'A.hwp', 'dirty': False, 'handle': 'A.hwp', 'has': True}, final)
    check('no page errors', not errors, errors[:3])
    browser.close()

for c in checks:
    print(('PASS ' if c['ok'] else 'FAIL ') + c['name'] + ('' if c['ok'] else '  -> ' + json.dumps(c['detail'], ensure_ascii=False)))
failed = [c for c in checks if not c['ok']]
print(f'{len(checks) - len(failed)}/{len(checks)} checks')
sys.exit(1 if failed else 0)
