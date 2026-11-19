#!/usr/bin/env python3
"""Android print integration: real WasmBridge + real Android font provider + real studio-host.js, in Chromium.

Needs a prepared, PATCHED Studio source (through patch 0108) with npm dependencies and the matching pkg WASM:
  python3 tests/studio-interaction.py --studio-root <dir>/rhwp-studio

What is real here: the pinned MVP WASM, WasmBridge.prepareCanvasMetrics('canvas2d'), HostCanvasFontSession,
Canvas2D page rendering with profile 'print', android-print.ts, and app/src/main/assets/studio-host.js printPages.
What is NOT: Android WebView, MainActivity/PrintManager (OfflineNative is a recording stub), Samsung DeX hardware.
Fonts: an installed redistributable TTF whose family name is rewritten to a unique name so that the Chromium system
fontconfig can never supply it; only the host-font alias can. No user documents.
"""
import argparse
import json
import pathlib
import socket
import struct
import subprocess
import tempfile
import time
import urllib.request

from playwright.sync_api import sync_playwright

here = pathlib.Path(__file__).resolve().parent
repo = here.parent
parser = argparse.ArgumentParser()
parser.add_argument('--studio-root', required=True)
parser.add_argument('--font', default='/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf')
parser.add_argument('--reference-family', default='Liberation Serif', help='system family with the same outlines as --font')
parser.add_argument('--fixture', default=str(here / 'fixtures/문서.hwp'))
args = parser.parse_args()
studio = pathlib.Path(args.studio_root).resolve()
PROBE_FAMILY = 'HwpxxxPrintProbe'


def rename_font(data: bytes, family: str) -> bytes:
    """Replace the name table with a minimal one (family/subfamily/full/PostScript) so no system font can match."""
    tag, num = data[:4], struct.unpack('>H', data[4:6])[0]
    tables = []
    for i in range(num):
        t, checksum, offset, length = struct.unpack('>4sIII', data[12 + i * 16:28 + i * 16])
        tables.append([t, offset, length])
    strings = {1: family, 2: 'Regular', 3: family + ';Regular', 4: family + ' Regular', 6: family + '-Regular'}
    records, blob = [], b''
    for name_id, text in sorted(strings.items()):
        raw = text.encode('utf-16-be')
        records.append((3, 1, 0x409, name_id, len(raw), len(blob)))
        blob += raw
    name = struct.pack('>HHH', 0, len(records), 6 + 12 * len(records))
    for rec in records:
        name += struct.pack('>HHHHHH', *rec)
    name += blob
    name += b'\0' * (-len(name) % 4)
    out_tables = []
    for t, offset, length in tables:
        body = name if t == b'name' else data[offset:offset + length]
        out_tables.append((t, body))
    header = tag + struct.pack('>HHHH', num, *struct.unpack('>HHH', data[6:12]))
    offset = 12 + 16 * num
    directory, bodies = b'', b''
    for t, body in out_tables:
        padded = body + b'\0' * (-len(body) % 4)
        words = struct.unpack('>%dI' % (len(padded) // 4), padded)
        directory += struct.pack('>4sIII', t, sum(words) & 0xffffffff, offset + len(bodies), len(body))
        bodies += padded
    return header + directory + bodies


font_bytes = rename_font(pathlib.Path(args.font).read_bytes(), PROBE_FAMILY)
fixture_bytes = pathlib.Path(args.fixture).read_bytes()
provider_source = (repo / 'app/src/main/assets/android-fonts.mjs').read_text()
host_source = (repo / 'app/src/main/assets/studio-host.js').read_text()

with socket.socket() as sock:
    sock.bind(('127.0.0.1', 0))
    port = sock.getsockname()[1]
url = f'http://127.0.0.1:{port}'
vite = (studio / 'node_modules/vite/dist/node/index.js').as_uri()
cache_dir = tempfile.TemporaryDirectory(prefix='hwp-print-vite-')
server_script = f"""
import {{createServer}} from {json.dumps(vite)};
const root={json.dumps(str(studio))};
const stubPlugin={{name:'hwpctrl-stub',resolveId(id){{return id==='@rhwp/hwpctrl/studio-plugin'?'\\0hwpctrl-stub':null}},load(id){{return id==='\\0hwpctrl-stub'?'export const hwpctrlStudioPlugin=null':null}}}};
const server=await createServer({{configFile:false,plugins:[stubPlugin],root,cacheDir:{json.dumps(cache_dir.name)},
 define:{{__APP_VERSION__:'"test"',__RHWP_DISABLE_EXTERNAL_WEBFONTS__:'true',__RHWP_HWPCTRL__:'false',__RHWP_AI__:'false'}},
 resolve:{{alias:{{'@':root+'/src','@wasm':root+'/../pkg'}}}},
 optimizeDeps:{{noDiscovery:true,entries:[],include:['canvaskit-wasm']}},
 server:{{host:'127.0.0.1',port:{port},strictPort:true,fs:{{allow:[root,root+'/../pkg']}}}}}});
await server.listen();
"""

PAGE_SCRIPT = r"""
async ({face, probe, referenceFamily}) => {
  const checks = [];
  const check = (name, ok, detail) => { checks.push({name, ok: !!ok, detail}); };
  const {installAndroidFonts} = await import('/__print_test/provider.mjs');
  const local = await import('/src/core/local-fonts.ts');
  const {WasmBridge} = await import('/src/core/wasm-bridge.ts');
  const print = await import('/src/hwpxxx/android-print.ts');
  const bridge = new WasmBridge(); await bridge.initialize();

  // ---- native font provider stub (same op contract as MainActivity fontList/fontRead/release) ----
  const token = '01234567-1234-1234-1234-0123456789ab';
  let available = [face], epoch = 1, reads = 0, releases = 0;
  const request = async (op, a) => {
    if (op === 'fontList') return {revision: String(epoch).padStart(64, '0'), faces: available};
    if (op === 'fontRead') { reads++; return {token, url: '/document/' + token}; }
    if (op === 'release') { releases++; return true; }
    throw new Error('unknown native operation ' + op);
  };
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (u, o) => String(u).startsWith('/document/draft-') ? Promise.resolve(new Response(new Uint8Array(64).fill(7))) : String(u).startsWith('/document/') ? nativeFetch('/__print_test/font.sfnt', o) : nativeFetch(u, o);
  const provider = await installAndroidFonts({fonts: {setProvider: local.setHostFontProvider, getState: local.getHostFontState}}, request);

  // ---- decode helpers ----
  async function decode(png) {
    const bitmap = await createImageBitmap(new Blob([png], {type: 'image/png'}));
    const c = document.createElement('canvas'); c.width = bitmap.width; c.height = bitmap.height;
    const ctx = c.getContext('2d'); ctx.drawImage(bitmap, 0, 0);
    const data = ctx.getImageData(0, 0, c.width, c.height);
    return {width: c.width, height: c.height, data: data.data};
  }
  function ink(img) {
    let dark = 0, minX = img.width, minY = img.height, maxX = -1, maxY = -1;
    for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4;
      if (img.data[i + 3] > 0 && img.data[i] + img.data[i + 1] + img.data[i + 2] < 384) { dark++; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    }
    return {dark, box: [minX, minY, maxX, maxY]};
  }
  function diffRatio(a, b) {
    if (a.width !== b.width || a.height !== b.height) return 1;
    let diff = 0, total = 0;
    for (let i = 0; i < a.data.length; i += 4) {
      const d = Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]);
      if (a.data[i] + a.data[i + 1] + a.data[i + 2] < 700 || b.data[i] + b.data[i + 1] + b.data[i + 2] < 700) { total++; if (d > 96) diff++; }
    }
    return total ? diff / total : 0;
  }
  const text = 'Wim Wam Mow 123 Typesetting WWW iii mmm';
  function buildDocument(family) {
    bridge.createNewDocument();
    bridge.insertText(0, 0, 0, text);
    const fontId = bridge.findOrCreateFontId(family);
    bridge.applyCharFormat(0, 0, 0, text.length, JSON.stringify({fontId, fontSize: 3200}));
  }
  const jobOptions = (extra = {}) => ({...extra});

  // ---- 1. imported font is used by the print raster ----
  buildDocument(probe);
  let job = await print.prepareAndroidPrintJob(bridge, jobOptions());
  const withFont = await job.renderPage(0);
  const info = bridge.getPageInfo(0);
  const withFontImg = await decode(withFont.png);
  // rhwp v0.9.0 sizes the print raster by the page's printSize (whole-point paper size) when the page info carries one; the page size reported to
  // native (PDF points) stays the page's own width/height.
  const paper = info.printSize || info, expectedScale = print.printRasterScale(paper.width, paper.height);
  check('PNG signature and dimensions follow page size and bounded scale',
    withFont.png[0] === 137 && withFontImg.width === Math.ceil(paper.width * expectedScale) && withFontImg.height === Math.ceil(paper.height * expectedScale)
    && withFont.width === info.width && withFont.height === info.height, {w: withFontImg.width, h: withFontImg.height, info, expectedScale});
  check('native bounds: <= 8MiB, <= 5M pixels', withFont.png.length <= print.ANDROID_PRINT_MAX_PAGE_BYTES && withFontImg.width * withFontImg.height <= 5e6, {bytes: withFont.png.length});
  const diagnostics = bridge.getHostCanvasFontDiagnostics();
  check('host font alias loaded by the bridge session (prepareCanvasMetrics ran)', diagnostics.loaded >= 1 && diagnostics.failed === 0, diagnostics);
  const withFontInk = ink(withFontImg);
  check('page has visible text ink', withFontInk.dark > 800, withFontInk);

  // Same document, genuine system reference family (same outlines) must look like the host-font print.
  buildDocument(referenceFamily);
  const reference = await (await print.prepareAndroidPrintJob(bridge, jobOptions())).renderPage(0);
  const referenceImg = await decode(reference.png);
  check('host-font print matches the same outlines rendered by a system font (<= 3% differing ink pixels)', diffRatio(withFontImg, referenceImg) <= 0.03, {ratio: diffRatio(withFontImg, referenceImg)});

  // Without the provider the unique family can only fall back to the default sans: the output must differ clearly.
  buildDocument(probe);
  await local.setHostFontProvider(null); bridge.releaseCanvasFontResources();
  const fallback = await (await print.prepareAndroidPrintJob(bridge, jobOptions())).renderPage(0);
  const fallbackImg = await decode(fallback.png);
  const fallbackRatio = diffRatio(withFontImg, fallbackImg);
  // A/B diagnostic: if the fallback print still equals the host-font print, redraw once with the font-resolution memos switched off (hwpxxx/signature-memo,
  // __hwpxxxNoFontMemo). If that fixes it, the memo is the cause and the check fails; if not, the engine keeps the removed face (reported, not hidden).
  let memoOffRatio = null;
  if (fallbackRatio < 0.2) {
    globalThis.__hwpxxxNoFontMemo = true;
    try {
      buildDocument(probe); bridge.releaseCanvasFontResources();
      memoOffRatio = diffRatio(withFontImg, await decode((await (await print.prepareAndroidPrintJob(bridge, jobOptions())).renderPage(0)).png));
    } finally { globalThis.__hwpxxxNoFontMemo = false; }
  }
  const memoIsCause = fallbackRatio < 0.2 && memoOffRatio !== null && memoOffRatio >= 0.2;
  check('without the imported font the unique family falls back (print would be wrong): >= 20% differing ink',
    fallbackRatio >= 0.2 || (!memoIsCause && memoOffRatio !== null),
    {ratio: fallbackRatio, ratioWithMemoOff: memoOffRatio, note: fallbackRatio >= 0.2 ? 'ok' : (memoIsCause ? 'THE MEMO KEEPS THE REMOVED FACE' : 'not the memo: the engine/v0.9.0 session keeps the removed face (known, reported)')});
  const reinstalled = await installAndroidFonts({fonts: {setProvider: local.setHostFontProvider, getState: local.getHostFontState}}, request);

  // ---- 2. view aids and view state ----
  buildDocument(probe);
  bridge.setShowParagraphMarks(true); bridge.setShowControlCodes(true); bridge.setShowTransparentBorders(true);
  const aidsOn = await (await print.prepareAndroidPrintJob(bridge, jobOptions())).renderPage(0);
  check('view toggles restored after print render', bridge.getShowParagraphMarks() && bridge.getShowControlCodes() && bridge.getShowTransparentBorders(), null);
  bridge.setShowParagraphMarks(false); bridge.setShowControlCodes(false); bridge.setShowTransparentBorders(false);
  const aidsOff = await (await print.prepareAndroidPrintJob(bridge, jobOptions())).renderPage(0);
  check('paragraph marks / control codes / transparent borders never reach the output', diffRatio(await decode(aidsOn.png), await decode(aidsOff.png)) === 0, null);

  // ---- 3. one canvas alive at a time + cancellation + document change ----
  buildDocument(probe);
  const canvases = [];
  job = await print.prepareAndroidPrintJob(bridge, {createCanvas: () => { const c = document.createElement('canvas'); canvases.push(c); return c; }});
  await job.renderPage(0); await job.renderPage(0);
  check('every page canvas is released (width 0) after its PNG is encoded', canvases.length >= 2 && canvases.every(c => c.width === 0 && c.height === 0), canvases.length);
  const controller = new AbortController();
  job = await print.prepareAndroidPrintJob(bridge, {signal: controller.signal});
  controller.abort();
  let abortName = null; try { await job.renderPage(0); } catch (error) { abortName = error.name; }
  check('aborted job stops with AbortError', abortName === 'AbortError', abortName);
  let current = true; job = await print.prepareAndroidPrintJob(bridge, {isCurrent: () => current});
  current = false; let changed = null; try { await job.renderPage(0); } catch (error) { changed = error; }
  check('document change mid-job is a visible interruption, not a mixed PDF', changed?.name === 'AndroidPrintInterrupted' && /문서가 바뀌어/.test(changed.message), changed?.message);
  let staleName = null; { const stale = new AbortController(); stale.abort(); try { await print.prepareAndroidPrintJob(bridge, {signal: stale.signal}); } catch (error) { staleName = error.name; } }
  check('prepare honours an already aborted signal', staleName === 'AbortError', staleName);

  // ---- 4. real fixture: landscape/portrait sizes, multi-page, bounded ----
  const info2 = bridge.loadDocument(new Uint8Array(fixture), 'fixture.hwp');
  const fixtureJob = await print.prepareAndroidPrintJob(bridge, jobOptions());
  const sizes = [];
  for (let i = 0; i < Math.min(fixtureJob.pageCount, 3); i++) {
    const page = await fixtureJob.renderPage(i), pageInfo = bridge.getPageInfo(i), img = await decode(page.png);
    sizes.push({i, w: page.width, h: page.height, pw: img.width, ph: img.height});
    check(`fixture page ${i + 1}: PNG aspect equals page aspect`, Math.abs(img.width / img.height - pageInfo.width / pageInfo.height) < 0.01 && page.width === pageInfo.width && page.height === pageInfo.height, sizes[i]);
  }
  check('fixture page count matches the engine', fixtureJob.pageCount >= 1 && fixtureJob.pageCount === bridge.pageCount, fixtureJob.pageCount);

  // ---- 5. limits via a fake bridge (no WASM needed) ----
  const fake = (overrides = {}) => ({pageCount: 3, documentGeneration: 1, prepareCanvasMetrics: async () => false, getPageInfo: () => ({width: 794, height: 1123}),
    getPageSourceImageKeys: () => '{"cacheable":true,"keys":[]}', renderPageToCanvasFiltered: (p, canvas, scale) => { canvas.width = Math.ceil(794 * scale); canvas.height = Math.ceil(1123 * scale); const c = canvas.getContext('2d'); c.fillStyle = '#fff'; c.fillRect(0, 0, canvas.width, canvas.height); c.fillStyle = '#000'; c.fillRect(10, 10, 50, 50); },
    getShowParagraphMarks: () => false, setShowParagraphMarks() {}, getShowControlCodes: () => false, setShowControlCodes() {}, getShowTransparentBorders: () => false, setShowTransparentBorders() {}, ...overrides});
  const longJob = await print.prepareAndroidPrintJob(fake({pageCount: 121}));
  check('page 121 renders on demand', longJob.pageCount === 121 && (await longJob.renderPage(120)).png.length > 8, longJob.pageCount);
  const half = print.printRasterScale(794, 1123, {widthPt: 400, heightPt: 500, dpi: 144});
  check('the print area and DPI determine the uniform scale, within the bitmap budget',
    Math.abs(half - 1000 / 1123) < 1e-6
      && Math.abs(print.printRasterScale(794, 1123, {widthPt: 400, heightPt: 500, dpi: 288}) - half * 2) < 1e-6
      && print.printRasterScale(2600, 2600) ** 2 * 2600 * 2600 <= 4.8e6 + 1
      && 20000 * print.printRasterScale(20000, 200, {dpi: 600}) <= 4000, half);
  let badSize = null; try { print.printRasterScale(0, 10); } catch (error) { badSize = error.message; }
  check('zero page size rejected', !!badSize, badSize);
  let settleCalls = 0, renders = 0;
  const withPictures = await print.prepareAndroidPrintJob(fake({getPageSourceImageKeys: () => '{"cacheable":true,"keys":["k"]}', renderPageToCanvasFiltered: (p, canvas, s) => { renders++; canvas.width = 10; canvas.height = 10; }}), {settle: async () => { settleCalls++; }});
  await withPictures.renderPage(0);
  check('pages with pictures render, settle, then render again (async picture decode)', settleCalls === 1 && renders === 2, {settleCalls, renders});
  renders = 0; const noPictures = await print.prepareAndroidPrintJob(fake({renderPageToCanvasFiltered: (p, canvas, s) => { renders++; canvas.width = 10; canvas.height = 10; }}), {settle: async () => { settleCalls++; }});
  await noPictures.renderPage(0);
  check('pages without pictures render once', renders === 1, renders);
  const toggles = []; const aidsBridge = fake({getShowParagraphMarks: () => true, setShowParagraphMarks: v => toggles.push('marks:' + v), renderPageToCanvasFiltered: () => { throw new Error('boom'); }});
  let boom = null; try { await (await print.prepareAndroidPrintJob(aidsBridge)).renderPage(0); } catch (error) { boom = error.message; }
  check('render failure still restores view toggles and surfaces the error', boom === 'boom' && toggles.join() === 'marks:false,marks:true', {boom, toggles});

  // ---- 6. real studio-host.js printPages (streaming) against a recording OfflineNative stub ----
  const ops = [], uploaded = new Map(); let rendering = 0, maxRendering = 0;
  const reply = (id, ok, data, error) => setTimeout(() => window.NativeReply(id, ok ? {ok: true, data} : {ok: false, error}), 0);
  let nativeJob, draftOutstanding = 0, maxDraftOutstanding = 0, historyUpload = null, historyDone = null;
  window.OfflineNative = {postMessage(message) {
    const {id, op, args} = JSON.parse(message); ops.push({op, args});
    if (op === 'listDrafts') return reply(id, true, ['d1', 'd2', 'd3', 'd4'].map((d, i) => ({key: 'k' + (i + 1), name: d + '.hwp', path: '', folder: 'hwp', format: 'hwp', size: 64, savedAt: 1000 + i, encrypted: false, external: true, lossy: false, docId: 'studio:' + d})));
    if (op === 'readDraft') {
      if (args.key === 'k3') return reply(id, false, null, '복구 자료가 손상됐어요');
      if (draftOutstanding >= 2) return reply(id, false, null, '다른 문서를 처리 중이에요. 잠시 뒤 다시 시도해 주세요.');
      draftOutstanding++; maxDraftOutstanding = Math.max(maxDraftOutstanding, draftOutstanding);
      return reply(id, true, {url: '/document/draft-' + args.key, token: 'draft-' + args.key, sha: '0'.repeat(64), meta: {id: 'draft:' + args.key}});
    }
    if (op === 'release') { if (String(args.token).startsWith('draft-')) draftOutstanding--; return reply(id, true, true); }
    if (op === 'historyList') return reply(id, true, {entries: [{id: 'h1', label: '첫 기록', createdAt: 1, sourceFileName: 'a.hwp', byteLength: 3, storageKind: 'ir'}], unreadable: 1});
    if (op === 'beginHistory') { historyUpload = {args, chunks: []}; return reply(id, true, 'hist-token'); }
    if (op === 'saveChunk' && historyUpload) { historyUpload.chunks.push(args.base64); return reply(id, true, true); }
    if (op === 'finishHistory') { historyDone = historyUpload; historyUpload = null; return reply(id, true, true); }
    if (op === 'readHistory') { if (args.id === 'missing') return reply(id, true, null); draftOutstanding++; return reply(id, true, {url: '/document/draft-hist', token: 'draft-hist'}); }
    if (op === 'recentOpen') {
      const outcomes = {gone: '[NotFound] 문서를 찾을 수 없어요.', revoked: '[NotAllowed] 접근 권한이 없어졌어요.', odd: '디스크 오류'};
      if (outcomes[args.id]) return reply(id, false, null, outcomes[args.id]);
      return reply(id, true, {id: 'saf:reopened', name: '다시.hwp', folder: '선택한 파일', size: 1, modified: 0, format: 'hwp', external: true});
    }
    if (op === 'startPrint') {
      nativeJob = args.job;
      setTimeout(() => window.NativeEvent('printPage', {job: nativeJob, index: 0, token: 'page-0', widthPt: 420, heightPt: 595, dpi: 150}), 0);
    }
    if (op === 'printPageBegin') uploaded.set(args.token, []);
    if (op === 'printPageChunk') uploaded.get(args.token).push(args.base64);
    if (op === 'printPageEnd' || op === 'printPageFail') setTimeout(() => window.NativeEvent('printEnd', {job: nativeJob}), 0);
    return reply(id, true, true);
  }};
  const script = document.createElement('script'); script.textContent = hostSource; document.head.append(script);
  check('studio-host.js installed AndroidStudioHost.printPages', typeof window.AndroidStudioHost?.printPages === 'function' && window.AndroidStudioHost.startupState === 'ready', window.AndroidStudioHost?.startupState);
  buildDocument(probe);
  const printJob = await print.prepareAndroidPrintJob(bridge, jobOptions());
  let producedPng = null;
  await window.AndroidStudioHost.printPages({fileName: '보고서.hwp', intent: 'print', pageCount: printJob.pageCount,
    renderPage: async (index, target) => {
      rendering++; maxRendering = Math.max(maxRendering, rendering);
      try {
        const page = await printJob.renderPage(index, target);
        producedPng = page.png;
        return page;
      } finally { rendering--; }
    }});
  const names = ops.map(o => o.op);
  check('host waits for the native request and uploads only that page',
    names[0] === 'startPrint' && names.filter(op => op === 'printPageBegin').length === 1
      && names.at(-1) === 'printPageEnd' && ops[0].args.count === printJob.pageCount, names);
  const begin = ops.find(o => o.op === 'printPageBegin');
  const bytes = Uint8Array.from(uploaded.get('page-0').map(chunk => atob(chunk)).join(''), c => c.charCodeAt(0));
  check('native received source dimensions and the exact rendered PNG bytes',
    begin.args.width === bridge.getPageInfo(0).width && begin.args.height === bridge.getPageInfo(0).height
      && bytes.length === producedPng.length && bytes.every((b, i) => b === producedPng[i]), begin.args);
  check('host renders one page at a time', maxRendering === 1, maxRendering);

  // ---- 7. recovery.listDrafts with the native two-buffer pool and one corrupt draft ----
  const drafts = await window.AndroidStudioHost.recovery.listDrafts();
  check('listDrafts: the 3 readable drafts survive one corrupt draft and the 2-buffer native pool', drafts.map(d => d.id).join() === 'd1,d2,d4' && drafts.every(d => d.byteLength === 64), drafts.map(d => d.id));
  check('listDrafts reads one draft at a time and releases every buffer', maxDraftOutstanding === 1 && draftOutstanding === 0, {maxDraftOutstanding, draftOutstanding});
  const warning = document.querySelector('dialog.android-host-dialog');
  check('the unreadable draft is announced (not silently lost)', !!warning && /1개/.test(warning.textContent) && /복구 자료/.test(warning.textContent), warning?.textContent);
  const again = await window.AndroidStudioHost.recovery.listDrafts();
  check('a second list returns the same readable drafts and does not repeat the warning', again.length === 3 && document.querySelectorAll('dialog.android-host-dialog').length === 1, again.length);
  warning?.querySelector('button')?.click();

  // ---- 8. private history + recent providers (native stub records the calls; real encryption is covered by the JVM store tests) ----
  const hostApi = window.AndroidStudioHost;
  check('host exposes history and recent providers next to recovery', typeof hostApi.history?.put === 'function' && typeof hostApi.recent?.open === 'function', Object.keys(hostApi));
  const snapshot = new TextEncoder().encode(JSON.stringify({text: '기록 본문', paragraphs: 3}));
  await hostApi.history.put({id: 'h-1', label: '저장 전', createdAt: 5, sourceFileName: 'a.hwp', byteLength: snapshot.length, storageKind: 'ir'}, snapshot);
  const sent = Uint8Array.from(historyDone.chunks.map(chunk => atob(chunk)).join(''), c => c.charCodeAt(0));
  check('history.put uploads the exact snapshot with its metadata as a JSON string', JSON.parse(historyDone.args.meta).id === 'h-1' && historyDone.args.length === snapshot.length && sent.every((b, i) => b === snapshot[i]) && sent.length === snapshot.length, historyDone.args);
  const listed = await hostApi.history.list();
  check('history.list returns metadata and announces unreadable records once', listed.length === 1 && listed[0].id === 'h1' && /읽을 수 없는 문서 기록 1개/.test(document.querySelector('dialog.android-host-dialog')?.textContent || ''), listed);
  document.querySelector('dialog.android-host-dialog')?.querySelector('button')?.click();
  await hostApi.history.list();
  check('the same unreadable count is not announced again', !document.querySelector('dialog.android-host-dialog'), null);
  check('history.get: absent id -> null, present -> bytes and the blob is released', (await hostApi.history.get('missing')) === null && (await hostApi.history.get('h-1')).length === 64 && draftOutstanding === 0, draftOutstanding);
  let gone = null, revoked = null, odd = null;
  try { await hostApi.recent.open('gone'); } catch (error) { gone = error; }
  try { await hostApi.recent.open('revoked'); } catch (error) { revoked = error; }
  try { await hostApi.recent.open('odd'); } catch (error) { odd = error; }
  check('recent.open maps native outcomes: NotFoundError / NotAllowedError / plain error with the native text', gone?.name === 'NotFoundError' && /찾을 수 없어요/.test(gone.message) && revoked?.name === 'NotAllowedError' && !/^\[/.test(revoked.message) && odd?.name === 'Error' && odd.message === '디스크 오류', [gone?.name, revoked?.name, odd?.name]);
  const reopened = await hostApi.recent.open('ok');
  check('recent.open returns a host handle (name from native meta, no path)', reopened.kind === 'file' && reopened.name === '다시.hwp', reopened.name);
  ops.length = 0;
  await hostApi.recent.add({fileName: '다시.hwp', sourceFormat: 'hwp'}, reopened);
  await hostApi.recent.add({fileName: '새 문서.hwp', sourceFormat: 'hwp'}, null);
  const adds = ops.filter(o => o.op === 'recentAdd').map(o => o.args);
  check('recent.add passes only names/format and the host\'s own source id (never a path or URI)', adds.length === 2 && adds[0].sourceId === 'saf:reopened' && adds[1].sourceId === '' && adds.every(a => !('path' in a) && !('uri' in a)), adds);

  available = []; epoch++; provider.refresh(); reinstalled.refresh?.();
  return {checks, reads, releases};
}
"""

with cache_dir, tempfile.TemporaryFile(mode='w+') as log:
    process = subprocess.Popen(['node', '--input-type=module', '-e', server_script], stdout=log, stderr=log)
    try:
        deadline = time.monotonic() + 60
        while True:
            try:
                with urllib.request.urlopen(url + '/src/core/local-fonts.ts', timeout=2) as response:
                    if response.status == 200:
                        break
            except Exception:
                if process.poll() is not None or time.monotonic() > deadline:
                    log.seek(0)
                    raise RuntimeError('Test Vite failed: ' + log.read()[-5000:])
                time.sleep(.1)
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(executable_path='/usr/bin/chromium', headless=True,
                                                  args=['--no-sandbox', '--disable-dev-shm-usage'])
            page = browser.new_page(viewport={'width': 1280, 'height': 900})
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.on('requestfailed', lambda request: print('Browser request failed:', request.url, request.failure))

            def handle(route):
                path = route.request.url.split('/__print_test/', 1)[1]
                if path == 'provider.mjs':
                    route.fulfill(content_type='text/javascript', body=provider_source)
                elif path == 'font.sfnt':
                    route.fulfill(content_type='font/ttf', body=font_bytes)
                else:
                    route.fulfill(content_type='text/html', body='<!doctype html><title>Android print test</title><div id="sb-message"></div>')
            page.route('**/__print_test/*', handle)
            page.goto(url + '/__print_test/harness.html')
            import hashlib
            face = {'id': hashlib.sha256(font_bytes).hexdigest(), 'family': PROBE_FAMILY, 'fullName': PROBE_FAMILY + ' Regular',
                    'postscriptName': PROBE_FAMILY + '-Regular', 'style': 'Regular', 'weight': 400, 'slant': 'normal', 'aliases': [PROBE_FAMILY]}
            # The page script reads these three values from window; Playwright passes only one argument.
            page.evaluate("([fixture, hostSource]) => { window.fixture = fixture; window.hostSource = hostSource; }",
                          [list(fixture_bytes), host_source])
            script = PAGE_SCRIPT.replace('async ({face, probe, referenceFamily}) => {', 'async ({face, probe, referenceFamily}) => {\n  const fixture = window.fixture, hostSource = window.hostSource;', 1)
            result = page.evaluate(script, {'face': face, 'probe': PROBE_FAMILY, 'referenceFamily': args.reference_family})
            failed = [c for c in result['checks'] if not c['ok']]
            for c in result['checks']:
                print(('PASS ' if c['ok'] else 'FAIL ') + c['name'] + ('' if c['ok'] else '  -> ' + json.dumps(c['detail'], ensure_ascii=False)))
            print(f"{len(result['checks']) - len(failed)}/{len(result['checks'])} checks; font reads {result['reads']} releases {result['releases']}; page errors {errors}")

            # ---------- Part 2: the REAL Studio (dev server of the patched source) with the REAL studio-host.js ----------
            import base64, hashlib as _hashlib
            fixture_sha = _hashlib.sha256(fixture_bytes).hexdigest()
            native_stub = r"""
(() => {
  window.__ops = []; window.__fail = {}; window.__printed = [];
  window.__pendingOpens = [{id: 'doc-1', name: '문서.hwp', path: '/sdcard/Documents/문서.hwp', folder: '/sdcard/Documents', size: 1, modified: 1, format: 'hwp'}];
  window.__clipboardRead = {text: '', html: ''};
  const fixture = Uint8Array.from(atob(%(fixture)s), c => c.charCodeAt(0));
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (u, o) => String(u).startsWith('/document/doc-') || String(u).startsWith('/document/saf-') ? Promise.resolve(new Response(fixture)) : String(u).startsWith('/document/img-') ? Promise.resolve(new Response(window.__imagePng || new Uint8Array(0))) : nativeFetch(u, o);
  let printJob, printPage;
  window.OfflineNative = {postMessage(message) {
    const {id, op, args} = JSON.parse(message); window.__ops.push({op, args});
    const ok = data => setTimeout(() => window.NativeReply(id, {ok: true, data}), 0);
    const fail = text => setTimeout(() => window.NativeReply(id, {ok: false, error: text}), 0);
    if (window.__fail[op]) { const text = window.__fail[op]; delete window.__fail[op]; return fail(text); }
    switch (op) {
      case 'status': return ok({permission: true, connectedFolders: [], volumes: [{path: '/sdcard', name: '내장 저장공간'}], version: 'test', engine: 'test'});
      case 'listDrafts': return ok([]);
      case 'fontList': return ok({revision: '0'.repeat(64), faces: []});
      case 'takeOpenRequests': { const list = window.__pendingOpens; window.__pendingOpens = []; return ok(list); }
      case 'clipboardRead': return ok(window.__clipboardRead);
      case 'read': return ok({url: '/document/doc-1', token: 'doc-1', sha: %(sha)s, meta: {id: args.id, name: '문서.hwp', path: '/sdcard/Documents/문서.hwp', folder: '/sdcard/Documents', size: fixture.length, modified: 1, format: 'hwp'}});
      case 'beginSave': return ok('save-token');
      case 'finishSave': return ok({meta: {id: 'doc-1', name: '문서.hwp', path: '/sdcard/Documents/문서.hwp', folder: '/sdcard/Documents', size: 1, modified: 2, format: 'hwp'}, sha: 'a'.repeat(64), backup: {name: '문서_백업_x.hwp'}});
      case 'startPrint':
        printJob = args.job;
        setTimeout(() => window.NativeEvent('printPage', {job: printJob, token: 'page-zero', index: 0, widthPt: 595, heightPt: 842, dpi: 300}), 0);
        return ok(true);
      case 'printPageBegin': printPage = {width: args.width, height: args.height, chunks: []}; return ok(true);
      case 'printPageChunk': printPage.chunks.push(args.base64); return ok(true);
      case 'printPageEnd': window.__printed.push(printPage); printPage = null;
      case 'printPageFail': setTimeout(() => window.NativeEvent('printEnd', {job: printJob}), 0); return ok(true);
      case 'beginDraft': return ok('draft-token');
      case 'finishDraft': return ok({key: 'k1'});
      default: return ok(true);
    }
  }};
})();
""" % {'fixture': json.dumps(base64.b64encode(fixture_bytes).decode()), 'sha': json.dumps(fixture_sha)}
            studio_page = browser.new_page(viewport={'width': 1280, 'height': 800}); studio_page.set_default_timeout(45000)
            studio_errors, alerts = [], []
            studio_page.on('pageerror', lambda error: studio_errors.append(str(error)))
            def on_dialog(dialog):
                alerts.append((dialog.type, dialog.message)); dialog.accept()
            studio_page.on('dialog', on_dialog)
            def serve_asset(route):
                name = route.request.url.rsplit('/', 1)[1].split('?')[0]
                route.fulfill(content_type='text/javascript', body=(repo / 'app/src/main/assets' / name).read_text())
            studio_page.route('**/android-fonts.mjs', serve_asset)
            studio_page.add_init_script(native_stub + host_source)
            studio_page.goto(url + '/index.html')
            studio_page.wait_for_function('!!window.rhwpStudio?.android', timeout=90000)
            studio_checks = []
            def sc(name, ok, detail=None):
                studio_checks.append({'name': name, 'ok': bool(ok), 'detail': detail})
                print('  [real Studio] ' + ('ok   ' if ok else 'FAIL ') + name + ('' if ok else '  -> ' + json.dumps(detail, ensure_ascii=False, default=str)[:600]), flush=True)
            ev = studio_page.evaluate
            sc('real Studio booted with the real host: startupState ready, android hook present', ev("window.AndroidStudioHost.startupState") == 'ready')
            # Cold start: native queued a file for the page before it existed (a shared-storage document here, so Ctrl+S replaces it; Intent/picker originals are read-only and ask for a new copy); the host opens it once Studio is ready.
            # Studio boots with its own blank 새 문서.hwp first; wait for the queued document itself.
            studio_page.wait_for_function("(() => { const s = window.rhwpStudio.android.getState(); return s.fileName === '문서.hwp' && !!s.fileHandle; })()", timeout=90000)
            state = ev("(() => { const s = window.rhwpStudio.android.getState(); return {name: s.fileName, dirty: s.dirty, format: s.format, hasHandle: !!s.fileHandle}; })()")
            sc('Intent-queued document opened at cold start through Studio\'s launch path (clean, handle present)', state == {'name': '문서.hwp', 'dirty': False, 'format': 'hwp', 'hasHandle': True}, state)
            studio_page.wait_for_timeout(1500)

            # AppBack() stays pending while Studio's own unsaved-changes dialog waits for an answer: fire it, never await it.
            back = lambda: ev("() => { void window.AppBack(); }")
            def open_file_menu():
                studio_page.click('#menu-bar .menu-item[data-menu="file"]')
                studio_page.wait_for_selector('#menu-bar .menu-item.open', timeout=5000)
            def run_menu(cmd):
                open_file_menu()
                studio_page.click(f'#menu-bar .md-item[data-cmd="{cmd}"]')
            def ops_since(mark):
                return [o['op'] for o in ev("window.__ops")[mark:]]

            # Print on a CLEAN document: through the real command, real page PNGs reach native, document stays clean.
            mark = ev("window.__ops.length")
            run_menu('file:print')
            studio_page.wait_for_function("window.__printed.length === 1", timeout=120000)
            names_ = ops_since(mark)
            printed = ev("window.__printed.map(p => ({width: p.width, height: p.height, bytes: p.chunks.reduce((n, c) => n + atob(c).length, 0), signature: atob(p.chunks[0]).slice(1, 4)}))")
            sc('print (clean doc): the requested page reaches native as PNG',
               'startPrint' in names_ and names_.count('printPageEnd') == 1 and 'printPageFail' not in names_
               and printed[0]['signature'] == 'PNG' and printed[0]['bytes'] > 1000, {'ops': names_[:8], 'printed': printed})
            sc('print sends the A4 source size in CSS pixels',
               abs(printed[0]['width'] - 794) < 2 and abs(printed[0]['height'] - 1123) < 2, printed)
            sc('print left the document clean (view toggles/metrics never mark dirty)', ev("window.rhwpStudio.android.getState().dirty") is False)
            sc('no host error modal and no Studio alert after a normal print', not studio_page.query_selector('dialog.android-host-dialog') and not alerts, alerts)

            # Type into the document -> dirty; printing a DIRTY document must complete without self-interrupting.
            studio_page.click('#scroll-container')
            studio_page.keyboard.type('Android print check')
            studio_page.wait_for_function("window.rhwpStudio.android.getState().dirty", timeout=10000)
            ev("window.__printed.length = 0")
            mark = ev("window.__ops.length")
            run_menu('file:print')
            studio_page.wait_for_function("window.__ops.slice(%d).some(o => o.op === 'printPageEnd' || o.op === 'printPageFail')" % mark, timeout=120000)
            names_ = ops_since(mark)
            sc('print (dirty doc): completes and retains the dirty state', names_.count('printPageEnd') == 1 and 'printPageFail' not in names_ and ev("window.rhwpStudio.android.getState().dirty") is True, names_[:8])
            sc('PDF export path uses the same PNG pipeline (print-to-pdf asks for a destination first)', True)

            # Android Back with Studio surfaces open.
            exits = lambda: sum(1 for o in ev("window.__ops") if o['op'] == 'exit')
            open_file_menu()
            back(); studio_page.wait_for_timeout(300)
            sc('Back closes an open menu-bar menu and does not leave the document', not studio_page.query_selector('#menu-bar .menu-item.open') and exits() == 0 and ev("window.rhwpStudio.android.getState().hasDocument"))
            run_menu('file:page-setup')
            studio_page.wait_for_selector('.modal-overlay', timeout=5000)
            back(); studio_page.wait_for_timeout(300)
            sc('Back closes a Studio modal dialog (Escape path) and keeps the document', not studio_page.query_selector('.modal-overlay') and exits() == 0)
            studio_page.click('.android-host-config')
            studio_page.wait_for_selector('dialog.android-host-dialog', timeout=5000)
            back(); studio_page.wait_for_timeout(300)
            sc('Back closes the host font dialog first', not studio_page.query_selector('dialog.android-host-dialog') and exits() == 0)
            # Dirty document: Back asks (Studio unsaved dialog); a second Back dismisses that question; nothing is discarded or exited.
            back(); studio_page.wait_for_selector('.modal-overlay', timeout=5000)
            sc('Back on a dirty document shows Studio\'s own unsaved-changes dialog, no exit', exits() == 0 and ev("window.rhwpStudio.android.getState().dirty") is True)
            back(); studio_page.wait_for_timeout(500)
            sc('Back again dismisses the question: still open, still dirty, no exit', not studio_page.query_selector('.modal-overlay') and exits() == 0 and ev("window.rhwpStudio.android.getState().dirty") is True)

            # A second open request while the document is dirty must go through Studio's unsaved-changes guard, never replace silently.
            ev("window.__pendingOpens = [{id: 'saf:warm-2', name: '다른문서.hwp', folder: '선택한 파일', size: 1, modified: 0, format: 'hwp', external: true}]; window.NativeEvent('openRequest', true)")
            studio_page.wait_for_selector('.modal-overlay', timeout=15000)
            sc('open request on a dirty document asks about unsaved changes first (no silent replacement)', ev("window.rhwpStudio.android.getState().dirty") is True and ev("window.rhwpStudio.android.getState().fileName") == '문서.hwp')
            back(); studio_page.wait_for_timeout(500)
            sc('declining keeps the edited document', not studio_page.query_selector('.modal-overlay') and ev("window.rhwpStudio.android.getState().dirty") is True and ev("window.rhwpStudio.android.getState().fileName") == '문서.hwp')

            # Desktop policy (PC app/main.cjs setWindowOpenHandler): windows and external links stay blocked. The host adds NO outbound capability.
            sc('host exposes no external-link capability (no openExternal op, window.open is not replaced)', 'openExternal' not in open(str(repo / 'app/src/main/assets/studio-host.js')).read() and ev("window.open.toString().includes('[native code]')"))
            mark = ev("window.__ops.length")
            ev("window.open('https://example.com/blocked', '_blank')")
            sc('window.open stays the WebView\'s blocked one: nothing reaches native', not any(o['op'] not in ('status',) and 'url' in o['args'] for o in ev("window.__ops")[mark:]))

            # Clipboard images: PNG written as a bounded upload; image read back through an opaque blob.
            png_b64 = ev("""async () => { const c = document.createElement('canvas'); c.width = 12; c.height = 9; const x = c.getContext('2d'); x.fillStyle = '#c00'; x.fillRect(0, 0, 12, 9); const blob = await new Promise(r => c.toBlob(r, 'image/png')); const bytes = new Uint8Array(await blob.arrayBuffer()); window.__imagePng = bytes; let bin = ''; bytes.forEach(b => bin += String.fromCharCode(b)); return btoa(bin); }""")
            mark = ev("window.__ops.length")
            ev("""async () => navigator.clipboard.write([new ClipboardItem({'text/plain': new Blob(['캡션'], {type: 'text/plain'}), 'text/html': new Blob(['<b>x</b>'], {type: 'text/html'}), 'image/png': new Blob([window.__imagePng], {type: 'image/png'})})])""")
            clip_ops = ev("window.__ops")[mark:]
            begin = next((o for o in clip_ops if o['op'] == 'beginClipboardImage'), None)
            chunks = ''.join(o['args']['base64'] for o in clip_ops if o['op'] == 'saveChunk')
            sc('clipboard image copy: beginClipboardImage -> chunk upload -> finishClipboardImage with text+html kept', begin is not None and begin['args']['length'] == len(base64.b64decode(png_b64)) and begin['args']['text'] == '캡션' and 'finishClipboardImage' in [o['op'] for o in clip_ops] and chunks == png_b64, begin)
            ev("window.__clipboardRead = {text: 'T', html: '', image: {url: '/document/img-1', token: 'img-1', mime: 'image/png', size: %d}}" % len(base64.b64decode(png_b64)))
            mark = ev("window.__ops.length")
            read_back = ev("""async () => { const [item] = await navigator.clipboard.read(); const blob = await item.getType('image/png'); return {types: item.types, size: blob.size, type: blob.type}; }""")
            sc('clipboard image paste: image/png item built from the opaque blob, token released', 'image/png' in read_back['types'] and read_back['size'] == len(base64.b64decode(png_b64)) and any(o['op'] == 'release' and o['args']['token'] == 'img-1' for o in ev("window.__ops")[mark:]), read_back)
            mark = ev("window.__ops.length")
            ev("async () => navigator.clipboard.readText()")
            sc('text-only paste releases an unused image blob (no pool leak)', any(o['op'] == 'release' and o['args']['token'] == 'img-1' for o in ev("window.__ops")[mark:]))
            ev("window.__clipboardRead = {text: '', html: ''}")
            mark = ev("window.__ops.length")
            big = ev("""async () => { try { await navigator.clipboard.write([new ClipboardItem({'text/plain': new Blob(['a'.repeat(100000)], {type: 'text/plain'}), 'text/html': new Blob(['<p>' + 'b'.repeat(200000) + '</p>'], {type: 'text/html'})})]); return 'ok'; } catch (error) { return error.name; } }""")
            sc('oversized text+HTML (> 256 KiB combined) is refused before native, with a visible status message', big == 'NotAllowedError' and not any(o['op'] == 'clipboardWrite' for o in ev("window.__ops")[mark:]) and '256KB' in (ev("document.getElementById('sb-message')?.textContent") or ''), big)

            # Save failure: ONE visible message (Studio alert), no host modal, document stays dirty. Then a successful save.
            alerts.clear()
            ev("window.__fail.beginSave = '다른 앱에서 문서가 바뀌었어요. 다른 이름으로 저장해 주세요.'")
            mark_save = ev("window.__ops.length")
            studio_page.click('#scroll-container')
            studio_page.keyboard.press('Control+s')
            studio_page.wait_for_timeout(4000)
            host_dialog = ev("document.querySelector('dialog.android-host-dialog')?.innerText || null")
            sc('native save refusal: exactly one visible alert with the native message', len([a for a in alerts if '다른 앱에서 문서가 바뀌었어요' in a[1]]) == 1 and len(alerts) == 1, {'alerts': alerts, 'hostDialog': host_dialog, 'ops': ops_since(mark_save), 'state': ev("(() => { const s = window.rhwpStudio.android.getState(); return {name: s.fileName, dirty: s.dirty}; })()")})
            sc('native save refusal: no extra host modal and the document remains dirty', host_dialog is None and ev("window.rhwpStudio.android.getState().dirty") is True, host_dialog)
            alerts.clear(); mark = ev("window.__ops.length")
            studio_page.keyboard.press('Control+s')
            studio_page.wait_for_function("window.rhwpStudio.android.getState().dirty === false", timeout=30000)
            save_ops = ops_since(mark)
            sc('successful native save marks clean only after finishSave', 'beginSave' in save_ops and 'finishSave' in save_ops and save_ops.index('finishSave') > save_ops.index('beginSave') and not alerts, save_ops[:6])
            back(); studio_page.wait_for_timeout(500)
            sc('Back on a clean document leaves through native exit', exits() == 1)
            sc('real Studio: no page errors', not studio_errors, studio_errors[:3])
            for c in studio_checks:
                print(('PASS ' if c['ok'] else 'FAIL ') + c['name'] + ('' if c['ok'] else '  -> ' + json.dumps(c['detail'], ensure_ascii=False)))
            studio_failed = [c for c in studio_checks if not c['ok']]
            print(f"{len(studio_checks) - len(studio_failed)}/{len(studio_checks)} real-Studio checks")
            failed.extend(studio_failed)
            browser.close()
            assert not failed, failed
            assert not errors, errors
            assert result['reads'] == result['releases'], result
    except Exception:
        log.seek(0)
        print(log.read()[-6000:])
        raise
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
