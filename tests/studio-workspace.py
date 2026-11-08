#!/usr/bin/env python3
"""Multi-document workspace contract tests: several INDEPENDENT real-Studio realms (one per tab) against the multi-session native MOCK.

  python3 tests/studio-workspace.py --allow-old-bundle [--only name,name]      realm-isolation scenarios against the current bundle
  python3 tests/studio-workspace.py --workspace                                 additionally enables the workspace-oracle controller (needs workspace-tabs.mjs in the assets)

REAL: production Studio bundle/WASM, real studio-host.js, the real workspace-tabs.mjs DOM in the real #menu-bar (Chromium, real mouse drag), strict production CSP (no bypass),
      real keyboard/mouse, independent WASM re-open of every file.
MOCK: OfflineNative (tests/preview-server.mjs, one session per view tag, synchronous workspaceEnabled()) and the WorkspaceModel oracle (tests/workspace-oracle.mjs).
      ?view=<id> exists only in this test shim; the Android WebView gets no query URI.
UNPROVEN HERE (device only, reported NOT RUN, never passed): Android native two-WebView attachment, EditorSession/WebView lifecycle, picker request routing, native crypto, physical DeX.
Without workspace-tabs.mjs in the assets only the realm scenarios may run, and only with --allow-old-bundle (they do not exercise the tab UI).
Assertions are never relaxed to get a pass.
"""
import argparse
import json
import os
import sys
import time
import traceback
import urllib.parse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import workspace_harness as wh  # noqa: E402
from workspace_harness import Realm, World, inspect_file, sha, PASSWORD, TABS  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

ROOT = wh.ROOT
QA = ROOT / '.qa'
QA.mkdir(exist_ok=True)
FAIL_DIR = QA / 'studio-workspace-failures'
FAIL_DIR.mkdir(exist_ok=True)
for old in FAIL_DIR.glob('*'):
    old.unlink()
ap = argparse.ArgumentParser()
ap.add_argument('--only', default='')
ap.add_argument('--allow-old-bundle', action='store_true')
ap.add_argument('--workspace', action='store_true')
ap.add_argument('--root-announced-build', action='store_true', help='required: root has announced a built bundle + wired workspace module; never run this earlier')
ARGS = ap.parse_args()
MODULE = wh.workspace_module_present()
assert (ROOT / 'app/src/main/assets/studio/index.html').is_file(), 'Build the shared Studio first: node scripts/build-studio.mjs'
if not ARGS.root_announced_build:
    sys.exit('NOT RUN: pass --root-announced-build only after root announced the built assets (no runs against unannounced/old bundles).')
if ARGS.workspace and not MODULE:
    sys.exit('NOT RUN: --workspace needs workspace-tabs.mjs in app/src/main/assets (the root has not delivered the new module/assets yet).')
if not MODULE and not ARGS.allow_old_bundle:
    sys.exit('NOT RUN: no workspace-tabs.mjs in the assets. Realm-only scenarios can run with --allow-old-bundle once the coordinator asks for it.')

HWPX_NAME, HWP_NAME, TABLE_NAME = '프로젝트 일정.hwpx', '주간 업무회의록.hwp', '업무 인수인계서.hwpx'
HWPX, HWP, TABLE = 'Download/' + HWPX_NAME, 'Documents/' + HWP_NAME, 'Documents/' + TABLE_NAME
FONT_FILE = Path('/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf')

RESULTS = {'environment': 'Chromium + production Studio bundle/WASM + strict CSP + MOCK multi-session OfflineNative' + (' + MOCK workspace oracle + real workspace-tabs.mjs DOM' if ARGS.workspace else '') + ' (JS/DOM contract only; Android two-WebView/lifecycle/picker routing and physical DeX unproven)',
           'workspaceModule': MODULE, 'mode': 'workspace' if ARGS.workspace else 'realms-only', 'scenarios': [], 'skipped': []}
RESULTS['skipped'] += [
    {'name': 'native_two_webview_attachment_lifecycle_picker_routing', 'reason': 'DEVICE ONLY: Android native two-WebView attachment, lifecycle and picker request routing are not exercised by Chromium + mock native'},
    {'name': 'physical_dex_hardware', 'reason': 'DEVICE ONLY: no Samsung DeX hardware available'},
    {'name': 'native_crypto_private_state', 'reason': 'DEVICE ONLY: AndroidKeystore encryption of history/recovery; the mock models the protocol only'},
]
if not (MODULE and ARGS.workspace):
    RESULTS['skipped'] += [{'name': n, 'reason': 'NOT RUN (needs --workspace and a wired workspace-tabs.mjs): workspace-tabs.mjs is not wired into studio-host.js/the Studio page yet (no assets announced by root)'}
                           for n in ['new_open_and_recent_children_start_in_their_own_session_without_recursion', 'capable_native_with_failed_handshake_fails_closed_without_inplace_fallback', 'routing_follows_the_capability_before_the_slow_ready_handshake', 'legacy_page_without_workspace_controller_has_no_tab_ui', 'tabs_live_in_the_existing_menu_row_right_of_tools_and_cap_is_eight', 'mouse_drag_reorders_tabs_with_drop_indicator_and_changes_nothing_else',
                                     'ctrl_tab_ctrl_t_and_ctrl_w_use_the_origin_realm_only', 'close_cancel_save_discard_acts_only_on_the_target_document']]

pw = sync_playwright().start()
browser = pw.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE', '/usr/bin/chromium'), args=['--no-sandbox'])
world = World()
SCENARIOS = []


def scenario(function):
    SCENARIOS.append(function)
    return function


def realms(h, labels, viewport=(960, 900), strict=True, extra=None, blank=True):
    """Fresh shared volume, optional workspace oracle for exactly these tabs, then one booted realm per label."""
    world.reset(strict, extra)
    if ARGS.workspace:
        world.enable_workspace(*[TABS[l] for l in labels], split=len(labels) >= 2)
    h['realms'] = [Realm(browser, world, label, viewport, inplace_open=ARGS.workspace) for label in labels]
    for realm in h['realms']:
        realm.boot(blank)
    return h['realms']


def relaunch(h, blank=False):
    """Process death: every EditorSession dies, native transient state is lost, per-tab private drafts survive."""
    old = h['realms']
    for r in old:
        r.assert_safe()
        r.close()
    world.ctl('/__restart')
    h['realms'] = [Realm(browser, world, r.label, r.viewport, tag=r.tag, inplace_open=r.inplace_open).boot(blank=blank) for r in old]
    return h['realms']


def assert_all_safe(h):
    for r in h.get('realms', []):
        r.assert_safe()


def targets(view, op='beginSave'):
    return [o['args']['target'] for o in world.ops(view, op) if o['ok']]


# ---------------------------------------------------------------------------------------------------- W2
def split_pair_equivalent(h, width):
    a, b = realms(h, ['A', 'B'], (width, 900))
    for r in (a, b):
        r.ev(f'window.__realmLabel = {json.dumps(r.label)}')
    assert a.ev('window.__realmLabel') == 'A' and b.ev('window.__realmLabel') == 'B'
    geometry = []
    for r in (a, b):
        geometry.append(r.ev("""(() => { const bar = document.querySelector('#menu-bar').getBoundingClientRect(), tool = document.querySelector('#menu-bar .menu-item[data-menu=tool]').getBoundingClientRect();
          return {barHeight: bar.height, toolLeft: tool.left, toolWidth: tool.width, overflowX: document.documentElement.scrollWidth - innerWidth, host: !!document.querySelector('.android-host-config'), keys: Object.keys(window.rhwpStudio.android.getState()).sort()}; })()"""))
    assert geometry[0] == geometry[1], ('contexts differ', geometry)
    assert geometry[0]['host'], geometry[0]
    RESULTS.setdefault('observations', {})[f'split{width}_menu_row_overflowX_px'] = geometry[0]['overflowX']  # compared with the legacy row in geometry_case
    a.open_doc(HWPX_NAME)
    b.open_doc(HWP_NAME)
    a.type_marker('ALPHA-SPLIT ')
    assert b.state()['dirty'] is False and b.state()['fileName'] == HWP_NAME, b.state()
    b.type_marker('BETA-SPLIT ')
    assert a.state()['fileName'] == HWPX_NAME and a.state()['dirty'] is True
    assert_all_safe(h)


@scenario
def split_960_two_realms_have_equivalent_contexts(h):
    """Two realms at the 960px split width: same menu row geometry, same host config, own JS realm; editing one never marks the other"""
    split_pair_equivalent(h, 960)


@scenario
def split_640_two_realms_have_equivalent_contexts(h):
    """Same at 640px per pane (DeX 1280 split): equivalent contexts and independent dirty state; baseline overflow compared separately"""
    split_pair_equivalent(h, 640)


# ---------------------------------------------------------------------------------------------------- W1 + W4
@scenario
def three_realms_edit_separately_and_ctrl_s_writes_each_file_independently(h):
    """3 realms, hwpx+hwp+hwpx, different typed text: each realm reads only its own document; Ctrl+S (out of order) writes only its own file; every file re-read by a separate WASM"""
    a, b, c = realms(h, ['A', 'B', 'C'])
    plan = {'A': (a, HWPX_NAME, HWPX, 'hwpx', 'MARK-ALPHA'), 'B': (b, HWP_NAME, HWP, 'hwp', 'MARK-BRAVO'), 'C': (c, TABLE_NAME, TABLE, 'hwpx', 'MARK-CHARLIE')}
    originals = {}
    for key, (r, name, rel, fmt, marker) in plan.items():
        originals[key] = (world.volume / rel).read_bytes()
        state = r.open_doc(name)
        assert state['fileName'] == name and state['format'] == fmt and not state['dirty'], (key, state)
    for key, (r, name, rel, fmt, marker) in plan.items():
        r.type_marker(marker + ' ')
    for key, (r, name, rel, fmt, marker) in plan.items():
        assert r.state()['dirty'] is True and r.state()['fileName'] == name, (key, r.state())
        assert all((world.volume / p[2]).read_bytes() == originals[k] for k, p in plan.items()), 'nothing may be written before Ctrl+S'
    done = set()
    for key in ['B', 'A', 'C']:  # out of order on purpose
        r = plan[key][0]
        r.page.bring_to_front()
        r.page.keyboard.press('Control+s')
        r.wait_state(dirty=False)
        done.add(key)
        for other in 'ABC':
            assert plan[other][0].state()['dirty'] is (other not in done), f'after saving {sorted(done)}: {other} dirty state is wrong'
    for key, (r, name, rel, fmt, marker) in plan.items():
        saved = inspect_file(world.volume / rel)
        assert saved['format'] == fmt and saved['text'].startswith(marker), (key, saved['text'][:40])
        assert not any(p[4] in saved['text'] for k, p in plan.items() if k != key), ('another realm\'s text leaked into', key)
        begins = world.ops(r.tag, 'beginSave')
        assert [o['args']['target'] for o in begins] == [str(world.volume / rel)], (key, begins)
        assert begins[0]['args']['sha'] == sha(originals[key]), 'conditional on its OWN handle baseline'
        reads = {o['args']['id'] for o in world.ops(r.tag, 'read')}
        assert reads == {sha(str(world.volume / rel).encode())}, ('realm read a document that is not its own', key, reads)
        backups = [p for p in (world.volume / rel).parent.glob('*_백업_*') if p.name.startswith(Path(name).stem)]
        assert len(backups) == 1 and backups[0].read_bytes() == originals[key], (key, 'backup of ORIGINAL')
    assert_all_safe(h)


# ---------------------------------------------------------------------------------------------------- W3
@scenario
def switching_focus_keeps_undo_caret_and_save_target(h):
    """Interleave A and B: caret box and undo history stay with their realm, Ctrl+Z in A never touches B, Ctrl+S after switching writes the realm's own file"""
    a, b = realms(h, ['A', 'B'])
    a.open_doc(HWPX_NAME)
    b.open_doc(HWP_NAME)
    a.type_marker('UNDOA1xyz ')
    caret_a = a.caret_box()
    b.page.bring_to_front()
    b.type_marker('KEEPB1xyz ')
    caret_b = b.caret_box()
    a.page.bring_to_front()
    assert a.caret_box() == caret_a, ('A caret moved while B was active', caret_a, a.caret_box())
    for _ in range(12):
        a.page.keyboard.press('Control+z')
    a.sleep(0.4)
    b.page.bring_to_front()
    assert b.caret_box() == caret_b and b.state()['dirty'] is True, 'A\'s undo reached B'
    a.page.bring_to_front()
    a.page.keyboard.type('POSTA ')
    a.wait_state(dirty=True)
    a.page.keyboard.press('Control+s')
    a.wait_state(dirty=False)
    b.page.bring_to_front()
    b.page.keyboard.press('Control+s')
    b.wait_state(dirty=False)
    ta, tb = inspect_file(world.volume / HWPX)['text'], inspect_file(world.volume / HWP)['text']
    assert 'UNDOA1xyz' not in ta and 'POSTA' in ta, ('A: undo did not apply or redo path wrong', ta[:60])
    assert 'KEEPB1xyz' in tb and 'POSTA' not in tb and 'UNDOA1' not in tb, ('B lost its edit or got A\'s', tb[:60])
    assert targets(a.tag) == [str(world.volume / HWPX)] and targets(b.tag) == [str(world.volume / HWP)], (targets(a.tag), targets(b.tag))
    b.page.keyboard.press('Control+z')  # B's own undo still works after all that
    b.wait_state(dirty=True)
    assert_all_safe(h)


# ---------------------------------------------------------------------------------------------------- W5
@scenario
def same_file_in_two_realms_second_save_refused_first_preserved(h):
    """One file opened by two realms (two native handles): A saves, B's later save is refused with a visible error, disk keeps A's save, B stays dirty and can Save As a copy"""
    a, b = realms(h, ['A', 'B'])
    original = (world.volume / HWPX).read_bytes()
    a.open_doc(HWPX_NAME)
    b.open_doc(HWPX_NAME)
    a.type_marker('FIRST-SAVE-A ')
    b.type_marker('SECOND-SAVE-B ')
    a.page.keyboard.press('Control+s')
    a.wait_state(dirty=False)
    first = (world.volume / HWPX).read_bytes()
    assert first != original and 'FIRST-SAVE-A' in inspect_file(world.volume / HWPX)['text']
    b.page.bring_to_front()
    b.page.keyboard.press('Control+s')
    b.take_alert('다른 앱')
    b.take_console_error('저장 실패')
    assert b.state()['dirty'] is True, 'refused save must keep B dirty'
    assert (world.volume / HWPX).read_bytes() == first, 'the conflicting second handle must never overwrite the first save'
    assert 'SECOND-SAVE-B' not in inspect_file(world.volume / HWPX)['text']
    refused = [o for o in world.ops(b.tag, 'finishSave') if not o['ok']]
    assert len(refused) == 1 and '다른 앱' in refused[0]['error'], refused
    b.page.keyboard.press('Control+Shift+s')
    b.confirm_studio_filename()
    b.choose_destination('qa-b-copy.hwpx', ['Documents'])
    b.wait_state(dirty=False)
    assert 'SECOND-SAVE-B' in inspect_file(world.volume / 'Documents/qa-b-copy.hwpx')['text'] and (world.volume / HWPX).read_bytes() == first
    assert a.state()['dirty'] is False
    assert_all_safe(h)


# ---------------------------------------------------------------------------------------------------- W8
@scenario
def font_catalog_is_shared_but_document_style_state_is_isolated(h):
    """Importing a font in A reaches B by the native fontsChanged broadcast without B opening any dialog; bold on A's selection is not bold in B"""
    if not FONT_FILE.is_file():
        RESULTS['skipped'].append({'name': 'font_catalog_is_shared_but_document_style_state_is_isolated', 'reason': 'NOT RUN: ' + str(FONT_FILE) + ' missing on this machine'})
        return
    a, b = realms(h, ['A', 'B'])
    a.open_doc(HWPX_NAME)
    b.open_doc(TABLE_NAME)
    assert b.ev('window.rhwpStudio.fonts.getState().count') == 0
    family = '워크스페이스 공유 글꼴'
    world.ctl('/__pickfont?family=' + urllib.parse.quote(family), FONT_FILE.read_bytes())
    a.page.get_by_role('button', name='Android · 글꼴').click()
    a.host_dialog().get_by_role('button', name='글꼴 가져오기').click()
    a.host_dialog().get_by_text(family).wait_for(timeout=15000)
    a.page.keyboard.press('Escape')
    a.host_dialog().wait_for(state='detached', timeout=10000)
    b.wait("(() => { const f = window.rhwpStudio.fonts.getState(); return f.active && f.count >= 1 && f.lastError === null; })()", 30, 'B registered the shared font without any user action')
    assert not b.host_dialog().count(), 'B never opened the font manager'
    assert [o for o in world.ops(b.tag, 'fontImport')] == [], 'B imported nothing itself'
    for r in (a, b):
        r.click_document()
        r.page.keyboard.press('Control+Home')
    a.page.bring_to_front()
    a.page.keyboard.press('Control+a')
    a.page.keyboard.press('Control+b')
    a.wait("document.querySelector('#btn-bold').classList.contains('active')", 10, 'A bold')
    b.page.bring_to_front()
    b.page.keyboard.press('Control+a')
    b.sleep(0.3)
    assert not b.ev("document.querySelector('#btn-bold').classList.contains('active')"), 'A\'s style state leaked into B'
    a.page.bring_to_front()
    assert a.ev("document.querySelector('#btn-bold').classList.contains('active')"), 'A lost its bold state'
    assert_all_safe(h)


# ---------------------------------------------------------------------------------------------------- W9
@scenario
def encrypted_password_never_crosses_realms_and_no_plaintext_draft(h):
    """Password typed in A only: B opening the same file is prompted again and stays on its own document; the password never appears in any native call; A's draft is not visible to B"""
    if not (wh.QA_FIXTURES / 'qa-locked.hwpx').is_file():
        RESULTS['skipped'].append({'name': 'encrypted_password_never_crosses_realms_and_no_plaintext_draft', 'reason': 'NOT RUN: .qa/fixtures/qa-locked.hwpx missing'})
        return
    a, b = realms(h, ['A', 'B'])
    locked = world.volume / 'Documents/암호 문서.hwpx'
    assert inspect_file(locked)['openError'], 'fixture must really be encrypted'
    a.open_doc('암호 문서', wait=False)
    a.studio_dialog().first.wait_for(timeout=30000)
    a.page.locator('.dialog-wrap input[type=password]').first.fill(PASSWORD)
    a.page.keyboard.press('Enter')
    a.wait_state(hasDocument=True, encrypted=True)
    a.type_marker('GEHEIM-A ')
    b.page.bring_to_front()
    b.open_doc('암호 문서', wait=False)
    b.studio_dialog().first.wait_for(timeout=30000)
    assert b.page.locator('.dialog-wrap input[type=password]').count() >= 1, 'B must ask for the password itself'
    assert b.page.locator('.dialog-wrap input[type=password]').first.input_value() == '', 'password prefilled in B'
    b.page.locator('.dialog-wrap input[type=password]').first.fill('wrong-password')
    b.page.keyboard.press('Enter')
    b.sleep(1.5)
    assert b.state()['fileName'] == '새 문서.hwp' and b.state()['encrypted'] is not True, ('B opened the protected file without the password', b.state())
    a.page.bring_to_front()
    flush = a.ev('window.rhwpStudio.android.flushRecovery()')
    log = json.dumps(world.log()['ops'], ensure_ascii=False)
    assert PASSWORD not in log, 'the password reached a native call'
    assert not [o for o in world.ops(a.tag, 'beginDraft') if not o['args']['encrypted']], 'an encrypted document must never produce a plaintext draft'
    drafts = a.ev("AndroidStudioHost.recovery.listDrafts().then(ds => ds.map(d => ({encrypted: d.encrypted, data: Array.from(d.data)})))")
    probe = QA / 'tmp-ws-encrypted-draft.hwp'
    if drafts:  # allowed ONLY as real ciphertext
        for draft in drafts:
            probe.write_bytes(bytes(draft['data']))
            assert draft['encrypted'] is True and inspect_file(probe)['openError'], 'a draft of an encrypted document must be real ciphertext'
        probe.unlink()
        RESULTS['encryptedRecovery'] = 'ciphertext draft (mock protocol; native crypto is device-only)'
    else:
        assert flush.get('ok') is not True, flush
        RESULTS['encryptedRecovery'] = 'blocked fail-closed: ' + json.dumps(flush)
    assert b.ev("AndroidStudioHost.request('listDrafts').then(rows => rows.length)") == 0, 'A\'s recovery draft is visible to B'
    assert_all_safe(h)


# ---------------------------------------------------------------------------------------------------- W10
@scenario
def per_tab_recovery_with_same_file_name_stays_private_across_restart(h):
    """A and B hold different documents both named same-name.hwpx; each realm's private draft is restored only into its own tab after process death, a third tab sees none"""
    extra = {'Documents/same-name.hwpx': wh.FIXTURES / '문서.hwpx', 'Download/same-name.hwpx': wh.FIXTURES / 'table.hwpx'}
    a, b = realms(h, ['A', 'B'], extra=extra)
    a.open_doc('same-name', folder='Documents')
    b.open_doc('same-name', folder='Download')
    assert a.state()['fileName'] == b.state()['fileName'] == 'same-name.hwpx'
    a.type_marker('DRAFT-ONLY-A ')
    b.type_marker('DRAFT-ONLY-B ')
    for r in (a, b):
        assert r.ev('window.rhwpStudio.android.flushRecovery()') == {'ok': True}
    sessions = world.log()['sessions']
    da, db = sessions[a.tag]['drafts'], sessions[b.tag]['drafts']
    assert len(da) == len(db) == 1, ('each tab owns exactly one private draft', da, db)
    assert [d['name'] for d in da + db] == ['same-name.hwpx'] * 2, 'both drafts carry the same display name'
    assert da[0]['key'] != db[0]['key'], ('same file name must not collapse two tabs onto one recovery key', da[0]['key'])
    assert da[0]['docId'] != db[0]['docId'], 'draft identities must differ'
    a2, b2 = relaunch(h)
    for r in (a2, b2):
        r.studio_dialog().locator('.dialog-title').filter(has_text='문서 복구').wait_for(timeout=30000)
        assert r.studio_dialog().get_by_role('button', name='복구', exact=True).count() == 1, 'exactly its own draft is offered'
    # third tab, same server: never offered anything
    c = Realm(browser, world, 'C', (960, 900), inplace_open=ARGS.workspace)
    h['realms'].append(c)
    c.boot(blank=True)
    assert c.studio_dialog().count() == 0, 'a tab without drafts was offered another tab\'s recovery'
    a2.studio_dialog().get_by_role('button', name='복구', exact=True).click()
    a2.wait_state(hasDocument=True, dirty=True)
    a2.page.keyboard.press('Control+s')
    if a2.studio_dialog().count():
        a2.confirm_studio_filename()
    a2.choose_destination('qa-restored-a.hwp', ['Documents'])  # recovered documents are HWP drafts: saved only as a copy, extension kept
    a2.wait_state(dirty=False)
    restored = inspect_file(world.volume / 'Documents/qa-restored-a.hwp')['text']
    assert 'DRAFT-ONLY-A' in restored and 'DRAFT-ONLY-B' not in restored, restored[:60]
    assert b2.ev("AndroidStudioHost.request('listDrafts').then(rows => rows.length)") == 1, 'restoring in A removed/consumed B\'s draft'
    b2.studio_dialog().get_by_role('button', name='삭제').click()
    b2.sleep(0.5)
    assert b2.ev("AndroidStudioHost.request('listDrafts').then(rows => rows.length)") == 0
    assert (world.volume / 'Documents/same-name.hwpx').read_bytes() == (wh.FIXTURES / '문서.hwpx').read_bytes() and (world.volume / 'Download/same-name.hwpx').read_bytes() == (wh.FIXTURES / 'table.hwpx').read_bytes(), 'originals must stay untouched'
    assert_all_safe(h)


# ---------------------------------------------------------------------------------------------------- module scenarios (real workspace-tabs.mjs; registered only with --workspace)
# DOM hooks read from app/src/main/assets/workspace-tabs.mjs: #menu-bar > .ws-tabs > .ws-tablist[role=tablist] > .ws-tabwrap[data-tab-id] > .ws-tab/.ws-close,
# .ws-btn[data-ws-action=new|open|split], classes is-dragging/drop-before/drop-after, drag MIME application/x-hwpxxx-workspace-tab.
TAB_MIME = 'application/x-hwpxxx-workspace-tab'
if MODULE and ARGS.workspace:
    def wait_tabs(r, count):
        r.wait(f"document.querySelectorAll('.ws-tabwrap').length === {count}", 30, f'{count} tabs rendered in the real menu row')

    def tab_order(r):
        return r.ev("[...document.querySelectorAll('.ws-tabwrap')].map(w => w.dataset.tabId)")

    def oracle():
        return world.ctl('/__workspace')

    def center(r, tab_id):
        box = r.page.locator(f'.ws-tabwrap[data-tab-id="{tab_id}"]').bounding_box()
        return box['x'] + box['width'] / 2, box['y'] + box['height'] / 2, box

    @scenario
    def legacy_page_without_workspace_controller_has_no_tab_ui(h):
        """Workspace controller absent (workspaceReady unsupported): no strip, #menu-bar untouched, document works as before"""
        world.reset()
        r = Realm(browser, world, 'A', inplace_open=True)
        h['realms'] = [r]
        r.boot()
        assert r.ev("document.querySelector('.ws-tabs') === null && !document.querySelector('style[data-workspace-tabs]')"), 'tab UI present without a workspace'
        r.open_doc(HWPX_NAME)
        assert_all_safe(h)

    @scenario
    def tabs_live_in_the_existing_menu_row_right_of_tools_and_cap_is_eight(h):
        """Strip is a child of #menu-bar right after the tool item, inside the bar's own rect (no new row/height); at 8 tabs the new/open buttons refuse locally and the controller refuses a 9th"""
        ids = [TABS['A']] + [f'00000000-0000-4000-8000-0000000000{n:02d}' for n in range(1, 8)]
        world.reset()
        world.enable_workspace(*ids)
        r = Realm(browser, world, 'A', inplace_open=True)
        h['realms'] = [r]
        r.boot()
        wait_tabs(r, 8)
        geometry = r.ev("""(() => { const bar = document.querySelector('#menu-bar'), strip = document.querySelector('#menu-bar > .ws-tabs'), tool = bar.querySelector(':scope > .menu-item[data-menu=tool]');
          const b = bar.getBoundingClientRect(), s = strip.getBoundingClientRect(), t = tool.getBoundingClientRect();
          return {parentIsBar: strip.parentNode === bar, afterTool: strip.previousElementSibling === tool, left: s.left - t.right, top: s.top - b.top, bottom: b.bottom - s.bottom, height: b.height, overflowX: document.documentElement.scrollWidth - innerWidth}; })()""")
        assert geometry['parentIsBar'] and geometry['afterTool'] and geometry['left'] >= -0.5, geometry
        assert geometry['top'] >= -0.5 and geometry['bottom'] >= -0.5, ('strip must stay inside the existing menu row', geometry)
        assert geometry['overflowX'] <= 0, geometry
        assert r.ev("document.querySelector('.ws-btn[data-ws-action=new]').getAttribute('aria-disabled')") == 'true'
        before = len(world.ops(r.tag, 'workspaceNew'))
        r.ev("document.querySelector('.ws-btn[data-ws-action=new]').click(), true")  # a real click on an aria-disabled button: the module itself must refuse
        r.sleep(0.4)
        assert len(world.ops(r.tag, 'workspaceNew')) == before, 'the strip must not even ask for a 9th tab'
        refused = r.ev("AndroidStudioHost.request('workspaceNew', {open: false}).then(() => 'accepted', e => String(e.message || e))")
        assert refused != 'accepted' and len(oracle()['tabs']) == 8, ('the controller accepted a 9th tab', refused)
        assert_all_safe(h)

    def bar_geometry(r):
        return r.ev("""(() => { const bar = document.querySelector('#menu-bar'), b = bar.getBoundingClientRect(), tool = bar.querySelector(':scope > .menu-item[data-menu=tool]').getBoundingClientRect(),
          toggle = bar.querySelector(':scope > #toolbox-basic-toggle'), strip = bar.querySelector(':scope > .ws-tabs'), s = strip && strip.getBoundingClientRect(), g = toggle && toggle.getBoundingClientRect();
          return {height: b.height, toolRight: tool.right, toolLeft: tool.left, strip: s && {left: s.left, right: s.right, top: s.top - b.top, bottom: b.bottom - s.bottom, height: s.height}, toggleLeft: g && g.left,
                  order: [...bar.children].map(c => c.id || c.className || c.tagName).slice(0, 40), overflowX: document.documentElement.scrollWidth - innerWidth}; })()""")

    def geometry_case(h, width):
        world.reset()
        legacy = Realm(browser, world, 'A', (width, 900), inplace_open=True)  # no controller enabled => workspaceEnabled() false => legacy row
        h['realms'] = [legacy]
        legacy.boot()
        base = bar_geometry(legacy)
        assert base['strip'] is None, 'legacy page must not have a strip'
        legacy.assert_safe()
        legacy.close()
        h['realms'] = []
        world.reset()
        world.enable_workspace(TABS['A'], TABS['B'], TABS['C'], split=True)
        r = Realm(browser, world, 'A', (width, 900), inplace_open=True)
        h['realms'] = [r]
        r.boot()
        wait_tabs(r, 3)
        now = bar_geometry(r)
        assert abs(now['height'] - base['height']) <= 0.5, ('menu bar height changed by the tab strip', base['height'], now['height'])
        s = now['strip']
        assert s and s['left'] >= now['toolRight'] - 0.5, ('strip must start at/after the Tools item', now)
        assert now['toggleLeft'] is None or s['right'] <= now['toggleLeft'] + 0.5, ('strip must end before #toolbox-basic-toggle', now)
        assert s['top'] >= -0.5 and s['bottom'] >= -0.5 and s['height'] <= now['height'] + 0.5, ('strip must stay inside the existing row', now)
        assert abs(now['toolLeft'] - base['toolLeft']) <= 0.5, (base, now)
        assert now['overflowX'] <= base['overflowX'] + 0.5, ('the strip must not add horizontal page overflow (legacy row overflow is a pre-existing property)', base['overflowX'], now['overflowX'])
        RESULTS.setdefault('observations', {})[f'legacy_row_overflowX_px_at_{width}'] = base['overflowX']
        assert_all_safe(h)

    @scenario
    def tab_strip_keeps_the_menu_row_height_after_tools_before_toggle_at_960(h):
        """Legacy row vs workspace row at 960px: same #menu-bar height (<=0.5px), strip after Tools and before the toggle, inside the row, no added overflow"""
        geometry_case(h, 960)

    @scenario
    def tab_strip_keeps_the_menu_row_height_after_tools_before_toggle_at_640(h):
        """Same comparison at 640px"""
        geometry_case(h, 640)

    @scenario
    def mouse_drag_reorders_tabs_with_drop_indicator_and_changes_nothing_else(h):
        """Real mouse drag of tab C before A: private MIME only, drop indicator while dragging, order broadcast to all realms, active/left/right/split and every document untouched; drop on the editor does nothing"""
        a, b, c = realms(h, ['A', 'B', 'C'])
        for r in (a, b, c):
            wait_tabs(r, 3)
        a.open_doc(HWPX_NAME)
        b.open_doc(HWP_NAME)
        before = oracle()
        order0 = [TABS['A'], TABS['B'], TABS['C']]
        assert [t['id'] for t in before['tabs']] == order0 and all(tab_order(r) == order0 for r in (a, b, c)), (before, [tab_order(r) for r in (a, b, c)])
        a.ev("document.addEventListener('dragstart', e => { window.__dragTypes = [...e.dataTransfer.types]; })")
        sx, sy, _ = center(a, TABS['C'])
        _, _, abox = center(a, TABS['A'])
        a.page.mouse.move(sx, sy)
        a.page.mouse.down()
        for step in range(1, 13):
            a.page.mouse.move(sx + (abox['x'] + 4 - sx) * step / 12, sy)
        a.wait(f"!!document.querySelector('.ws-tabwrap.drop-before[data-tab-id=\"{TABS['A']}\"]') && !!document.querySelector('.ws-tabwrap.is-dragging[data-tab-id=\"{TABS['C']}\"]')", 10, 'drop indicator before A while C is dragged')
        a.page.mouse.up()
        a.wait("!document.querySelector('.ws-tabwrap.drop-before, .ws-tabwrap.drop-after, .ws-tabwrap.is-dragging')", 10, 'drop indicator cleared after the drop')
        assert a.ev('window.__dragTypes') == [TAB_MIME], ('drag payload must be the private MIME only', a.ev('window.__dragTypes'))
        order1 = [TABS['C'], TABS['A'], TABS['B']]
        for r in (a, b, c):
            r.wait(f"JSON.stringify([...document.querySelectorAll('.ws-tabwrap')].map(w => w.dataset.tabId)) === {json.dumps(json.dumps(order1, separators=(',', ':')))}", 15, 'new order broadcast to every realm')
        after = oracle()
        assert [t['id'] for t in after['tabs']] == order1 and after['problems'] == []
        for key in ['activeId', 'primaryId', 'secondaryId', 'split', 'visible']:
            assert after[key] == before[key], (key, before[key], after[key])
        moves = [o for o in world.log()['ops'] if o['op'] == 'workspaceMove']
        assert [(o['view'], o['args']) for o in moves] == [(a.tag, {'id': TABS['C'], 'beforeId': TABS['A']})], moves
        assert a.state()['fileName'] == HWPX_NAME and b.state()['fileName'] == HWP_NAME and not a.state()['dirty'] and not b.state()['dirty']
        assert not [o for o in world.log()['ops'] if o['op'] in ('beginSave', 'read') and o.get('view') == c.tag], 'reordering must not touch any document'
        # a tab dropped on the editor surface is swallowed: nothing moves, nothing is typed
        sx, sy, _ = center(a, TABS['B'])
        canvas = a.page.locator('#scroll-container canvas').first.bounding_box()
        a.page.mouse.move(sx, sy)
        a.page.mouse.down()
        for step in range(1, 11):
            a.page.mouse.move(sx, sy + (canvas['y'] + 150 - sy) * step / 10)
        a.page.mouse.up()
        a.sleep(0.5)
        assert [t['id'] for t in oracle()['tabs']] == order1 and not a.state()['dirty'], 'dropping a tab on the editor must be a no-op'
        assert len([o for o in world.log()['ops'] if o['op'] == 'workspaceMove']) == 1
        assert_all_safe(h)

    @scenario
    def ctrl_tab_ctrl_t_and_ctrl_w_use_the_origin_realm_only(h):
        """Ctrl+Tab/Ctrl+Shift+Tab ask native to select the neighbouring tab, Ctrl+T asks for one new blank tab, Ctrl+W closes only its own tab; nothing fires while a dialog is open"""
        a, b = realms(h, ['A', 'B'])
        wait_tabs(a, 2)
        wait_tabs(b, 2)
        a.page.keyboard.press('Control+Tab')
        sel = [o for o in world.log()['ops'] if o['op'] == 'workspaceSelect']
        assert [(o['view'], o['args']) for o in sel] == [(a.tag, {'id': TABS['B']})], sel
        a.page.keyboard.press('Control+Shift+Tab')
        sel = [o for o in world.log()['ops'] if o['op'] == 'workspaceSelect']
        assert (sel[-1]['view'], sel[-1]['args']) == (a.tag, {'id': TABS['B']}), 'two tabs: previous is the other one'
        a.page.keyboard.press('Control+t')
        a.wait(f"document.querySelectorAll('.ws-tabwrap').length === 3", 15, 'new blank tab appears in the strip')
        assert len(oracle()['tabs']) == 3 and [o['view'] for o in world.log()['ops'] if o['op'] == 'workspaceNew'] == [a.tag]
        a.page.get_by_role('button', name='Android · 글꼴').click()  # a host dialog is open now (Ctrl+O would open a child tab by design)
        a.host_dialog().wait_for(timeout=10000)
        n = len([o for o in world.log()['ops'] if o['op'] in ('workspaceNew', 'workspaceClose', 'workspaceSelect')])
        for combo in ('Control+t', 'Control+w', 'Control+Tab'):
            a.page.keyboard.press(combo)
        a.sleep(0.4)
        assert len([o for o in world.log()['ops'] if o['op'] in ('workspaceNew', 'workspaceClose', 'workspaceSelect')]) == n, 'shortcuts must be inert while a dialog is open'
        a.page.keyboard.press('Escape')
        a.page.keyboard.press('Control+w')
        a.sleep(0.6)
        closes = [o for o in world.log()['ops'] if o['op'] == 'workspaceClose']
        assert [(o['view'], o['args']) for o in closes] == [(a.tag, {'id': TABS['A']})], closes
        assert_all_safe(h)

    @scenario
    def ctrl_tab_then_typing_reaches_the_retained_caret_without_a_document_click(h):
        """Two visible tabs: Ctrl+Tab in A asks native to focus B; after the (simulated) native focus change typing goes to B's retained caret with NO document click, and later back to A the same way"""
        a, b = realms(h, ['A', 'B'])
        wait_tabs(a, 2)
        wait_tabs(b, 2)
        a.open_doc(HWPX_NAME)
        b.open_doc(HWP_NAME)
        a.type_marker('A-BEFORE ')       # the only document clicks of the test
        b.type_marker('B-BEFORE ')
        caret_a, caret_b = a.caret_box(), b.caret_box()
        a.page.bring_to_front()
        a.page.keyboard.press('Control+Tab')  # module -> workspaceSelect(B); the oracle focuses the visible B
        end = time.time() + 15
        while time.time() < end and oracle()['activeId'] != TABS['B']:
            a.sleep(0.1)
        assert oracle()['activeId'] == TABS['B'], oracle()
        b.page.bring_to_front()               # SIMULATES the native WebView attach/focus only
        b.page.keyboard.type('B-AFTERTAB ')   # no click on the document
        b.wait_state(dirty=True)
        assert b.caret_box() != caret_b, 'B typing did not move B\'s retained caret'
        assert a.caret_box() == caret_a, 'A caret moved by typing in B'
        b.page.keyboard.press('Control+Tab')  # from B the next tab is A
        end = time.time() + 15
        while time.time() < end and oracle()['activeId'] != TABS['A']:
            b.sleep(0.1)
        assert oracle()['activeId'] == TABS['A'], oracle()
        a.page.bring_to_front()               # SIMULATES the native focus change
        a.page.keyboard.type('A-AFTERBACK ')  # again no click
        for r in (a, b):
            r.page.bring_to_front()
            r.page.keyboard.press('Control+s')
            r.wait_state(dirty=False)
        ta, tb = inspect_file(world.volume / HWPX)['text'], inspect_file(world.volume / HWP)['text']
        assert 'A-AFTERBACK' in ta and 'A-BEFORE' in ta and 'B-AFTERTAB' not in ta and 'B-BEFORE' not in ta, ta[:80]
        assert 'B-AFTERTAB' in tb and 'B-BEFORE' in tb and 'A-AFTERBACK' not in tb and 'A-BEFORE' not in tb, tb[:80]
        assert_all_safe(h)

    @scenario
    def close_cancel_save_discard_acts_only_on_the_target_document(h):
        """Close B from A's strip: Cancel keeps all; a token from another origin or unknown is refused; Discard removes only B; Save writes only C's own file before C goes. Other realms stay dirty and untouched"""
        a, b, c = realms(h, ['A', 'B', 'C'])
        for r in (a, b, c):
            wait_tabs(r, 3)
        files = {'A': (a, HWPX_NAME, HWPX), 'B': (b, HWP_NAME, HWP), 'C': (c, TABLE_NAME, TABLE)}
        originals = {}
        for key, (r, name, rel) in files.items():
            originals[key] = (world.volume / rel).read_bytes()
            r.open_doc(name)
            r.type_marker(f'CLOSE-{key} ')
        spy = "(() => { const original = window.AndroidWorkspaceCloseRequest; window.__tokens = []; window.AndroidWorkspaceCloseRequest = t => { window.__tokens.push(t); return original(t); }; })()"
        for r in (a, b, c):
            r.ev(spy)
        # 1. cancel
        a.page.locator(f'.ws-close[data-tab-id="{TABS["B"]}"]').click()
        b.studio_dialog().get_by_text('저장하지 않은 변경사항').wait_for(timeout=15000)
        assert a.studio_dialog().count() == 0 and c.studio_dialog().count() == 0, 'only the target document may ask'
        token = b.ev('window.__tokens[0]')
        # 2. a token answered by another origin / an unknown token never closes anything
        a.ev(f"AndroidStudioHost.request('workspaceCloseResult', {{token: {json.dumps(token)}, allow: true}}).catch(() => null)")  # wrong origin: native must ignore it
        a.ev("AndroidStudioHost.request('workspaceCloseResult', {token: 'no-such-token', allow: true}).catch(() => null)")
        a.sleep(0.4)
        state = oracle()
        assert [r['reason'] for r in state['rejected']] == ['wrong origin', 'unknown token'] and len(state['tabs']) == 3, state['rejected']
        b.studio_dialog().get_by_role('button', name='취소').click()
        b.sleep(0.5)
        assert len(oracle()['tabs']) == 3 and all(r.state()['dirty'] for r in (a, b, c)), 'cancel must keep every tab and every dirty flag'
        assert [o['args']['allow'] for o in world.ops(b.tag, 'workspaceCloseResult')] == [False]
        # 3. discard B
        a.page.locator(f'.ws-close[data-tab-id="{TABS["B"]}"]').click()
        b.studio_dialog().get_by_role('button', name='저장 안 함').click()
        for r in (a, c):
            r.wait(f"document.querySelectorAll('.ws-tabwrap').length === 2", 15, 'B disappeared from the other strips')
        assert [t['id'] for t in oracle()['tabs']] == [TABS['A'], TABS['C']]
        assert (world.volume / HWP).read_bytes() == originals['B'], 'discard must not write B'
        assert a.state()['dirty'] and c.state()['dirty'] and a.state()['fileName'] == HWPX_NAME and c.state()['fileName'] == TABLE_NAME
        assert (world.volume / HWPX).read_bytes() == originals['A'] and (world.volume / TABLE).read_bytes() == originals['C']
        # 4. save C
        a.page.locator(f'.ws-close[data-tab-id="{TABS["C"]}"]').click()
        c.studio_dialog().get_by_text('저장하지 않은 변경사항').wait_for(timeout=15000)
        c.studio_dialog().get_by_role('button', name='저장', exact=True).click()
        a.wait(f"document.querySelectorAll('.ws-tabwrap').length === 1", 30, 'C closed after its own save')
        assert 'CLOSE-C' in inspect_file(world.volume / TABLE)['text'] and 'CLOSE-A' not in inspect_file(world.volume / TABLE)['text']
        assert (world.volume / HWPX).read_bytes() == originals['A'] and a.state()['dirty'] is True, 'A was neither saved nor cleaned by closing C'
        assert targets(a.tag) == [] and targets(c.tag) == [str(world.volume / TABLE)]
        assert_all_safe(h)


if MODULE and ARGS.workspace:
    def child_tab(h, before_ids, viewport=(960, 900)):
        """Play the native root: a workspaceNew/OpenRecent created exactly one tab; start its EditorSession (a realm with that tab's id)."""
        fresh_ids = [t['id'] for t in oracle()['tabs'] if t['id'] not in before_ids]
        assert len(fresh_ids) == 1, ('exactly one new tab expected', fresh_ids)
        r = Realm(browser, world, 'child', viewport, tag=fresh_ids[0], inplace_open=True)
        h['realms'].append(r)
        return r

    @scenario
    def new_open_and_recent_children_start_in_their_own_session_without_recursion(h):
        """workspace.openRecent / openDocument create ONE child tab each; the child opens the document in place in its OWN session (recentOpen / pickFile only there) even when readiness is slow, sends no workspaceNew itself, a reload sees a blank action, a cancelled open drops only the clean opener tab"""
        (a,) = realms(h, ['A'])
        wait_tabs(a, 1)
        a.open_doc(HWPX_NAME)
        recents = a.ev("AndroidStudioHost.request('recentList')")
        assert recents and all(len(r['id']) == 64 and set(r['id']) <= set('0123456789abcdef') for r in recents), ('recent ids must be the real 64-hex provider ids', recents)
        recent_id = next(r['id'] for r in recents if r['fileName'] == HWPX_NAME)
        # --- recent
        known = {t['id'] for t in oracle()['tabs']}
        assert a.ev(f"AndroidStudioHost.workspace.openRecent({json.dumps(recent_id)})") is True
        child = child_tab(h, known)
        for op in ('fontList', 'recentOpen', 'read'):  # make readiness/middleware slow: a flag cleared right after the synchronous execute() would now be too early
            world.ctl(f'/__delay?op={op}&ms=1200&view={child.tag}')
        child.boot(blank=False)
        child.wait_state(hasDocument=True, fileName=HWPX_NAME)
        assert [o['args'] for o in world.ops(child.tag, 'workspaceNew')] == [] and world.ops(child.tag, 'workspaceOpenRecent') == [], 'the child must open in place, never ask for another tab'
        assert len(world.ops(child.tag, 'recentOpen')) == 1 and world.ops(a.tag, 'recentOpen') == [], 'recent id resolved ONLY in the child session'
        assert a.state()['fileName'] == HWPX_NAME and not a.state()['dirty'] and len(oracle()['tabs']) == 2, 'origin document untouched, exactly one tab added'
        assert oracle()['pendingInitial'] == {}, 'the initial action was consumed'
        # reload of the child: native hands out blank now
        world.ctl('/__restart')
        again = Realm(browser, world, 'child', (960, 900), tag=child.tag, inplace_open=True)
        child.close()
        h['realms'][h['realms'].index(child)] = again
        again.boot(blank=True)
        # --- open (picker inside the new tab)
        known = {t['id'] for t in oracle()['tabs']}
        assert a.ev('AndroidStudioHost.workspace.openDocument()') is True
        opener = child_tab(h, known)
        world.ctl(f'/__pick?view={opener.tag}&name=picked.hwp', (wh.FIXTURES / 'blank.hwp').read_bytes())  # consumed only when the user presses 파일 선택
        world.ctl(f'/__delay?op=fontList&ms=1200&view={opener.tag}')
        opener.boot(blank=False)
        opener.host_dialog().locator('#android-host-title').filter(has_text='문서 열기').wait_for(timeout=30000)  # in-place file:open in the NEW tab shows the host open dialog
        opener.host_dialog().get_by_role('button', name='파일 선택').click()
        opener.wait_state(hasDocument=True, fileName='picked.hwp')
        assert len(world.ops(opener.tag, 'pickFile')) == 1 and world.ops(opener.tag, 'workspaceNew') == [], 'picker once, in the new tab, no recursion'
        assert world.ops(a.tag, 'pickFile') == [], 'the picker belongs to the new tab, not the origin'
        # --- open cancelled
        known = {t['id'] for t in oracle()['tabs']}
        assert a.ev('AndroidStudioHost.workspace.openDocument()') is True
        cancelled = child_tab(h, known)
        cancelled.boot(blank=False)
        cancelled.host_dialog().locator('#android-host-title').filter(has_text='문서 열기').wait_for(timeout=30000)
        cancelled.page.keyboard.press('Escape')  # the user cancels the open dialog of the new tab
        end = time.time() + 20
        while time.time() < end and cancelled.tag in [t['id'] for t in oracle()['tabs']]:
            cancelled.sleep(0.2)
        left = [t['id'] for t in oracle()['tabs']]
        assert cancelled.tag not in left and a.tag in left and again.tag in left and opener.tag in left, ('cancel must drop only the clean opener tab', left)
        assert [o['args'] for o in world.ops(cancelled.tag, 'workspaceInitialDone')] == [{'cancelled': True}]
        assert_all_safe(h)

    @scenario
    def capable_native_with_failed_handshake_fails_closed_without_inplace_fallback(h):
        """workspaceEnabled()=true but workspaceReady fails (bridge V2): visible error dialog, no tab strip, enabled stays true, new/open keep asking native (workspaceNew) and NEVER run the in-place newDocument"""
        world.reset()
        world.enable_workspace(TABS['A'])
        world.ctl(f'/__fail?op=workspaceReady&view={TABS["A"]}&times=20&message=' + urllib.parse.quote('작업 공간을 시작하지 못했어요'))
        r = Realm(browser, world, 'A', inplace_open=True)
        h['realms'] = [r]
        r.boot(blank=False)
        r.sleep(1.5)
        assert r.ev("document.querySelector('.ws-tabs') === null"), 'no tab strip after a failed handshake'
        assert world.ops(r.tag, 'workspaceReady'), 'the capability must have triggered the handshake'
        notice = r.ev("[...document.querySelectorAll('dialog[open], .dialog-wrap, [role=alert], body')].some(d => /작업 공간|문서 탭을 시작하지 못했어요/.test(d.innerText))") or any('작업 공간' in m for _, m in r.dialogs)
        assert notice, ('fail closed needs a visible notice', r.dialogs)
        assert r.ev('window.AndroidStudioHost.workspace.enabled') is True, 'V2: a capable host stays routed to native after a failed handshake (it does not fall back to in-place)'
        before = len(world.ops(r.tag, 'newDocument'))
        r.ev("Promise.resolve(rhwpStudio.automation.execute('file:new-doc', {}, {allowDialog: true})).catch(() => null)")
        r.sleep(1.0)
        assert len(world.ops(r.tag, 'newDocument')) == before, 'no in-place new document after a failed handshake'
        assert len(world.ops(r.tag, 'workspaceNew')) >= 1, 'new keeps asking native (it is never silently redirected in place)'
        for kind, text in list(r.console):
            assert '작업 공간' in text or 'workspace' in text.lower(), ('only the announced handshake failure may appear in the console', kind, text)
        r.console.clear()
        r.dialogs.clear()
        assert_all_safe(h)

    @scenario
    def routing_follows_the_capability_before_the_slow_ready_handshake(h):
        """With workspaceReady and fontList slow, file:new-doc already goes to workspaceNew (capability, not handshake, enables routing); it never starts an in-place newDocument"""
        world.reset()
        world.enable_workspace(TABS['A'])
        world.ctl(f'/__delay?op=workspaceReady&ms=2500&view={TABS["A"]}')
        world.ctl(f'/__delay?op=fontList&ms=2500&view={TABS["A"]}')
        r = Realm(browser, world, 'A', inplace_open=True)
        h['realms'] = [r]
        r.page.goto(f'{world.base}/studio/index.html?view={r.tag}')
        r.wait("!!(window.rhwpStudio && window.rhwpStudio.automation && window.AndroidStudioHost && window.AndroidStudioHost.workspace)", 60, 'automation + synchronous workspace object')
        r.ev("Promise.resolve(rhwpStudio.automation.execute('file:new-doc', {}, {allowDialog: true})).catch(() => null)")
        end = time.time() + 20
        while time.time() < end and not world.ops(r.tag, 'workspaceNew'):
            r.sleep(0.2)
        assert len(world.ops(r.tag, 'workspaceNew')) == 1, 'routing must follow the capability before the handshake completes'
        assert world.ops(r.tag, 'newDocument') == [], 'no in-place new document'
        assert_all_safe(h)


# ---------------------------------------------------------------------------------------------------- runner
def run_all():
    wanted = {x for x in ARGS.only.split(',') if x}
    failed = 0
    for function in SCENARIOS:
        name = function.__name__
        if wanted and name not in wanted:
            continue
        started, holder = time.time(), {}
        try:
            function(holder)
            RESULTS['scenarios'].append({'name': name, 'passed': True, 'seconds': round(time.time() - started, 1), 'doc': (function.__doc__ or '').strip()})
            print(f'PASS: {name} - {(function.__doc__ or "").strip()}', flush=True)
        except BaseException as error:  # noqa: BLE001 - report every failure and continue
            failed += 1
            artifact = {'error': ''.join(traceback.format_exception_only(type(error), error)).strip(), 'trace': traceback.format_exc()}
            for r in holder.get('realms', []):
                try:
                    r.page.screenshot(path=str(FAIL_DIR / f'{name}-{r.label}.png'))
                    artifact[r.label] = {'console': r.console, 'pageErrors': r.page_errors, 'external': r.external, 'badHttp': r.bad_http, 'dialogs': r.dialogs,
                                         'nativeLog': world.log(r.tag)['ops'][-40:],
                                         'visibleDialogs': r.ev("[...document.querySelectorAll('dialog[open], .dialog-wrap, [role=alert]')].map(d => d.innerText.slice(0, 300))")}
                except Exception as inner:  # noqa: BLE001
                    artifact[r.label + '-artifactError'] = str(inner)
            (FAIL_DIR / f'{name}.json').write_text(json.dumps(artifact, ensure_ascii=False, indent=2))
            RESULTS['scenarios'].append({'name': name, 'passed': False, 'seconds': round(time.time() - started, 1), 'error': artifact['error'], 'doc': (function.__doc__ or '').strip()})
            print(f'FAIL: {name}: {artifact["error"]}', flush=True)
        finally:
            for r in holder.get('realms', []):
                try:
                    r.close()
                except Exception:  # noqa: BLE001
                    pass
    return failed


if __name__ == '__main__':
    failed = 0
    try:
        failed = run_all()
    finally:
        RESULTS['failed'] = failed
        (QA / 'studio-workspace-results.json').write_text(json.dumps(RESULTS, ensure_ascii=False, indent=2))
        browser.close()
        pw.stop()
        world.close()
    total = len(RESULTS['scenarios'])
    print(f'\n{total - failed}/{total} scenarios passed; NOT RUN (never counted as passes): {[x["name"] for x in RESULTS["skipped"]]}; failures in {FAIL_DIR}')
    sys.exit(1 if failed else 0)
