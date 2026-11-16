// Protocol tests for the REAL app/src/main/assets/studio-host.js running in Chromium against the
// strict Node OfflineNative mock in tests/preview-server.mjs (single upload slot, single draft slot,
// 2-blob read pool, SHA conflicts, extension/format policy: the same rules MainActivity enforces).
//
// WHAT THIS IS NOT: it is not Android WebView, not MainActivity/FileStore/ExportStore (those have JVM tests),
// not the real Studio editor (tests/studio-ui.py) and not a DeX device. The Studio here is a fake that implements
// only the rhwpStudio.android hook surface, so every assertion is about the host<->native boundary.
//   node --test tests/studio-host.test.mjs
import test, {before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const nodeModules = process.env.PLAYWRIGHT_NODE_MODULES || '/workspace/.cloud-setup/pr2-node/node_modules';
const {chromium} = createRequire(nodeModules + '/')('playwright');
const fixtures = f => path.join(here, 'fixtures', f);
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

let server, base, volume, browser, context, page, pageErrors, externalRequests;
const seeded = {
  'Documents/주간 업무회의록.hwp': '문서.hwp', 'Download/프로젝트 일정.hwpx': '문서.hwpx',
  'Download/업무자료/2026년 사업계획 검토 의견 최종본.hwp': 'table.hwp', 'Documents/업무 인수인계서.hwpx': 'table.hwpx', 'Download/회의 자료.hwp': 'blank.hwp',
};
const doc = rel => path.join(volume, rel);
const HWP = 'Documents/주간 업무회의록.hwp', HWPX = 'Download/프로젝트 일정.hwpx';

async function freePort() {
  return new Promise(resolve => { const s = net.createServer().listen(0, '127.0.0.1', () => { const {port} = s.address(); s.close(() => resolve(port)); }); });
}
async function control(pathAndQuery, init) { const r = await fetch(base + pathAndQuery, init); return r.headers.get('content-type')?.includes('json') ? r.json() : r.text(); }
const nativeLog = async () => (await control('/__log')).ops;

before(async () => {
  const port = await freePort();
  server = spawn('node', [path.join(here, 'preview-server.mjs'), String(port)], {cwd: root, stdio: ['ignore', 'pipe', 'inherit']});
  const line = await new Promise((resolve, reject) => {
    let buffer = ''; server.stdout.on('data', chunk => { buffer += chunk; if (buffer.includes('\n')) resolve(buffer.trim()); });
    server.on('exit', code => reject(new Error('preview server exited ' + code)));
  });
  base = `http://localhost:${port}`; volume = line.split('sandbox ')[1];
  browser = await chromium.launch({executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium', args: ['--no-sandbox']});
});
after(async () => { await browser?.close(); server?.kill(); });

async function freshPage(options = {}) {
  await context?.close();
  for (const [rel, fixture] of Object.entries(seeded)) fs.copyFileSync(fixtures(fixture), doc(rel));
  for (const dir of ['Documents', 'Download', 'Pictures']) for (const f of fs.readdirSync(doc(dir))) if (/_백업_|^qa-/.test(f)) fs.rmSync(doc(dir + '/' + f), {force: true});
  await control('/__reset'); await control('/__config?strict=1'); await control('/__grant?1');
  context = await browser.newContext({viewport: {width: 1280, height: 800}});
  page = await context.newPage(); pageErrors = []; externalRequests = [];
  page.on('pageerror', error => pageErrors.push(String(error)));
  page.on('request', request => { if (/^https?:/.test(request.url()) && !request.url().startsWith(base + '/')) externalRequests.push(request.url()); });
  if (options.clock) await page.clock.install();
  await page.goto(base + '/__harness.html');
  await page.waitForFunction(() => window.AndroidStudioHost && window.__studio.provider, null, {timeout: 15000});
  // Startup ops (fontList, listDrafts, takeOpenRequests) are not what the tests measure: wait for the last of them, then clear the log.
  for (let i = 0; i < 100 && !(await nativeLog()).some(o => o.op === 'takeOpenRequests'); i++) await new Promise(r => setTimeout(r, 50));
  await control('/__logclear');
}
beforeEach(async () => { await freshPage(); });
function assertClean() { assert.deepEqual(pageErrors, [], 'page errors'); assert.deepEqual(externalRequests, [], 'external requests'); }

// --- UI helpers for the real host dialogs (no private functions are called) ---
const dialog = () => page.locator('dialog.android-host-dialog');
async function chooseOpen(name) {
  await dialog().getByRole('searchbox', {name: '문서 이름 검색'}).fill(name);
  await dialog().locator('.android-host-list button').filter({hasText: name}).first().click();
}
// The dialog starts in the document's folder, the last save folder or Documents: walk up to the storage root so `folders` is a path from it.
async function destinationRoot() {
  const up = dialog().getByRole('button', {name: '상위 폴더'}), where = dialog().locator('.android-host-path');
  while (await up.isEnabled()) {
    const before = await where.innerText(); await up.click();
    await page.waitForFunction(text => document.querySelector('dialog.android-host-dialog .android-host-path')?.textContent !== text, before);
  }
}
async function chooseDestination({name, folders = []}) {
  await dialog().getByRole('heading', {name: '다른 이름으로 저장'}).waitFor();
  await dialog().locator('.android-host-path').filter({hasText: '/'}).waitFor();
  await destinationRoot();
  for (const folder of folders) { await dialog().locator('.android-host-list button').filter({hasText: '📁 ' + folder}).click(); await dialog().locator('.android-host-path').filter({hasText: folder}).waitFor(); }
  await dialog().getByLabel('파일 이름').fill(name);
  await dialog().getByRole('button', {name: '저장', exact: true}).click();
}
// Open a document through the real FSA adapter and keep the handle in the page (handles cannot cross evaluate()).
async function openHandle(rel, key = 'a') {
  const settled = page.evaluate(async key => { const [handle] = await showOpenFilePicker(); __h[key] = handle; return handle.name; }, key);
  await chooseOpen(path.basename(rel)); return settled;
}
const getFileInfo = (key = 'a') => page.evaluate(async key => { const file = await __h[key].getFile(); return {name: file.name, bytes: [...new Uint8Array(await file.arrayBuffer())]}; }, key);
// Save through a handle exactly as the desktop does (createWritable -> write(Blob) -> close()). Resolves {ok} | {error:{name,message}}.
const saveVia = (bytes, key = 'a') => page.evaluate(async ({bytes, key}) => {
  try { const writable = await __h[key].createWritable(); await writable.write(new Blob([new Uint8Array(bytes)])); await writable.close(); return {ok: true}; }
  catch (error) { return {error: {name: error.name, message: error.message}}; }
}, {bytes: [...bytes], key});
// A failed native write rejects close() promptly with the native message (Studio alerts once and stays dirty). The host must NOT
// raise its own modal (double report) and must NOT use AbortError/NotAllowedError, which the Studio save flow treats as a silent user cancel.
async function saveFailing(bytes, key = 'a') {
  const result = await saveVia(bytes, key);
  assert.ok(result.error, 'save must fail'); assert.equal(await dialog().count(), 0, 'no host modal on failure');
  assert.ok(!['AbortError', 'NotAllowedError'].includes(result.error.name), 'failure must not look like a user cancel: ' + result.error.name);
  return result;
}
const closeErrorDialog = async () => { await dialog().getByRole('button', {name: '닫기'}).click(); await dialog().waitFor({state: 'detached'}); };
const studioCalls = () => page.evaluate(() => ({...__studio.calls}));
async function expectHeld(n) { for (let i = 0; i < 100; i++) { if ((await control('/__log')).pendingHeld >= n) return; await new Promise(r => setTimeout(r, 50)); } assert.fail('native reply was never held'); }
async function pngBytes(width = 8, height = 8) {
  return page.evaluate(async ({width, height}) => { const c = document.createElement('canvas'); c.width = width; c.height = height; c.getContext('2d').fillRect(0, 0, width, height); return [...new Uint8Array(await (await new Promise(r => c.toBlob(r, 'image/png'))).arrayBuffer())]; }, {width, height});
}

test('open: handle yields the exact bytes of the selected document, no path leaks, native blob is released', async () => {
  const name = await openHandle(HWPX);
  assert.equal(name, '프로젝트 일정.hwpx');
  const info = await getFileInfo();
  assert.deepEqual(Buffer.from(info.bytes), fs.readFileSync(doc(HWPX)));
  const surface = await page.evaluate(() => ({keys: Object.keys(__h.a).sort(), json: JSON.stringify(Object.getOwnPropertyDescriptors(__h.a), (k, v) => typeof v === 'function' ? 'fn' : v)}));
  assert.deepEqual(surface.keys, ['createWritable', 'getFile', 'isSameEntry', 'kind', 'name', 'queryPermission', 'requestPermission']);
  assert.ok(!surface.json.includes('Download/') && !surface.json.includes(volume), 'handle must not expose storage paths');
  const ops = await nativeLog();
  assert.ok(ops.some(o => o.op === 'read') && ops.some(o => o.op === 'release'));
  assert.equal(await page.evaluate(async () => (await fetch('/document/00000000-0000-0000-0000-000000000000')).status), 403);
  assert.deepEqual(await studioCalls(), {flush: 0, notifySaved: 0, close: 0});
  assertClean();
});

test('open: native read failure rejects getFile with the native message and the next read works', async () => {
  await openHandle(HWP);
  await control('/__fail?op=read&message=' + encodeURIComponent('읽기 시험 실패'));
  const failed = await page.evaluate(async () => { try { await __h.a.getFile(); return 'resolved'; } catch (error) { return error.message; } });
  assert.equal(failed, '읽기 시험 실패');
  const info = await getFileInfo();
  assert.deepEqual(Buffer.from(info.bytes), fs.readFileSync(doc(HWP)));
});

test('save same file: conditional write with the opened SHA, original backup, new baseline, notifySaved NOT called by host', async () => {
  const original = fs.readFileSync(doc(HWP)); await openHandle(HWP);
  await getFileInfo();
  const edited = Buffer.concat([original, Buffer.from('edit-1')]);
  assert.deepEqual(await saveVia(edited), {ok: true});
  assert.deepEqual(fs.readFileSync(doc(HWP)), edited);
  const backups = fs.readdirSync(doc('Documents')).filter(f => f.includes('_백업_'));
  assert.equal(backups.length, 1); assert.deepEqual(fs.readFileSync(doc('Documents/' + backups[0])), original, 'backup must hold the ORIGINAL bytes');
  const begin = (await nativeLog()).find(o => o.op === 'beginSave');
  assert.equal(begin.args.replace, true); assert.equal(begin.args.studio, true); assert.equal(begin.args.sha, sha(original));
  assert.equal(begin.args.format, 'hwp'); assert.equal(begin.args.length, edited.length); assert.ok(begin.args.target.endsWith(HWP));
  // The second save must use the first save's hash as its baseline (otherwise a real conflict could slip through or a legit save fail).
  const edited2 = Buffer.concat([edited, Buffer.from('edit-2')]);
  assert.deepEqual(await saveVia(edited2), {ok: true});
  assert.deepEqual(fs.readFileSync(doc(HWP)), edited2);
  assert.equal((await nativeLog()).filter(o => o.op === 'beginSave')[1].args.sha, sha(edited));
  assert.equal((await studioCalls()).notifySaved, 0, 'only the desktop completeHandleSave may mark the document clean');
  assertClean();
});

test('conflict: external change after open is refused, disk keeps the other app\'s bytes, baseline does not silently advance', async () => {
  await openHandle(HWPX); await getFileInfo();
  const external = Buffer.from('changed by another app'); fs.writeFileSync(doc(HWPX), external);
  const result = await saveFailing(Buffer.from('my edit that must not overwrite'));
  assert.match(result.error.message, /다른 앱/);
  assert.deepEqual(fs.readFileSync(doc(HWPX)), external);
  assert.equal(fs.readdirSync(doc('Download')).filter(f => f.includes('_백업_')).length, 0, 'no backup/partial output on refusal');
  const again = await saveFailing(Buffer.from('retry')); // still a conflict: the host must not re-baseline by itself
  assert.deepEqual(fs.readFileSync(doc(HWPX)), external);
  assert.equal((await studioCalls()).notifySaved, 0); assertClean();
});

test('failed native write rejects with the native message (not a user-cancel error), keeps the original, releases the slot for a retry', async () => {
  const original = fs.readFileSync(doc(HWP)); await openHandle(HWP); await getFileInfo();
  await control('/__fail?op=finishSave&message=' + encodeURIComponent('디스크가 가득 찼어요'));
  const result = await saveFailing(Buffer.concat([original, Buffer.from('x')]));
  assert.match(result.error.message, /디스크가 가득/);
  assert.deepEqual(fs.readFileSync(doc(HWP)), original);
  const retry = Buffer.concat([original, Buffer.from('retry')]); assert.deepEqual(await saveVia(retry), {ok: true});
  assert.deepEqual(fs.readFileSync(doc(HWP)), retry);
});

test('failure BEFORE finish (chunk upload) aborts the native session so a later save is not blocked by the single upload slot', async () => {
  const original = fs.readFileSync(doc(HWP)); await openHandle(HWP); await getFileInfo();
  await control('/__fail?op=saveChunk&message=' + encodeURIComponent('조각 실패'));
  await saveFailing(Buffer.concat([original, Buffer.from('x')]));
  assert.ok((await nativeLog()).some(o => o.op === 'abortSave'));
  const retry = Buffer.concat([original, Buffer.from('ok')]); assert.deepEqual(await saveVia(retry), {ok: true});
  assert.deepEqual(fs.readFileSync(doc(HWP)), retry);
});

test('chunked upload: a >192 KiB document arrives in order, every chunk within the native limit, bytes identical', async () => {
  const original = fs.readFileSync(doc(HWPX)); await openHandle(HWPX); await getFileInfo();
  const big = Buffer.concat([original, crypto.randomBytes(700_000)]);
  assert.deepEqual(await saveVia(big), {ok: true}); assert.deepEqual(fs.readFileSync(doc(HWPX)), big);
  const chunks = (await nativeLog()).filter(o => o.op === 'saveChunk');
  assert.deepEqual(chunks.map(o => o.args.seq), chunks.map((_, i) => i)); assert.equal(chunks.length, Math.ceil(big.length / 196608));
  for (const chunk of chunks) assert.ok(Number(/\d+/.exec(chunk.args.base64)[0]) <= 350000);
});

test('writable semantics: Blob/ArrayBuffer/TypedArray chunks concatenate; non-sequential or text data is rejected and does not wedge the handle', async () => {
  const original = fs.readFileSync(doc(HWP)); await openHandle(HWP); await getFileInfo();
  const outcome = await page.evaluate(async () => {
    const result = {};
    let writable = await __h.a.createWritable();
    try { await writable.write({type: 'write', position: 5, data: new Uint8Array(8)}); } catch (error) { result.seek = error.name; }
    writable = await __h.a.createWritable(); // the failed write closed the previous session
    try { await writable.write('plain text'); } catch (error) { result.text = error.name; }
    writable = await __h.a.createWritable();
    try { await __h.a.createWritable(); } catch (error) { result.concurrent = error.name; }
    await writable.abort();
    return result;
  });
  assert.deepEqual(outcome, {seek: 'NotAllowedError', text: 'TypeError', concurrent: 'NotAllowedError'});
  const expected = Buffer.concat([original, Buffer.from('tail')]);
  await page.evaluate(async bytes => {
    const writable = await __h.a.createWritable(), whole = new Uint8Array(bytes);
    await writable.write(new Blob([whole.slice(0, 10)])); await writable.write(whole.slice(10, 30).buffer); await writable.write(whole.subarray(30, 40));
    await writable.write({type: 'write', data: new Blob([whole.slice(40)])}); await writable.close();
  }, [...expected]);
  assert.deepEqual(fs.readFileSync(doc(HWP)), expected);
});

test('two handles to one document: the second writer is refused after the first save (multi-open conflict)', async () => {
  await openHandle(HWP, 'a'); await openHandle(HWP, 'b'); await getFileInfo('a'); await getFileInfo('b');
  const first = Buffer.from('first writer wins'); assert.deepEqual(await saveVia(first, 'a'), {ok: true});
  const second = await saveFailing(Buffer.from('second writer'), 'b');
  assert.deepEqual(fs.readFileSync(doc(HWP)), first);
  assert.equal(await page.evaluate(() => __h.a.isSameEntry(__h.b)), true, 'same document -> same entry');
});

test('only one picker at a time: a concurrent open/save picker rejects while the first dialog stays usable', async () => {
  const first = page.evaluate(async () => { const [h] = await showOpenFilePicker(); return h.name; });
  await dialog().getByRole('heading', {name: '문서 열기'}).waitFor();
  const second = await page.evaluate(async () => { try { await showSaveFilePicker({suggestedName: 'x.hwp'}); return 'opened'; } catch (error) { return error.message; } });
  assert.match(second, /대화상자/);
  await chooseOpen('회의 자료'); assert.equal(await first, '회의 자료.hwp'); assertClean();
});

test('Escape/cancel on the pickers is an AbortError (the desktop treats it as user cancel, not failure)', async () => {
  const open = page.evaluate(async () => { try { await showOpenFilePicker(); } catch (error) { return error.name; } });
  await dialog().waitFor(); await page.keyboard.press('Escape'); assert.equal(await open, 'AbortError');
  const save = page.evaluate(async () => { try { await showSaveFilePicker({suggestedName: 'a.hwp'}); } catch (error) { return error.name; } });
  await dialog().getByRole('button', {name: '취소'}).click(); assert.equal(await save, 'AbortError');
  assert.equal(await dialog().count(), 0); assertClean();
});

test('Save As: new name in a chosen folder is a NEW copy (replace=false); original is untouched; later saves replace the copy with its own baseline', async () => {
  const original = fs.readFileSync(doc(HWP)); await openHandle(HWP);
  await page.evaluate(() => { __studio.state.fileHandle = __h.a; });
  const picking = page.evaluate(async () => { __h.b = await showSaveFilePicker({suggestedName: '사본.hwp', types: [{accept: {'application/x-hwp': ['.hwp']}}]}); return __h.b.name; });
  await chooseDestination({name: 'qa-사본.hwp', folders: ['Download']}); assert.equal(await picking, 'qa-사본.hwp');
  const copy = Buffer.concat([original, Buffer.from('copy')]); assert.deepEqual(await saveVia(copy, 'b'), {ok: true});
  assert.deepEqual(fs.readFileSync(doc('Download/qa-사본.hwp')), copy); assert.deepEqual(fs.readFileSync(doc(HWP)), original);
  const begin = (await nativeLog()).find(o => o.op === 'beginSave');
  assert.equal(begin.args.replace, false); assert.equal(begin.args.sha, ''); assert.ok(begin.args.target.endsWith('Download/qa-사본.hwp'));
  const next = Buffer.concat([copy, Buffer.from('+')]); assert.deepEqual(await saveVia(next, 'b'), {ok: true});
  const begins = (await nativeLog()).filter(o => o.op === 'beginSave'); assert.equal(begins[1].args.replace, true); assert.equal(begins[1].args.sha, sha(copy));
  assert.deepEqual(fs.readFileSync(doc(HWP)), original);
});

test('Save As onto an existing file is refused in the dialog (name stays editable); a file that appears after the listing is still refused natively', async () => {
  const victim = fs.readFileSync(doc(HWPX)); await openHandle(HWP);
  const picking = page.evaluate(async () => { __h.b = await showSaveFilePicker({suggestedName: 'x.hwpx'}); return __h.b.name; });
  await chooseDestination({name: '프로젝트 일정.hwpx', folders: ['Download']});
  await dialog().locator('.android-host-error').filter({hasText: '같은 이름'}).waitFor();
  assert.match(await dialog().locator('.android-host-error').innerText(), /프로젝트 일정 \(2\)\.hwpx/, 'a free name is suggested');
  assert.ok((await dialog().locator('.android-host-file').allInnerTexts()).includes('프로젝트 일정.hwpx'), 'existing files of the folder are listed');
  assert.equal((await nativeLog()).filter(o => o.op === 'beginSave').length, 0);
  // The listing is only a courtesy: a file created after it was read is caught by the native collision rule.
  fs.writeFileSync(doc('Download/qa-late.hwpx'), victim);
  await dialog().getByLabel('파일 이름').fill('qa-late.hwpx'); await dialog().getByRole('button', {name: '저장', exact: true}).click();
  assert.equal(await picking, 'qa-late.hwpx');
  const refused = await saveFailing(Buffer.from('payload payload'), 'b');
  assert.match(refused.error.message, /같은 이름/); assert.deepEqual(fs.readFileSync(doc(HWPX)), victim); assert.deepEqual(fs.readFileSync(doc('Download/qa-late.hwpx')), victim);
});

test('destination dialog starts where the user works: the document folder, then the last save folder, then Documents; a taken name is replaced by a free one', async () => {
  const pathText = () => dialog().locator('.android-host-path').innerText();
  const openSave = suggestedName => page.evaluate(async suggestedName => { try { await showSaveFilePicker({suggestedName}); return 'picked'; } catch (error) { return error.name; } }, suggestedName);
  const listed = async () => { await dialog().getByRole('heading', {name: '다른 이름으로 저장'}).waitFor(); await dialog().locator('.android-host-path').filter({hasText: '/'}).waitFor(); };
  // no document, nothing remembered -> Documents
  let picking = openSave('새 문서.hwp'); await listed();
  assert.ok((await pathText()).endsWith('/Documents'), await pathText());
  assert.equal(await dialog().getByRole('button', {name: '상위 폴더'}).isEnabled(), true);
  await page.keyboard.press('Escape'); assert.equal(await picking, 'AbortError');
  // a document from shared storage -> its own folder, and its own (taken) name becomes a free one
  await openHandle('Download/업무자료/2026년 사업계획 검토 의견 최종본.hwp'); await page.evaluate(() => { __studio.state.fileHandle = __h.a; });
  picking = openSave('2026년 사업계획 검토 의견 최종본.hwp'); await listed();
  assert.ok((await pathText()).endsWith('/Download/업무자료'), await pathText());
  assert.equal(await dialog().getByLabel('파일 이름').inputValue(), '2026년 사업계획 검토 의견 최종본 (2).hwp');
  await page.keyboard.press('Escape'); await picking;
  // a name typed without an extension gets the one being saved; Enter confirms
  await page.evaluate(() => { __studio.state.fileHandle = null; });
  picking = page.evaluate(async () => { __h.e = await showSaveFilePicker({suggestedName: 'a.hwp', types: [{accept: {'application/x-hwp': ['.hwp']}}]}); return __h.e.name; });
  await listed(); await destinationRoot();
  assert.equal(await dialog().getByRole('button', {name: '상위 폴더'}).isEnabled(), false, 'no silent no-op at the storage root');
  await dialog().locator('.android-host-list button').filter({hasText: '📁 Pictures'}).click(); await dialog().locator('.android-host-path').filter({hasText: 'Pictures'}).waitFor();
  await dialog().getByLabel('파일 이름').fill('qa-확장자없음'); await page.keyboard.press('Enter');
  assert.equal(await picking, 'qa-확장자없음.hwp');
  // the folder just used is where the next save starts
  picking = openSave('다음.hwp'); await listed();
  assert.ok((await pathText()).endsWith('/Pictures'), await pathText());
  await page.keyboard.press('Escape'); await picking; assertClean();
});

test('open dialog: without all-files access it says so and offers the grant; granting rescans by itself; rows carry folder, date and size', async () => {
  await control('/__grant?0');
  const opened = page.evaluate(async () => { const [h] = await showOpenFilePicker(); return h.name; });
  await dialog().getByRole('heading', {name: '문서 열기'}).waitFor();
  await dialog().locator('.android-host-notice').filter({hasText: '파일 접근 허용'}).waitFor();
  assert.equal(await dialog().getByRole('button', {name: '파일 접근 허용'}).isVisible(), true);
  await page.evaluate(() => __mock.grant(true));
  const row = dialog().locator('.android-host-list button').filter({hasText: '회의 자료.hwp'});
  await row.waitFor();
  assert.equal(await dialog().getByRole('button', {name: '파일 접근 허용'}).isVisible(), false);
  assert.equal(await dialog().locator('.android-host-notice').isVisible(), false);
  assert.match(await row.locator('small').innerText(), /Download · \d{4}\. ?\d{2}\. ?\d{2}\.? · \d+(\.\d)?(B|KB|MB)/);
  assert.equal(await dialog().getByRole('button', {name: '검색 중지'}).isVisible(), false, 'no stop control when nothing is scanning');
  await dialog().getByRole('searchbox', {name: '문서 이름 검색'}).fill('없는 문서 이름');
  await dialog().getByText('이름에 검색어가 들어간 문서가 없어요.').waitFor();
  await dialog().getByRole('searchbox', {name: '문서 이름 검색'}).fill('회의 자료'); await page.keyboard.press('Enter');
  assert.equal(await opened, '회의 자료.hwp'); assertClean();
});

test('destination dialog enforces name and extension locally (traversal, wrong extension, padded name) and nothing is created', async () => {
  const picking = page.evaluate(async () => { try { await showSaveFilePicker({suggestedName: 'a.hwp', types: [{accept: {'application/x-hwp': ['.hwp']}}]}); } catch (error) { return error.name; } });
  await dialog().getByRole('heading', {name: '다른 이름으로 저장'}).waitFor();
  await dialog().locator('.android-host-path').filter({hasText: '/'}).waitFor();
  const name = dialog().getByLabel('파일 이름'), save = dialog().getByRole('button', {name: '저장', exact: true});
  await name.fill('../escape.hwp'); await save.click(); assert.match(await dialog().locator('.android-host-error').innerText(), /파일 이름/);
  await name.fill('qa-wrong.txt'); await save.click(); assert.match(await dialog().locator('.android-host-error').innerText(), /확장자/);
  await name.fill(' qa-space.hwp'); await save.click(); assert.match(await dialog().locator('.android-host-error').innerText(), /파일 이름/);
  await page.keyboard.press('Escape'); assert.equal(await picking, 'AbortError');
  assert.equal(fs.readdirSync(doc('Documents')).filter(f => f.startsWith('qa-')).length, 0);
  assert.ok(!fs.existsSync(path.join(volume, '../escape.hwp')));
});

test('new document: native-issued identity, first save creates a file as new copy, second save replaces it with a baseline', async () => {
  const picking = page.evaluate(async () => { __h.n = await showSaveFilePicker({suggestedName: '새 문서.hwp'}); });
  await chooseDestination({name: 'qa-new.hwp', folders: ['Documents']}); await picking;
  const bytes = fs.readFileSync(fixtures('blank.hwp'));
  assert.deepEqual(await saveVia(bytes, 'n'), {ok: true}); assert.deepEqual(fs.readFileSync(doc('Documents/qa-new.hwp')), bytes);
  const ops = await nativeLog(), index = ops.findIndex(o => o.op === 'newDocument'), begin = ops.find(o => o.op === 'beginSave');
  assert.ok(index >= 0 && index < ops.indexOf(begin)); assert.equal(ops[index].args.format, 'hwp'); assert.equal(begin.args.replace, false);
  assert.equal(await page.evaluate(async () => { try { await __h.n.getFile(); return 'ok'; } catch (e) { return 'unsaved'; } }), 'ok', 'saved copy is now a readable native handle');
  const again = Buffer.concat([bytes, Buffer.from('2')]); assert.deepEqual(await saveVia(again, 'n'), {ok: true});
  assert.equal((await nativeLog()).filter(o => o.op === 'beginSave')[1].args.sha, sha(bytes));
});

test('SAF-picked file is read-only: the first Save asks for a destination and creates a copy; the external original is never a target', async () => {
  const source = fs.readFileSync(fixtures('문서.hwpx'));
  await control('/__pick?name=' + encodeURIComponent('외부.hwpx'), {method: 'POST', body: source});
  const opened = page.evaluate(async () => { const [h] = await showOpenFilePicker(); __h.s = h; return h.name; });
  await dialog().getByRole('button', {name: '파일 선택'}).click(); assert.equal(await opened, '외부.hwpx');
  assert.deepEqual(Buffer.from((await getFileInfo('s')).bytes), source);
  const edit = Buffer.concat([source, Buffer.from('saf edit')]);
  const saving = saveVia(edit, 's'); await chooseDestination({name: 'qa-from-saf.hwpx', folders: ['Documents']});
  assert.deepEqual(await saving, {ok: true}); assert.deepEqual(fs.readFileSync(doc('Documents/qa-from-saf.hwpx')), edit);
  const begin = (await nativeLog()).find(o => o.op === 'beginSave'); assert.equal(begin.args.replace, false); assert.match(begin.args.id, /^saf:/);
});

test('cancelling the copy destination of a read-only source writes nothing, fails the save (stays dirty) and leaves the handle reusable', async () => {
  await control('/__pick?name=' + encodeURIComponent('외부.hwp'), {method: 'POST', body: fs.readFileSync(fixtures('문서.hwp'))});
  const opened = page.evaluate(async () => { const [h] = await showOpenFilePicker(); __h.s = h; });
  await dialog().getByRole('button', {name: '파일 선택'}).click(); await opened;
  const saving = saveVia(Buffer.from('payload12'), 's'); await dialog().getByRole('heading', {name: '다른 이름으로 저장'}).waitFor();
  await dialog().getByRole('button', {name: '취소'}).click(); const result = await saving;
  assert.equal(result.error.name, 'AbortError', 'user cancel of the copy destination is a silent AbortError (document stays dirty, nothing written)');
  assert.equal(await dialog().count(), 0);
  assert.equal((await nativeLog()).filter(o => ['beginSave', 'finishSave'].includes(o.op)).length, 0);
  const again = saveVia(Buffer.from('second12'), 's'); await chooseDestination({name: 'qa-after-cancel.hwp', folders: ['Documents']}); assert.deepEqual(await again, {ok: true});
});

test('late native reply after the host timeout is ignored: no page error, session aborted, nothing marked saved', async () => {
  await freshPage({clock: true});
  const original = fs.readFileSync(doc(HWP)); await openHandle(HWP); await getFileInfo();
  await control('/__hold?op=finishSave');
  const saving = saveVia(Buffer.concat([original, Buffer.from('late')]));
  await expectHeld(1);
  await page.clock.fastForward(61000);
  const result = await saving; assert.match(result.error.message, /시간이 초과/); assert.notEqual(result.error.name, 'AbortError');
  await control('/__release?op=finishSave'); await page.waitForTimeout(300);
  assert.deepEqual(pageErrors, []); assert.equal((await studioCalls()).notifySaved, 0);
  // Honest limitation: native DID finish the write. The host baseline was not advanced, so the next save is a conflict, never a silent overwrite.
  await saveFailing(Buffer.from('after late reply'));
});

test('recovery store: exact bytes/metadata through native private drafts; overwrite, delete, clear; legacy drafts stay untouched', async () => {
  const bytes = Buffer.alloc(250_000); for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
  const result = await page.evaluate(async bytes => {
    const store = AndroidStudioHost.recovery, data = new Uint8Array(bytes);
    await store.saveDraft({id: 'doc-1', fileName: '회의록.hwpx', sourceFormat: 'hwpx', savedAt: 1, byteLength: data.length, data, dirtyReason: 'edit', encrypted: false});
    // an app-library (non-Studio) draft that Studio recovery must never see or delete
    const token = await AndroidStudioHost.request('beginDraft', {id: 'legacy-1', docId: 'legacy:1', name: 'legacy.hwp', path: '', folder: '', format: 'hwp', length: 8});
    await AndroidStudioHost.request('saveChunk', {token, seq: 0, base64: btoa('12345678')}); await AndroidStudioHost.request('finishDraft', {token});
    const got = await store.getDraft('doc-1'), list = await store.listDrafts();
    await store.saveDraft({id: 'doc-1', fileName: '회의록 v2.hwpx', sourceFormat: 'hwpx', savedAt: 2, byteLength: 8, data: new Uint8Array(8).fill(7)});
    const replaced = await store.listDrafts();
    await store.deleteDraft('doc-1'); const afterDelete = await store.getDraft('doc-1');
    await store.saveDraft({id: 'doc-2', fileName: 'b.hwp', sourceFormat: 'hwp', savedAt: 3, byteLength: 8, data: new Uint8Array(8).fill(9), encrypted: true});
    const encrypted = (await store.getDraft('doc-2')).encrypted; await store.clearDrafts();
    return {got: {...got, data: [...got.data]}, listIds: list.map(d => d.id), replaced: replaced.map(d => [d.id, d.fileName, d.data.length]), afterDelete, encrypted,
      remaining: (await store.listDrafts()).length, legacy: (await AndroidStudioHost.request('listDrafts')).map(d => d.docId)};
  }, [...bytes]);
  assert.deepEqual(Buffer.from(result.got.data), bytes); assert.equal(result.got.fileName, '회의록.hwpx'); assert.equal(result.got.sourceFormat, 'hwpx'); assert.equal(result.got.id, 'doc-1');
  assert.deepEqual(result.listIds, ['doc-1']); assert.deepEqual(result.replaced, [['doc-1', '회의록 v2.hwpx', 8]]);
  assert.equal(result.afterDelete, null); assert.equal(result.encrypted, true); assert.equal(result.remaining, 0);
  assert.deepEqual(result.legacy, ['legacy:1'], 'clearDrafts must not delete the library app\'s own drafts');
  const begin = (await nativeLog()).find(o => o.op === 'beginDraft'); assert.equal(begin.args.docId, 'studio:doc-1'); assert.equal(begin.args.format, 'hwp');
  assertClean();
});

test('recovery store: a failed native draft write is surfaced, never swallowed, and releases the draft slot', async () => {
  await control('/__fail?op=finishDraft&message=' + encodeURIComponent('복구 저장 실패'));
  const error = await page.evaluate(async () => { try { await AndroidStudioHost.recovery.saveDraft({id: 'x', fileName: 'x.hwp', sourceFormat: 'hwp', savedAt: 1, byteLength: 8, data: new Uint8Array(8)}); return null; } catch (e) { return e.message; } });
  assert.equal(error, '복구 저장 실패');
  await page.evaluate(() => AndroidStudioHost.recovery.saveDraft({id: 'x', fileName: 'x.hwp', sourceFormat: 'hwp', savedAt: 1, byteLength: 8, data: new Uint8Array(8)}));
  assert.equal((await nativeLog()).filter(o => o.op === 'finishDraft' && o.ok).length, 1, 'a retry after the failure must succeed');
});

test('regression (was DEFECT-1): recovery.listDrafts with 3+ drafts must not trip the native 2-blob read pool', async () => {
  const listed = await page.evaluate(async () => {
    const store = AndroidStudioHost.recovery;
    for (const id of ['a', 'b', 'c', 'd']) await store.saveDraft({id, fileName: id + '.hwp', sourceFormat: 'hwp', savedAt: 1, byteLength: 8, data: new Uint8Array(8).fill(id.charCodeAt(0))});
    try { return (await store.listDrafts()).map(d => d.id).sort(); } catch (error) { return 'ERROR: ' + error.message; }
  });
  assert.deepEqual(listed, ['a', 'b', 'c', 'd']);
});

test('lifecycle: native pause and page hide flush recovery; AppBack respects dialogs and the unsaved-changes decision', async () => {
  await page.evaluate(() => NativeEvent('pause', true)); await page.waitForFunction(() => __studio.calls.flush === 1);
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', {configurable: true, value: true}); document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForFunction(() => __studio.calls.flush === 2);
  const exits = async () => (await nativeLog()).filter(o => o.op === 'exit').length;
  // 1. back while a host dialog is open closes only the dialog
  const pick = page.evaluate(async () => { try { await showOpenFilePicker(); } catch (e) { return e.name; } });
  await dialog().waitFor(); await page.evaluate(() => AppBack()); assert.equal(await pick, 'AbortError');
  assert.equal((await studioCalls()).close, 0); assert.equal(await exits(), 0);
  // 2. user cancels the unsaved-changes dialog -> stay
  await page.evaluate(async () => { __studio.closeResult = false; await AppBack(); }); assert.equal((await studioCalls()).close, 1); assert.equal(await exits(), 0);
  // 3. close() throws -> error shown, stay
  await page.evaluate(() => { __studio.closeError = '저장 실패'; window.__back = AppBack(); }); await dialog().getByText('저장 실패').waitFor(); assert.equal(await exits(), 0); await closeErrorDialog(); await page.evaluate(() => window.__back);
  // 4. close() true -> native exit exactly once
  await page.evaluate(async () => { __studio.closeError = null; __studio.closeResult = true; await AppBack(); }); assert.equal(await exits(), 1);
  assertClean();
});

test('clipboard adapter: text and rich HTML round-trip through the native clipboard; oversize is refused', async () => {
  const r = await page.evaluate(async () => {
    await navigator.clipboard.writeText('평문 텍스트'); const text = await navigator.clipboard.readText();
    await navigator.clipboard.write([new ClipboardItem({'text/plain': new Blob(['표'], {type: 'text/plain'}), 'text/html': new Blob(['<table><tr><td>표</td></tr></table>'], {type: 'text/html'})})]);
    const [item] = await navigator.clipboard.read(); const types = [...item.types], html = await (await item.getType('text/html')).text(), plain = await (await item.getType('text/plain')).text();
    await navigator.clipboard.writeText('only text'); const [plainItem] = await navigator.clipboard.read();
    let big; try { await navigator.clipboard.writeText('x'.repeat(1_000_001)); big = 'accepted'; } catch (e) { big = e.message; }
    return {text, types, html, plain, plainTypes: [...plainItem.types], big};
  });
  assert.equal(r.text, '평문 텍스트'); assert.deepEqual(r.types.sort(), ['text/html', 'text/plain']); assert.equal(r.html, '<table><tr><td>표</td></tr></table>'); assert.equal(r.plain, '표');
  assert.deepEqual(r.plainTypes, ['text/plain']); assert.match(r.big, /너무 커요/);
});

test('exportFile: new-file-only native export with bytes verified; collisions, wrong content and unsupported extensions are refused and leave no file', async () => {
  const html = Buffer.from('<!doctype html><meta charset="utf-8"><p>내보내기</p>');
  const exportAs = async (name, blobBytes, type) => {
    const p = page.evaluate(async ({name, bytes, type}) => { try { await AndroidStudioHost.exportFile(new Blob([new Uint8Array(bytes)], {type}), name); return 'ok'; } catch (e) { return e.message; } }, {name, bytes: [...blobBytes], type});
    await chooseDestination({name, folders: ['Documents']}); return p;
  };
  assert.equal(await exportAs('qa-out.html', html, 'text/html'), 'ok'); assert.deepEqual(fs.readFileSync(doc('Documents/qa-out.html')), html);
  // A taken name is refused while the dialog is still open; nothing reaches native and the first export is untouched.
  const clash = exportAs('qa-out.html', html, 'text/html');
  await dialog().locator('.android-host-error').filter({hasText: '같은 이름'}).waitFor(); await page.keyboard.press('Escape');
  assert.match(await clash, /취소/); assert.equal((await nativeLog()).filter(o => o.op === 'beginExport').length, 1); assert.deepEqual(fs.readFileSync(doc('Documents/qa-out.html')), html);
  assert.match(await exportAs('qa-fake.png', Buffer.from('not a png at all'), 'image/png'), /PNG/); assert.ok(!fs.existsSync(doc('Documents/qa-fake.png')));
  assert.match(await exportAs('qa-run.exe', html, 'application/octet-stream'), /지원하지 않는/); assert.ok(!fs.existsSync(doc('Documents/qa-run.exe')));
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), crypto.randomBytes(64)]);
  assert.equal(await exportAs('qa-ok.png', png, 'image/png'), 'ok'); assert.deepEqual(fs.readFileSync(doc('Documents/qa-ok.png')), png);
});

test('print: renderer PNG pages go to the private native print path with point-converted sizes; no shared-storage prompt', async () => {
  const png = await pngBytes();
  await page.evaluate(async png => AndroidStudioHost.printPages({fileName: '보고서.hwp', intent: 'print', pages: [{png: new Uint8Array(png), width: 794, height: 1123}, {png: new Uint8Array(png), width: 1123, height: 794}]}), png);
  const log = await control('/__log'), ops = log.ops.map(o => o.op);
  assert.deepEqual(ops.filter(o => !['saveChunk', 'status'].includes(o)), ['beginPrintPdf', 'beginPdfPage', 'finishPdfPage', 'beginPdfPage', 'finishPdfPage', 'finishPdf']);
  assert.equal(await dialog().count(), 0);
  assert.deepEqual(log.printed, [{name: '보고서.hwp', pages: [{width: 596, height: 842, bytes: png.length}, {width: 842, height: 596, bytes: png.length}]}]);
});

test('PDF: destination chosen in the host dialog; real PDF target; SVG fallback rasterises; limits and failures release the native session', async () => {
  const png = await pngBytes(), svg = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="300"><rect width="200" height="300" fill="red"/></svg>';
  const pdf = page.evaluate(async ({png, svg}) => AndroidStudioHost.printPages({fileName: '계약.hwpx', intent: 'pdf', pages: [{png: new Uint8Array(png), width: 400, height: 500}, {svg, width: 200, height: 300}]}), {png, svg});
  await chooseDestination({name: 'qa-계약.pdf', folders: ['Documents']}); await pdf;
  assert.ok(fs.readFileSync(doc('Documents/qa-계약.pdf'), 'latin1').startsWith('%PDF'));
  assert.equal((await nativeLog()).find(o => o.op === 'beginPdf').args.count, 2);
  const pages = (await nativeLog()).filter(o => o.op === 'beginPdfPage'); assert.deepEqual(pages.map(p => [p.args.index, p.args.width, p.args.height]), [[0, 300, 375], [1, 150, 225]]);
  // limits are enforced before any native call
  await control('/__logclear');
  const limit = await page.evaluate(async png => { const out = []; for (const pages of [[], Array.from({length: 101}, () => ({png: new Uint8Array(png), width: 10, height: 10}))]) { try { await AndroidStudioHost.printPages({fileName: 'a.hwp', intent: 'print', pages}); out.push('ok'); } catch (e) { out.push(e.message); } } return out; }, png);
  assert.ok(limit.every(m => /100페이지/.test(m)), String(limit)); assert.deepEqual(await nativeLog(), []);
  // a failure on page two aborts the PDF (native has one PDF slot) and a following print still works
  await control('/__fail?op=finishPdfPage&message=' + encodeURIComponent('페이지 실패') + '&times=1');
  const failed = await page.evaluate(async png => { try { await AndroidStudioHost.printPages({fileName: 'a.hwp', intent: 'print', pages: [{png: new Uint8Array(png), width: 100, height: 100}, {png: new Uint8Array(png), width: 100, height: 100}]}); return 'ok'; } catch (e) { return e.message; } }, png);
  assert.equal(failed, '페이지 실패'); assert.ok((await nativeLog()).some(o => o.op === 'abortPdf'));
  await page.evaluate(async png => AndroidStudioHost.printPages({fileName: 'a.hwp', intent: 'print', pages: [{png: new Uint8Array(png), width: 100, height: 100}]}), png);
  assert.equal((await control('/__log')).printed.length, 1);
});

test('file inputs: Studio\'s programmatic input.click() is routed to the SAF picker with the right kind; cancel emits cancel; bytes are exact', async () => {
  const png = Buffer.from(await pngBytes());
  await control('/__pick?name=pic.png', {method: 'POST', body: png});
  const result = await page.evaluate(() => new Promise(resolve => {
    const input = document.createElement('input'); input.type = 'file'; input.accept = 'image/png,image/jpeg';
    input.onchange = async () => { const file = input.files[0]; resolve({name: file.name, type: file.type, bytes: [...new Uint8Array(await file.arrayBuffer())]}); }; input.click();
  }));
  assert.equal(result.name, 'pic.png'); assert.equal(result.type, 'image/png'); assert.deepEqual(Buffer.from(result.bytes), png);
  assert.equal((await nativeLog()).find(o => o.op === 'pickFile').args.kind, 'image');
  await control('/__pick?cancel=1');
  assert.equal(await page.evaluate(() => new Promise(resolve => { const input = document.createElement('input'); input.type = 'file'; input.accept = '.hwp'; input.oncancel = () => resolve('cancel'); input.click(); })), 'cancel');
  assert.equal((await nativeLog()).filter(o => o.op === 'pickFile')[1].args.kind, 'document');
});

test('launch(): a native document reaches the Studio launchQueue consumer as a readable handle; before the consumer exists it fails visibly', async () => {
  const early = await page.evaluate(async () => { try { await AndroidStudioHost.launch({id: 'x'}); return 'ok'; } catch (e) { return e.message; } });
  assert.match(early, /준비/);
  await page.evaluate(() => { window.launchQueue.setConsumer(params => { __h.l = params.files[0]; }); });
  const meta = await page.evaluate(async () => {
    const items = [], previous = window.NativeEvent; window.NativeEvent = (name, data) => { if (name === 'scanBatch') items.push(...data); previous(name, data); };
    await AndroidStudioHost.request('scan'); window.NativeEvent = previous; return items.find(item => item.name === '회의 자료.hwp');
  });
  await page.evaluate(meta => AndroidStudioHost.launch(meta), meta);
  assert.deepEqual(Buffer.from((await getFileInfo('l')).bytes), fs.readFileSync(doc('Download/회의 자료.hwp')));
  assert.equal(await page.evaluate(() => __h.l.name), '회의 자료.hwp');
});

test('permission adapter: queryPermission reflects native storage access and requestPermission goes through the native settings flow', async () => {
  await openHandle(HWP);
  assert.equal(await page.evaluate(() => __h.a.queryPermission({mode: 'readwrite'})), 'granted');
  await control('/__grant?0');
  assert.equal(await page.evaluate(() => __h.a.queryPermission({mode: 'readwrite'})), 'prompt');
  assert.equal(await page.evaluate(() => __h.a.requestPermission({mode: 'readwrite'})), 'prompt');
  assert.ok((await nativeLog()).some(o => o.op === 'permission'));
});

test('font manager: native import registers the face with the Studio provider, deletion removes it, and the dialog is keyboard-dismissable', async () => {
  const font = fs.readFileSync('/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf');
  await page.getByRole('button', {name: 'Android · 글꼴'}).click();
  await dialog().getByRole('heading', {name: '글꼴 관리'}).waitFor(); await dialog().getByText('가져온 글꼴이 없어요.').waitFor();
  await control('/__pickfont?family=' + encodeURIComponent('QA 글꼴'), {method: 'POST', body: font});
  await dialog().getByRole('button', {name: '글꼴 가져오기'}).click(); await dialog().getByText('QA 글꼴').waitFor();
  assert.deepEqual(await page.evaluate(async () => (await __studio.provider.getSnapshot()).faces.map(f => f.family)), ['QA 글꼴']);
  const bytes = await page.evaluate(async () => { const s = await __studio.provider.getSnapshot(); return (await __studio.provider.readFace(s.faces[0].id, s.revision)).bytes.byteLength; });
  assert.equal(bytes, font.length);
  await dialog().getByRole('button', {name: '삭제'}).click(); await dialog().getByText('가져온 글꼴이 없어요.').waitFor();
  assert.equal(await page.evaluate(async () => (await __studio.provider.getSnapshot()).faces.length), 0);
  await page.keyboard.press('Escape'); await dialog().waitFor({state: 'detached'});
  assertClean();
});

test('font manager returns mouse users to the editor and keyboard users to its launch button', async () => {
  await page.evaluate(() => {
    const editor = document.createElement('textarea'); editor.id = 'qa-editor-focus';
    document.body.append(editor); editor.focus();
  });
  const config = page.getByRole('button', {name: 'Android · 글꼴'});
  await config.click(); await dialog().getByRole('heading', {name: '글꼴 관리'}).waitFor();
  await page.keyboard.press('Escape'); await dialog().waitFor({state: 'detached'});
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'qa-editor-focus');
  await config.focus(); await page.keyboard.press('Enter');
  await dialog().getByRole('heading', {name: '글꼴 관리'}).waitFor();
  await page.keyboard.press('Escape'); await dialog().waitFor({state: 'detached'});
  assert.equal(await config.evaluate(node => node === document.activeElement), true);
  assertClean();
});

test('save guard installed by the host blocks lossy, empty or wrongly-typed output before native sees a byte', async () => {
  const outcome = await page.evaluate(async () => {
    const guard = __studio.guard, bytes = new Uint8Array(16), results = [];
    for (const input of [{bytes, format: 'hwp', contentLoss: {count: 0}}, {bytes, format: 'hwp', contentLoss: {count: 2}}, {bytes: new Uint8Array(0), format: 'hwp'}, {bytes, format: 'pdf'}, {bytes, format: 'hwpx', contentLoss: {losses: ['표']}}]) {
      try { await guard(input); results.push('allow'); } catch (e) { results.push('block'); }
    }
    return results;
  });
  assert.deepEqual(outcome, ['allow', 'block', 'block', 'block', 'block']);
  assert.deepEqual(await nativeLog(), []);
});

test('host installs nothing outside the Android shell (no OfflineNative): the plain desktop browser path stays untouched', async () => {
  const other = await context.newPage();
  await other.route('**/plain.html', route => route.fulfill({contentType: 'text/html', body: '<script src="/studio-host.js"></script>'}));
  await other.goto(base + '/plain.html');
  assert.deepEqual(await other.evaluate(() => [typeof window.AndroidStudioHost, typeof window.rhwpAndroidHost, typeof window.AppBack,
    /native code/.test(String(window.showOpenFilePicker)), /native code/.test(String(window.launchQueue?.setConsumer)), /native code/.test(String(navigator.clipboard?.writeText)), document.querySelector('style, dialog, button')]),
    ['undefined', 'undefined', 'undefined', true, true, true, null]);
});

test('startup markers are immutable aliases of one object and report ready only after the full adapter is installed', async () => {
  const r = await page.evaluate(() => {
    const host = window.AndroidStudioHost, same = host === window.rhwpAndroidHost, state = host.startupState;
    let replaced = 'replaced'; try { window.AndroidStudioHost = {}; replaced = window.AndroidStudioHost === host ? 'unchanged' : 'replaced'; } catch { replaced = 'throws'; }
    return {same, state, replaced, stillSame: window.AndroidStudioHost === host && window.rhwpAndroidHost === host, picker: /native code/.test(String(window.showOpenFilePicker))};
  });
  assert.deepEqual(r, {same: true, state: 'ready', replaced: 'unchanged', stillSame: true, picker: false});
});

test('fail-closed startup: an adapter that cannot be installed blocks pickers, recovery and the editor, and Back still leaves the app', async () => {
  const broken = await context.newPage();
  await broken.addInitScript(() => { Object.freeze(HTMLInputElement.prototype); });
  await broken.goto(base + '/__harness.html');
  await broken.waitForFunction(() => window.AndroidStudioHost?.startupState === 'failed');
  const r = await broken.evaluate(async () => {
    const out = {};
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) { try { await window[name](); out[name] = 'opened'; } catch (e) { out[name] = e.name; } }
    out.recovery = typeof AndroidStudioHost.recovery + '/' + typeof AndroidStudioHost.recoveryStore;
    const key = new KeyboardEvent('keydown', {key: 'o', ctrlKey: true, bubbles: true, cancelable: true}); let reached = false;
    document.addEventListener('keydown', () => { reached = true; }); document.dispatchEvent(key); out.keyBlocked = key.defaultPrevented && !reached;
    out.alert = document.querySelector('[role=alert]')?.textContent || null;
    return out;
  });
  assert.deepEqual({picker: [r.showOpenFilePicker, r.showSaveFilePicker], recovery: r.recovery, keyBlocked: r.keyBlocked}, {picker: ['NotAllowedError', 'NotAllowedError'], recovery: 'undefined/undefined', keyBlocked: true});
  assert.match(r.alert, /시작하지 못했어요/);
  await broken.evaluate(() => AppBack());
  let exited = false; for (let i = 0; i < 40 && !exited; i++) { exited = (await nativeLog()).some(o => o.op === 'exit'); if (!exited) await new Promise(r => setTimeout(r, 50)); }
  assert.ok(exited, 'Back from the fatal screen must still exit through native');
});

test('recovery: one unreadable draft is reported once and never hides the readable ones', async () => {
  const listed = await page.evaluate(async () => {
    const store = AndroidStudioHost.recovery;
    for (const id of ['a', 'b', 'c']) await store.saveDraft({id, fileName: id + '.hwp', sourceFormat: 'hwp', savedAt: 1, byteLength: 8, data: new Uint8Array(8).fill(1)});
    return null;
  });
  void listed;
  await control('/__fail?op=readDraft&message=' + encodeURIComponent('손상된 복구 자료') + '&times=1');
  const first = await page.evaluate(async () => (await AndroidStudioHost.recovery.listDrafts()).length);
  assert.equal(first, 2);
  await dialog().getByText(/읽을 수 없는 복구 자료 1개/).waitFor(); await closeErrorDialog();
  const again = await page.evaluate(async () => (await AndroidStudioHost.recovery.listDrafts()).length);
  assert.equal(again, 3); assert.equal(await dialog().count(), 0, 'a healed draft is listed again and the notice is not repeated');
});

test('open-with / share: a file queued natively opens through the launchQueue consumer; only the newest of several is opened and announced', async () => {
  await page.evaluate(() => { window.launchQueue.setConsumer(params => { (__h.opened = __h.opened || []).push(params.files[0]); }); });
  const one = fs.readFileSync(fixtures('문서.hwpx')), two = fs.readFileSync(fixtures('table.hwpx'));
  await control('/__openrequest?name=' + encodeURIComponent('받은1.hwpx'), {method: 'POST', body: one});
  await control('/__openrequest?name=' + encodeURIComponent('받은2.hwpx'), {method: 'POST', body: two});
  await page.evaluate(() => NativeEvent('openRequest', true));
  await page.waitForFunction(() => __h.opened?.length === 1);
  assert.equal(await page.evaluate(() => __h.opened[0].name), '받은2.hwpx');
  assert.deepEqual(Buffer.from((await page.evaluate(async () => [...new Uint8Array(await (await __h.opened[0].getFile()).arrayBuffer())]))), two);
  assert.match(await page.locator('#sb-message').innerText(), /전달받은 파일 2개/);
  assert.equal(await page.evaluate(() => __h.opened.length), 1, 'the older shared file must not open silently');
  // a shared file is an external (SAF-like) source: Save must ask for a destination and create a copy, never write to the source
  await page.evaluate(() => { __h.s = __h.opened[0]; });
  const saving = saveVia(Buffer.concat([two, Buffer.from('x')]), 's');
  await chooseDestination({name: 'qa-from-share.hwpx', folders: ['Documents']});
  assert.deepEqual(await saving, {ok: true}); assert.deepEqual(fs.readFileSync(doc('Documents/qa-from-share.hwpx')), Buffer.concat([two, Buffer.from('x')]));
  assert.equal((await nativeLog()).find(o => o.op === 'beginSave').args.replace, false);
  assertClean();
});

test('external links stay blocked like the PC build: a user-gesture window.open never reaches native and the host exposes no outbound-open capability', async () => {
  // PC app/main.cjs denies every new window and non-local navigation; Android must not add an outbound path (no openExternal op, no confirmation flow).
  assert.equal(await page.evaluate(() => ['openExternal', 'open', 'openUrl'].filter(name => typeof AndroidStudioHost[name] === 'function' && name !== 'open').length), 0);
  await page.mouse.click(10, 10);                                  // a real user gesture, the case that used to be allowed
  const outcome = await page.evaluate(() => {
    const stand = window.open('about:blank'); if (!stand) return 'null';
    const replaced = /native code/.test(String(window.open)); try { stand.close(); } catch { /* the test browser's own popup */ }
    return replaced ? 'browser-popup' : 'host-stand-in';
  });
  assert.notEqual(outcome, 'host-stand-in', 'the host must not install a window.open stand-in that forwards addresses to native');
  await page.waitForTimeout(300);
  const ops = (await nativeLog()).map(o => o.op);
  assert.ok(!ops.includes('openExternal'), 'native must never receive an outbound-open request');
  assert.deepEqual(externalRequests, [], 'no network request leaves the page');
  assert.equal(await dialog().count(), 0, 'no confirmation/consent flow exists for external links');
});

test('clipboard image: PNG with text+html travels as one bounded upload; reads return the image through an opaque URL that is released', async () => {
  const png = Buffer.from(await pngBytes(16, 16));
  const r = await page.evaluate(async png => {
    const blob = new Blob([new Uint8Array(png)], {type: 'image/png'});
    await navigator.clipboard.write([new ClipboardItem({'image/png': blob, 'text/plain': new Blob(['그림'], {type: 'text/plain'}), 'text/html': new Blob(['<img src="x">'], {type: 'text/html'})})]);
    const [item] = await navigator.clipboard.read(); const out = {types: [...item.types].sort(), bytes: [...new Uint8Array(await (await item.getType('image/png')).arrayBuffer())], text: await (await item.getType('text/plain')).text()};
    let bad; try { await navigator.clipboard.write([new ClipboardItem({'image/png': new Blob([new Uint8Array(32)], {type: 'image/png'})})]); bad = 'accepted'; } catch (e) { bad = e.message; }
    await navigator.clipboard.writeText('plain only'); const [after] = await navigator.clipboard.read();
    return {...out, bad, afterTypes: [...after.types]};
  }, [...png]);
  assert.deepEqual(r.types, ['image/png', 'text/html', 'text/plain']); assert.deepEqual(Buffer.from(r.bytes), png); assert.equal(r.text, '그림');
  assert.match(r.bad, /PNG/); assert.deepEqual(r.afterTypes, ['text/plain'], 'writing text clears the stale image');
  const ops = await nativeLog(); assert.equal(ops.filter(o => o.op === 'release').length, 1, 'the one image blob that was read must be released');
  assert.equal((await control('/__log')).clipboard.imageBytes, 0);
});
