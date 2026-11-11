// Workspace-tab host tests (studio-host.js + workspace-tabs.mjs [+ Studio patch 0115]).
//
// What runs here is Chromium (NOT Android WebView, NOT MainActivity, NOT Samsung DeX hardware) with a recording OfflineNative that speaks the
// docs/DEX-WORKSPACE.md workspace protocol through a contract-shaped TEST DOUBLE of the native workspace (FakeNative below; it is not the Java
// WorkspaceModel). Two targets:
//   fake   - a minimal page that imitates Studio's menu row and rhwpStudio.android surface, for protocol edge cases (state/dirty, close tokens, ...)
//   studio - the REAL patched Studio (vite dev server over a source tree that has all patches incl. 0115) with the real studio-host.js
// Pure helpers are tested without a browser. The `studio` target needs STUDIO_WORKSPACE_SRC (default .build/studio-workspace-src); tests that
// cannot run say so with an explicit skip reason — a skip is not a pass.
import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath, pathToFileURL} from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assets = path.join(repo, 'app/src/main/assets');
const tabs = await import(pathToFileURL(path.join(assets, 'workspace-tabs.mjs')).href);
const read = name => fs.readFileSync(path.join(assets, name), 'utf8');
const TAB_MIME = tabs.TAB_MIME;

// ───────────────────────────── pure helpers (no browser) ─────────────────────────────
const snapshotOf = (ids, extra = {}) => ({enabled: true, selfId: ids[0], tabs: ids.map(id => ({id, title: id, dirty: false, encrypted: false, ready: true})), activeId: ids[0], primaryId: ids[0], secondaryId: null, split: false, maxTabs: 8, ...extra});

test('normalizeSnapshot accepts contract snapshots (also wrapped) and rejects malformed/unsafe ones', () => {
  const ok = tabs.normalizeSnapshot({snapshot: snapshotOf(['a', 'b'])});
  assert.equal(ok.tabs.length, 2); assert.equal(ok.selfId, 'a'); assert.equal(ok.secondaryId, null); assert.equal(ok.split, false);
  assert.equal(tabs.normalizeSnapshot({...snapshotOf(['a']), enabled: false}), null);
  assert.equal(tabs.normalizeSnapshot({...snapshotOf(['a', 'a'])}), null, 'duplicate ids');
  assert.equal(tabs.normalizeSnapshot({...snapshotOf(['a', 'b']), activeId: 'zzz'}), null, 'unknown active');
  assert.equal(tabs.normalizeSnapshot({...snapshotOf(['a', 'b']), secondaryId: 'zzz', split: true}), null);
  assert.equal(tabs.normalizeSnapshot({...snapshotOf(['a']), tabs: [{id: '../x'}]}), null, 'path-like id');
  assert.equal(tabs.normalizeSnapshot(null), null);
  const long = tabs.normalizeSnapshot({...snapshotOf(['a']), tabs: [{id: 'a', title: 'x'.repeat(500)}]});
  assert.equal(long.tabs[0].title.length, tabs.MAX_TITLE);
  assert.equal(tabs.normalizeSnapshot({...snapshotOf(['a', 'b']), split: true, secondaryId: null}).split, false, 'split needs a secondary');
});

test('parseInitialAction understands the contract strings and the recent object; garbage is blank', () => {
  assert.deepEqual(tabs.parseInitialAction('open'), {kind: 'open'});
  assert.deepEqual(tabs.parseInitialAction({kind: 'open'}), {kind: 'open'});
  assert.deepEqual(tabs.parseInitialAction('blank'), {kind: 'blank'});
  assert.deepEqual(tabs.parseInitialAction({kind: 'recent', recentId: 'abc_12-3'}), {kind: 'recent', recentId: 'abc_12-3'});
  for (const bad of [{kind: 'recent'}, {kind: 'recent', recentId: '../../x'}, {kind: 'recent', recentId: 5}, 'recent', 7, null, undefined, {kind: 'format-c'}]) assert.deepEqual(tabs.parseInitialAction(bad), {kind: 'blank'}, JSON.stringify(bad));
});

test('drop slot / moveTarget: before/after, end, no-op and unknown ids', () => {
  const order = ['a', 'b', 'c', 'd'];
  assert.equal(tabs.dropSlot([10, 30, 50, 70], 0), 0); assert.equal(tabs.dropSlot([10, 30, 50, 70], 35), 2); assert.equal(tabs.dropSlot([10, 30, 50, 70], 999), 4);
  assert.deepEqual(tabs.moveTarget(order, 'd', 0), {beforeId: 'a', noop: false});
  assert.deepEqual(tabs.moveTarget(order, 'a', 4), {beforeId: null, noop: false}, 'to the end');
  assert.deepEqual(tabs.moveTarget(order, 'b', 1), {beforeId: 'c', noop: true}, 'dropping on its own left edge');
  assert.deepEqual(tabs.moveTarget(order, 'b', 2), {beforeId: 'c', noop: true}, 'dropping on its own right edge');
  assert.deepEqual(tabs.moveTarget(order, 'a', 2), {beforeId: 'c', noop: false});
  assert.deepEqual(tabs.moveTarget(order, 'd', 4), {beforeId: null, noop: true});
  assert.equal(tabs.moveTarget(order, 'nope', 1), null);
  assert.equal(tabs.cycleId(['a'], 'a', 1), null); assert.equal(tabs.cycleId(order, 'd', 1), 'a'); assert.equal(tabs.cycleId(order, 'a', -1), 'd');
});

test('documentState only reports the four contract fields and a stable key', () => {
  const state = tabs.documentState({hasDocument: true, fileName: ' 보고서.hwp ', dirty: true, encrypted: false, fileHandle: {secret: 1}});
  assert.deepEqual(state, {title: '보고서.hwp', dirty: true, encrypted: false, ready: true});
  assert.deepEqual(tabs.documentState({hasDocument: false}), {title: '여는 중…', dirty: false, encrypted: false, ready: false});
  assert.equal(tabs.docStateKey(state), tabs.docStateKey({...state}));
});

test('sources: no HTML injection, no iframes, text/plain never carried by a tab drag, host never lets JS pick the origin', () => {
  const module = read('workspace-tabs.mjs'), host = read('studio-host.js');
  const code = source => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const [name, source] of [['workspace-tabs.mjs', code(module)], ['studio-host.js', code(host)]]) {
    assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|createContextualFragment/, name);
    assert.doesNotMatch(source, /createElement\(['"]iframe|<iframe/i, name);
  }
  assert.doesNotMatch(code(module), /setData\(['"]text\/(plain|uri-list|html)/);
  assert.match(code(module), /setData\(TAB_MIME/);
  assert.doesNotMatch(code(module), /(workspace\w+)['"],\s*\{[^}]*(origin|selfId)/, 'no origin/self id is sent to native for authority');
});

// ───────────────────────────── browser harness ─────────────────────────────
const requireNode = createRequire(import.meta.url);
function loadChromium() {
  const modules = process.env.PLAYWRIGHT_NODE_MODULES;
  const candidates = ['playwright-core', 'playwright', ...(modules ? [path.join(modules, 'playwright-core'), path.join(modules, 'playwright')] : [])];
  for (const name of candidates) { try { return requireNode(name).chromium; } catch { /* next */ } }
  return null;
}
const chromiumType = loadChromium();
const chromePath = [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE, '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].filter(Boolean).find(file => fs.existsSync(file));
const browserSkip = !chromiumType ? 'playwright is not installed' : !chromePath ? 'no chromium binary found' : false;
const studioSrc = path.resolve(process.env.STUDIO_WORKSPACE_SRC || path.join(repo, '.build/studio-workspace-src'), 'rhwp-studio');
const studioSkip = browserSkip || (!fs.existsSync(path.join(studioSrc, 'src/hwpxxx/android-host.ts')) ? `patched Studio source not found at ${studioSrc} (set STUDIO_WORKSPACE_SRC)`
  : !/workspace/.test(fs.readFileSync(path.join(studioSrc, 'src/hwpxxx/android-host.ts'), 'utf8')) ? 'Studio source does not contain patch 0115' : false);

let browser = null, vite = null, studioUrl = null;
const freePort = () => new Promise((resolve, reject) => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const {port} = server.address(); server.close(() => resolve(port)); }); server.on('error', reject); });

async function startVite() {
  const port = await freePort(), cache = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-vite-'));
  const viteEntry = pathToFileURL(path.join(studioSrc, 'node_modules/vite/dist/node/index.js')).href;
  const script = `
import {createServer} from ${JSON.stringify(viteEntry)};
const root=${JSON.stringify(studioSrc)};
const stub={name:'hwpctrl-stub',resolveId(id){return id==='@rhwp/hwpctrl/studio-plugin'?'\\0hwpctrl-stub':null},load(id){return id==='\\0hwpctrl-stub'?'export const hwpctrlStudioPlugin=null':null}};
const server=await createServer({configFile:false,plugins:[stub],root,cacheDir:${JSON.stringify(cache)},
 define:{__APP_VERSION__:'"test"',__RHWP_DISABLE_EXTERNAL_WEBFONTS__:'true',__RHWP_HWPCTRL__:'false'},
 resolve:{alias:{'@':root+'/src','@wasm':root+'/../pkg'}},
 optimizeDeps:{noDiscovery:true,entries:[],include:['canvaskit-wasm']},
 server:{host:'127.0.0.1',port:${port},strictPort:true,fs:{allow:[root,root+'/../pkg']}}});
await server.listen();`;
  const log = [];
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {stdio: ['ignore', 'pipe', 'pipe']});
  child.stdout.on('data', d => log.push(String(d))); child.stderr.on('data', d => log.push(String(d)));
  const url = `http://127.0.0.1:${port}`, deadline = Date.now() + 90000;
  for (;;) {
    try { const response = await fetch(url + '/index.html'); if (response.ok) break; } catch { /* retry */ }
    if (child.exitCode !== null || Date.now() > deadline) throw new Error('Studio dev server failed: ' + log.join('').slice(-2000));
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  return {child, url, cache};
}

before(async () => {
  if (browserSkip) return;
  browser = await chromiumType.launch({executablePath: chromePath, args: ['--no-sandbox']});
  if (!studioSkip) { vite = await startVite(); studioUrl = vite.url; }
});
after(async () => {
  await browser?.close();
  if (vite) { vite.child.kill(); fs.rmSync(vite.cache, {recursive: true, force: true}); }
});

/** Contract-shaped test double of the native workspace (docs/DEX-WORKSPACE.md). NOT the Java WorkspaceModel. */
class FakeNative {
  constructor({workspace = true, maxTabs = 5} = {}) {
    this.workspace = workspace; this.maxTabs = maxTabs; this.tabs = []; this.activeId = null; this.primaryId = null; this.secondaryId = null; this.split = false;
    this.pending = new Map(); this.views = new Map(); this.log = []; this.closeWaiters = new Map(); this.finished = false; this.mru = [];
    this.onTabAdded = null; this.recents = [];
  }
  add(origin, initial = 'blank') {
    if (this.tabs.length >= this.maxTabs) throw new Error(`탭은 최대 ${this.maxTabs}개까지 열 수 있어요.`);
    const id = randomUUID(); this.tabs.push({id, title: '새 문서', dirty: false, encrypted: false, ready: false});
    this.pending.set(id, initial); this.mru.push(id);
    if (!this.primaryId) this.primaryId = this.activeId = id; else if (origin) this.select(id, origin);
    return id;
  }
  visible() { return [this.primaryId, this.secondaryId].filter(Boolean); }
  select(id, origin) {
    if (!this.tabs.some(tab => tab.id === id)) throw new Error('unknown tab');
    if (!this.visible().includes(id)) { const from = this.visible().includes(origin) ? origin : this.activeId; if (this.split && from === this.secondaryId) this.secondaryId = id; else this.primaryId = id; }
    this.activeId = id; this.mru = [id, ...this.mru.filter(x => x !== id)];
  }
  snapshotFor(id) {
    return {enabled: true, selfId: id, tabs: this.tabs.map(tab => ({...tab})), activeId: this.activeId, primaryId: this.primaryId, secondaryId: this.split ? this.secondaryId : null, split: this.split, maxTabs: this.maxTabs};
  }
  async broadcast() { await Promise.all([...this.views].map(([id, view]) => view.emit('workspaceChanged', this.snapshotFor(id)).catch(() => {}))); }
  async handle(origin, op, args) {
    this.log.push({origin, op, args});
    const meta = this.tabs.find(tab => tab.id === origin);
    switch (op) {
      case 'workspaceReady': {
        if (!this.workspace) throw new Error('알 수 없는 작업이에요: workspaceReady');
        const initial = this.pending.get(origin) ?? 'blank'; this.pending.delete(origin);
        return {...this.snapshotFor(origin), initialAction: initial};
      }
      case 'workspaceState': return this.snapshotFor(origin);
      case 'workspaceNew': case 'workspaceOpenRecent': {
        const id = this.add(origin, op === 'workspaceNew' ? (args.open ? {kind: 'open'} : 'blank') : {kind: 'recent', recentId: args.recentId});
        this.onTabAdded?.(id); await this.broadcast(); return this.snapshotFor(origin);
      }
      case 'workspaceSelect': this.select(args.id, origin); await this.broadcast(); return this.snapshotFor(origin);
      case 'workspaceFocus': if (this.visible().includes(origin)) { this.activeId = origin; await this.broadcast(); } return this.snapshotFor(origin);
      case 'workspaceSplit': {
        if (!!args.enabled === this.split) return this.snapshotFor(origin);
        if (args.enabled) {
          let other = this.mru.find(id => id !== this.primaryId && this.tabs.some(tab => tab.id === id));
          if (!other) { other = this.add(null, 'blank'); this.onTabAdded?.(other); }
          this.split = true; this.secondaryId = other;
        } else { const keep = this.activeId; this.split = false; this.primaryId = keep; this.secondaryId = null; }
        await this.broadcast(); return this.snapshotFor(origin);
      }
      case 'workspaceMove': {
        const ids = this.tabs.map(tab => tab.id);
        if (!ids.includes(args.id) || (args.beforeId !== null && !ids.includes(args.beforeId))) throw new Error('알 수 없는 탭이에요.');
        const [moved] = this.tabs.splice(ids.indexOf(args.id), 1);
        this.tabs.splice(args.beforeId === null ? this.tabs.length : this.tabs.findIndex(tab => tab.id === args.beforeId), 0, moved);
        await this.broadcast(); return this.snapshotFor(origin);
      }
      case 'workspaceUpdate': Object.assign(meta, {title: args.title, dirty: args.dirty, encrypted: args.encrypted, ready: args.ready}); await this.broadcast(); return {ok: true};
      case 'workspaceInitialDone': {
        if (args.cancelled && meta && !meta.dirty && this.tabs.length > 1) this.remove(origin);
        await this.broadcast(); return {ok: true};
      }
      case 'workspaceClose': {
        if (!this.tabs.some(tab => tab.id === args.id)) throw new Error('알 수 없는 탭이에요.');
        this.select(args.id, origin);
        const token = 'close-' + randomUUID(), view = this.views.get(args.id);
        const decision = new Promise(resolve => this.closeWaiters.set(token, {target: args.id, resolve}));
        await view.callClose(token);
        const allow = await decision;
        if (allow) { this.remove(args.id); }
        await this.broadcast(); return this.snapshotFor(origin);
      }
      case 'workspaceCloseResult': {
        const waiter = this.closeWaiters.get(args.token);
        if (!waiter || waiter.target !== origin) throw new Error('닫기 요청을 찾지 못했어요.');
        this.closeWaiters.delete(args.token); waiter.resolve(args.allow === true); return {ok: true};
      }
      case 'takeOpenRequests': return [];
      case 'status': return {permission: true, connectedFolders: [], volumes: [{path: '/sdcard', name: '내장 저장공간'}], version: 'test', engine: 'test'};
      case 'listDrafts': return [];
      case 'fontList': return {revision: '0'.repeat(64), faces: []};
      case 'historyList': return {entries: [], unreadable: 0};
      case 'recentList': return this.recents;
      case 'scan': return {limited: false, cancelled: false};
      case 'exit':
        if (this.workspace) return this.handle(origin, 'workspaceClose', {id: origin});
        this.finished = true; return true;
      default: return true;
    }
  }
  remove(id) {
    const index = this.tabs.findIndex(tab => tab.id === id); this.tabs.splice(index, 1); this.mru = this.mru.filter(x => x !== id);
    if (!this.tabs.length) { this.finished = true; return; }
    const fallback = () => this.mru.find(x => !this.visible().includes(x) || x === this.primaryId) ?? this.tabs[0].id;
    if (this.primaryId === id) this.primaryId = this.split && this.secondaryId !== id ? this.secondaryId : fallback();
    if (this.secondaryId === id || this.primaryId === this.secondaryId) { this.secondaryId = null; this.split = false; }
    if (this.activeId === id) this.activeId = this.primaryId;
  }
  ops(op, origin) { return this.log.filter(entry => entry.op === op && (!origin || entry.origin === origin)); }
}

// capability: 'true' (native exposes workspaceEnabled()===true), 'false' (method present, returns false), 'absent' (old fake/legacy harness: no method)
const STUB = capability => `
(() => {
  window.__ops = [];
  window.OfflineNative = {postMessage(message) {
    const {id, op, args} = JSON.parse(message); window.__ops.push({op, args});
    window.__nativePost(op, JSON.stringify(args ?? {})).then(reply => window.NativeReply(id, JSON.parse(reply)));
  }${capability === 'absent' ? '' : `, workspaceEnabled() { return ${capability === 'true'}; }`}};
})();`;

const FAKE_PAGE = menu => `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>fake studio</title>
<style>
:root{--color-bg-light:#f1f3f6;--ui-border-light:#c4c9d2;--font-size-md:13px;--radius-sm:3px;--color-text-muted:#555;--accent-hover:#6b8fd6;--ui-accent-bg:#e8effc;--color-primary-dark:#2a55b8}
body{margin:0;font-family:system-ui}
${menu.css}
.modal-overlay{position:fixed;inset:0;background:#0003}
</style></head><body>
${menu.html}
<div id="sb-message"></div><textarea id="editor" rows="3"></textarea>
<script>
window.__studio = Object.assign({dirty:false, name:'', has:true, confirmResult:true, executed:[], confirmCalls:0, confirmDelay:0, executeResult:{ok:true}, executeDelay:40}, window.__studioInit || {});
window.rhwpStudio = {
  fonts:{setProvider(){},getState(){return {}}},
  // like the real automation host the command may be dispatched LATER (readiness/middleware), after execute() has already returned a promise
  automation:{async execute(id, params, options){
    await new Promise(r => setTimeout(r, window.__studio.executeDelay));
    window.__studio.executed.push({id, params, options});
    if (id === 'file:open' && window.__studio.executeResult.ok) Promise.resolve().then(() => window.showOpenFilePicker()).catch(() => {});
    return window.__studio.executeResult;
  }},
  android:{
    getState(){const s=window.__studio; return {hasDocument:s.has, fileName:s.name, dirty:s.dirty, encrypted:false, format:'hwp', fileHandle:null};},
    async confirmClose(){const s=window.__studio; s.confirmCalls++; if(s.confirmDelay) await new Promise(r=>setTimeout(r,s.confirmDelay)); return s.confirmResult;},
    async flushRecovery(){return {ok:true}},
    setSaveGuard(){},
  },
};
</script></body></html>`;

function menuFromStudio() {
  // Use Studio's real menu markup + CSS when the patched source is available, so heights/placement are measured on the real row.
  if (!studioSkip) {
    const index = fs.readFileSync(path.join(studioSrc, 'index.html'), 'utf8');
    const html = /<nav id="menu-bar"[\s\S]*?<\/nav>/.exec(index)?.[0];
    const css = ['menu-bar.css', 'responsive.css'].map(name => fs.readFileSync(path.join(studioSrc, 'src/styles', name), 'utf8')).join('\n');
    if (html) return {html, css};
  }
  const titles = ['파일', '편집', '보기', '입력', '서식', '쪽', '표', '도구'];
  return {
    html: `<nav id="menu-bar" aria-label="주 메뉴">${titles.map((title, i) => `<div class="menu-item" data-menu="${['file', 'edit', 'view', 'insert', 'format', 'page', 'table', 'tool'][i]}"><span class="menu-title">${title}</span></div>`).join('')}<button type="button" id="toolbox-basic-toggle" class="menu-command menu-toolbox-toggle active" aria-label="기본 도구 상자 접기"></button></nav>`,
    css: '#menu-bar{display:flex;align-items:center;padding:0 8px;height:28px;flex-shrink:0;background:var(--color-bg-light)}.menu-item{flex:0 0 auto}.menu-title{display:block;padding:0 14px}.menu-toolbox-toggle{width:24px;height:22px;margin-left:auto;flex:0 0 24px}',
  };
}

/** One WebView-like view of a tab: its own page, own selfId, own host. */
async function openView(native, tabId, {target = 'fake', width = 1280, height = 800, capability = native.workspace ? 'true' : 'absent', init = ''} = {}) {
  const context = await browser.newContext({viewport: {width, height}});
  const page = await context.newPage();
  const errors = [], consoleErrors = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  await page.exposeFunction('__nativePost', async (op, json) => {
    try { return JSON.stringify({ok: true, data: await native.handle(tabId, op, JSON.parse(json))}); }
    catch (error) { return JSON.stringify({ok: false, error: String(error?.message || error)}); }
  });
  await page.route('**/android-fonts.mjs', route => route.fulfill({contentType: 'text/javascript', body: 'export async function installAndroidFonts(){return {refresh(){}}}'}));
  await page.route('**/workspace-tabs.mjs', route => route.fulfill({contentType: 'text/javascript', body: read('workspace-tabs.mjs')}));
  await page.addInitScript(STUB(capability) + init + read('studio-host.js'));
  if (target === 'fake') {
    await page.route('http://fake.test/index.html', route => route.fulfill({contentType: 'text/html', body: FAKE_PAGE(menuFromStudio())}));
    await page.goto('http://fake.test/index.html');
    await page.waitForFunction('!!window.rhwpStudio?.android && window.AndroidStudioHost?.startupState === "ready"');
  } else {
    await page.goto(studioUrl + '/index.html');
    await page.waitForFunction('!!window.rhwpStudio?.android', null, {timeout: 90000});
  }
  const view = {
    tabId, page, errors, consoleErrors, context,
    emit: (name, data) => page.evaluate(([n, d]) => window.NativeEvent(n, d), [name, data]),
    callClose: token => page.evaluate(token => { void window.AndroidWorkspaceCloseRequest(token); }, token),
    strip: () => page.locator('#menu-bar .ws-tabs'),
    tab: id => page.locator(`#menu-bar .ws-tabwrap[data-tab-id="${id}"]`),
    order: () => page.$$eval('#menu-bar .ws-tabwrap', nodes => nodes.map(node => node.dataset.tabId)),
    close: () => context.close(),
  };
  native.views.set(tabId, view);
  return view;
}
async function until(fn, message, timeout = 8000) {
  const end = Date.now() + timeout; let last;
  for (;;) { last = await fn(); if (last) return last; if (Date.now() > end) assert.fail('timeout: ' + message); await new Promise(resolve => setTimeout(resolve, 50)); }
}
async function startWorkspace({target = 'fake', width = 1280, views = 1, workspace = true, maxTabs = 5, capability, init} = {}) {
  const native = new FakeNative({workspace, maxTabs});
  const first = native.add(null);
  const opened = [await openView(native, first, {target, width, capability, init})];
  if (workspace) await until(() => opened[0].page.$('#menu-bar .ws-tabs'), 'strip rendered').catch(async error => { throw new Error(error.message + ' | pageerrors=' + JSON.stringify(opened[0].errors) + ' console=' + JSON.stringify(opened[0].consoleErrors) + ' ops=' + JSON.stringify(native.log.map(entry => entry.op))); });
  if (views > 1) {
    native.onTabAdded = null;
    const id = native.add(first); native.split = true; native.secondaryId = id; native.primaryId = first; native.activeId = first;
    opened.push(await openView(native, id, {target, width, capability}));
    await native.broadcast();
  }
  return {native, views: opened, close: async () => { for (const view of opened.concat([...native.views.values()])) await view.close().catch(() => {}); }};
}
const withWorkspace = (name, options, fn, skip = browserSkip) => test(name, {skip, timeout: 180000}, async () => {
  const world = await startWorkspace(options);
  try { await fn(world); } finally { await world.close(); }
});

// ───────────────────────────── scenarios: legacy host ─────────────────────────────
for (const capability of ['absent', 'false']) {
  withWorkspace(`legacy host (workspaceEnabled ${capability === 'absent' ? 'method absent' : 'returns false'}): no strip, no workspace op of any kind, no unhandled errors, original menu row intact`, {workspace: false, capability}, async ({native, views: [view]}) => {
    await view.page.waitForTimeout(1000);
    assert.equal(await view.page.locator('.ws-tabs').count(), 0);
    assert.equal(await view.page.evaluate('window.AndroidStudioHost.workspace.enabled'), false);
    assert.equal(await view.page.evaluate('typeof window.AndroidWorkspaceCloseRequest'), 'undefined');
    assert.deepEqual(view.errors, []);
    assert.deepEqual(view.consoleErrors.filter(text => /workspace/i.test(text)), []);
    assert.equal(await view.page.evaluate(() => document.querySelector('#menu-bar .menu-item[data-menu="tool"]').nextElementSibling.id), 'toolbox-basic-toggle');
    assert.equal(await view.page.evaluate(() => window.AndroidStudioHost.workspace.newDocument()), false, 'disabled workspace never handles commands');
    assert.equal(await view.page.evaluate(() => window.AndroidStudioHost.workspace.openRecent('a'.repeat(64))), false);
    assert.deepEqual(native.log.filter(entry => /^workspace/.test(entry.op)), [], 'no workspace op (not even workspaceReady) reaches a legacy native');
    assert.deepEqual((await view.page.evaluate('window.__ops')).filter(entry => /^workspace/.test(entry.op)), []);
  });
}

withWorkspace('capable native but failed handshake: fails closed with a notice, routing stays on, the current document is never replaced', {workspace: false, capability: 'true'}, async ({native, views: [view]}) => {
  await view.page.waitForSelector('dialog.android-host-dialog[open] .android-host-error', {state: 'attached'});
  assert.match(await view.page.textContent('dialog.android-host-dialog h2'), /작업을 완료하지 못했어요/);
  assert.match(await view.page.textContent('dialog.android-host-dialog .android-host-error'), /현재 문서를 바꾸지 않아요/);
  assert.equal(await view.page.locator('.ws-tabs').count(), 0);
  assert.equal(await view.page.evaluate('window.AndroidStudioHost.workspace.enabled'), true, 'capability is not downgraded to legacy in-place');
  await view.page.evaluate(() => window.AppBack()); // dismiss the notice
  assert.equal(await view.page.evaluate(() => window.AndroidStudioHost.workspace.newDocument()), true, 'handled (never falls back to legacy replacement)');
  assert.equal(await view.page.evaluate(() => window.AndroidStudioHost.workspace.openDocument()), true);
  assert.ok(native.ops('workspaceNew').length === 2, 'the host still asks native (which refuses here) instead of replacing in place');
  assert.deepEqual(await view.page.evaluate('window.__studio.executed'), [], 'no in-place command was run');
});

// ───────────────────────────── scenarios: placement ─────────────────────────────
for (const [target, skip] of [['fake', browserSkip], ['studio', studioSkip]]) {
  for (const width of [1920, 1280, 900, 960, 640]) {
    test(`placement (${target}, ${width}px pane): strip sits in the existing menu row after Tools, before the toolbox toggle, with no extra height`, {skip, timeout: 240000}, async t => {
      const baseline = await startWorkspace({target, width, workspace: false});
      let barHeight, barScrollBaseline;
      try { await baseline.views[0].page.waitForTimeout(600); [barHeight, barScrollBaseline] = await baseline.views[0].page.evaluate(() => { const bar = document.getElementById('menu-bar'); return [bar.getBoundingClientRect().height, [bar.scrollWidth, bar.clientWidth, bar.scrollHeight, bar.clientHeight]]; }); } finally { await baseline.close(); }
      const world = await startWorkspace({target, width});
      try {
        const {page} = world.views[0];
        // many long-titled tabs: only the strip may scroll
        for (let i = 0; i < 7; i++) world.native.add(null);
        world.native.tabs.forEach((tab, i) => { tab.title = '아주 긴 문서 이름 ' + i + ' '.padEnd(60, '가'); });
        await world.native.broadcast();
        await until(async () => (await world.views[0].order()).length === 8, '8 tabs rendered');
        const geometry = await page.evaluate(() => {
          const bar = document.getElementById('menu-bar'), strip = bar.querySelector('.ws-tabs'), list = bar.querySelector('.ws-tablist'), tool = bar.querySelector('.menu-item[data-menu="tool"]');
          const rect = node => { const r = node.getBoundingClientRect(); return {left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height}; };
          return {bar: rect(bar), strip: rect(strip), list: rect(list), tool: rect(tool), toggle: rect(document.getElementById('toolbox-basic-toggle')),
            prev: strip.previousElementSibling === tool, next: strip.nextElementSibling?.id, barScroll: [bar.scrollWidth, bar.clientWidth, bar.scrollHeight, bar.clientHeight],
            listOverflows: list.scrollWidth > list.clientWidth, tabs: [...bar.querySelectorAll('.ws-tabwrap, .ws-btn')].map(rect), actions: [...bar.querySelectorAll('.ws-btn')].map(rect), children: bar.children.length};
        });
        t.diagnostic(`${target}@${width}: strip ${Math.round(geometry.strip.width)}px (tablist ${Math.round(geometry.list.width)}px, 8 tabs), row ${geometry.bar.height}px`);
        assert.ok(geometry.prev, 'immediately after the Tools menu'); assert.equal(geometry.next, 'toolbox-basic-toggle');
        assert.equal(geometry.bar.height, barHeight, 'menu row height unchanged');
        assert.deepEqual([geometry.barScroll[2], geometry.barScroll[3]], [barScrollBaseline[2], barScrollBaseline[3]], 'menu row scroll/client height identical to the legacy row ' + JSON.stringify(geometry));
        assert.ok(geometry.strip.left >= geometry.tool.right - 0.5 && geometry.strip.right <= geometry.toggle.left + 0.5, 'strip lies between Tools and the toggle');
        assert.ok(geometry.strip.top >= geometry.bar.top - 0.5 && geometry.strip.bottom <= geometry.bar.bottom + 0.5, 'strip inside the single row');
        for (const box of geometry.tabs) assert.ok(box.top >= geometry.bar.top - 0.5 && box.bottom <= geometry.bar.bottom + 0.5, 'tab/button inside the row');
        assert.ok(geometry.barScroll[0] <= Math.max(geometry.barScroll[1], barScrollBaseline[0]) + 1, 'the menu row itself gains no horizontal overflow');
        assert.ok(geometry.list.width <= geometry.strip.width + 0.5);
        assert.ok(geometry.strip.width > 0, 'strip takes the remaining width');
        assert.ok(geometry.list.width <= geometry.strip.width + 0.5, 'any overflow stays inside the strip scroller');
        assert.deepEqual(world.views[0].errors, []);
      } finally { await world.close(); }
    });
  }
}

// ───────────────────────────── scenarios: two views, sync, badges, tooltips ─────────────────────────────
withWorkspace('two views show the same global tabs in the same order with self/active/visible badges and update together', {views: 2}, async ({native, views: [a, b]}) => {
  await until(async () => (await a.order()).length === 2 && (await b.order()).length === 2, 'both strips synced');
  assert.deepEqual(await a.order(), await b.order());
  const flags = async view => view.page.$$eval('#menu-bar .ws-tabwrap', nodes => nodes.map(n => ({id: n.dataset.tabId, self: n.dataset.self, active: n.dataset.active, visible: n.dataset.visible})));
  const fa = await flags(a), fb = await flags(b);
  assert.deepEqual(fa.filter(x => x.self === 'true').map(x => x.id), [a.tabId]); assert.deepEqual(fb.filter(x => x.self === 'true').map(x => x.id), [b.tabId]);
  assert.ok(fa.every(x => x.visible === 'true'), 'both docs are visible'); assert.deepEqual(fa.filter(x => x.active === 'true').map(x => x.id), [a.tabId]);
  // third tab from view B's '+': hidden tab replaces B's pane (origin pane), A's doc untouched
  await b.page.click('#menu-bar .ws-btn[data-ws-action="new"]');
  await until(async () => (await a.order()).length === 3, 'third tab on both strips');
  assert.equal(native.secondaryId, native.tabs[2].id); assert.equal(native.primaryId, a.tabId);
  assert.equal(await a.page.locator('#menu-bar .ws-tabwrap[data-visible="false"]').count(), 1, 'the replaced tab is now hidden but still listed');
  // split button tooltip + pressed state follow the snapshot in both views
  assert.equal(await a.page.getAttribute('.ws-btn[data-ws-action="split"]', 'aria-pressed'), 'true');
  assert.equal(await a.page.getAttribute('.ws-btn[data-ws-action="split"]', 'title'), '한 문서만 보기');
  await a.page.click('.ws-btn[data-ws-action="split"]');
  await until(async () => (await b.page.getAttribute('.ws-btn[data-ws-action="split"]', 'aria-pressed')) === 'false', 'collapse reaches the other view');
  assert.equal(await b.page.getAttribute('.ws-btn[data-ws-action="split"]', 'title'), '두 문서 나란히 보기');
  assert.equal(native.tabs.length, 3, 'collapsing keeps every tab');
  // tooltips on the other controls
  assert.match(await a.page.getAttribute('.ws-btn[data-ws-action="new"]', 'title'), /새 문서 탭/);
  assert.match(await a.page.getAttribute('.ws-btn[data-ws-action="open"]', 'title'), /새 탭에서 열기/);
  assert.deepEqual([...a.errors, ...b.errors], []);
});

withWorkspace('tab count cap: + and open are disabled at the limit with the Korean message and never reach native', {maxTabs: 2, views: 2}, async ({native, views: [a]}) => {
  await until(async () => (await a.order()).length === 2, 'two tabs');
  assert.equal(await a.page.getAttribute('.ws-btn[data-ws-action="new"]', 'aria-disabled'), 'true');
  assert.match(await a.page.getAttribute('.ws-btn[data-ws-action="new"]', 'title'), /최대 2개/);
  const before = native.ops('workspaceNew').length;
  await a.page.click('.ws-btn[data-ws-action="new"]', {force: true}); await a.page.click('.ws-btn[data-ws-action="open"]', {force: true});
  assert.equal(native.ops('workspaceNew').length, before);
  assert.match(await a.page.textContent('#sb-message'), /최대 2개/);
});

withWorkspace('titles are text only: markup in a title never becomes an element', {}, async ({native, views: [view]}) => {
  native.tabs[0].title = '<img src=x onerror="window.__xss=1"><b>굵게</b>'; await native.broadcast();
  await until(async () => (await view.page.textContent('#menu-bar .ws-tab .ws-title')).includes('<img'), 'title rendered');
  assert.equal(await view.page.locator('#menu-bar .ws-tabs img, #menu-bar .ws-tabs b').count(), 0);
  assert.equal(await view.page.evaluate('window.__xss'), undefined);
  assert.equal(await view.page.locator('iframe').count(), 0);
});

// ───────────────────────────── scenarios: drag reorder ─────────────────────────────
for (const [target, skip] of [['fake', browserSkip], ['studio', studioSkip]]) withWorkspace(`drag reorders only the global order (${target}): real mouse drag, private MIME, drop indicator, native move, views/data/visible assignments preserved`, {views: 2, target}, async ({native, views: [a, b]}) => {
  for (let i = 0; i < 2; i++) { const id = native.add(null); native.onTabAdded?.(id); }
  native.tabs[0].dirty = true; native.tabs[1].title = '두번째'; await native.broadcast();
  await until(async () => (await a.order()).length === 4, 'four tabs');
  const [t0, t1, t2, t3] = native.tabs.map(tab => tab.id);
  const state = () => JSON.stringify([native.activeId, native.primaryId, native.secondaryId, native.split, native.tabs.map(tab => [tab.id, tab.title, tab.dirty])]);
  const before = JSON.parse(state());
  await a.page.evaluate(() => { window.__drag = []; document.addEventListener('dragstart', event => { window.__drag.push({types: [...event.dataTransfer.types], plain: event.dataTransfer.getData('text/plain')}); }, false); });
  // indicator while hovering, then drop t3 before t1
  const box = async (view, id) => (await view.tab(id).boundingBox());
  const source = await box(a, t3), over = await box(a, t1);
  await a.page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await a.page.mouse.down();
  await a.page.mouse.move(over.x + 10, over.y + over.height / 2, {steps: 8});
  await a.page.mouse.move(over.x + 8, over.y + over.height / 2, {steps: 2});
  assert.equal(await a.page.locator('#menu-bar .ws-tabwrap.drop-before, #menu-bar .ws-tabwrap.drop-after').count(), 1, 'one drop indicator is shown');
  assert.equal(await a.tab(t1).evaluate(node => node.classList.contains('drop-before')), true, 'indicator before the hovered tab');
  await a.page.mouse.up();
  await until(async () => JSON.stringify(await a.order()) === JSON.stringify([t0, t3, t1, t2]), 'tab moved before t1 in view A');
  await until(async () => JSON.stringify(await b.order()) === JSON.stringify([t0, t3, t1, t2]), 'and in view B');
  assert.deepEqual(native.ops('workspaceMove').map(entry => entry.args), [{id: t3, beforeId: t1}]);
  const drag = await a.page.evaluate('window.__drag');
  assert.deepEqual(drag, [{types: [TAB_MIME], plain: ''}], 'only the private MIME is on the drag, never text/plain');
  assert.equal(await a.page.locator('#menu-bar .drop-before, #menu-bar .drop-after, #menu-bar .is-dragging').count(), 0, 'indicator cleared');
  const after = JSON.parse(state());
  assert.deepEqual([after[0], after[1], after[2], after[3]], [before[0], before[1], before[2], before[3]], 'active/primary/secondary/split untouched');
  assert.deepEqual(after[4].map(x => x.slice(1)).sort(), before[4].map(x => x.slice(1)).sort(), 'titles/dirty (document data) untouched');
  assert.deepEqual([...a.errors, ...b.errors], []);
}, skip);

withWorkspace('drag edge cases: drop on the same slot, onto the editor, stale/empty payloads and cancel send nothing and move nothing', {views: 2}, async ({native, views: [a]}) => {
  const id = native.add(null); await native.broadcast();
  await until(async () => (await a.order()).length === 3, 'three tabs');
  const ids = native.tabs.map(tab => tab.id), moves = () => native.ops('workspaceMove').length;
  const drop = (payload, target = '#menu-bar .ws-tablist') => a.page.evaluate(([payload, target]) => {
    const node = document.querySelector(target), data = new DataTransfer();
    if (payload !== null) data.setData('application/x-hwpxxx-workspace-tab', payload);
    const rect = node.getBoundingClientRect();
    for (const type of ['dragover', 'drop']) node.dispatchEvent(new DragEvent(type, {bubbles: true, cancelable: true, dataTransfer: data, clientX: rect.right - 2, clientY: rect.top + 5}));
  }, [payload, target]);
  await drop('00000000-0000-0000-0000-00000000dead'); await drop(''); await drop(null); await drop('../../etc/passwd');
  assert.equal(moves(), 0, 'stale, empty and malformed payloads are ignored');
  // a tab dragged over the editor must not reach editor/Studio handlers and must not change text
  const editorBefore = await a.page.inputValue('#editor').catch(() => '');
  await a.page.evaluate(([mime, ids]) => { window.__editorDrops = 0; document.getElementById('editor')?.addEventListener('drop', () => { window.__editorDrops++; }); const data = new DataTransfer(); data.setData(mime, ids[0]); document.getElementById('editor')?.dispatchEvent(new DragEvent('drop', {bubbles: true, cancelable: true, dataTransfer: data})); }, [TAB_MIME, ids]);
  assert.equal(await a.page.evaluate('window.__editorDrops'), 0, 'tab drops are swallowed before reaching the editor');
  assert.equal(await a.page.inputValue('#editor').catch(() => ''), editorBefore);
  assert.equal(moves(), 0);
  // dragging the first tab onto its own position is a no-op
  const t0 = await a.tab(ids[0]).boundingBox();
  await a.page.mouse.move(t0.x + t0.width / 2, t0.y + t0.height / 2); await a.page.mouse.down();
  await a.page.mouse.move(t0.x + t0.width / 2 + 3, t0.y + t0.height / 2, {steps: 3}); await a.page.mouse.up();
  await a.page.waitForTimeout(300);
  assert.equal(moves(), 0, 'dropping on its own slot does not call native');
  assert.equal(await a.page.locator('#menu-bar .drop-before, #menu-bar .drop-after').count(), 0);
  void id;
});

// ───────────────────────────── scenarios: keyboard ─────────────────────────────
withWorkspace('keyboard: roving tabindex/ARIA, Enter selects, Ctrl+Tab cycles, Ctrl+T opens a blank tab, Ctrl+W asks the close flow', {views: 2}, async ({native, views: [a, b]}) => {
  const id3 = native.add(null); await native.broadcast();
  await until(async () => (await a.order()).length === 3, 'three tabs');
  const roles = await a.page.$$eval('#menu-bar [role=tab]', nodes => nodes.map(n => ({sel: n.getAttribute('aria-selected'), tab: n.tabIndex, label: n.getAttribute('aria-label')})));
  assert.equal(roles.filter(r => r.tab === 0).length, 1, 'exactly one tab stop (roving tabindex)');
  assert.equal(roles.filter(r => r.sel === 'true').length, 1);
  assert.ok(roles.every(r => r.label), 'every tab has an accessible name');
  assert.equal(await a.page.getAttribute('#menu-bar [role=tablist]', 'aria-orientation'), 'horizontal');
  // arrows move focus (not selection); Enter selects
  await a.page.focus('#menu-bar .ws-tab[tabindex="0"]');
  await a.page.keyboard.press('ArrowRight');
  const focused = await a.page.evaluate(() => document.activeElement.dataset.tabId);
  assert.equal(focused, native.tabs[1].id);
  assert.equal(native.activeId, a.tabId, 'moving focus does not select');
  await a.page.keyboard.press('End');
  assert.equal(await a.page.evaluate(() => document.activeElement.dataset.tabId), id3);
  await a.page.keyboard.press('Enter');
  await until(() => native.activeId === id3 && native.ops('workspaceSelect', a.tabId).length === 1, 'Enter selects the focused tab');
  // Ctrl+Tab / Ctrl+Shift+Tab from the focused editor
  await a.page.focus('#editor');
  await a.page.keyboard.press('Control+Tab');
  await until(() => native.ops('workspaceSelect', a.tabId).length === 2, 'Ctrl+Tab selects next');
  assert.equal(native.ops('workspaceSelect', a.tabId)[1].args.id, native.tabs[1].id, 'next after self (index 0) is index 1');
  await a.page.keyboard.press('Control+Shift+Tab');
  assert.equal(native.ops('workspaceSelect', a.tabId)[2].args.id, id3, 'previous before self wraps to last');
  // Ctrl+T: blank tab
  const created = native.tabs.length;
  await a.page.keyboard.press('Control+t');
  await until(() => native.tabs.length === created + 1 && native.ops('workspaceNew', a.tabId).at(-1).args.open === false, 'Ctrl+T makes a blank tab');
  // typing is not broken
  await a.page.focus('#editor'); await a.page.keyboard.type('안녕 abc');
  assert.equal(await a.page.inputValue('#editor'), '안녕 abc');
  // composition: never hijacked
  const during = native.ops('workspaceClose').length;
  await a.page.evaluate(() => document.getElementById('editor').dispatchEvent(new KeyboardEvent('keydown', {key: 'w', ctrlKey: true, isComposing: true, keyCode: 229, bubbles: true, cancelable: true})));
  await a.page.waitForTimeout(150);
  assert.equal(native.ops('workspaceClose').length, during, 'Ctrl+W during IME composition is ignored');
  // a modal dialog blocks the shortcuts
  await a.page.evaluate(() => { const overlay = document.createElement('div'); overlay.className = 'modal-overlay'; document.body.append(overlay); });
  await a.page.keyboard.press('Control+t'); await a.page.waitForTimeout(150);
  assert.equal(native.tabs.length, created + 1, 'Ctrl+T ignored while a modal is open');
  await a.page.evaluate(() => document.querySelector('.modal-overlay').remove());
  // Ctrl+W: native close flow with this tab as target, confirmClose consulted (clean => allow)
  await a.page.focus('#editor'); await a.page.keyboard.press('Control+w');
  await until(() => native.ops('workspaceClose', a.tabId).length === 1 && native.ops('workspaceCloseResult', a.tabId).length === 1, 'Ctrl+W round trip');
  assert.deepEqual(native.ops('workspaceClose', a.tabId)[0].args, {id: a.tabId});
  assert.equal(native.ops('workspaceCloseResult', a.tabId)[0].args.allow, true);
  assert.equal(native.tabs.some(tab => tab.id === a.tabId), false, 'closed after allow');
  void b;
});

// ───────────────────────────── scenarios: close request / state / focus ─────────────────────────────
withWorkspace('workspace AppBack delegates one native close guard: cancel keeps all, discard closes only origin without a second prompt', {views: 2}, async ({native, views: [a, b]}) => {
  await a.page.evaluate(() => { window.__studio.dirty = true; window.__studio.confirmResult = false; });
  await a.page.evaluate(() => window.AppBack());
  assert.equal(await a.page.evaluate('window.__studio.confirmCalls'), 1, 'cancel consults Core exactly once via the native token flow');
  assert.equal(native.tabs.length, 2, 'cancel preserves both documents');
  await a.page.evaluate(() => { window.__studio.confirmResult = true; });
  await a.page.evaluate(() => window.AppBack());
  assert.equal(await a.page.evaluate('window.__studio.confirmCalls'), 2, 'discard consults Core once more, never twice');
  assert.deepEqual(native.tabs.map(tab => tab.id), [b.tabId], 'only the originating document closes');
  assert.equal(native.ops('exit', a.tabId).length, 2);
  assert.equal(native.ops('workspaceCloseResult', b.tabId).length, 0, 'the other document never receives a close request');
});

withWorkspace('close request: matching confirmClose answer, dirty+cancel keeps the tab, dialog/busy/duplicate/malformed tokens are safe', {views: 2}, async ({native, views: [a, b]}) => {
  await a.page.evaluate(() => { window.__studio.dirty = true; window.__studio.confirmResult = false; });
  // native asks B's tab to close; B's studio denies
  b.page.evaluate(() => { window.__studio.confirmResult = false; });
  await native.handle(a.tabId, 'workspaceClose', {id: b.tabId});
  assert.equal(native.tabs.some(tab => tab.id === b.tabId), true, 'cancel keeps the tab (no discard)');
  assert.equal(await b.page.evaluate('window.__studio.confirmCalls'), 1);
  assert.equal(native.ops('workspaceCloseResult', b.tabId).at(-1).args.allow, false);
  // duplicate/malformed tokens
  const results = () => native.ops('workspaceCloseResult', b.tabId).length;
  const count = results();
  await b.page.evaluate(() => { void window.AndroidWorkspaceCloseRequest('x y'); void window.AndroidWorkspaceCloseRequest({}); void window.AndroidWorkspaceCloseRequest('a'.repeat(300)); });
  await b.page.waitForTimeout(200); assert.equal(results(), count, 'malformed tokens get no answer');
  await b.page.evaluate(() => { void window.AndroidWorkspaceCloseRequest('dup-1'); void window.AndroidWorkspaceCloseRequest('dup-1'); });
  await b.page.waitForTimeout(300); assert.equal(results(), count + 1, 'a token is answered once');
  // an open host dialog refuses (never discards behind a modal)
  await b.page.evaluate(() => { window.__studio.confirmResult = true; window.showOpenFilePicker().catch(() => {}); });
  await b.page.waitForSelector('dialog.android-host-dialog[open]');
  const calls = await b.page.evaluate('window.__studio.confirmCalls');
  await b.page.evaluate(() => { void window.AndroidWorkspaceCloseRequest('while-dialog'); });
  await until(() => native.log.some(entry => entry.op === 'workspaceCloseResult' && entry.args.token === 'while-dialog'), 'answered while dialog');
  assert.equal(native.log.find(entry => entry.args?.token === 'while-dialog').args.allow, false);
  assert.equal(await b.page.evaluate('window.__studio.confirmCalls'), calls, 'confirmClose is not even asked while a host dialog is open');
});

withWorkspace('document state: one workspaceUpdate per real change, none while idle; focus is debounced and only when not active', {views: 2}, async ({native, views: [a, b]}) => {
  await until(() => native.ops('workspaceUpdate', a.tabId).length >= 1, 'initial state reported');
  await a.page.waitForTimeout(1500);
  const idle = native.ops('workspaceUpdate').length;
  await a.page.waitForTimeout(1500);
  assert.equal(native.ops('workspaceUpdate').length, idle, 'steady state sends no updates (no per-frame flood)');
  await a.page.evaluate(() => { window.__studio.dirty = true; });
  await until(() => native.ops('workspaceUpdate', a.tabId).at(-1).args.dirty === true, 'dirty reported');
  await a.page.evaluate(() => { window.__studio.name = '보고서.hwp'; });
  await until(() => native.tabs.find(tab => tab.id === a.tabId).title === '보고서.hwp', 'title reported');
  const updates = native.ops('workspaceUpdate', a.tabId);
  assert.deepEqual(Object.keys(updates.at(-1).args).sort(), ['dirty', 'encrypted', 'ready', 'title']);
  await a.page.waitForTimeout(1200);
  assert.equal(native.ops('workspaceUpdate', a.tabId).length, updates.length, 'no repeat of an unchanged state');
  // the badge appears in both views
  await until(async () => (await b.page.getAttribute(`#menu-bar .ws-tabwrap[data-tab-id="${a.tabId}"]`, 'data-dirty')) === 'true', 'dirty badge synced to the other view');
  // focus: A is active => interacting with A sends nothing; interacting with B sends exactly one debounced workspaceFocus
  assert.equal(native.activeId, a.tabId);
  await a.page.focus('#editor'); await a.page.click('#editor'); await a.page.waitForTimeout(400);
  assert.equal(native.ops('workspaceFocus', a.tabId).length, 0);
  for (let i = 0; i < 5; i++) await b.page.mouse.click(300 + i, 400);
  await until(() => native.activeId === b.tabId, 'B becomes active');
  await b.page.waitForTimeout(600);
  assert.equal(native.ops('workspaceFocus', b.tabId).length, 1, 'debounced to a single request');
  assert.equal(await a.page.getAttribute(`#menu-bar .ws-tabwrap[data-tab-id="${b.tabId}"]`, 'data-active'), 'true', 'badge moved in the other view');
});

// ───────────────────────────── scenarios: initial action & routing ─────────────────────────────
withWorkspace('initial open tab: runs the core open command once in place (per-command marker, deferred automation), picker cancel tells native; recent runs once with the opaque id', {views: 1}, async ({native, views: [first]}) => {
  const openId = native.add(null, {kind: 'open'}); native.onTabAdded = null;
  const openView_ = await openView(native, openId);
  await until(() => native.ops('workspaceInitialDone', openId).length === 0 && openView_.page.evaluate('window.__studio.executed.length'), 'initial command dispatched');
  const exec = await openView_.page.evaluate('window.__studio');
  assert.deepEqual(exec.executed.map(entry => [entry.id, entry.params, entry.options]), [['file:open', {androidWorkspaceInPlace: true}, {allowDialog: true}]], 'dispatched (late, after the automation delay) with the marker that travels with the command');
  assert.equal(await openView_.page.evaluate('window.AndroidStudioHost.workspace.inPlaceAction'), undefined, 'there is no shared in-place flag');
  assert.deepEqual(native.ops('workspaceNew', openId), [], 'the child never recursively creates tabs');
  await openView_.page.waitForSelector('dialog.android-host-dialog[open]'); // the real host picker of the NEW tab
  await openView_.page.evaluate(() => window.AppBack()); // Back = cancel
  await until(() => native.ops('workspaceInitialDone', openId).length === 1, 'cancel reported');
  assert.deepEqual(native.ops('workspaceInitialDone', openId)[0].args, {cancelled: true});
  assert.equal(native.tabs.some(tab => tab.id === first.tabId), true, 'the earlier tab is untouched');
  assert.equal(native.tabs.some(tab => tab.id === openId), false, 'native dropped only the clean unused tab');
  const SHA = 'ab'.repeat(32), recentId = native.add(null, {kind: 'recent', recentId: SHA});
  const recentView = await openView(native, recentId);
  await until(() => recentView.page.evaluate('window.__studio.executed.length'), 'recent dispatched');
  const rexec = await recentView.page.evaluate('window.__studio');
  assert.deepEqual(rexec.executed.map(entry => [entry.id, entry.params]), [['file:open-recent', {id: SHA, androidWorkspaceInPlace: true}]]);
  assert.deepEqual(native.ops('workspaceOpenRecent', recentId).concat(native.ops('workspaceNew', recentId)), []);
  await recentView.page.waitForTimeout(500);
  assert.equal((await recentView.page.evaluate('window.__studio.executed.length')), 1, 'only once');
});

withWorkspace('a wrong initial action (command fails / rejects) never fans out into recursive empty tabs', {views: 1}, async ({native}) => {
  for (const executeResult of [{ok: false, message: '등록되지 않은 명령'}, {ok: false}]) {
    const before = native.tabs.length, id = native.add(null, {kind: 'open'});
    const view = await openView(native, id, {init: `window.__studioInit = {executeResult: ${JSON.stringify(executeResult)}};`});
    await until(() => view.page.evaluate('window.__studio.executed.length'), 'initial command attempted');
    await until(() => native.ops('workspaceInitialDone', id).length === 1, 'native told the open did not happen');
    await view.page.waitForTimeout(400);
    assert.deepEqual(native.ops('workspaceNew').concat(native.ops('workspaceOpenRecent')), [], 'no tab creation from a failed in-place action');
    assert.equal(native.tabs.length <= before + 1, true);
    assert.equal(await view.page.evaluate('window.__studio.executed.length'), 1, 'attempted exactly once');
  }
});

withWorkspace('host.workspace API: newDocument/openDocument/openRecent go to native; cap/invalid are announced and still "handled"', {views: 1}, async ({native, views: [a]}) => {
  assert.equal(await a.page.evaluate('window.AndroidStudioHost.workspace.enabled'), true);
  assert.equal(await a.page.evaluate(() => window.AndroidStudioHost.workspace.openDocument()), true);
  assert.deepEqual(native.ops('workspaceNew', a.tabId).at(-1).args, {open: true});
  assert.equal(await a.page.evaluate(() => window.AndroidStudioHost.workspace.newDocument()), true);
  assert.deepEqual(native.ops('workspaceNew', a.tabId).at(-1).args, {open: false});
  assert.equal(await a.page.evaluate(() => window.AndroidStudioHost.workspace.openRecent('cd'.repeat(32))), true);
  assert.deepEqual(native.ops('workspaceOpenRecent', a.tabId).at(-1).args, {recentId: 'cd'.repeat(32)});
  const count = native.ops('workspaceOpenRecent').length;
  const rejected = await a.page.evaluate(() => window.AndroidStudioHost.workspace.openRecent('../x').then(() => 'resolved', error => error.message));
  assert.match(rejected, /최근 문서/); assert.equal(native.ops('workspaceOpenRecent').length, count, 'invalid recent id never reaches native');
  assert.equal(await a.page.evaluate(() => Object.keys(window.AndroidStudioHost.workspace).sort().join()), 'enabled,newDocument,openDocument,openRecent,version', 'no controller/internal objects are exposed');
});

// real Studio: the command surface itself routes into native (needs patch 0115)
withWorkspace('REAL Studio: file:new-doc / file:open / file:open-recent from the real command registry open new tabs and leave the document alone', {target: 'studio'}, async ({native, views: [view]}) => {
  await view.page.waitForFunction('!!window.rhwpStudio?.automation && window.AndroidStudioHost.workspace.enabled === true', null, {timeout: 60000});
  await view.page.waitForTimeout(1500);
  const docBefore = await view.page.evaluate(() => JSON.stringify({...window.rhwpStudio.android.getState(), fileHandle: null}));
  const run = (id, params) => view.page.evaluate(([id, params]) => window.rhwpStudio.automation.execute(id, params, {allowDialog: true}), [id, params]);
  assert.equal((await run('file:new-doc')).ok, true);
  await until(() => native.ops('workspaceNew', view.tabId).length === 1, 'new-doc reached native');
  assert.deepEqual(native.ops('workspaceNew', view.tabId)[0].args, {open: false});
  assert.equal((await run('file:open')).ok, true);
  await until(() => native.ops('workspaceNew', view.tabId).length === 2, 'open reached native');
  assert.deepEqual(native.ops('workspaceNew', view.tabId)[1].args, {open: true});
  assert.equal(await view.page.locator('dialog.android-host-dialog[open]').count(), 0, 'no host picker/unsaved prompt in the CURRENT document');
  assert.equal(await view.page.locator('.modal-overlay').count(), 0, 'no unsaved-changes dialog');
  native.recents.push({id: 'ef'.repeat(32), fileName: 'a.hwp', sourceFormat: 'hwp', openedAt: 1, reopenable: true});
  assert.equal((await run('file:open-recent', {id: 'ef'.repeat(32)})).ok, true);
  await until(() => native.ops('workspaceOpenRecent', view.tabId).length === 1, 'open-recent reached native with the opaque id');
  assert.deepEqual(native.ops('workspaceOpenRecent', view.tabId)[0].args, {recentId: 'ef'.repeat(32)});
  assert.equal(native.ops('recentOpen').length, 0, 'the current document never opens the recent entry itself (no foreign handle into this realm)');
  assert.equal((await run('file:open-recent', {id: '12'.repeat(32)})).ok, true);
  await view.page.waitForTimeout(500);
  assert.equal(native.ops('workspaceOpenRecent', view.tabId).length, 1, 'a stale recent id does not create a tab');
  const docAfter = await view.page.evaluate(() => JSON.stringify({...window.rhwpStudio.android.getState(), fileHandle: null}));
  assert.equal(docAfter, docBefore, 'current document name/dirty/format unchanged');
  assert.deepEqual(view.errors, []);
}, studioSkip);

withWorkspace('REAL Studio: a child tab whose initial action is "open" runs the real in-place file:open once (host picker in the new tab), no recursive tabs, cancel reported', {target: 'studio'}, async ({native, views: [first]}) => {
  const id = native.add(null, {kind: 'open'});
  const child = await openView(native, id, {target: 'studio'});
  await child.page.waitForSelector('dialog.android-host-dialog[open]', {timeout: 60000}); // the real host picker, opened by Studio's own file:open
  assert.deepEqual(native.ops('workspaceNew', id), [], 'the marker keeps the real command in place: no recursive workspaceNew');
  await child.page.evaluate(() => window.AppBack());
  await until(() => native.ops('workspaceInitialDone', id).length === 1, 'cancel reported');
  assert.deepEqual(native.ops('workspaceInitialDone', id)[0].args, {cancelled: true});
  assert.equal(native.tabs.some(tab => tab.id === first.tabId), true);
  assert.equal(native.ops('workspaceNew').length, 0);
  assert.deepEqual(child.errors, []);
}, studioSkip);
