// Browser preview of the WebView assets with a mock OfflineNative bridge.
// Not shipped in the APK. File operations run on a throwaway copy of tests/fixtures
// so the JS <-> bridge contract (rename, move, mkdir, save, PDF) can be exercised on real bytes.
//   node tests/preview-server.mjs [port]
// Mock controls in the page console: __mock.grant(true|false), __mock.resume()
import http from 'node:http';
import fs from 'node:fs';
import nodePath from 'node:path';
const path=nodePath.posix;
import os from 'node:os';
import crypto from 'node:crypto';
import { WorkspaceOracle } from './workspace-oracle.mjs';

const port = Number(process.argv[2] || 8765);
const assets = new URL('../app/src/main/assets/', import.meta.url);
const sandbox = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'hwpxxx-preview-')).split(nodePath.sep).join('/');
const volume = path.join(sandbox, 'storage');
for (const dir of ['Documents', 'Download/업무자료', 'Pictures']) fs.mkdirSync(path.join(volume, dir), { recursive: true });
const fixtures = new URL('fixtures/', import.meta.url);
const names = ['문서.hwp', '문서.hwpx', 'table.hwp', 'table.hwpx', 'blank.hwp'];
const placed = ['Documents/주간 업무회의록.hwp', 'Download/프로젝트 일정.hwpx', 'Download/업무자료/2026년 사업계획 검토 의견 최종본.hwp', 'Documents/업무 인수인계서.hwpx', 'Download/회의 자료.hwp'];
placed.forEach((p, i) => fs.copyFileSync(new URL(names[i], fixtures), path.join(volume, p)));

// An encrypted HWPX (password qa-only-2026) is placed when tests/build-qa-fixtures.mjs has produced it.
const locked = new URL('../.qa/fixtures/qa-locked.hwpx', import.meta.url);
if (fs.existsSync(locked)) fs.copyFileSync(locked, path.join(volume, 'Documents/암호 문서.hwpx'));

let permission = false;
// Mock of a connected Termux folder (read-only, external): GET /__termux?1 connects it, ?0 disconnects it.
let termux = false;
const termuxFile = path.join(sandbox, 'termux-home/hwpxxx-project/termux-nested.hwpx');
fs.mkdirSync(path.dirname(termuxFile), { recursive: true });
fs.copyFileSync(new URL('문서.hwpx', fixtures), termuxFile);
let docs = new Map(), blobs = new Map();
let newDocuments = new Map();
let upload = null, pdf = null, draftUpload = null, printJob = null;
const printed = [];
const delays = {};
// Studio-contract test controls (all default OFF so the legacy suites keep their original behaviour):
//   /__config?strict=1   emulate MainActivity's single upload slot, single draft slot and 2-blob read pool
//   /__fail?op=X&message=M&times=N   next N calls of op fail with message M (before they run)
//   /__hold?op=X, /__release?op=X     delay replies of op until released (late/out-of-order reply tests)
//   /__pick (POST bytes, ?name=&kind=) queue the next pickFile result; /__pick?cancel=1 queues a cancel
//   /__pickfont (POST bytes, ?family=&style=&weight=)  queue the next fontImport; /__log, /__reset, /__clipboard
const cfg = { strict: false };
let opLog = [];
const failures = new Map(), holds = new Set(), held = [];
let pickQueue = [], selected = new Map();
const fontQueue = [], fonts = new Map();
let clipboard = { text: '', html: '', image: null };
let openQueue = [];
// Private persisted state (native: PrivateStateStore, AES-GCM at rest). The mock keeps records in memory and models ONLY the protocol and its
// failure codes; it proves nothing about native encryption. Records survive /__restart, native ephemeral ids do not.
const history = new Map(), recents = new Map();
let stateUpload = null, historyUnreadable = 0, recentPersistable = true;
const revokedGrants = new Set();
// Recovery drafts survive a page reload, like the app's private storage survives a process kill.
let drafts = new Map();
const draftKey = id => crypto.createHash('sha256').update(id).digest('hex').slice(0, 32);
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const ext = f => /\.hwpx$/i.test(f) ? 'hwpx' : /\.hwp$/i.test(f) ? 'hwp' : /\.hml$/i.test(f) ? 'hml' : /\.pdf$/i.test(f) ? 'pdf' : '';
const fontRevision = () => sha(Buffer.from(JSON.stringify([...fonts.keys()].sort())));
const fontSnapshot = () => ({ revision: fontRevision(), faces: [...fonts.values()].map(f => f.face) });
const MAX_BLOBS = 2, MAX_BYTES = 32 * 1024 * 1024;
function putBlob(bytes) { if (cfg.strict && blobs.size >= MAX_BLOBS) throw new Error('다른 문서를 처리 중이에요. 잠시 뒤 다시 시도해 주세요.'); const t = crypto.randomUUID(); blobs.set(t, bytes); return t; }
function validateExport(bytes, fileName) {
  const e = fileName.split('.').pop().toLowerCase(), head = bytes.subarray(0, 8192).toString('latin1').toLowerCase();
  if (bytes.length < 1 || bytes.length > MAX_BYTES) throw new Error('내보내기 크기가 올바르지 않아요.');
  if (['html', 'htm', 'doc'].includes(e) && !/^\s*<(!doctype html|html)/.test(bytes.subarray(0, 2048).toString('utf8').replace('\ufeff', '').toLowerCase())) throw new Error('HTML 내보내기 형식이 일치하지 않아요.');
  if (['mhtml', 'mht'].includes(e) && !(head.includes('mime-version:') && head.includes('content-type: multipart/'))) throw new Error('MHTML 내보내기 형식이 일치하지 않아요.');
  if (e === 'png' && !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('PNG 형식이 일치하지 않아요.');
  if (['jpg', 'jpeg'].includes(e) && !(bytes[0] === 255 && bytes[1] === 216 && bytes[bytes.length - 2] === 255 && bytes[bytes.length - 1] === 217)) throw new Error('JPEG 형식이 일치하지 않아요.');
  if (e === 'txt' && bytes.includes(0)) throw new Error('텍스트 파일에 이진 자료가 있어요.');
  if (['svg', 'hml'].includes(e) && !new RegExp('<' + (e === 'svg' ? 'svg' : 'hwpml'), 'i').test(bytes.subarray(0, 4096).toString('utf8'))) throw new Error('XML 문서의 형식이 일치하지 않아요.');
}
function inside(p) { const r = path.normalize(p); if (r !== volume && !r.startsWith(volume + path.sep)) throw new Error('기기 저장공간 안의 경로를 선택해 주세요.'); return r; }
function record(f) { const id = sha(Buffer.from(f)); docs.set(id, f); const st = fs.statSync(f); return { id, name: path.basename(f), path: f, folder: path.dirname(f), size: st.size, modified: st.mtimeMs, format: ext(f) }; }
function termuxRecord() { const id = sha(Buffer.from('termux:' + termuxFile)); docs.set(id, termuxFile); const st = fs.statSync(termuxFile); return { id, name: path.basename(termuxFile), path: 'content://com.termux.documents/mock', folder: 'Termux · hwpxxx-project/nested', size: st.size, modified: st.mtimeMs, format: 'hwpx', external: true }; }
function doc(id) { const f = docs.get(id); if (!f || !fs.existsSync(f)) throw new Error('문서 목록을 새로고침한 뒤 다시 선택해 주세요.'); return f; }
function name(n) { if (!n || !n.trim()) throw new Error('이름을 입력해 주세요.'); if (n !== n.trim() || /[\\/\x00-\x1f\x7f]/.test(n)) throw new Error('이름의 앞뒤 공백, /, \\ 또는 제어 문자를 지우고 240바이트 이내로 입력해 주세요.'); }

// ---- Workspace multi-session overlay (tests/workspace-*.py). ONE Android process hosts one EditorSession per tab; the browser tests model
// that with a *view tag* (header x-view, from the page URL ?view=<id>). The empty tag is the exact old single-session state above, so every
// legacy page/test is unchanged. A tagged request runs operation() with that session's PRIVATE state swapped in (operation() is synchronous):
// upload/draft/state/pdf slots, blobs, picked/open-request handles, source-handle ids, new-document ids, pick/open queues and the private
// per-tab recovery drafts (= DraftStore for the tab UUID). Shared by every session like WorkspaceServices: the file volume + hash-checked
// finishSave, fonts, private history/recents, permission, clipboard. This is a protocol mock: it proves nothing about native code/crypto.
const sessions = new Map();
const TAG = /^[A-Za-z0-9-]{1,64}$/;
const blankSession = () => ({ docs: new Map(), blobs: new Map(), newDocuments: new Map(), upload: null, pdf: null, printJob: null, draftUpload: null, stateUpload: null, pickQueue: [], openQueue: [], selected: new Map(), drafts: new Map() });
const capture = () => ({ docs, blobs, newDocuments, upload, pdf, printJob, draftUpload, stateUpload, pickQueue, openQueue, selected, drafts });
function restore(v) { ({ docs, blobs, newDocuments, upload, pdf, printJob, draftUpload, stateUpload, pickQueue, openQueue, selected, drafts } = v); }
function inSession(tag, fn) {
  if (!tag) return fn();
  if (!sessions.has(tag)) sessions.set(tag, blankSession());
  const outer = capture(), mine = sessions.get(tag);
  restore(mine);
  try { return fn(); } finally { sessions.set(tag, capture()); restore(outer); }
}
const tagUrls = (value, tag) => { if (!tag || value == null || typeof value !== 'object') return value; for (const [k, v] of Object.entries(value)) { if (k === 'url' && typeof v === 'string' && v.startsWith('/document/')) value[k] = v + '?view=' + tag; else tagUrls(v, tag); } return value; };
// Event channel (SSE) of tagged pages: native -> JS pushes that are not replies (workspaceChanged, fontsChanged to the other sessions, close requests).
const listeners = new Map();
function push(tag, frame) { for (const res of listeners.get(tag) || []) res.write('data: ' + JSON.stringify(frame) + '\n\n'); }
const pushAll = (frame, except) => { for (const tag of listeners.keys()) if (tag !== except) push(tag, frame); };
// Workspace controller MOCK (workspace-oracle.mjs): CONTRACT.md ops with the implicit origin = the request's session. Off unless /__workspace?enable=1.
let workspace = null, closeTokens = new Map(), rejected = [];
const initialActions = new Map(), openCreated = new Set();
const sessionReads = tag => opLog.some(o => o.view === tag && o.op === 'read' && o.ok);
const broadcastWorkspace = () => { if (workspace) for (const tag of listeners.keys()) push(tag, { kind: 'event', name: 'workspaceChanged', data: workspace.snapshot(tag) }); };
function workspaceOperation(op, a, origin) {
  if (!workspace || !origin) throw new Error('지원하지 않는 작업이에요.');
  const w = workspace, snap = () => w.snapshot(origin);
  const changed = result => { const problems = w.checkInvariants(); if (problems.length) throw new Error('workspace oracle invariant: ' + problems.join(',')); broadcastWorkspace(); return result; };
  switch (op) {
    case 'workspaceState': return snap();
    // Canonical initialAction is an OBJECT: {kind:'blank'} | {kind:'open'} | {kind:'recent',recentId}; a non-blank action is returned ONCE per tab.
    case 'workspaceReady': { const action = initialActions.get(origin) || { kind: 'blank' }; initialActions.delete(origin); return { ...snap(), initialAction: action }; }
    case 'workspaceInitialDone': {
      // Mock of the native rule: a cancelled open may drop ONLY the origin tab, and only while it was created for that action, is clean and never read a document.
      if (a.cancelled === true && openCreated.has(origin) && w.has(origin) && !w.meta.get(origin).dirty && !sessionReads(origin)) { openCreated.delete(origin); w.removeConfirmed(origin); }
      return changed(snap());
    }
    case 'workspaceNew': { const id = crypto.randomUUID(); w.newTab(id, origin); if (a.open === true) { initialActions.set(id, { kind: 'open' }); openCreated.add(id); } return changed(snap()); }
    case 'workspaceOpenRecent': {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(String(a.recentId ?? ''))) throw new Error('최근 문서 정보가 올바르지 않아요.');  // native validates shape/length only; the child resolves it itself
      const id = crypto.randomUUID(); w.newTab(id, origin); initialActions.set(id, { kind: 'recent', recentId: String(a.recentId) }); return changed(snap());
    }
    case 'workspaceSelect': w.select(String(a.id), origin); return changed(snap());
    case 'workspaceFocus': if (w.visible().includes(origin)) w.setActive(origin); return changed(snap());
    case 'workspaceSplit': w.setSplit(a.enabled === true, origin); return changed(snap());
    case 'workspaceMove': w.moveBefore(String(a.id), a.beforeId == null ? null : String(a.beforeId)); return changed(snap());
    case 'workspaceUpdate': w.update(origin, a); return changed(snap());
    case 'workspaceClose': {
      const target = String(a.id); if (!w.has(target)) throw new Error('unknown tab');
      w.select(target, origin);  // a hidden target is activated before it is asked
      const token = crypto.randomUUID(); closeTokens.set(token, target); broadcastWorkspace();
      push(target, { kind: 'call', fn: 'AndroidWorkspaceCloseRequest', args: [token] }); return snap();
    }
    case 'workspaceCloseResult': {
      const target = closeTokens.get(String(a.token));
      if (!target || target !== origin) { rejected.push({ op, origin, token: String(a.token), reason: target ? 'wrong origin' : 'unknown token' }); return snap(); }
      closeTokens.delete(String(a.token));
      if (a.allow === true) { w.removeConfirmed(target); return changed(snap()); }
      return snap();
    }
  }
  throw new Error('지원하지 않는 작업이에요.');
}

function operation(op, a, events) {
  // Same ungated set as MainActivity.UNGATED; read/scan re-check the permission for shared-storage documents below.
  if (!['status', 'release', 'scan', 'read', 'disconnectFolder', 'abortSave', 'abortPdf', 'listDrafts', 'beginDraft', 'finishDraft', 'abortDraft', 'readDraft', 'discardDraft', 'saveChunk', 'fontList', 'newDocument', 'pickFile', 'fontImport', 'fontImportFolder', 'fontRead', 'fontDelete', 'clipboardRead', 'clipboardWrite', 'startPrint', 'printPageBegin', 'printPageChunk', 'printPageEnd', 'printPageFail', 'beginPdfPage', 'finishPdfPage', 'finishPdf', 'permission', 'exit', 'beginClipboardImage', 'finishClipboardImage', 'takeOpenRequests', 'historyList', 'beginHistory', 'finishHistory', 'readHistory', 'deleteHistory', 'clearHistory', 'recentList', 'recentAdd', 'recentOpen', 'recentRemove', 'recentClear'].includes(op) && !permission) throw new Error('문서에 접근하려면 파일 접근을 허용해 주세요.');
  switch (op) {
    case 'status': return { permission, connectedFolders: termux ? [{ id: 'termux-mock', name: 'Termux · hwpxxx-project', active: true }] : [], volumes: [{ path: volume, name: '내장 저장공간' }], version: '0.2.0', engine: 'rhwp 0.8.7' };
    case 'scan': {
      const found = [];
      const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.hwpx?$/i.test(e.name)) found.push(record(p)); } };
      if (permission) walk(volume); if (termux) found.push(termuxRecord()); events.push(['scanBatch', found]); return { cancelled: false, limited: false, skipped: 0, count: found.length };
    }
    case 'cancelScan': return true;
    case 'disconnectFolder': termux = false; events.push(['foldersChanged', true]); return true;
    case 'read': { if (selected.has(a.id)) { const s = selected.get(a.id), t = putBlob(s.bytes); return { url: '/document/' + t, token: t, sha: sha(s.bytes), meta: { id: a.id, name: s.name, folder: '선택한 파일', size: s.bytes.length, modified: 0, format: s.format, mime: s.mime, external: true } }; } const linked = termux && a.id === termuxRecord().id; if (!linked && !permission) throw new Error('문서에 접근하려면 파일 접근을 허용해 주세요.'); const f = doc(a.id), b = fs.readFileSync(f), t = putBlob(b); return { url: '/document/' + t, token: t, sha: sha(b), meta: (linked ? termuxRecord() : record(f)) }; }
    case 'release': blobs.delete(a.token); return true;
    // Studio browser contract only. Native storage/security is tested separately.
    case 'fontList': return fontSnapshot();
    case 'fontRead': { const f = fonts.get(a.id); if (!f || a.revision !== fontRevision()) throw new Error('글꼴 목록이 바뀌었어요. 다시 시도해 주세요.'); const t = putBlob(f.bytes); return { url: '/document/' + t, token: t }; }
    case 'fontImport': {
      const next = fontQueue.shift(); if (!next) return null;
      if (fonts.size >= 64) throw new Error('글꼴이 너무 많아요.');
      const view = next.bytes; if (view.length < 12 || ![0x00010000, 0x4f54544f].includes(view.readUInt32BE(0))) throw new Error('TTF 또는 OTF 글꼴만 가져올 수 있어요.');
      const id = sha(next.bytes), face = { id, family: next.family, fullName: next.family + ' ' + next.style, postscriptName: next.family.replace(/\s/g, '') + '-' + next.style, style: next.style, weight: next.weight, slant: 'normal', aliases: [next.family] };
      fonts.set(id, { face, bytes: next.bytes }); events.push(['fontsChanged', true]); return fontSnapshot();
    }
    // The queued fonts stand for the files of the chosen folder; an empty queue is a cancelled folder picker.
    case 'fontImportFolder': {
      if (!fontQueue.length) return null;
      const files = fontQueue.splice(0); let added = 0, failed = 0, full = false;
      for (const next of files) {
        const view = next.bytes;
        if (view.length < 12 || ![0x00010000, 0x4f54544f].includes(view.readUInt32BE(0))) { failed++; continue; }
        const id = sha(next.bytes); if (fonts.has(id)) continue;
        if (fonts.size >= 64) { full = true; break; }
        fonts.set(id, { face: { id, family: next.family, fullName: next.family + ' ' + next.style, postscriptName: next.family.replace(/\s/g, '') + '-' + next.style, style: next.style, weight: next.weight, slant: 'normal', aliases: [next.family] }, bytes: next.bytes }); added++;
      }
      if (added) events.push(['fontsChanged', true]);
      return { ...fontSnapshot(), folder: { found: files.length, added, failed, full } };
    }
    case 'fontDelete': { if (!fonts.delete(a.id)) throw new Error('글꼴을 찾을 수 없어요.'); events.push(['fontsChanged', true]); return fontSnapshot(); }
    case 'pickFile': {
      const next = pickQueue.shift(); if (!next || next.cancel) return null;
      const want = a.kind === 'image' ? 'image' : 'document';
      if (next.kind !== want) throw new Error('선택한 파일 형식이 맞지 않아요.');
      const id = 'saf:' + crypto.randomUUID(); selected.set(id, next);
      return { id, name: next.name, folder: '선택한 파일', size: next.bytes.length, modified: 0, format: next.format, mime: next.mime, external: true };
    }
    case 'clipboardRead': { const out = { text: clipboard.text, html: clipboard.html }; if (clipboard.image) { const t = putBlob(clipboard.image); out.image = { url: '/document/' + t, token: t, mime: 'image/png', size: clipboard.image.length }; } return out; }
    case 'beginClipboardImage': {
      if (cfg.strict && upload) throw new Error('저장 중이에요. 잠시 기다려 주세요.');
      if (!(a.length >= 8 && a.length <= MAX_BYTES)) throw new Error('클립보드 이미지의 크기가 올바르지 않아요.');
      if (String(a.text ?? '').length > 1000000 || String(a.html ?? '').length > 1000000) throw new Error('클립보드 내용이 너무 커요.');
      upload = { token: crypto.randomUUID(), kind: 'clipimage', length: a.length, parts: [], seq: 0, text: String(a.text ?? ''), html: String(a.html ?? '') }; return upload.token;
    }
    case 'finishClipboardImage': {
      const u = upload; upload = null; if (!u || u.token !== a.token || u.kind !== 'clipimage') throw new Error('저장 세션이 만료되었어요.');
      const png = Buffer.concat(u.parts); if (png.length !== u.length) throw new Error('클립보드 이미지 크기가 일치하지 않아요.');
      if (!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('PNG 이미지만 복사할 수 있어요.');
      clipboard = { text: u.text, html: u.html, image: png }; return true;
    }
    case 'takeOpenRequests': return openQueue.splice(0).slice(-4);
    case 'historyList': return { entries: [...history.values()].map(h => ({ ...h.meta })), unreadable: historyUnreadable };
    case 'beginHistory': {
      if (cfg.strict && stateUpload) throw new Error('기록을 저장하고 있어요. 잠시 기다려 주세요.');
      if (!/^[A-Za-z0-9._:-]{1,128}$/.test(a.id || '')) throw new Error('기록 ID가 올바르지 않아요.');
      const text = String(a.meta ?? ''); if (Buffer.byteLength(text) > 4096 || !text.trim().startsWith('{')) throw new Error('기록 정보가 올바르지 않아요.');
      if (JSON.parse(text).id !== a.id) throw new Error('기록 정보가 ID와 맞지 않아요.');
      if (!(a.length >= 1 && a.length <= MAX_BYTES)) throw new Error('기록이 비어 있거나 32MB를 넘어요.');
      stateUpload = { token: crypto.randomUUID(), kind: 'history', id: a.id, meta: JSON.parse(text), length: a.length, parts: [], seq: 0 }; return stateUpload.token;
    }
    case 'finishHistory': {
      const u = stateUpload; stateUpload = null; if (!u || u.token !== a.token) throw new Error('기록 저장 세션이 만료되었어요.');
      const bytes = Buffer.concat(u.parts); if (bytes.length !== u.length) throw new Error('기록 크기가 일치하지 않아요.');
      history.delete(u.id); history.set(u.id, { meta: { ...u.meta, byteLength: u.length }, bytes });
      while (history.size > 24) history.delete(history.keys().next().value);
      return true;
    }
    case 'readHistory': { const h = history.get(a.id); if (!h) return null; const t = putBlob(h.bytes); return { url: '/document/' + t, token: t }; }
    case 'deleteHistory': history.delete(a.id); return true;
    case 'clearHistory': history.clear(); return true;
    case 'recentList': return [...recents.values()].sort((x, y) => y.openedAt - x.openedAt).map(r => ({ id: r.id, fileName: r.fileName, sourceFormat: r.sourceFormat, openedAt: r.openedAt, reopenable: r.reopenable }));
    case 'recentAdd': {
      const fileName = String(a.fileName ?? '').slice(0, 240), format = String(a.sourceFormat ?? 'hwp');
      if (!fileName || !['hwp', 'hwpx', 'hml'].includes(format)) throw new Error('최근 문서 정보가 올바르지 않아요.');
      let key = 'name:' + format + ':' + fileName, entry = { fileName, sourceFormat: format, openedAt: Date.now(), reopenable: false };
      const file = docs.get(a.sourceId), picked = selected.get(a.sourceId);
      if (file) { key = 'path:' + file; entry = { ...entry, kind: 'path', path: file, reopenable: true }; }
      else if (picked && recentPersistable) { key = 'uri:' + picked.name + ':' + sha(picked.bytes); entry = { ...entry, kind: 'uri', uri: key, bytes: picked.bytes, picked, reopenable: true }; }
      const id = sha(Buffer.from('recent\0' + key)); recents.delete(id); recents.set(id, { id, ...entry });
      while (recents.size > 30) recents.delete(recents.keys().next().value);
      return true;
    }
    case 'recentOpen': {
      const r = recents.get(a.id); if (!r) throw new Error('[NotFound] 최근 문서 목록에서 찾을 수 없어요.');
      if (r.kind === 'path') {
        if (!permission) throw new Error('[NotAllowed] 문서에 접근하려면 파일 접근을 허용해 주세요.');
        if (!fs.existsSync(r.path)) throw new Error('[NotFound] 문서를 찾을 수 없어요. 옮기거나 지웠는지 확인해 주세요.');
        return record(r.path);
      }
      if (r.kind === 'uri') {
        if (revokedGrants.has(r.uri)) throw new Error('[NotAllowed] 이 파일의 접근 권한이 없어졌어요. 다시 선택해 주세요.');
        const id = 'saf:' + crypto.randomUUID(); selected.set(id, r.picked);
        return { id, name: r.picked.name, folder: '선택한 파일', size: r.bytes.length, modified: 0, format: r.picked.format, mime: r.picked.mime, external: true };
      }
      throw new Error('[NotAllowed] 이 문서는 다시 선택해야 열 수 있어요.');
    }
    case 'recentRemove': recents.delete(a.id); return true;
    case 'recentClear': recents.clear(); return true;
    case 'clipboardWrite': { const text = String(a.text ?? ''), html = String(a.html ?? ''); if (text.length > 1000000 || html.length > 1000000) throw new Error('클립보드 내용이 너무 커요.'); clipboard = { text, html, image: null }; return true; }
    case 'newDocument': {
      if (!['hwp', 'hwpx', 'hml'].includes(a.format)) throw new Error('문서 형식을 확인해 주세요.');
      const id = 'new:' + crypto.randomUUID(); newDocuments.set(id, a.format); return {id, format: a.format};
    }
    case 'listDirs': {
      const d = inside(a.path);
      const files = fs.readdirSync(d, { withFileTypes: true }).filter(e => e.isFile() && !e.name.startsWith('.') && /\.(hwp|hwpx|hml|pdf|html|htm|doc|mhtml|mht|txt|svg|png|jpg|jpeg)$/i.test(e.name)).map(e => e.name);
      return { path: d, writable: true, files, filesTruncated: false, folders: fs.readdirSync(d, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => { const p = path.join(d, e.name); return { path: p, name: e.name, modified: fs.statSync(p).mtimeMs, count: fs.readdirSync(p).length }; }) };
    }
    case 'mkdir': { name(a.name); const p = inside(path.join(inside(a.parent), a.name)); if (fs.existsSync(p)) throw new Error('같은 이름의 항목이 있어요.'); fs.mkdirSync(p); return { path: p }; }
    case 'rename': case 'move': {
      const f = doc(a.id), target = op === 'rename' ? path.join(path.dirname(f), a.name) : inside(path.join(inside(a.parent), path.basename(f)));
      if (op === 'rename') { name(a.name); if (ext(a.name) !== ext(f)) throw new Error('확장자는 변경할 수 없어요.'); }
      if (target === f) throw new Error('현재 폴더와 같은 위치예요.');
      if (fs.existsSync(target)) throw new Error('같은 이름의 파일이 있어요. 다른 폴더를 선택해 주세요.');
      fs.renameSync(f, target); docs.delete(a.id); return record(target);
    }
    case 'delete': { const f = doc(a.id); fs.unlinkSync(f); docs.delete(a.id); return true; }
    case 'beginSave': {
      if (cfg.strict && upload) throw new Error('저장 중이에요. 잠시 기다려 주세요.');
      const draft = a.id.startsWith('draft:') ? drafts.get(a.id.slice(6)) : null;
      const fresh = newDocuments.get(a.id), pickedFile = selected.get(a.id);
      if (draft && a.replace) throw new Error('복구한 내용은 다른 이름으로 저장해 주세요.');
      if (fresh && a.replace) throw new Error('새 문서는 다른 이름으로 저장해 주세요.');
      if (pickedFile && a.replace) throw new Error('선택한 파일 원본은 유지해요. 다른 이름으로 저장해 주세요.');
      const src = fresh ? 'new.' + fresh : pickedFile ? pickedFile.name : draft ? draft.name : doc(a.id), target = inside(a.target);
      const format = a.format || ext(src);
      if (a.studio && (!['hwp', 'hwpx', 'hml'].includes(format) || ext(target) !== format)) throw new Error('저장할 문서 형식이 일치하지 않아요.');
      // Same as MainActivity: a confirmed "Save as" onto another existing file replaces it (hash taken now, backup kept).
      let replace = !!a.replace, sha = a.sha, overwrite = false;
      if (!replace && a.overwrite) {
        if (!fs.existsSync(target) || !fs.statSync(target).isFile()) throw new Error('덮어쓸 파일을 찾을 수 없어요. 다시 골라 주세요.');
        if (target === src) throw new Error('지금 연 문서예요. 저장(Ctrl+S)을 눌러 주세요.');
        overwrite = true; replace = true; sha = crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
      }
      if (ext(target) !== ext(src) && (!a.studio || (replace && !overwrite))) throw new Error('원래 문서 형식을 유지해 주세요.');
      if (a.studio && replace && !/^[0-9a-f]{64}$/.test(sha || '')) throw new Error('원본 확인 정보가 없어요. 문서를 다시 열어 주세요.');
      if (replace && !overwrite && target !== src) throw new Error('원본 저장 경로가 일치하지 않아요.');
      if (!replace && fs.existsSync(target)) throw new Error('같은 이름의 파일이 있어요. 이름이나 폴더를 바꿔 주세요.');
      if (!(a.length >= 8 && a.length <= MAX_BYTES)) throw new Error('저장할 문서가 너무 커요.');
      upload = { token: crypto.randomUUID(), kind: 'document', target, source: a.id, studio: !!a.studio, replace, backup: !!a.backup || (!!a.studio && replace), sha, length: a.length, parts: [], seq: 0 }; return upload.token;
    }
    case 'beginExport': {
      if (cfg.strict && upload) throw new Error('저장 중이에요. 잠시 기다려 주세요.');
      const target = inside(a.target), e = target.split('.').pop().toLowerCase();
      name(path.basename(target));
      if (!['html', 'htm', 'doc', 'mhtml', 'mht', 'txt', 'svg', 'png', 'jpg', 'jpeg', 'hml'].includes(e)) throw new Error('지원하지 않는 내보내기 형식이에요.');
      if (fs.existsSync(target)) throw new Error('같은 이름의 파일이 있어요. 이름을 바꿔 주세요.');
      if (!(a.length >= 1 && a.length <= MAX_BYTES)) throw new Error('내보내기 결과가 32MB를 넘거나 비어 있어요.');
      upload = { token: crypto.randomUUID(), kind: 'export', target, length: a.length, parts: [], seq: 0 }; return upload.token;
    }
    case 'finishExport': {
      const u = upload; upload = null; if (!u || u.token !== a.token || u.kind !== 'export') throw new Error('저장 세션이 만료되었어요.');
      const bytes = Buffer.concat(u.parts); if (bytes.length !== u.length) throw new Error('내보내기 크기가 일치하지 않아요.');
      validateExport(bytes, u.target); if (fs.existsSync(u.target)) throw new Error('같은 이름의 파일이 있어요. 이름을 바꿔 주세요.');
      fs.writeFileSync(u.target, bytes, { flag: 'wx' }); return { path: u.target };
    }
    case 'saveChunk': { const u = upload && upload.token === a.token ? upload : draftUpload && draftUpload.token === a.token ? draftUpload : stateUpload && stateUpload.token === a.token ? stateUpload : null; if (!u) throw new Error('저장 세션이 만료되었어요.'); if (a.seq !== u.seq++) throw new Error('저장 순서가 올바르지 않아요.'); if (typeof a.base64 !== 'string' || a.base64.length > 350000) throw new Error('저장 조각이 너무 커요.'); const part = Buffer.from(a.base64, 'base64'); if (u.parts.reduce((n, p) => n + p.length, 0) + part.length > u.length) throw new Error('저장 크기가 일치하지 않아요.'); u.parts.push(part); return true; }
    case 'beginDraft': { if (cfg.strict && draftUpload) throw new Error('복구 자료를 저장하고 있어요.'); if (!(a.length >= 8 && a.length <= MAX_BYTES)) throw new Error('복구 자료의 크기가 올바르지 않아요.'); draftUpload = { token: crypto.randomUUID(), seq: 0, parts: [], length: a.length, id: a.id, info: { name: a.name, path: a.path, folder: a.folder, format: a.format, encrypted: !!a.encrypted, external: !!a.external, docId: a.docId, lossy: !!a.lossy } }; return draftUpload.token; }
    case 'finishDraft': { const u = draftUpload; draftUpload = null; if (!u || u.token !== a.token) throw new Error('복구 저장 세션이 만료되었어요.'); const bytes = Buffer.concat(u.parts); if (bytes.length !== u.length) throw new Error('복구 자료 크기가 일치하지 않아요.'); const key = u.id.startsWith('draft:') ? u.id.slice(6) : draftKey(u.id); drafts.set(key, { ...u.info, key, bytes, size: bytes.length, savedAt: Date.now() }); return { key }; }
    case 'abortDraft': draftUpload = null; return true;
    case 'listDrafts': return [...drafts.values()].sort((x, y) => y.savedAt - x.savedAt).map(({ bytes, ...d }) => d);
    case 'readDraft': { const d = drafts.get(a.key || (a.id.startsWith('draft:') ? a.id.slice(6) : draftKey(a.id))); if (!d) throw new Error('복구 항목을 찾을 수 없어요.'); const t = putBlob(d.bytes); return { url: '/document/' + t, token: t, sha: sha(d.bytes), meta: { id: 'draft:' + d.key, name: d.name, path: d.path, folder: d.folder, size: d.size, modified: d.savedAt, format: d.format, external: true, draft: true, encrypted: d.encrypted } }; }
    case 'discardDraft': drafts.delete(a.key || (a.id.startsWith('draft:') ? a.id.slice(6) : draftKey(a.id))); return true;
    case 'abortSave': upload = null; return true;
    case 'finishSave': {
      const u = upload; upload = null; if (!u || u.token !== a.token || u.kind !== 'document') throw new Error('저장 세션이 만료되었어요.');
      const bytes = Buffer.concat(u.parts); if (bytes.length !== u.length) throw new Error('저장 크기가 일치하지 않아요.');
      let backup = null;
      if (u.replace) {
        if (sha(fs.readFileSync(u.target)) !== u.sha) throw new Error('다른 앱에서 문서가 바뀌었어요. 다른 이름으로 저장해 주세요.');
        if (u.backup && (u.studio || ext(u.target) === 'hwp')) { const e = ext(u.target), b = u.target.replace(/\.[^.]+$/, '_백업_preview.' + e); fs.copyFileSync(u.target, b); backup = record(b); }
      }
      fs.writeFileSync(u.target, bytes); newDocuments.delete(u.source); return { meta: record(u.target), sha: sha(bytes), backup };
    }
    case 'beginPdf': { if (pdf) throw new Error('다른 PDF를 만들고 있어요.'); const t = inside(a.target); if (!t.endsWith('.pdf') || fs.existsSync(t)) throw new Error('같은 이름의 파일이 있거나 PDF 이름이 올바르지 않아요.'); if (!Number.isInteger(a.count) || a.count < 1) throw new Error('PDF로 저장할 쪽이 없어요.'); pdf = { target: t, count: a.count, pages: [] }; return true; }
    case 'startPrint': {
      if (printJob) throw new Error('열려 있는 인쇄 작업을 마쳐 주세요.');
      const indices = a.count > 2 ? [0, a.count - 1] : Array.from({length: a.count}, (_, i) => i);
      printJob = {job: a.job, name: a.name, indices, pages: [], token: crypto.randomUUID(), upload: null};
      events.push(['printPage', {job: a.job, token: printJob.token, index: indices[0], widthPt: 595, heightPt: 842, dpi: 300}]);
      return true;
    }
    case 'printPageBegin': {
      if (printJob?.token !== a.token || printJob.upload) throw new Error('인쇄 쪽 요청이 끝났어요.');
      printJob.upload = {width: a.width, height: a.height, length: a.length, bytes: 0, seq: 0};
      return true;
    }
    case 'printPageChunk': {
      if (printJob?.token !== a.token || !printJob.upload || printJob.upload.seq++ !== a.seq) throw new Error('인쇄 조각의 순서가 올바르지 않아요.');
      printJob.upload.bytes += Buffer.from(a.base64, 'base64').length;
      return true;
    }
    case 'printPageEnd': {
      const u = printJob?.upload;
      if (printJob?.token !== a.token || !u || u.bytes !== u.length) throw new Error('인쇄 쪽 데이터가 일치하지 않아요.');
      printJob.pages.push({index: printJob.indices.shift(), width: u.width, height: u.height, bytes: u.bytes});
      if (printJob.indices.length) {
        printJob.token = crypto.randomUUID(); printJob.upload = null;
        events.push(['printPage', {job: printJob.job, token: printJob.token, index: printJob.indices[0], widthPt: 595, heightPt: 842, dpi: 300}]);
      } else {
        printed.push({name: printJob.name, pages: printJob.pages});
        events.push(['printEnd', {job: printJob.job}]);
        printJob = null;
      }
      return true;
    }
    case 'printPageFail': {
      if (printJob?.token === a.token) { events.push(['printEnd', {job: printJob.job}]); printJob = null; }
      return true;
    }
    case 'beginPdfPage': {
      if (!pdf || upload || a.index !== pdf.pages.length) throw new Error('PDF 페이지 순서가 올바르지 않아요.');
      if (!(a.length >= 8 && a.length <= 8 * 1024 * 1024) || !(a.width >= 36 && a.width <= 2000 && a.height >= 36 && a.height <= 2000)) throw new Error('PDF 페이지의 크기가 너무 커요.');
      upload = { token: crypto.randomUUID(), kind: 'pdf', parts: [], seq: 0, length: a.length, width: a.width, height: a.height }; return upload.token;
    }
    case 'finishPdfPage': { const u = upload; upload = null; if (!pdf || !u || u.token !== a.token || u.kind !== 'pdf') throw new Error('PDF 페이지 데이터가 일치하지 않아요.'); const png = Buffer.concat(u.parts); if (png.length !== u.length || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('PDF 이미지를 읽지 못했어요.'); pdf.pages.push({ png, width: u.width, height: u.height }); return true; }
    case 'finishPdf': { if (!pdf || pdf.pages.length !== pdf.count) throw new Error('PDF 페이지가 모두 준비되지 않았어요.'); fs.writeFileSync(pdf.target, Buffer.from('%PDF-1.4 preview stub, ' + pdf.pages.length + ' PNG pages\n')); const t = pdf.target; pdf = null; return { path: t }; }
    case 'abortPdf': pdf = null; upload = null; return true;
    case 'permission': return true;
    case 'exit': return true;
  }
  throw new Error('지원하지 않는 작업이에요.');
}

const shim = `(()=>{const q=[];
window.OfflineNative={workspaceEnabled(){return false;},postMessage(m){const {id,op,args}=JSON.parse(m);fetch('/__native',{method:'POST',body:m}).then(r=>r.json()).then(r=>{for(const [n,d] of r.events)window.NativeEvent&&window.NativeEvent(n,d);window.NativeReply(id,r.reply);if(op==='permission')setTimeout(()=>window.NativeEvent&&window.NativeEvent('resume',true),400);});}};
window.__mock={grant:v=>fetch('/__grant?'+(v?1:0)).then(()=>window.NativeEvent('resume',true)),resume:()=>window.NativeEvent('resume',true)};})();`;
// Tagged (workspace) pages: same shim + x-view header on every native call + an SSE channel for native pushes. Untagged pages never get this.
const taggedShim = (tag, enabled) => `(()=>{const tag=${JSON.stringify(tag)};
// Synchronous capability like EditorSession.Bridge.workspaceEnabled(): true only when this page is tagged AND the workspace controller mock was enabled when the page was served.
window.OfflineNative={workspaceEnabled(){return ${enabled ? 'true' : 'false'};},postMessage(m){const {id,op}=JSON.parse(m);fetch('/__native',{method:'POST',headers:{'x-view':tag},body:m}).then(r=>r.json()).then(r=>{for(const [n,d] of r.events)window.NativeEvent&&window.NativeEvent(n,d);window.NativeReply(id,r.reply);if(op==='permission')setTimeout(()=>window.NativeEvent&&window.NativeEvent('resume',true),400);});}};
window.__mock={grant:v=>fetch('/__grant?'+(v?1:0)).then(()=>window.NativeEvent('resume',true)),resume:()=>window.NativeEvent('resume',true),view:tag};
const deliver=(frame,n=0)=>{try{if(frame.kind==='event'&&window.NativeEvent)return window.NativeEvent(frame.name,frame.data);if(frame.kind==='call'&&typeof window[frame.fn]==='function')return window[frame.fn](...frame.args);}catch(e){setTimeout(()=>{throw e});return;}if(n<100)setTimeout(()=>deliver(frame,n+1),100);};
const source=new EventSource('/__events?view='+encodeURIComponent(tag));source.onmessage=e=>deliver(JSON.parse(e.data));})();`;

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs':'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.svg':'image/svg+xml', '.png': 'image/png', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8' };
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  // /__delay?op=finishSave&ms=7000 makes the bridge take that long to START an operation, like a save that is slow to finish (0 = off).
  const view = url.searchParams.get('view') || '';
  if (view && !TAG.test(view)) { res.statusCode = 400; return res.end('bad view'); }
  const viewTag = () => view;
  const scopeKey = () => (url.searchParams.get('view') ? url.searchParams.get('view') + '|' : '') + url.searchParams.get('op');  // optional view= scopes a control to one session
  if (url.pathname === '/__delay') { delays[scopeKey()] = Number(url.searchParams.get('ms')) || 0; return res.end('ok'); }
  if (url.pathname === '/__native') {
    let body = ''; req.on('data', c => body += c);
    req.on('end', () => {
      const tag = String(req.headers['x-view'] || '');
      if (tag && !TAG.test(tag)) { res.statusCode = 400; return res.end('bad view'); }
      const m = JSON.parse(body), events = [], scoped = k => (tag && k.has?.(tag + '|' + m.op)) ? tag + '|' + m.op : k.has?.(m.op) ? m.op : null;
      setTimeout(() => {
        let reply;
        try {
          const f = (tag && failures.get(tag + '|' + m.op)) || failures.get(m.op);
          if (f && f.times > 0) { f.times--; throw new Error(f.message); }
          const data = String(m.op).startsWith('workspace') ? workspaceOperation(m.op, m.args || {}, tag) : inSession(tag, () => tagUrls(operation(m.op, m.args || {}, events), tag));
          reply = { ok: true, data };
          if (tag && events.some(e => e[0] === 'fontsChanged')) pushAll({ kind: 'event', name: 'fontsChanged', data: true }, tag);
        } catch (e) { reply = { ok: false, error: e.message }; }
        const args = Object.fromEntries(Object.entries(m.args || {}).map(([k, v]) => [k, k === 'base64' ? `<${String(v).length} chars>` : v]));
        opLog.push({ op: m.op, args, ok: reply.ok, error: reply.error, ...(tag ? { view: tag } : {}) });
        const send = () => res.end(JSON.stringify({ reply, events }));
        const key = scoped(holds);
        if (key) held.push({ op: m.op, key, send }); else send();
      }, (tag && delays[tag + '|' + m.op]) || delays[m.op] || 0);
    });
    return;
  }
  if (url.pathname === '/__config') { cfg.strict = url.searchParams.get('strict') === '1'; return res.end('ok'); }
  if (url.pathname === '/__fail') { failures.set(scopeKey(), { message: url.searchParams.get('message') || '시험용 실패', times: Number(url.searchParams.get('times') || 1) }); return res.end('ok'); }
  if (url.pathname === '/__hold') { holds.add(scopeKey()); return res.end('ok'); }
  if (url.pathname === '/__release') { const key = scopeKey(); holds.delete(key); for (const h of held.splice(0).filter(h => { if (h.key === key) return true; held.push(h); return false; })) h.send(); return res.end('ok'); }
  if (url.pathname === '/__pick') {
    if (url.searchParams.get('cancel') === '1') { inSession(viewTag(), () => pickQueue.push({ cancel: true })); return res.end('ok'); }
    const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => inSession(viewTag(), () => { const nameValue = url.searchParams.get('name'), e = ext(nameValue), image = /\.(png|jpe?g)$/i.test(nameValue); pickQueue.push({ name: nameValue, kind: url.searchParams.get('kind') || (image ? 'image' : 'document'), bytes: Buffer.concat(chunks), format: image ? 'image' : e, mime: image ? (/png$/i.test(nameValue) ? 'image/png' : 'image/jpeg') : '' }); res.end('ok'); })); return;
  }
  if (url.pathname === '/__pickfont') {
    const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => { fontQueue.push({ bytes: Buffer.concat(chunks), family: url.searchParams.get('family') || 'QA Font', style: url.searchParams.get('style') || 'Regular', weight: Number(url.searchParams.get('weight') || 400) }); res.end('ok'); }); return;
  }
  // Native process restart: transient in-memory state (upload/draft/pdf slots, blobs, issued new-document ids, picks) is lost; drafts, fonts and files persist.
  if (url.pathname === '/__restart') { for (const [tag, v] of sessions) sessions.set(tag, { ...blankSession(), drafts: v.drafts }); closeTokens.clear(); upload = pdf = printJob = draftUpload = stateUpload = null; blobs.clear(); newDocuments.clear(); selected.clear(); docs.clear(); held.splice(0); holds.clear(); pickQueue.length = 0; openQueue.length = 0; return res.end('ok'); }
  if (url.pathname === '/__state') {  // /__state?unreadableHistory=N  /__state?persistable=0|1  /__state?revoke=1 (revoke every kept document grant)
    const q = url.searchParams;
    if (q.has('unreadableHistory')) historyUnreadable = Number(q.get('unreadableHistory'));
    if (q.has('persistable')) recentPersistable = q.get('persistable') === '1';
    if (q.get('revoke') === '1') for (const r of recents.values()) if (r.uri) revokedGrants.add(r.uri);
    return res.end('ok');
  }
  if (url.pathname === '/__openrequest') {  // POST bytes + ?name= : a file another app opened with / shared to the app (content:// handed over by Android)
    const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => inSession(viewTag(), () => { const nameValue = url.searchParams.get('name'), bytes = Buffer.concat(chunks), id = 'saf:' + crypto.randomUUID(); selected.set(id, { name: nameValue, kind: 'document', bytes, format: ext(nameValue), mime: '' }); openQueue.push({ id, name: nameValue, folder: '선택한 파일', size: bytes.length, modified: 0, format: ext(nameValue), mime: '', external: true }); res.end('ok'); })); return;
  }
  if (url.pathname === '/__log') { res.setHeader('content-type', 'application/json'); const only = url.searchParams.get('view'); return res.end(JSON.stringify({ ops: only == null ? opLog : opLog.filter(o => (o.view || '') === only), printed, clipboard: { text: clipboard.text, html: clipboard.html, imageBytes: clipboard.image ? clipboard.image.length : 0 }, historyIds: [...history.keys()], recentCount: recents.size, pendingHeld: held.length, ...(sessions.size ? { sessions: Object.fromEntries([...sessions].map(([t, v]) => [t, { drafts: [...v.drafts.values()].map(({ bytes, ...d }) => d), blobs: v.blobs.size, uploadOpen: !!v.upload, draftUploadOpen: !!v.draftUpload }])) } : {}) })); }
  if (url.pathname === '/__logclear') { opLog = []; printed.length = 0; return res.end('ok'); }
  if (url.pathname === '/__reset') { sessions.clear(); workspace = null; initialActions.clear(); openCreated.clear(); closeTokens.clear(); rejected = []; opLog = []; printed.length = 0; failures.clear(); holds.clear(); held.splice(0); pickQueue.length = 0; fontQueue.length = 0; selected.clear(); fonts.clear(); blobs.clear(); newDocuments.clear(); drafts.clear(); upload = pdf = printJob = draftUpload = null; clipboard = { text: '', html: '', image: null }; openQueue.length = 0; history.clear(); recents.clear(); stateUpload = null; historyUnreadable = 0; recentPersistable = true; revokedGrants.clear(); cfg.strict = false; return res.end('ok'); }
  if (url.pathname === '/__termux') { termux = url.search === '?1'; return res.end('ok'); }
  if (url.pathname === '/__grant') { permission = url.search === '?1'; return res.end('ok'); }
  if (url.pathname === '/__mock.js') { res.setHeader('content-type', 'text/javascript'); res.setHeader('cache-control', 'no-store'); return res.end(view ? taggedShim(view, !!workspace) : shim); }
  if (url.pathname.startsWith('/document/')) { const b = inSession(viewTag(), () => blobs.get(url.pathname.slice(10))); if (!b) { res.statusCode = 403; return res.end(); } return res.end(b); }
  if (url.pathname === '/__events') {  // SSE for a tagged page
    const tag = viewTag(); if (!tag) { res.statusCode = 400; return res.end(); }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' }); res.write(': open\n\n');
    if (!listeners.has(tag)) listeners.set(tag, new Set()); listeners.get(tag).add(res);
    req.on('close', () => { listeners.get(tag)?.delete(res); if (!listeners.get(tag)?.size) listeners.delete(tag); });
    if (workspace) push(tag, { kind: 'event', name: 'workspaceChanged', data: workspace.snapshot(tag) });
    return;
  }
  // /__workspace?enable=1&tabs=A,B,C[&split=1]  configure the oracle controller (explicit MOCK; tab ids = view tags) | ?disable=1 | no query = JSON state
  if (url.pathname === '/__workspace') {
    const q = url.searchParams;
    if (q.get('disable') === '1') { workspace = null; closeTokens.clear(); }
    if (q.get('enable') === '1') {
      workspace = new WorkspaceOracle(Number(q.get('max') || 8)); closeTokens.clear(); rejected = []; initialActions.clear(); openCreated.clear();
      for (const id of (q.get('tabs') || '').split(',').filter(Boolean)) workspace.createTab(id);
      if (q.get('split') === '1') workspace.setSplit(true, workspace.primaryId);
      broadcastWorkspace();
    }
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify(workspace ? { enabled: true, ...workspace.snapshot(''), mock: 'workspace-oracle', visible: workspace.visible(), mru: workspace.mru, pendingCloseTokens: closeTokens.size, pendingInitial: Object.fromEntries(initialActions), rejected, connected: [...listeners.keys()], problems: workspace.checkInvariants() } : { enabled: false, connected: [...listeners.keys()] }));
  }
  if (url.pathname === '/__harness.html') { res.setHeader('content-type', 'text/html; charset=utf-8'); return res.end(fs.readFileSync(new URL('studio-host-harness.html', import.meta.url))); }
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
  const file = new URL(rel, assets);
  if (!file.href.startsWith(assets.href) || !fs.existsSync(file)) { res.statusCode = 404; return res.end(); }
  let body = fs.readFileSync(file);
  if (rel === 'index.html') body = Buffer.from(body.toString().replace('<script src="icons.js" defer></script>', '<script src="__mock.js' + (view ? '?view=' + view : '') + '"></script><script src="icons.js" defer></script>'));
  if (rel === 'studio/index.html') body = Buffer.from(body.toString().replace('<head>', '<head><script src="/__mock.js' + (view ? '?view=' + view : '') + '"></script>'));
  res.setHeader('content-type', types[path.extname(rel)] || 'application/octet-stream');
  res.end(body);
}).listen(port, () => console.log(`preview http://localhost:${port}  sandbox ${volume}`));

