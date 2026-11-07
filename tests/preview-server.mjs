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
const docs = new Map(), blobs = new Map();
let upload = null, pdf = null, draftUpload = null;
const delays = {};
// Recovery drafts survive a page reload, like the app's private storage survives a process kill.
const drafts = new Map();
const draftKey = id => crypto.createHash('sha256').update(id).digest('hex').slice(0, 32);
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const ext = f => /\.hwpx$/i.test(f) ? 'hwpx' : /\.hwp$/i.test(f) ? 'hwp' : /\.pdf$/i.test(f) ? 'pdf' : '';
function inside(p) { const r = path.normalize(p); if (r !== volume && !r.startsWith(volume + path.sep)) throw new Error('기기 저장공간 안의 경로를 선택해 주세요.'); return r; }
function record(f) { const id = sha(Buffer.from(f)); docs.set(id, f); const st = fs.statSync(f); return { id, name: path.basename(f), path: f, folder: path.dirname(f), size: st.size, modified: st.mtimeMs, format: ext(f) }; }
function termuxRecord() { const id = sha(Buffer.from('termux:' + termuxFile)); docs.set(id, termuxFile); const st = fs.statSync(termuxFile); return { id, name: path.basename(termuxFile), path: 'content://com.termux.documents/mock', folder: 'Termux · hwpxxx-project/nested', size: st.size, modified: st.mtimeMs, format: 'hwpx', external: true }; }
function doc(id) { const f = docs.get(id); if (!f || !fs.existsSync(f)) throw new Error('문서 목록을 새로고침한 뒤 다시 선택해 주세요.'); return f; }
function name(n) { if (!n || !n.trim()) throw new Error('이름을 입력해 주세요.'); if (n !== n.trim() || /[\\/\x00-\x1f\x7f]/.test(n)) throw new Error('이름의 앞뒤 공백, /, \\ 또는 제어 문자를 지우고 240바이트 이내로 입력해 주세요.'); }

function operation(op, a, events) {
  // Same ungated set as MainActivity.UNGATED; read/scan re-check the permission for shared-storage documents below.
  if (!['status', 'release', 'scan', 'read', 'disconnectFolder', 'abortSave', 'abortPdf', 'listDrafts', 'beginDraft', 'finishDraft', 'abortDraft', 'readDraft', 'discardDraft', 'saveChunk'].includes(op) && !permission) throw new Error('문서에 접근하려면 파일 접근을 허용해 주세요.');
  switch (op) {
    case 'status': return { permission, connectedFolders: termux ? [{ id: 'termux-mock', name: 'Termux · hwpxxx-project', active: true }] : [], volumes: [{ path: volume, name: '내장 저장공간' }], version: '0.2.0', engine: 'rhwp 0.8.7' };
    case 'scan': {
      const found = [];
      const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.hwpx?$/i.test(e.name)) found.push(record(p)); } };
      if (permission) walk(volume); if (termux) found.push(termuxRecord()); events.push(['scanBatch', found]); return { cancelled: false, limited: false, skipped: 0, count: found.length };
    }
    case 'cancelScan': return true;
    case 'disconnectFolder': termux = false; events.push(['foldersChanged', true]); return true;
    case 'read': { const linked = termux && a.id === termuxRecord().id; if (!linked && !permission) throw new Error('문서에 접근하려면 파일 접근을 허용해 주세요.'); const f = doc(a.id), b = fs.readFileSync(f), t = crypto.randomUUID(); blobs.set(t, b); return { url: '/document/' + t, token: t, sha: sha(b), meta: (linked ? termuxRecord() : record(f)) }; }
    case 'release': blobs.delete(a.token); return true;
    case 'listDirs': {
      const d = inside(a.path);
      return { path: d, writable: true, folders: fs.readdirSync(d, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => { const p = path.join(d, e.name); return { path: p, name: e.name, modified: fs.statSync(p).mtimeMs, count: fs.readdirSync(p).length }; }) };
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
      const draft = a.id.startsWith('draft:') ? drafts.get(a.id.slice(6)) : null;
      if (draft && a.replace) throw new Error('복구한 내용은 다른 이름으로 저장해 주세요.');
      const src = draft ? draft.name : doc(a.id), target = inside(a.target);
      if (ext(target) !== ext(src)) throw new Error('원래 문서 형식을 유지해 주세요.');
      if (a.replace && target !== src) throw new Error('원본 저장 경로가 일치하지 않아요.');
      if (!a.replace && fs.existsSync(target)) throw new Error('같은 이름의 파일이 있어요. 이름이나 폴더를 바꿔 주세요.');
      upload = { token: crypto.randomUUID(), kind: 'document', target, replace: !!a.replace, backup: !!a.backup, sha: a.sha, length: a.length, parts: [], seq: 0 }; return upload.token;
    }
    case 'saveChunk': { const u = upload && upload.token === a.token ? upload : draftUpload && draftUpload.token === a.token ? draftUpload : null; if (!u) throw new Error('저장 세션이 만료되었어요.'); if (a.seq !== u.seq++) throw new Error('저장 순서가 올바르지 않아요.'); u.parts.push(Buffer.from(a.base64, 'base64')); return true; }
    case 'beginDraft': { draftUpload = { token: crypto.randomUUID(), seq: 0, parts: [], length: a.length, id: a.id, info: { name: a.name, path: a.path, folder: a.folder, format: a.format, encrypted: !!a.encrypted, external: !!a.external, docId: a.docId, lossy: !!a.lossy } }; return draftUpload.token; }
    case 'finishDraft': { const u = draftUpload; draftUpload = null; if (!u || u.token !== a.token) throw new Error('복구 저장 세션이 만료되었어요.'); const bytes = Buffer.concat(u.parts); if (bytes.length !== u.length) throw new Error('복구 자료 크기가 일치하지 않아요.'); const key = u.id.startsWith('draft:') ? u.id.slice(6) : draftKey(u.id); drafts.set(key, { ...u.info, key, bytes, size: bytes.length, savedAt: Date.now() }); return { key }; }
    case 'abortDraft': draftUpload = null; return true;
    case 'listDrafts': return [...drafts.values()].sort((x, y) => y.savedAt - x.savedAt).map(({ bytes, ...d }) => d);
    case 'readDraft': { const d = drafts.get(a.key || (a.id.startsWith('draft:') ? a.id.slice(6) : draftKey(a.id))); if (!d) throw new Error('복구 항목을 찾을 수 없어요.'); const t = crypto.randomUUID(); blobs.set(t, d.bytes); return { url: '/document/' + t, token: t, sha: sha(d.bytes), meta: { id: 'draft:' + d.key, name: d.name, path: d.path, folder: d.folder, size: d.size, modified: d.savedAt, format: d.format, external: true, draft: true, encrypted: d.encrypted } }; }
    case 'discardDraft': drafts.delete(a.key || (a.id.startsWith('draft:') ? a.id.slice(6) : draftKey(a.id))); return true;
    case 'abortSave': upload = null; return true;
    case 'finishSave': {
      const u = upload; upload = null; if (!u || u.token !== a.token) throw new Error('저장 세션이 만료되었어요.');
      const bytes = Buffer.concat(u.parts); if (bytes.length !== u.length) throw new Error('저장 크기가 일치하지 않아요.');
      let backup = null;
      if (u.replace) { if (sha(fs.readFileSync(u.target)) !== u.sha) throw new Error('다른 앱에서 문서가 바뀌었어요. 다른 이름으로 저장해 주세요.'); if (u.backup && ext(u.target) === 'hwp') { const b = u.target.replace(/\.hwp$/i, '_백업_preview.hwp'); fs.copyFileSync(u.target, b); backup = record(b); } }
      fs.writeFileSync(u.target, bytes); return { meta: record(u.target), sha: sha(bytes), backup };
    }
    case 'beginPdf': { const t = inside(a.target); if (!t.endsWith('.pdf') || fs.existsSync(t)) throw new Error('같은 이름의 파일이 있거나 PDF 이름이 올바르지 않아요.'); pdf = { target: t, count: a.count, pages: [] }; return true; }
    case 'beginPdfPage': upload = { token: crypto.randomUUID(), kind: 'pdf', parts: [], seq: 0, length: a.length }; return upload.token;
    case 'finishPdfPage': { const u = upload; upload = null; pdf.pages.push(Buffer.concat(u.parts)); return true; }
    case 'finishPdf': { fs.writeFileSync(pdf.target, Buffer.from('%PDF-1.4 preview stub, ' + pdf.pages.length + ' PNG pages\n')); const t = pdf.target; pdf = null; return { path: t }; }
    case 'abortPdf': pdf = null; return true;
    case 'permission': return true;
    case 'exit': return true;
  }
  throw new Error('지원하지 않는 작업이에요.');
}

const shim = `(()=>{const q=[];
window.OfflineNative={postMessage(m){const {id,op,args}=JSON.parse(m);fetch('/__native',{method:'POST',body:m}).then(r=>r.json()).then(r=>{for(const [n,d] of r.events)window.NativeEvent&&window.NativeEvent(n,d);window.NativeReply(id,r.reply);if(op==='permission')setTimeout(()=>window.NativeEvent&&window.NativeEvent('resume',true),400);});}};
window.__mock={grant:v=>fetch('/__grant?'+(v?1:0)).then(()=>window.NativeEvent('resume',true)),resume:()=>window.NativeEvent('resume',true)};})();`;

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs':'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.png': 'image/png', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8' };
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  // /__delay?op=finishSave&ms=7000 makes the bridge take that long to START an operation, like a save that is slow to finish (0 = off).
  if (url.pathname === '/__delay') { delays[url.searchParams.get('op')] = Number(url.searchParams.get('ms')) || 0; return res.end('ok'); }
  if (url.pathname === '/__native') { let body = ''; req.on('data', c => body += c); req.on('end', () => { const m = JSON.parse(body), events = []; setTimeout(() => { let reply; try { reply = { ok: true, data: operation(m.op, m.args || {}, events) }; } catch (e) { reply = { ok: false, error: e.message }; } res.end(JSON.stringify({ reply, events })); }, delays[m.op] || 0); }); return; }
  if (url.pathname === '/__termux') { termux = url.search === '?1'; return res.end('ok'); }
  if (url.pathname === '/__grant') { permission = url.search === '?1'; return res.end('ok'); }
  if (url.pathname === '/__mock.js') { res.setHeader('content-type', 'text/javascript'); return res.end(shim); }
  if (url.pathname.startsWith('/document/')) { const b = blobs.get(url.pathname.slice(10)); if (!b) { res.statusCode = 403; return res.end(); } return res.end(b); }
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
  const file = new URL(rel, assets);
  if (!file.href.startsWith(assets.href) || !fs.existsSync(file)) { res.statusCode = 404; return res.end(); }
  let body = fs.readFileSync(file);
  if (rel === 'index.html') body = Buffer.from(body.toString().replace('<script src="icons.js" defer></script>', '<script src="__mock.js"></script><script src="icons.js" defer></script>'));
  res.setHeader('content-type', types[path.extname(rel)] || 'application/octet-stream');
  res.end(body);
}).listen(port, () => console.log(`preview http://localhost:${port}  sandbox ${volume}`));

