// hwpxxx editor features in the REAL patched Studio (real WASM, real studio-host.js; Chromium + a recording OfflineNative stub; not a device).
//   node tests/studio-hwpxxx-features.mjs --studio-root <patched tree>/rhwp-studio [--throttle 4] [--out .qa/studio-hwpxxx-features.json]
// Covers: IME composition overlay font (CDP Input.imeSetComposition), Alt+C continuous format copy + Enter in its dialog, Ctrl+Enter page
// break (also while composing), Shift+Enter line break, and typing/deleting latency + the perf probe snapshot (informational numbers; a headless
// desktop Chromium with optional CPU throttling is NOT the tablet, so only the functional checks fail the run).
// Needs Playwright (env PLAYWRIGHT_NODE_MODULES) and a Chromium (env PLAYWRIGHT_CHROMIUM_EXECUTABLE).
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath, pathToFileURL} from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assets = path.join(repo, 'app/src/main/assets');
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback; };
const studioSrc = path.resolve(arg('--studio-root', ''));
if (!arg('--studio-root')) { console.error('--studio-root is required'); process.exit(2); }
const throttle = Number(arg('--throttle', '1'));
const profileTyping = process.argv.includes('--profile');
const outFile = arg('--out', '.qa/studio-hwpxxx-features.json');
const req = createRequire(path.join(process.env.PLAYWRIGHT_NODE_MODULES || repo, 'x.js'));
// Local-only (Termux reports process.platform 'android', which Playwright refuses): HWPXXX_PLATFORM_SHIM=1 shows it 'linux' while Playwright loads/launches.
const withLinux = fn => { if (process.env.HWPXXX_PLATFORM_SHIM !== '1') return fn(); const real = process.platform; Object.defineProperty(process, 'platform', {value: 'linux'}); try { return fn(); } finally { Object.defineProperty(process, 'platform', {value: real}); } };
let pw; try { pw = withLinux(() => req('playwright')); } catch { pw = withLinux(() => req('playwright-core')); }
const chromePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium';

const doc = fs.readFileSync(path.join(repo, 'tests/fixtures/blank.hwp'));
const META = {id: 'idA', name: 'A.hwp', path: '/sdcard/Documents/A.hwp', folder: '/sdcard/Documents', size: doc.length, modified: 1, format: 'hwp'};
const STUB = `(() => {
  const bytes = Uint8Array.from(atob(${JSON.stringify(doc.toString('base64'))}), c => c.charCodeAt(0));
  const meta = ${JSON.stringify(META)};
  window.__ops = []; window.__pendingOpens = [meta.id];
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (u, o) => String(u) === '/document/doc-idA' ? Promise.resolve(new Response(bytes)) : nativeFetch(u, o);
  window.OfflineNative = {postMessage(message) {
    const {id, op, args} = JSON.parse(message); window.__ops.push({op, args});
    const ok = data => setTimeout(() => window.NativeReply(id, {ok: true, data}), 0);
    switch (op) {
      case 'status': return ok({permission: true, connectedFolders: [], volumes: [{path: '/sdcard', name: 'internal'}], version: 't', engine: 't'});
      case 'listDrafts': return ok([]);
      case 'fontList': return ok({revision: '0'.repeat(64), faces: []});
      case 'takeOpenRequests': { const list = window.__pendingOpens; window.__pendingOpens = []; return ok(list); }
      case 'read': return ok({url: '/document/doc-' + args.id, token: 'doc-' + args.id, sha: 'a'.repeat(64), meta});
      case 'beginDraft': return ok('draft-token');
      case 'finishDraft': return ok({key: 'k1'});
      default: return ok(true);
    }
  }};
})();`;

const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const {port} = s.address(); s.close(() => resolve(port)); }); s.on('error', reject); });
async function startVite() {
  const port = await freePort(), cache = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpxxx-feat-vite-'));
  const viteEntry = pathToFileURL(path.join(studioSrc, 'node_modules/vite/dist/node/index.js')).href;
  const script = `
import {createServer} from ${JSON.stringify(viteEntry)};
const root=${JSON.stringify(studioSrc)};
const stub={name:'hwpctrl-stub',resolveId(id){return id==='@rhwp/hwpctrl/studio-plugin'?'\\0hwpctrl-stub':null},load(id){return id==='\\0hwpctrl-stub'?'export const hwpctrlStudioPlugin=null':null}};
const server=await createServer({configFile:false,plugins:[stub],root,cacheDir:${JSON.stringify(cache)},
 define:{__APP_VERSION__:'"test"',__RHWP_DISABLE_EXTERNAL_WEBFONTS__:'true',__RHWP_HWPCTRL__:'false',__RHWP_AI__:'false'},
 resolve:{alias:{'@':root+'/src','@wasm':root+'/../pkg'}},
 optimizeDeps:{noDiscovery:true,entries:[],include:['canvaskit-wasm']},
 server:{host:'127.0.0.1',port:${port},strictPort:true,fs:{allow:[root,root+'/../pkg']}}});
await server.listen();`;
  const log = [], child = spawn(process.execPath, ['--input-type=module', '-e', script], {stdio: ['ignore', 'pipe', 'pipe']});
  child.stdout.on('data', d => log.push(String(d))); child.stderr.on('data', d => log.push(String(d)));
  const url = `http://127.0.0.1:${port}`, deadline = Date.now() + 120000;
  for (;;) {
    try { const r = await fetch(url + '/index.html'); if (r.ok) break; } catch { /* retry */ }
    if (child.exitCode !== null || Date.now() > deadline) throw new Error('Studio dev server failed: ' + log.join('').slice(-2000));
    await new Promise(r => setTimeout(r, 200));
  }
  return {child, url, cache};
}

const checks = [], numbers = {};
const check = (name, ok, detail) => { checks.push({name, ok: !!ok, detail}); console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok || detail === undefined ? '' : '  ' + JSON.stringify(detail).slice(0, 700))); };
const pause = ms => new Promise(r => setTimeout(r, ms));
// Self time per function from a CDP CPU profile (the heaviest first): where the main thread goes while keys are typed.
const topSelfTime = (profile, limit = 25) => {
  const byId = new Map(profile.nodes.map(n => [n.id, n])), self = new Map();
  profile.samples.forEach((id, i) => self.set(id, (self.get(id) || 0) + (profile.timeDeltas[i] || 0)));
  const rows = new Map();
  for (const [id, us] of self) { const f = byId.get(id).callFrame, key = `${f.functionName || '(anonymous)'} ${String(f.url).split('/').slice(-2).join('/')}:${f.lineNumber + 1}`; rows.set(key, (rows.get(key) || 0) + us); }
  return [...rows].sort((x, y) => y[1] - x[1]).slice(0, limit).map(([name, us]) => ({name, ms: Math.round(us / 100) / 10}));
};
const quantile = (list, q) => { const s = [...list].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.ceil(s.length * q) - 1)] : null; };

const vite = await startVite();
const browser = await withLinux(() => pw.chromium.launch({executablePath: chromePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage']}));
try {
  const page = await browser.newPage({viewport: {width: 1280, height: 800}});
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('dialog', d => d.accept());
  await page.route('**/android-fonts.mjs', route => route.fulfill({contentType: 'text/javascript', body: fs.readFileSync(path.join(assets, 'android-fonts.mjs'), 'utf8')}));
  await page.addInitScript(STUB + fs.readFileSync(path.join(assets, 'studio-host.js'), 'utf8'));
  await page.goto(vite.url + '/index.html');
  await page.waitForFunction('!!window.rhwpStudio?.android', null, {timeout: 120000});
  await page.waitForFunction('window.rhwpStudio.android.getState().hasDocument', null, {timeout: 90000});
  await page.waitForFunction('!!window.__inputHandler', null, {timeout: 90000});
  await pause(1500);
  const cdp = await page.context().newCDPSession(page);
  if (throttle > 1) await cdp.send('Emulation.setCPUThrottlingRate', {rate: throttle});
  const kb = page.keyboard, ev = (fn, a) => page.evaluate(fn, a);
  const focusDoc = async () => { await page.click('#scroll-container'); await kb.press('Control+Home'); };
  const text = () => ev('window.__wasm.doc.getTextFileUnicode()');
  const paragraphs = () => ev('window.__wasm.doc.getParagraphCount(0)');
  const pages = () => ev('window.__wasm.pageCount');
  const hasCopy = () => ev('window.__inputHandler.hasCopiedFormat()');
  const frames = () => ev('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(performance.now()))))');

  // ---------------------------------------------------------------- 0. baseline: a plain Ctrl+B on a fresh selection (before any simulated IME)
  await focusDoc(); await kb.type('abc def');
  for (let i = 0; i < 3; i++) await kb.press('Shift+ArrowLeft');
  await kb.press('Control+b'); await pause(300);
  check('Ctrl+B bolds a Shift+Arrow selection in a fresh document', await ev('window.__inputHandler.getCharPropertiesAtCursor().bold === true'));
  await kb.press('Control+b'); await pause(200); // toggle back
  await kb.press('ArrowRight');

  // ---------------------------------------------------------------- 1. IME composition overlay font
  await focusDoc(); await kb.type('시작 ');
  await ev('window.__inputHandler.applyCharFormat({bold: true, fontSize: 2000})'); // caret only -> pending char shape for the composing text
  await cdp.send('Input.imeSetComposition', {text: '한', selectionStart: 1, selectionEnd: 1});
  let shown = true;
  try { await page.waitForFunction(() => { const e = document.querySelector('.caret-composition'); return !!e && getComputedStyle(e).display !== 'none' && e.textContent.length > 0; }, null, {timeout: 8000}); }
  catch (e) { shown = false; check('composition overlay appears while composing', false, String(e.message).slice(0, 200)); }
  if (shown) {
    const r = await ev(async () => {
      const {compositionCssFont} = await import('/src/hwpxxx/composition-font.ts');
      const ih = window.__inputHandler, el = document.querySelector('.caret-composition');
      const props = ih.getCharPropertiesAtCursor(), zoom = ih.viewportManager.getZoom();
      const probe = document.createElement('div'); probe.style.cssText = 'position:absolute;visibility:hidden';
      probe.style.font = compositionCssFont({fontFamily: props.fontFamily, fontSize: props.fontSize, bold: props.bold, italic: props.italic, zoom, boxHeight: parseFloat(el.style.height) / zoom});
      document.body.appendChild(probe);
      const cs = getComputedStyle(el), ps = getComputedStyle(probe);
      const out = {props: {family: props.fontFamily, size: props.fontSize, bold: props.bold}, zoom, actual: {family: cs.fontFamily, size: parseFloat(cs.fontSize), weight: cs.fontWeight}, expected: {family: ps.fontFamily, size: parseFloat(ps.fontSize), weight: ps.fontWeight}};
      probe.remove(); return out;
    });
    check('composition overlay uses the canvas-resolved font family', r.actual.family === r.expected.family, r);
    check('composition overlay follows the real font size', Math.abs(r.actual.size - r.expected.size) < 0.6, r);
    check('composition overlay follows bold', Number(r.actual.weight) >= 600 && Number(r.expected.weight) >= 600, r);
    check('pending bold/size reach the composing text (props at caret)', r.props.bold === true && r.props.size === 2000, r.props);
  }
  await kb.insertText('한'); await pause(300);
  check('composition overlay hides after the text is committed', await ev(() => { const e = document.querySelector('.caret-composition'); return !e || getComputedStyle(e).display === 'none'; }));
  check('committed Hangul reached the document', (await text()).includes('한'), (await text()).slice(0, 80));

  // ---------------------------------------------------------------- 2. Shift+Enter / Enter / Ctrl+Enter
  await focusDoc(); await kb.press('Control+End');
  const paras0 = await paragraphs();
  await kb.press('Shift+Enter'); await pause(200);
  check('Shift+Enter makes a line break without a new paragraph', (await paragraphs()) === paras0, {before: paras0, after: await paragraphs()});
  await kb.press('Enter'); await pause(200);
  check('Enter makes a new paragraph', (await paragraphs()) === paras0 + 1, {before: paras0, after: await paragraphs()});
  let before = await pages(); await kb.press('Control+Enter'); await pause(500);
  check('Ctrl+Enter inserts a page break', (await pages()) === before + 1, {before, after: await pages()});
  await kb.type('다음 ');
  await cdp.send('Input.imeSetComposition', {text: '쪽', selectionStart: 1, selectionEnd: 1}); await pause(200);
  before = await pages();
  await cdp.send('Input.dispatchKeyEvent', {type: 'rawKeyDown', key: 'Process', code: 'Enter', windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 229, modifiers: 2});
  await cdp.send('Input.dispatchKeyEvent', {type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 2});
  await pause(600);
  check('Ctrl+Enter during Hangul composition inserts a page break', (await pages()) === before + 1, {before, after: await pages()});
  check('the composing character is kept (committed before the break)', (await text()).includes('쪽'), (await text()).slice(-80));
  await cdp.send('Input.imeSetComposition', {text: '', selectionStart: 0, selectionEnd: 0}).catch(() => {});

  // ---------------------------------------------------------------- 3. Alt+C continuous format copy, Enter in its dialog
  await focusDoc(); await kb.press('Control+End'); await kb.type(' alpha beta gamma');
  const selectWord = async fromEnd => { await kb.press('Control+End'); for (let i = 0; i < fromEnd; i++) await kb.press('Control+ArrowLeft'); await kb.press('Control+Shift+ArrowLeft'); };
  { // informational: does a plain Ctrl+B bold a word selected with Shift+Arrow? (recorded, never fails the run)
    await kb.press('Control+End'); for (let i = 0; i < 5; i++) await kb.press('Shift+ArrowLeft');
    const sel = await ev('JSON.stringify(window.__inputHandler.getSelection?.() ?? null)');
    await kb.press('Control+b'); await pause(300);
    const props = await ev('window.__inputHandler.getCharPropertiesAtCursor().bold');
    numbers.ctrlB = {selection: sel, boldAfterKey: props, activeClass: await ev("document.querySelector('#btn-bold')?.classList.contains('active')"), focus: await ev('document.activeElement?.tagName + "#" + (document.activeElement?.id || "")')};
    console.log('CTRL_B_PROBE', JSON.stringify(numbers.ctrlB));
    if (props !== true) { // not bolded by the key: is it the shortcut routing or the command?
      numbers.ctrlB.viaCommand = await ev(async () => { const ih = window.__inputHandler; ih.dispatcher?.dispatch('format:bold'); await new Promise(r => setTimeout(r, 300)); return ih.getCharPropertiesAtCursor().bold; });
      numbers.ctrlB.composing = await ev('window.__inputHandler.isComposing');
      numbers.ctrlB.canExecute = await ev(() => { try { const d = window.__inputHandler.dispatcher; return d?.services?.getContext ? JSON.stringify({sel: d.services.getContext().hasSelection, edit: d.services.getContext().isEditable}) : 'n/a'; } catch (e) { return String(e); } });
      console.log('CTRL_B_PROBE2', JSON.stringify(numbers.ctrlB));
      if (numbers.ctrlB.viaCommand === true) await ev("window.__inputHandler.dispatcher.dispatch('format:bold')");
    }
    if (props === true) await kb.press('Control+b'); // toggle back
    await pause(200);
  }
  await selectWord(2); await kb.press('Control+b'); await pause(300);
  let boldNow = await ev('window.__inputHandler.getCharPropertiesAtCursor().bold === true');
  if (!boldNow) { // informational: a plain Ctrl+B keypress is not what this scenario tests; bold the selection directly and keep going
    numbers.notes = [...(numbers.notes || []), 'Ctrl+B keypress did not bold the selection in this run'];
    console.log('WARN Ctrl+B keypress did not bold the selection; applying bold directly for the Alt+C scenario');
    await ev('window.__inputHandler.applyCharFormat({bold: true})'); await pause(300);
    boldNow = await ev('window.__inputHandler.getCharPropertiesAtCursor().bold === true');
  }
  check('the first word is bold before Alt+C copies its format', boldNow);
  await kb.press('Alt+c');
  let dialog = true;
  try { await page.waitForSelector('.modal-overlay', {timeout: 8000}); } catch { dialog = false; }
  check('Alt+C opens the format copy dialog', dialog);
  if (dialog) {
    check('dialog has "continuous" checked by default', await ev(() => !!document.querySelector('input[name=format-copy-continuous]')?.checked));
    await ev(() => document.querySelector('input[name=format-copy-body][value=char]')?.focus());
    await kb.press('Enter'); await pause(300);
    check('Enter on a dialog radio confirms and closes the dialog', await ev(() => document.querySelectorAll('.modal-overlay').length === 0));
    check('copied format is held after the dialog', await hasCopy());
    for (const [i, label] of [[1, 'second'], [0, 'third']]) {
      await selectWord(i); await kb.press('Alt+c'); await pause(300);
      const bold = await ev('window.__inputHandler.getCharPropertiesAtCursor().bold === true');
      check(`Alt+C applies the copied format (${label} use)`, bold && await ev(() => document.querySelectorAll('.modal-overlay').length === 0), {bold, state: await ev(() => { const ih = window.__inputHandler; return {copy: ih.formatCopyState, sel: ih.getSelection?.() ?? null}; })});
      check(`copied format is still held after the ${label} use`, await hasCopy());
    }
    await kb.press('Escape'); await pause(200);
    check('Escape releases the continuous format copy', !(await hasCopy()));
  }

  // ---------------------------------------------------------------- 4. typing / deleting latency and the perf probe (informational)
  await ev('window.rhwpPerfReset && window.rhwpPerfReset()');
  await focusDoc(); await kb.press('Control+End');
  await kb.insertText('가나다라마바사 '.repeat(250)); await pause(800); // a body of ~2000 characters before measuring
  const typed = [], deleted = [];
  if (profileTyping) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', {interval: 200}); await cdp.send('Profiler.start'); }
  for (let i = 0; i < 40; i++) { const t0 = await ev('performance.now()'); await kb.press('KeyA'); typed.push((await frames()) - t0); }
  if (profileTyping) { const {profile} = await cdp.send('Profiler.stop'); numbers.typingProfile = topSelfTime(profile); if (process.env.HWPXXX_PROFILE_RAW) fs.writeFileSync(process.env.HWPXXX_PROFILE_RAW, JSON.stringify(profile)); console.log('TYPING_PROFILE', JSON.stringify(numbers.typingProfile, null, 1)); }
  for (let i = 0; i < 40; i++) { const t0 = await ev('performance.now()'); await kb.press('Backspace'); deleted.push((await frames()) - t0); }
  numbers.keyToPaintMs = {throttle, typed: {p50: quantile(typed, .5), p95: quantile(typed, .95), max: Math.max(...typed)}, deleted: {p50: quantile(deleted, .5), p95: quantile(deleted, .95), max: Math.max(...deleted)}};
  console.log('LATENCY', JSON.stringify(numbers.keyToPaintMs));
  await ev("window.__autosaveManager.flushNow('feature-test')"); await pause(1500);
  const snap = await ev('window.rhwpPerfSnapshot ? window.rhwpPerfSnapshot() : null');
  numbers.perf = snap;
  check('perf snapshot is available and records input and autosave stages', !!snap && !!snap.summary['input.afterEdit'] && !!snap.summary['autosave.export'], snap && snap.summary);
  check('no uncaught page errors', errors.length === 0, errors.slice(0, 3));
} finally {
  await browser.close().catch(() => {});
  vite.child.kill(); fs.rmSync(vite.cache, {recursive: true, force: true});
}
fs.mkdirSync(path.dirname(outFile), {recursive: true});
fs.writeFileSync(outFile, JSON.stringify({checks, ...numbers}, null, 2));
const failed = checks.filter(c => !c.ok);
console.log(`${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
