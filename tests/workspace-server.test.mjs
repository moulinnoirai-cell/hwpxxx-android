// Protocol-level self-test of the multi-session overlay in tests/preview-server.mjs (HTTP only: no browser, no Studio bundle).
// It checks the MOCK's isolation rules that the browser workspace tests rely on. It proves nothing about Java/EditorSession.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
let server, base, volume, seq = 0;
const free = () => new Promise(resolve => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const ctl = async (p, body) => { const r = await fetch(base + p, body === undefined ? {} : { method: 'POST', body }); const t = await r.text(); return t[0] === '{' || t[0] === '[' ? JSON.parse(t) : t; };
const call = async (view, op, args = {}) => { const r = await fetch(base + '/__native', { method: 'POST', headers: view ? { 'x-view': view } : {}, body: JSON.stringify({ id: ++seq, op, args }) }); return (await r.json()).reply; };
const A = 'aaaaaaaa-0000-4000-8000-00000000000a', B = 'bbbbbbbb-0000-4000-8000-00000000000b', C = 'cccccccc-0000-4000-8000-00000000000c';
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const save = async (view, id, target, bytes, shaOf) => {
  const begin = await call(view, 'beginSave', { id, target, replace: true, studio: true, format: path.extname(target).slice(1), length: bytes.length, sha: shaOf }); if (!begin.ok) return begin;
  assert.equal((await call(view, 'saveChunk', { token: begin.data, seq: 0, base64: bytes.toString('base64') })).ok, true);
  return call(view, 'finishSave', { token: begin.data });
};
const listing = async view => (await call(view, 'scan')).ok;

before(async () => {
  const port = await free(); base = `http://127.0.0.1:${port}`;
  server = spawn('node', [path.join(here, 'preview-server.mjs'), String(port)], { stdio: ['ignore', 'pipe', 'inherit'] });
  const line = await new Promise(resolve => server.stdout.once('data', d => resolve(String(d))));
  volume = line.split('sandbox ')[1].trim();
  await ctl('/__grant?1'); await ctl('/__config?strict=1');
});
after(() => server.kill());

test('slots are per session in strict mode (one EditorSession each), the legacy tag-less session keeps its own', async () => {
  const file = path.join(volume, 'Documents/주간 업무회의록.hwp');
  assert.equal((await call(B, 'read', { id: sha(Buffer.from(file)) })).ok, false, 'B has no source handle before it scanned itself');
  for (const v of [A, B, '']) assert.equal((await call(v, 'scan')).ok, true);
  const read = async v => (await call(v, 'read', { id: sha(Buffer.from(file)) })).data;
  const ra = await read(A), rb = await read(B), rl = await read('');
  assert.ok(ra && rb && rl);
  // strict: one upload slot per session; before the overlay this was global and the 2nd begin failed
  const bytes = Buffer.alloc(16, 1);
  const b1 = await call(A, 'beginSave', { id: ra.meta.id, target: file, replace: true, studio: true, format: 'hwp', length: 16, sha: ra.sha });
  const b2 = await call(B, 'beginSave', { id: rb.meta.id, target: file, replace: true, studio: true, format: 'hwp', length: 16, sha: rb.sha });
  assert.equal(b1.ok && b2.ok, true);
  assert.equal((await call(A, 'beginSave', { id: ra.meta.id, target: file, replace: true, studio: true, format: 'hwp', length: 16, sha: ra.sha })).ok, false, 'same session: slot still single');
  assert.equal((await call(B, 'saveChunk', { token: b1.data, seq: 0, base64: bytes.toString('base64') })).ok, false, 'a session cannot feed another session\'s upload token');
  assert.equal((await call('', 'saveChunk', { token: b2.data, seq: 0, base64: bytes.toString('base64') })).ok, false, 'legacy session cannot either');
  await call(A, 'abortSave'); await call(B, 'abortSave');
  for (const r of [ra, rb, rl]) await call(r === ra ? A : r === rb ? B : '', 'release', { token: r.token });
});

test('blob urls carry the owner tag and answer 403 to every other session', async () => {
  const file = path.join(volume, 'Documents/주간 업무회의록.hwp'), id = sha(Buffer.from(file));
  await call(A, 'scan');
  const r = (await call(A, 'read', { id })).data;
  assert.match(r.url, new RegExp(`^/document/${r.token}\\?view=${A}$`));
  assert.equal((await fetch(base + r.url)).status, 200);
  assert.equal((await fetch(base + r.url.replace(A, B))).status, 403);
  assert.equal((await fetch(base + `/document/${r.token}`)).status, 403);
  assert.equal((await call(B, 'release', { token: r.token })).ok, true); // release of a foreign token is a no-op, not a free of A's blob
  assert.equal((await fetch(base + r.url)).status, 200, 'B could not free A\'s blob');
  await call(A, 'release', { token: r.token });
  assert.equal((await fetch(base + r.url)).status, 403);
});

test('picked/open-request handles belong to one session', async () => {
  await ctl(`/__pick?view=${A}&name=picked.hwp`, fs.readFileSync(path.join(here, 'fixtures/blank.hwp')));
  assert.equal((await call(B, 'pickFile', { kind: 'document' })).data, null, 'B has no pick queued');
  const picked = (await call(A, 'pickFile', { kind: 'document' })).data; assert.ok(picked?.id);
  assert.equal((await call(B, 'read', { id: picked.id })).ok, false, 'B cannot read A\'s picked handle');
  assert.equal((await call(A, 'read', { id: picked.id })).ok, true);
});

test('recovery drafts are private per tab uuid, survive /__restart, and are not listable across tabs', async () => {
  const put = async (view, id, name, text) => { const bytes = Buffer.from(text.padEnd(16, '.')); const t = (await call(view, 'beginDraft', { id, name, format: 'hwp', length: bytes.length, path: '/x/' + name })).data; await call(view, 'saveChunk', { token: t, seq: 0, base64: bytes.toString('base64') }); return (await call(view, 'finishDraft', { token: t })).data.key; };
  const ka = await put(A, 'doc-a', 'same.hwp', 'draft of A'), kb = await put(B, 'doc-b', 'same.hwp', 'draft of B');
  assert.notEqual(ka, kb);
  await ctl('/__restart');
  assert.deepEqual((await call(A, 'listDrafts')).data.map(d => d.key), [ka]);
  assert.deepEqual((await call(B, 'listDrafts')).data.map(d => d.key), [kb]);
  assert.deepEqual((await call(C, 'listDrafts')).data, []);
  assert.equal((await call(C, 'readDraft', { key: ka })).ok, false);
  assert.equal((await call(B, 'readDraft', { key: ka })).ok, false);
  assert.equal((await call(A, 'discardDraft', { key: ka })).ok, true);
  assert.deepEqual((await call(B, 'listDrafts')).data.map(d => d.key), [kb], 'discard in A leaves B');
});

test('shared FileStore: the second handle of one file is refused and the first save stays on disk', async () => {
  const file = path.join(volume, 'Documents/업무 인수인계서.hwpx'), id = sha(Buffer.from(file));
  await call(A, 'scan'); await call(B, 'scan');
  const ra = (await call(A, 'read', { id })).data, rb = (await call(B, 'read', { id })).data;
  assert.equal(ra.sha, rb.sha);
  const first = Buffer.from('first-save-bytes-A'), second = Buffer.from('second-save-bytes-B');
  const sa = await save(A, ra.meta.id, file, first, ra.sha); assert.equal(sa.ok, true, JSON.stringify(sa));
  const sb = await save(B, rb.meta.id, file, second, rb.sha); assert.equal(sb.ok, false); assert.match(sb.error, /다른 앱|바뀌었/);
  assert.deepEqual(fs.readFileSync(file), first);
});

test('fonts are shared and broadcast to the other sessions only', async () => {
  const font = Buffer.concat([Buffer.from([0, 1, 0, 0]), Buffer.alloc(64, 7)]);
  const frames = [];
  const sse = async (view) => { const r = await fetch(`${base}/__events?view=${view}`); const reader = r.body.getReader(); (async () => { const dec = new TextDecoder(); for (;;) { const { value, done } = await reader.read(); if (done) return; for (const m of dec.decode(value).split('\n\n')) if (m.startsWith('data: ')) frames.push({ view, ...JSON.parse(m.slice(6)) }); } })(); return reader; };
  const readers = [await sse(A), await sse(B)];
  await ctl(`/__pickfont?family=QA%20Shared&style=Regular&weight=400`, font);
  assert.equal((await call(A, 'fontImport')).ok, true);
  await new Promise(r => setTimeout(r, 300));
  assert.deepEqual(frames.filter(f => f.name === 'fontsChanged').map(f => f.view), [B]);
  for (const f of [A, B, C]) assert.equal((await call(f, 'fontList')).data.faces.length, 1, 'catalog shared by ' + f);
  readers.forEach(r => r.cancel());
});

test('workspace mock: disabled = legacy failure; enabled = contract ops with implicit origin, token-validated close, order-only move', async () => {
  assert.equal((await call(A, 'workspaceState')).ok, false, 'default server: no workspace => legacy single-doc fallback');
  await ctl(`/__workspace?enable=1&tabs=${A},${B},${C}&split=1`);
  const frames = [];
  const r = await fetch(`${base}/__events?view=${B}`); const reader = r.body.getReader();
  (async () => { const dec = new TextDecoder(); for (;;) { const { value, done } = await reader.read(); if (done) return; for (const m of dec.decode(value).split('\n\n')) if (m.startsWith('data: ')) frames.push(JSON.parse(m.slice(6))); } })();
  const s0 = (await call(A, 'workspaceState')).data;
  assert.equal(s0.selfId, A); assert.equal(s0.primaryId, A); assert.ok(s0.split && s0.secondaryId); assert.deepEqual(s0.tabs.map(t => t.id), [A, B, C]);
  assert.equal((await call(B, 'workspaceState')).data.selfId, B, 'origin is the session, JS cannot name another');
  const moved = (await call(A, 'workspaceMove', { id: C, beforeId: A })).data;
  assert.deepEqual(moved.tabs.map(t => t.id), [C, A, B]);
  for (const k of ['activeId', 'primaryId', 'secondaryId', 'split']) assert.equal(moved[k], s0[k], k + ' unchanged by a reorder');
  assert.equal((await call(A, 'workspaceMove', { id: C, beforeId: 'ghost' })).ok, false);
  await new Promise(r => setTimeout(r, 200));
  assert.equal(frames.filter(f => f.name === 'workspaceChanged').at(-1).data.selfId, B, 'broadcast carries the receiver\'s own selfId');
  // close flow
  await call(A, 'workspaceClose', { id: B });
  await new Promise(r => setTimeout(r, 200));
  const req = frames.find(f => f.kind === 'call' && f.fn === 'AndroidWorkspaceCloseRequest'); assert.ok(req, 'close request reaches the TARGET only');
  const token = req.args[0];
  await call(C, 'workspaceCloseResult', { token, allow: true });      // wrong origin
  await call(B, 'workspaceCloseResult', { token: 'nope', allow: true }); // unknown token
  let st = await ctl('/__workspace'); assert.deepEqual(st.rejected.map(x => x.reason), ['wrong origin', 'unknown token']); assert.equal(st.tabs.length, 3);
  await call(B, 'workspaceCloseResult', { token, allow: false });     // cancel keeps everything
  assert.equal((await ctl('/__workspace')).tabs.length, 3);
  await call(A, 'workspaceClose', { id: B }); await new Promise(r => setTimeout(r, 150));
  const token2 = frames.filter(f => f.kind === 'call').at(-1).args[0]; assert.notEqual(token2, token);
  await call(B, 'workspaceCloseResult', { token: token2, allow: true });
  st = await ctl('/__workspace'); assert.deepEqual(st.tabs.map(t => t.id), [C, A]); assert.deepEqual(st.problems, []);
  assert.equal((await call(B, 'workspaceCloseResult', { token: token2, allow: true })).ok, true); // replay changes nothing
  assert.equal((await ctl('/__workspace')).tabs.length, 2);
  reader.cancel(); await ctl('/__workspace?disable=1');
});

test('legacy (tag-less) protocol is unchanged: no view field in logs, shim without SSE', async () => {
  await ctl('/__logclear');
  await call('', 'status');
  const log = await ctl('/__log?view=');
  assert.deepEqual(log.ops.map(o => ['view' in o, o.op]), [[false, 'status']]);
  const plain = await (await fetch(base + '/__mock.js')).text(), tagged = await (await fetch(base + `/__mock.js?view=${A}`)).text();
  assert.ok(!plain.includes('EventSource') && !plain.includes('x-view'));
  assert.ok(tagged.includes('EventSource') && tagged.includes('x-view'));
  // synchronous capability (EditorSession.Bridge.workspaceEnabled stand-in): untagged legacy = false, tagged = true ONLY when the controller was enabled before the page was served
  const cap = async (tag, enabled) => { const src = await (await fetch(base + '/__mock.js' + (tag ? `?view=${tag}` : ''))).text(); const w = {}; new Function('window', 'fetch', 'EventSource', src)(w, () => new Promise(() => {}), function () {}); return w.OfflineNative.workspaceEnabled(); };
  assert.equal(await cap(''), false); assert.equal(await cap(A), false, 'tagged but no controller');
  await ctl(`/__workspace?enable=1&tabs=${A},${B}`);
  assert.equal(await cap(''), false, 'untagged stays legacy even with a controller enabled'); assert.equal(await cap(A), true);
  await ctl('/__workspace?disable=1');
  assert.equal(await cap(A), false);
  assert.equal((await fetch(base + '/__mock.js?view=../x')).status, 400);
});

test('workspaceOpenRecent / workspaceNew(open) hand the child ONE object initialAction; cancelled open drops only a clean handle-less tab', async () => {
  await ctl(`/__workspace?enable=1&tabs=${A}`);
  const recentId = crypto.createHash('sha256').update('recent\0name:hwp:x.hwp').digest('hex'); // shape of the real HostState/recentList ids (64 hex)
  assert.equal((await call(A, 'workspaceOpenRecent', { recentId: '../etc' })).ok, false);
  assert.equal((await call(A, 'workspaceOpenRecent', { recentId: 'x'.repeat(129) })).ok, false);
  const s1 = (await call(A, 'workspaceOpenRecent', { recentId })).data;
  const child = s1.tabs.map(t => t.id).find(id => id !== A);
  assert.equal(s1.primaryId, child, 'new tab is shown in the origin pane');
  assert.deepEqual((await call(child, 'workspaceReady')).data.initialAction, { kind: 'recent', recentId });
  assert.deepEqual((await call(child, 'workspaceReady')).data.initialAction, { kind: 'blank' }, 'once only: a reload sees blank');
  assert.deepEqual((await call(A, 'workspaceReady')).data.initialAction, { kind: 'blank' }, 'the origin never receives the child action');
  const s2 = (await call(A, 'workspaceNew', { open: true })).data, opener = s2.tabs.map(t => t.id).find(id => ![A, child].includes(id));
  assert.deepEqual((await call(opener, 'workspaceReady')).data.initialAction, { kind: 'open' });
  assert.equal((await call(child, 'workspaceInitialDone', { cancelled: true })).data.tabs.length, 3, 'a tab not created for an open action is never dropped');
  assert.equal((await call(A, 'workspaceInitialDone', { cancelled: true })).data.tabs.length, 3, 'origin cannot drop another tab');
  const after = (await call(opener, 'workspaceInitialDone', { cancelled: true })).data;
  assert.deepEqual(after.tabs.map(t => t.id), [A, child], 'cancelled open drops exactly the clean opener tab');
  await ctl('/__workspace?disable=1');
});
