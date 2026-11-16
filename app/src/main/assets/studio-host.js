/* Android platform boundary for the pinned desktop Studio. No editing commands live here. */
(() => {
  'use strict';
  if (!globalThis.OfflineNative) return;
  // Install the Android boundary before touching browser-owned properties. A shim
  // failure must never let Studio fall back to browser downloads or IndexedDB.
  const host = {version: 1, startupState: 'initializing'};
  Object.defineProperty(window, 'rhwpAndroidHost', {value: host});
  Object.defineProperty(window, 'AndroidStudioHost', {value: host});
  function installWindowApi(name, value) {
    Object.defineProperty(window, name, {configurable: true, writable: true, value});
  }
  function unavailable() { return Promise.reject(new DOMException('Android 파일 연결을 준비하지 못했어요. 앱을 다시 열어 주세요.', 'NotAllowedError')); }
  try {
  // Block the browser's own pickers until the complete native adapter is installed.
  installWindowApi('showOpenFilePicker', unavailable);
  installWindowApi('showSaveFilePicker', unavailable);
  const MAX_BYTES = 32 * 1024 * 1024;
  // Document-tab workspace (bridge-contract.md). Capability is SYNCHRONOUS and fixed: native's OfflineNative.workspaceEnabled() === true.
  // A host without that method (old fakes, the legacy harness) is a single-document host: no workspace ops are ever sent.
  // Patch 0115 routes file:new-doc / file:open / file:open-recent here whenever `enabled` is true — from the first instant, not after the
  // handshake — and never falls back to replacing the current document. The in-place bypass is a per-command param (androidWorkspaceInPlace).
  const workspaceCapable = (() => { try { return typeof OfflineNative.workspaceEnabled === 'function' && OfflineNative.workspaceEnabled() === true; } catch { return false; } })();
  let workspaceController = null;
  async function workspaceAction(op, args) {
    if (!workspace.enabled) return false;
    try { const reply = await request(op, args); workspaceController?.apply(reply); }
    catch (error) { announce(String(error?.message || error)); } // handled with an error: the current document is never replaced
    return true;
  }
  const workspace = {
    version: 1, enabled: workspaceCapable,
    newDocument: () => workspaceAction('workspaceNew', {open: false}),
    openDocument: () => workspaceAction('workspaceNew', {open: true}),
    async openRecent(id) {
      if (!workspace.enabled) return false;
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(String(id))) throw new Error('최근 문서를 확인하지 못했어요.');
      return workspaceAction('workspaceOpenRecent', {recentId: String(id)});
    },
  };
  host.workspace = workspace;
  let sequence = 0, currentDialog = null, readyStudio = null, fontIntegration = null;
  const pending = new Map(), events = new Map(), handles = new WeakMap();
  const abort = () => new DOMException('취소했습니다.', 'AbortError');
  const denied = error => new DOMException(String(error?.message || error), 'NotAllowedError');
  const extension = name => String(name).split('.').pop().toLowerCase();
  function request(op, args = {}) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        if (op === 'scan') request('cancelScan').catch(() => {});
        reject(new Error('작업 시간이 초과됐어요. 다시 시도해 주세요.'));
      }, ['connectFolder', 'fontImport', 'fontImportFolder', 'pickFile'].includes(op) ? 600000 : op === 'scan' ? 300000 : 60000);
      pending.set(id, {resolve, reject, timer});
      try { OfflineNative.postMessage(JSON.stringify({id, op, args})); }
      catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
    });
  }
  window.NativeReply = (id, reply) => {
    const task = pending.get(id);
    if (!task) return;
    clearTimeout(task.timer); pending.delete(id);
    reply.ok ? task.resolve(reply.data) : task.reject(new Error(reply.error || '파일 작업을 마치지 못했어요.'));
  };
  function subscribe(name, callback) {
    if (!events.has(name)) events.set(name, new Set());
    events.get(name).add(callback);
    return () => events.get(name)?.delete(callback);
  }
  window.NativeEvent = (name, data) => {
    for (const callback of events.get(name) || []) callback(data);
    if (name === 'pause') readyStudio?.android?.flushRecovery().catch(showError);
    if (name === 'fontsChanged') Promise.resolve(fontIntegration?.refresh()).catch(showError);
    if (name === 'openRequest') void drainOpenRequests();
    if (name === 'hostError') void showError(new Error(String(data)));
  };
  async function upload(token, bytes) {
    for (let offset = 0, seq = 0; offset < bytes.length; offset += 196608, seq++) {
      const part = bytes.subarray(offset, offset + 196608);
      let binary = '';
      for (let index = 0; index < part.length; index += 8192) binary += String.fromCharCode(...part.subarray(index, index + 8192));
      await request('saveChunk', {token, seq, base64: btoa(binary)});
    }
  }
  async function readRecord(meta) {
    const result = await request(meta.draft ? 'readDraft' : 'read', meta.draft ? {key: meta.key || meta.id.slice(6)} : {id: meta.id});
    try {
      const response = await fetch(result.url);
      if (!response.ok) throw new Error('문서를 읽지 못했어요.');
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length > MAX_BYTES) throw new Error('32MB를 넘는 문서는 열 수 없어요.');
      return {...result, bytes};
    } finally { await request('release', {token: result.token}).catch(() => {}); }
  }
  function element(tag, text, properties = {}) {
    const node = document.createElement(tag); if (text != null) node.textContent = text;
    Object.assign(node, properties); return node;
  }
  function button(label, callback) {
    const node = element('button', label, {type: 'button'});
    node.addEventListener('click', () => Promise.resolve().then(callback).catch(error => currentDialog?.error(error)));
    return node;
  }
  function openDialog(title) {
    if (currentDialog) throw new Error('열려 있는 대화상자를 먼저 닫아 주세요.');
    const priorFocus = document.activeElement, dialog = element('dialog', null, {className: 'android-host-dialog'});
    const heading = element('h2', title), body = element('div', null, {className: 'android-host-body'});
    const footer = element('div', null, {className: 'android-host-actions'}), message = element('p', '', {className: 'android-host-error'});
    message.setAttribute('role', 'status'); heading.id = 'android-host-title';
    dialog.setAttribute('aria-labelledby', heading.id); dialog.append(heading, body, message, footer);
    const inertNodes = [...document.body.children].filter(node => node !== dialog && !node.inert);
    let resolve, reject, settled = false;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    const finish = (value, error) => {
      if (settled) return; settled = true;
      dialog.close(); dialog.remove(); inertNodes.forEach(node => { node.inert = false; });
      currentDialog = null; priorFocus?.focus?.({preventScroll: true});
      error ? reject(error) : resolve(value);
    };
    const api = {dialog, body, footer, promise, finish: value => finish(value), cancel: () => finish(null, abort()), error: error => { message.textContent = error?.message || String(error); }};
    dialog.addEventListener('cancel', event => { event.preventDefault(); api.cancel(); });
    footer.append(button('취소', api.cancel)); document.body.append(dialog); inertNodes.forEach(node => { node.inert = true; });
    currentDialog = api; dialog.showModal(); return api;
  }
  async function showError(error) {
    if (error?.name === 'AbortError') return;
    if (currentDialog) return currentDialog.error(error);
    const ui = openDialog('작업을 완료하지 못했어요'); ui.error(error);
    ui.footer.replaceChildren(button('닫기', () => ui.finish()));
    await ui.promise.catch(() => {});
  }
  function installStyles() {
    const style = element('style');
    style.textContent = '.android-host-dialog{box-sizing:border-box;width:min(800px,94vw);max-height:90vh;padding:24px;border:1px solid #9da7b5;border-radius:10px;color:CanvasText;background:Canvas;font:14px system-ui;box-shadow:0 16px 70px #0007}.android-host-dialog::backdrop{background:#0006}.android-host-dialog h2{margin:0 0 18px;font-size:19px}.android-host-dialog button,.android-host-dialog input,.android-host-dialog select{font:inherit;padding:9px 12px;border:1px solid #a7b0be;border-radius:5px;color:CanvasText;background:Canvas}.android-host-dialog button{cursor:pointer}.android-host-dialog button:hover{background:color-mix(in srgb,Highlight 14%,Canvas)}.android-host-dialog button:focus-visible,.android-host-dialog input:focus-visible{outline:2px solid Highlight;outline-offset:2px}.android-host-body{display:grid;gap:12px}.android-host-actions,.android-host-tools{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}.android-host-list{max-height:46vh;overflow:auto;display:grid;gap:5px}.android-host-list button{text-align:left;white-space:normal;overflow-wrap:anywhere}.android-host-list small{display:block;opacity:.7}.android-host-error{color:#b33535;min-height:1.4em;white-space:pre-wrap}.android-host-path{overflow-wrap:anywhere;font-size:12px}.android-host-dialog input{box-sizing:border-box;width:100%}.android-host-notice{margin:0;padding:10px 12px;border-radius:6px;background:color-mix(in srgb,Highlight 12%,Canvas)}.android-host-file{margin:0;padding:6px 12px;opacity:.65;overflow-wrap:anywhere}.android-host-list>div{display:flex;align-items:center;justify-content:space-between;gap:8px}.android-host-list>div>button{flex:none}.android-host-dialog button:disabled{opacity:.5;cursor:default}.android-host-dialog [hidden]{display:none}@media (pointer:coarse){.android-host-dialog button,.android-host-dialog input,.android-host-dialog select{min-height:44px}}.android-host-config{position:fixed;bottom:28px;right:8px;z-index:110;padding:4px 8px;font:12px system-ui;color:CanvasText;background:Canvas;border:1px solid #a7b0be;border-radius:5px}';
    document.head.append(style);
  }
  // The list is rebuilt at most once per frame-ish tick and shows one page at a time: a device scan reports up to 10,000 documents in
  // batches of 24, and rebuilding (and sorting) every row for every batch froze the dialog on large storages.
  const OPEN_PAGE = 200;
  const sizeText = bytes => bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + 'MB' : bytes >= 1024 ? Math.round(bytes / 1024) + 'KB' : bytes > 0 ? bytes + 'B' : '';
  const dateText = time => { try { return time > 0 ? new Date(time).toLocaleDateString('ko-KR', {year: 'numeric', month: '2-digit', day: '2-digit'}) : ''; } catch { return ''; } };
  async function pickOpen() {
    const ui = openDialog('문서 열기'), search = element('input', null, {type: 'search', placeholder: '문서 이름 검색'});
    search.setAttribute('aria-label', '문서 이름 검색');
    const tools = element('div', null, {className: 'android-host-tools'}), status = element('p', '문서를 찾고 있어요…');
    const notice = element('p', '', {className: 'android-host-notice', hidden: true});
    const list = element('div', null, {className: 'android-host-list'}), docs = new Map();
    status.setAttribute('role', 'status');
    let scanning = false, timer = 0, shown = OPEN_PAGE, permission = true, summary = '';
    const matches = () => {
      const query = search.value.trim().toLocaleLowerCase();
      return [...docs.values()].filter(item => item.name.toLocaleLowerCase().includes(query)).sort((a, b) => b.modified - a.modified);
    };
    function render() {
      clearTimeout(timer); timer = 0;
      const found = matches();
      list.replaceChildren(...found.slice(0, shown).map(item => {
        const node = button(item.name, () => ui.finish(makeHandle({meta: item})));
        node.append(element('small', [item.folder || '선택한 문서', dateText(item.modified), sizeText(item.size)].filter(Boolean).join(' · '))); return node;
      }));
      if (found.length > shown) list.append(button(`문서 ${found.length - shown}개 더 보기`, () => { shown += OPEN_PAGE; render(); }));
      else if (!found.length && !scanning) list.append(element('p', search.value.trim() ? '이름에 검색어가 들어간 문서가 없어요.' : permission ? '문서를 찾지 못했어요. ‘파일 선택’으로 직접 고를 수 있어요.' : '아직 보여 줄 문서가 없어요.'));
    }
    const schedule = () => { if (!timer) timer = setTimeout(render, 60); };
    const offBatch = subscribe('scanBatch', items => { for (const item of items) docs.set(item.id, item); schedule(); });
    const offProgress = subscribe('scanProgress', progress => { if (scanning && progress) status.textContent = `문서를 찾고 있어요… 폴더 ${progress.folders}개 확인 · 문서 ${docs.size}개`; });
    const allow = button('파일 접근 허용', () => request('permission')), refresh = button('새로고침', () => scan()), stop = button('검색 중지', () => request('cancelScan'));
    function controls() { allow.hidden = permission; notice.hidden = permission; refresh.disabled = scanning; stop.hidden = !scanning; }
    // Without all-files access only linked folders and single picked files are reachable: say so instead of showing an empty list.
    async function checkPermission() {
      try { permission = (await request('status')).permission !== false; } catch { permission = true; }
      notice.textContent = permission ? '' : '기기의 문서를 모두 찾아 보여 드리려면 ‘파일 접근 허용’을 눌러 주세요. 허용하지 않아도 ‘파일 선택’으로 문서를 하나씩 열 수 있어요.';
      controls(); return permission;
    }
    async function scan() {
      if (scanning) return; scanning = true; docs.clear(); shown = OPEN_PAGE; render(); controls(); status.textContent = '문서를 찾고 있어요…';
      try {
        const result = await request('scan');
        summary = `${docs.size}개 문서${result.limited ? ' · 검색 범위에 도달했어요' : ''}${result.cancelled ? ' · 검색 중지' : ''}`; status.textContent = summary;
      } catch (error) { status.textContent = '문서를 끝까지 찾지 못했어요. ‘새로고침’으로 다시 시도해 주세요.'; throw error; }
      finally { scanning = false; controls(); render(); }
    }
    tools.append(button('파일 선택', async () => { const picked = await request('pickFile', {kind: 'document'}); if (picked) ui.finish(makeHandle({meta: picked})); }), button('폴더 연결', async () => { if (await request('connectFolder')) await scan(); }), allow, refresh, stop);
    ui.body.append(search, tools, notice, status, list);
    search.addEventListener('input', () => { shown = OPEN_PAGE; render(); });
    // A keyboard user (DeX) types a name and presses Enter to open the first match.
    search.addEventListener('keydown', event => { if (event.key !== 'Enter' || event.isComposing) return; event.preventDefault(); if (search.value.trim()) list.querySelector('button')?.click(); });
    // Coming back from the system settings screen with access newly granted: find the documents without a manual refresh.
    const offResume = subscribe('resume', async () => { const before = permission; try { if (await checkPermission() && !before) await scan(); } catch (error) { ui.error(error); } });
    controls(); void checkPermission();
    scan().catch(ui.error);
    try { return await ui.promise; } finally { clearTimeout(timer); offBatch(); offProgress(); offResume(); request('cancelScan').catch(() => {}); }
  }
  // ---- save destination -------------------------------------------------------------------------------------------------------
  // The last folder a document was saved to, so the next save does not start at the storage root again. Only a folder path is
  // kept, in the WebView's own storage; when it is unavailable or the folder is gone the dialog falls back to Documents, then the root.
  const FOLDER_KEY = 'hwpxxx.android.saveFolder';
  let lastFolder = '';
  const rememberedFolder = () => { if (lastFolder) return lastFolder; try { return localStorage.getItem(FOLDER_KEY) || ''; } catch { return ''; } };
  function rememberFolder(path) { lastFolder = path; try { localStorage.setItem(FOLDER_KEY, path); } catch { /* storage disabled: this session only */ } }
  const stemOf = name => { const dot = name.lastIndexOf('.'); return dot > 0 ? name.slice(0, dot) : name; };
  /** "보고서.hwp" -> "보고서 (2).hwp" … the first name not taken in the folder (compared case-insensitively, as shared storage does). */
  function freeName(wanted, taken) {
    if (!taken.has(wanted.toLocaleLowerCase())) return wanted;
    const stem = stemOf(wanted), tail = wanted.slice(stem.length);
    for (let index = 2; index < 1000; index++) { const candidate = `${stem} (${index})${tail}`; if (!taken.has(candidate.toLocaleLowerCase())) return candidate; }
    return wanted;
  }
  async function pickDestination(suggestedName, allowed = null, startFolder = null) {
    const info = await request('status');
    const suggested = String(suggestedName || '문서.hwp');
    const ui = openDialog('다른 이름으로 저장'), name = element('input', null, {value: suggested});
    name.setAttribute('aria-label', '파일 이름'); name.setAttribute('enterkeyhint', 'done');
    const location = element('select'), pathText = element('p', '', {className: 'android-host-path'}), list = element('div', null, {className: 'android-host-list'});
    location.setAttribute('aria-label', '저장공간');
    const volumes = info.volumes || [];
    for (const volume of volumes) location.append(element('option', volume.name, {value: volume.path}));
    const volumeOf = folder => volumes.map(volume => volume.path).filter(root => folder === root || folder.startsWith(root + '/')).sort((a, b) => b.length - a.length)[0] || '';
    let path = '', generation = 0, taken = new Set(), complete = false, edited = false;
    name.addEventListener('input', () => { edited = true; });
    const up = button('상위 폴더', async () => { if (path && path !== location.value) await enter(path.slice(0, path.lastIndexOf('/'))); });
    up.disabled = true;
    async function enter(next) {
      const generationAtStart = ++generation, result = await request('listDirs', {path: next});
      if (generationAtStart !== generation || currentDialog !== ui) return;
      path = result.path; pathText.textContent = path;
      const root = volumeOf(path); if (root && location.value !== root) location.value = root;
      up.disabled = !path || path === location.value;
      // Names already in this folder (when the host reports them): shown so a clash is visible before saving, never as a save target.
      const files = Array.isArray(result.files) ? result.files.map(String) : [];
      taken = new Set(files.map(file => file.toLocaleLowerCase())); complete = Array.isArray(result.files) && result.filesTruncated !== true;
      const children = (result.folders || []).sort((a,b) => a.name.localeCompare(b.name));
      const same = allowed ? files.filter(file => allowed.includes('.' + extension(file))) : files;
      list.replaceChildren(...children.map(folder => button('📁 ' + folder.name, () => enter(folder.path))), ...same.sort((a, b) => a.localeCompare(b)).slice(0, 200).map(file => element('p', file, {className: 'android-host-file'})));
      if (!list.childElementCount) list.append(element('p', '하위 폴더가 없어요.', {className: 'android-host-file'}));
      if (!edited) name.value = freeName(suggested, taken);
    }
    // First folder that can be listed: the document's own folder, the last save folder, Documents, the storage root.
    async function start() {
      const root = location.value, candidates = [startFolder, rememberedFolder(), root && root + '/Documents', root].filter((folder, index, all) => folder && volumeOf(folder) && all.indexOf(folder) === index);
      for (const folder of candidates) {
        try { await enter(folder); return; } catch (error) { if (folder === candidates[candidates.length - 1]) throw error; }
      }
    }
    location.addEventListener('change', () => enter(location.value).catch(ui.error));
    ui.body.append(location, pathText, list, name);
    ui.footer.prepend(up, button('새 폴더', async () => {
      const folderName = window.prompt('새 폴더 이름'); if (!folderName) return;
      await request('mkdir', {parent: path, name: folderName}); await enter(path);
    }));
    const save = button('저장', () => {
      let value = name.value;
      // A name typed without an extension gets the one being saved; a different extension is still refused below.
      if (value && !value.includes('.') && allowed?.length) { value += allowed[0]; name.value = value; }
      if (!value || value.trim() !== value || /[\\/\x00-\x1f\x7f]/.test(value)) throw new Error('파일 이름을 확인해 주세요.');
      if (allowed && !allowed.includes('.' + extension(value))) throw new Error('선택한 저장 형식의 확장자를 유지해 주세요.');
      if (!path) throw new Error('저장할 폴더를 선택해 주세요.');
      // Native refuses to overwrite through this dialog; say so here, while the name can still be changed.
      if (complete && taken.has(value.toLocaleLowerCase())) throw new Error(`이 폴더에 같은 이름의 파일이 있어요. 이름을 바꿔 주세요. (예: ${freeName(value, taken)})`);
      rememberFolder(path);
      ui.finish({name: value, target: path + '/' + value});
    });
    ui.footer.append(save);
    name.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); save.click(); } });
    if (!info.permission) { ui.error(new Error('저장하려면 파일 접근을 허용해 주세요.')); ui.footer.prepend(button('파일 접근 허용', () => request('permission'))); }
    else if (location.value) start().catch(ui.error);
    const offResume = subscribe('resume', async () => { try { const now = await request('status'); if (now.permission && !path && location.value) { ui.error(''); await start(); } } catch (error) { ui.error(error); } });
    try { return await ui.promise; } finally { offResume(); }
  }
  /** Folder of the document being edited when it lives in shared storage (never a picked/linked/recovered source). */
  function sourceFolder(record = activeSource()) {
    const meta = record?.meta;
    return meta && !meta.external && !meta.draft && meta.path && meta.folder ? String(meta.folder) : null;
  }
  function activeSource() {
    const state = readyStudio?.android?.getState();
    return state?.fileHandle ? handles.get(state.fileHandle) : null;
  }
  function makeHandle(info) {
    const record = {meta: info.meta || null, target: info.target || info.meta?.path || null, name: String(info.name || info.meta?.name || '문서.hwp'), sha: info.sha || null, source: info.source || null};
    let writing = false;
    const handle = {
      kind: 'file', get name() { return record.name; },
      async getFile() {
        if (!record.meta) throw denied('아직 저장하지 않은 문서예요.');
        const result = await readRecord(record.meta); record.meta = result.meta; record.sha = result.sha;
        return new File([result.bytes], record.name, {lastModified: result.meta.modified || Date.now()});
      },
      async createWritable() {
        if (writing) throw denied('이 문서를 저장하고 있어요.');
        writing = true;
        let chunks = [], size = 0, closed = false;
        return {
          async write(data) {
            if (closed) throw denied('저장 세션이 끝났어요.');
            if (data?.type === 'write') { if (data.position != null && data.position !== size) { closed = true; writing = false; chunks = []; throw denied('순차 저장만 지원해요.'); } data = data.data; }
            const chunk = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : data instanceof ArrayBuffer ? new Uint8Array(data.slice(0)) : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)) : null;
            if (!chunk) { closed = true; writing = false; chunks = []; throw new TypeError('지원하지 않는 저장 데이터예요.'); }
            size += chunk.length; if (size > MAX_BYTES) { closed = true; writing = false; chunks = []; throw new Error('저장 결과가 32MB를 넘어요.'); } chunks.push(chunk);
          },
          async close() {
            if (closed) throw denied('저장 세션이 끝났어요.');
            closed = true; let token;
            try {
              // SAF/Termux/recovery handles are read-only. Their first Save creates a copy.
              if (!record.target || record.meta?.external || record.meta?.draft) {
                const picked = await pickDestination(record.name, ['.' + extension(record.name)], sourceFolder(record.source || record));
                record.target = picked.target; record.name = picked.name;
              }
              const bytes = new Uint8Array(size); let offset = 0;
              for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
              if (!['hwp', 'hwpx', 'hml'].includes(extension(record.name))) {
                token = await request('beginExport', {target: record.target, length: bytes.length});
                await upload(token, bytes); await request('finishExport', {token}); token = null;
                announce('내보냈어요: ' + record.name); return;
              }
              const source = record.source || record;
              let id = source.meta?.id;
              if (!id) id = (await request('newDocument', {format: extension(record.name)})).id;
              const replace = !!(record.meta && !record.meta.external && !record.meta.draft && record.target === record.meta.path);
              if (replace && !record.sha) throw new Error('원본 확인 정보가 없어요. 문서를 다시 열어 주세요.');
              token = await request('beginSave', {id, target: record.target, replace, sha: replace ? record.sha : '', backup: replace, length: bytes.length, format: extension(record.name), studio: true});
              await upload(token, bytes);
              const result = await request('finishSave', {token}); token = null;
              record.meta = result.meta; record.target = result.meta.path; record.sha = result.sha; record.source = null;
              if (result.backup) announce('저장했어요. 원본 백업: ' + result.backup.name);
            } catch (error) {
              // One visible report: Studio's save flow alerts with this message and keeps the document dirty. A host modal here would
              // report twice and hold the failure back until it is dismissed. Only the user's own cancel (AbortError) stays silent.
              throw error?.name === 'AbortError' ? error : new Error(String(error?.message || error));
            }
            finally { if (token) await request('abortSave', {token}).catch(() => {}); writing = false; chunks = []; }
          },
          async abort() { closed = true; chunks = []; writing = false; },
        };
      },
      async isSameEntry(other) {
        const otherRecord = handles.get(other);
        return other === handle || !!(otherRecord && ((record.target && otherRecord.target === record.target) || (record.meta?.id && record.meta.id === otherRecord.meta?.id)));
      },
      async queryPermission() { return record.meta?.external ? 'granted' : (await request('status')).permission ? 'granted' : 'prompt'; },
      async requestPermission() { if ((await request('status')).permission || record.meta?.external) return 'granted'; await request('permission'); return 'prompt'; },
    };
    handles.set(handle, record); return handle;
  }
  // The document picker's outcome is observable by the workspace so a new "open" tab whose picker was cancelled can say so natively.
  const pickerWatchers = new Set();
  const pickerOutcome = outcome => { for (const watcher of [...pickerWatchers]) { pickerWatchers.delete(watcher); try { watcher(outcome); } catch { /* observer failure must not affect opening */ } } };
  installWindowApi('showOpenFilePicker', async () => {
    try { const handle = await pickOpen(); pickerOutcome('picked'); return [handle]; }
    catch (error) { pickerOutcome(error?.name === 'AbortError' ? 'cancelled' : 'failed'); throw error; }
  });
  installWindowApi('showSaveFilePicker', async (options = {}) => {
    const types = (options.types || []).flatMap(type => Object.values(type.accept || {}).flat());
    const picked = await pickDestination(options.suggestedName, types.length ? types : null, sourceFolder());
    return makeHandle({...picked, source: activeSource()});
  });
  // Menu clipboard actions use Android's foreground clipboard. Keyboard paste/copy
  // events continue through WebView and Studio's own rich/internal clipboard code.
  // Text + HTML share one system-clipboard transaction: refuse early and say so (the status bar), never silently drop.
  const CLIPBOARD_LIMIT = 256 * 1024, utf8 = value => new TextEncoder().encode(value).length;
  function checkClipboardSize(text, html) {
    if (utf8(text) + utf8(html) <= CLIPBOARD_LIMIT) return;
    announce('복사한 내용이 너무 커서 클립보드에 넣지 못했어요. (글자·서식 합계 256KB까지)');
    throw new DOMException('클립보드 내용이 너무 커요.', 'NotAllowedError');
  }
  async function releaseClipboardImage(data) { if (data?.image?.token) await request('release', {token: data.image.token}).catch(() => {}); }
  const clipboard = {
    async writeText(text) { checkClipboardSize(String(text), ''); await request('clipboardWrite', {text: String(text), html: ''}); },
    async readText() { const data = await request('clipboardRead'); await releaseClipboardImage(data); return data.text; },
    async write(items) {
      let text = '', html = '', image = null;
      for (const item of items) {
        if (item.types.includes('text/plain')) text = await (await item.getType('text/plain')).text();
        if (item.types.includes('text/html')) html = await (await item.getType('text/html')).text();
        if (item.types.includes('image/png')) image = new Uint8Array(await (await item.getType('image/png')).arrayBuffer());
      }
      checkClipboardSize(text, html);
      if (!image) { await request('clipboardWrite', {text, html}); return; }
      // Images travel as a bounded, signature-checked PNG upload; native publishes it through a private read-only URI.
      if (image.length < 8 || image.length > MAX_BYTES) throw new DOMException('이미지가 너무 커서 복사할 수 없어요.', 'NotAllowedError');
      let token;
      try { token = await request('beginClipboardImage', {length: image.length, text, html}); await upload(token, image); await request('finishClipboardImage', {token}); token = null; }
      finally { if (token) await request('abortSave', {token}).catch(() => {}); }
    },
    async read() {
      const data = await request('clipboardRead'), parts = {'text/plain': new Blob([data.text], {type: 'text/plain'})};
      try {
        if (data.html) parts['text/html'] = new Blob([data.html], {type: 'text/html'});
        if (data.image) {
          const response = await fetch(data.image.url);
          if (!response.ok) throw new Error('클립보드 이미지를 읽지 못했어요.');
          const bytes = new Uint8Array(await response.arrayBuffer());
          if (bytes.length > MAX_BYTES) throw new Error('클립보드 이미지가 32MB를 넘어요.');
          parts['image/png'] = new Blob([bytes], {type: 'image/png'});
        }
      } finally { await releaseClipboardImage(data); }
      return [new ClipboardItem(parts)];
    },
  };
  try { Object.defineProperty(navigator, 'clipboard', {configurable: true, value: clipboard}); }
  catch { /* WebView versions with immutable navigator use normal clipboard events. */ }
  // Input-based image insertion and comparison use the Android SAF picker. The WebView
  // retains its prohibition on arbitrary content:// and file:// resource access.
  const inputClick = HTMLInputElement.prototype.click;
  HTMLInputElement.prototype.click = function() {
    if (this.type !== 'file') return inputClick.call(this);
    const input = this;
    request('pickFile', {kind: /image\//i.test(input.accept) ? 'image' : 'document'}).then(async meta => {
      if (!meta) { input.dispatchEvent(new Event('cancel')); return; }
      const result = await readRecord(meta), transfer = new DataTransfer();
      transfer.items.add(new File([result.bytes], meta.name, {type: meta.mime || '', lastModified: meta.modified || Date.now()}));
      input.files = transfer.files; input.dispatchEvent(new Event('change', {bubbles: true}));
    }).catch(showError);
  };
  let consumer = null;
  const launchQueueAdapter = {setConsumer(fn) { consumer = typeof fn === 'function' ? fn : null; }};
  try { installWindowApi('launchQueue', launchQueueAdapter); }
  catch (error) {
    // Some WebViews expose a non-configurable accessor but an extensible native
    // queue object. Keep its real platform delivery while observing registration.
    const queue = window.launchQueue, register = queue?.setConsumer;
    if (typeof register !== 'function') throw error;
    Object.defineProperty(queue, 'setConsumer', {configurable: true, value(fn) {
      launchQueueAdapter.setConsumer(fn); return register.call(queue, fn);
    }});
  }
  // Files other apps open with / share to the app wait natively; the newest one opens through Studio's own file-handling path,
  // which asks about unsaved changes first. A running document is never replaced silently.
  let draining = false, drainAgain = false;
  async function drainOpenRequests() {
    if (!readyStudio) return;
    if (draining) { drainAgain = true; return; }
    draining = true;
    try {
      do {
        drainAgain = false;
        const metas = await request('takeOpenRequests');
        if (!metas.length) continue;
        // Never swap the document underneath a host dialog (save destination, errors, fonts); wait for it to close.
        for (let attempt = 0; (typeof consumer !== 'function' || currentDialog) && attempt < 600; attempt++) await new Promise(resolve => setTimeout(resolve, 100));
        if (metas.length > 1) announce(`전달받은 파일 ${metas.length}개 중 마지막 파일을 열어요.`);
        await launch(metas[metas.length - 1]);
      } while (drainAgain);
    } catch (error) { await showError(error); }
    finally { draining = false; }
  }
  async function launch(meta) { if (typeof consumer !== 'function') throw new Error('편집기를 준비하고 있어요.'); consumer({files: [makeHandle({meta})]}); }
  async function draftRows() { return (await request('listDrafts')).filter(row => row.docId?.startsWith('studio:')); }
  async function readDraftRow(row) {
    const result = await readRecord({id: 'draft:' + row.key, key: row.key, draft: true});
    return {id: row.docId.slice(7), fileName: row.name, sourceFormat: row.folder || row.format, savedAt: row.savedAt, byteLength: result.bytes.length, data: result.bytes, encrypted: !!row.encrypted, lossy: row.lossy === true};
  }
  async function getDraft(id) {
    const row = (await draftRows()).find(item => item.docId === 'studio:' + id); return row ? readDraftRow(row) : null;
  }
  // Drafts that could not be read are reported once per key, never silently dropped and never hiding the readable ones.
  const reportedUnreadable = new Set();
  async function listDrafts() {
    // Native keeps at most two read buffers: read one draft at a time. One corrupt draft must not hide the others.
    const drafts = [], unreadable = [];
    for (const row of await draftRows()) {
      try { drafts.push(await readDraftRow(row)); } catch (error) { unreadable.push(row); console.warn('Recovery draft unreadable:', row.key, error?.message); }
    }
    const fresh = unreadable.filter(row => !reportedUnreadable.has(row.key));
    fresh.forEach(row => reportedUnreadable.add(row.key));
    if (fresh.length) void showError(new Error(`읽을 수 없는 복구 자료 ${fresh.length}개를 목록에서 뺐어요. 나머지 복구 자료는 그대로 있어요.`));
    return drafts;
  }
  const recovery = {
    supportsLossyDrafts: true,
    async saveDraft(draft) {
      const bytes = new Uint8Array(draft.data); let token;
      try {
        token = await request('beginDraft', {id: 'studio:' + draft.id, docId: 'studio:' + draft.id, name: draft.fileName, path: '', folder: draft.sourceFormat || 'hwp', format: 'hwp', encrypted: !!draft.encrypted, lossy: !!draft.lossy, external: true, length: bytes.length});
        await upload(token, bytes); await request('finishDraft', {token}); token = null;
      } finally { if (token) await request('abortDraft', {token}).catch(() => {}); }
    },
    getDraft,
    listDrafts,
    async deleteDraft(id) { const row = (await draftRows()).find(item => item.docId === 'studio:' + id); if (row) await request('discardDraft', {key: row.key}); },
    async clearDrafts() { for (const row of await draftRows()) await request('discardDraft', {key: row.key}); },
  };
  // ---- document history + recent documents: encrypted private state in native (never IndexedDB/localStorage) ----
  const warnedUnreadable = {history: 0};
  const history = {
    async list() {
      const result = await request('historyList');
      if (result.unreadable > warnedUnreadable.history) void showError(new Error(`읽을 수 없는 문서 기록 ${result.unreadable}개는 목록에서 뺐어요. 나머지 기록은 그대로 있어요.`));
      warnedUnreadable.history = result.unreadable;
      return result.entries;
    },
    async put(meta, snapshot) {
      const bytes = new Uint8Array(snapshot);
      if (!bytes.length || bytes.length > MAX_BYTES) throw new Error('문서 기록의 크기가 올바르지 않아요.');
      let token;
      try { token = await request('beginHistory', {id: meta.id, meta: JSON.stringify(meta), length: bytes.length}); await upload(token, bytes); await request('finishHistory', {token}); token = null; }
      finally { if (token) await request('abortSave', {token}).catch(() => {}); }
    },
    async get(id) {
      const result = await request('readHistory', {id});
      if (!result) return null;
      try {
        const response = await fetch(result.url);
        if (!response.ok) throw new Error('문서 기록을 읽지 못했어요.');
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.length > MAX_BYTES) throw new Error('문서 기록이 32MB를 넘어요.');
        return bytes;
      } finally { await request('release', {token: result.token}).catch(() => {}); }
    },
    async delete(id) { await request('deleteHistory', {id}); },
    async clear() { await request('clearHistory'); },
  };
  // The page only ever sees opaque ids and names; native resolves the source from the host's own handle id.
  const nativeCode = error => /^\[(NotFound|NotAllowed)\]\s*/.exec(String(error?.message || ''));
  const recent = {
    list: () => request('recentList'),
    async add(entry, handle) {
      const record = handle ? handles.get(handle) : null;
      await request('recentAdd', {fileName: entry.fileName, sourceFormat: entry.sourceFormat, sourceId: record?.meta?.id || ''});
    },
    async open(id) {
      try { return makeHandle({meta: await request('recentOpen', {id})}); }
      catch (error) {
        const code = nativeCode(error);
        if (code) throw new DOMException(String(error.message).slice(code[0].length), code[1] === 'NotFound' ? 'NotFoundError' : 'NotAllowedError');
        throw error;
      }
    },
    async remove(id) { await request('recentRemove', {id}); },
    async clear() { await request('recentClear'); },
  };
  async function exportFile(blob, fileName) {
    const picked = await pickDestination(fileName, ['.' + extension(fileName)], sourceFolder()), bytes = new Uint8Array(await blob.arrayBuffer()); let token;
    try { token = await request('beginExport', {target: picked.target, length: bytes.length}); await upload(token, bytes); await request('finishExport', {token}); token = null; announce('저장했어요: ' + picked.name); }
    finally { if (token) await request('abortSave', {token}).catch(() => {}); }
  }
  // PDF 한 건의 쪽 이미지 합계 상한. 네이티브는 마지막에 PDF 크기를 다시 확인하지만, 쪽을 다 만든 뒤에야 실패하지 않도록 먼저 멈춘다.
  const MAX_PRINT_PAGES = 100;
  async function rasterizeSvgPage(page, width, height) {
    // 호환 경로(Studio 는 쓰지 않는다): SVG 에는 가져온 글꼴이 들어 있지 않아 글꼴 보존을 주장하지 않는다.
    const url = URL.createObjectURL(new Blob([page.svg], {type: 'image/svg+xml'}));
    try {
      const image = new Image(); image.src = url; await image.decode();
      const scale = Math.min(2.25, 1800 / width, 2600 / height), canvas = document.createElement('canvas');
      canvas.width = Math.ceil(width * scale); canvas.height = Math.ceil(height * scale);
      const context = canvas.getContext('2d'); context.fillStyle = 'white'; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const png = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      canvas.width = canvas.height = 1;
      if (!png) throw new Error('인쇄 페이지를 만들지 못했어요.');
      return new Uint8Array(await png.arrayBuffer());
    } finally { URL.revokeObjectURL(url); }
  }
  // 쪽을 하나씩 받아 네이티브로 올린다: pages 배열(호환) 또는 pageCount + renderPage(index). 한 번에 한 쪽만 메모리에 둔다.
  async function printPages({fileName, pages, pageCount, renderPage, intent, signal}) {
    const streaming = !Array.isArray(pages), count = streaming ? pageCount : pages.length;
    if (intent !== 'print' && intent !== 'pdf') throw new Error('인쇄 방식을 확인하지 못했어요.');
    if (!Number.isInteger(count) || count < 1 || count > MAX_PRINT_PAGES) throw new Error('PDF와 인쇄는 한 번에 100페이지까지 지원해요.');
    if (streaming && typeof renderPage !== 'function') throw new TypeError('인쇄할 쪽을 가져올 수 없어요.');
    const checkStop = () => { if (signal?.aborted) throw abort(); };
    let started = false, total = 0;
    try {
      checkStop();
      if (intent === 'print') await request('beginPrintPdf', {count, name: fileName});
      else { const picked = await pickDestination(String(fileName || '문서').replace(/\.[^.]+$/, '') + '.pdf', ['.pdf'], sourceFolder()); await request('beginPdf', {target: picked.target, count}); }
      started = true;
      for (let index = 0; index < count; index++) {
        checkStop();
        const page = streaming ? await renderPage(index) : pages[index];
        checkStop();
        const width = Number(page?.width), height = Number(page?.height);
        if (!(width > 0 && height > 0)) throw new Error('페이지 크기를 확인하지 못했어요.');
        const bytes = page.png ? new Uint8Array(page.png) : await rasterizeSvgPage(page, width, height);
        if ((total += bytes.length) > MAX_BYTES) throw new Error('인쇄 결과가 32MB를 넘어요. 그림이 많은 쪽을 줄여 주세요.');
        const token = await request('beginPdfPage', {index, length: bytes.length, width: Math.round(width * .75), height: Math.round(height * .75)});
        await upload(token, bytes); await request('finishPdfPage', {token});
      }
      checkStop();
      await request('finishPdf'); started = false;
    } finally { if (started) await request('abortPdf').catch(() => {}); }
  }
  function announce(text) { const status = document.getElementById('sb-message'); if (status) status.textContent = text; }
  async function fontManager() {
    const ui = openDialog('글꼴 관리'), list = element('div', null, {className: 'android-host-list'});
    ui.body.append(element('p', 'TTF·OTF 파일을 가져오면 이 기기에 보관하고 편집기에 등록해요. 글꼴이 여러 개면 폴더째 가져올 수 있어요.'), list);
    async function refresh() {
      const snapshot = await request('fontList');
      list.replaceChildren(...snapshot.faces.map(face => {
        const row = element('div', null), name = element('span', face.family + ' · ' + (face.style || ''));
        row.append(name, button('삭제', async () => { await request('fontDelete', {id: face.id}); await fontIntegration?.refresh(); await refresh(); })); return row;
      }));
      if (!snapshot.faces.length) list.append(element('p', '가져온 글꼴이 없어요.'));
    }
    const note = element('p', '', {className: 'android-host-notice', hidden: true});
    note.setAttribute('role', 'status'); ui.body.append(note);
    const say = text => { note.textContent = text; note.hidden = !text; };
    ui.footer.append(button('글꼴 가져오기', async () => { say(''); const result = await request('fontImport'); if (result) { await fontIntegration?.refresh(); await refresh(); } }));
    // A whole folder at once (purchased font packs): every TTF/OTF in the chosen folder and its subfolders, same checks and limits per file.
    ui.footer.append(button('폴더에서 가져오기', async () => {
      say(''); ui.error('');
      const result = await request('fontImportFolder'); if (!result) return;
      await fontIntegration?.refresh(); await refresh();
      const {found = 0, added = 0, failed = 0, full = false} = result.folder || {};
      if (!found) { say('이 폴더에서 TTF·OTF 글꼴을 찾지 못했어요.'); return; }
      const parts = [added ? `글꼴 ${added}개를 가져왔어요.` : '새로 가져온 글꼴이 없어요.'];
      const already = found - added - failed; if (already > 0 && !full) parts.push(`이미 있던 글꼴 ${already}개는 그대로 두었어요.`);
      if (failed) parts.push(`읽지 못했거나 글꼴이 아닌 파일 ${failed}개는 건너뛰었어요.`);
      if (full) parts.push('저장 한도(64개 또는 128MB)에 닿아 나머지는 가져오지 못했어요.');
      say(parts.join(' '));
    }));
    refresh().catch(ui.error); await ui.promise.catch(() => {});
  }
  async function onReady(studio) {
    if (readyStudio) return; readyStudio = studio;
    void startWorkspace(studio); // before the font awaits below: the tab UI and this tab's first action need only the ready Studio
    if (typeof studio.android?.setSaveGuard === 'function') studio.android.setSaveGuard(({bytes, format, contentLoss}) => {
      if (!bytes?.length || bytes.length > MAX_BYTES) throw new Error('저장 결과의 크기를 확인하지 못했어요.');
      if (!['hwp', 'hwpx', 'hml'].includes(format)) throw new Error('저장 형식을 확인하지 못했어요.');
      // Only losses of user content block the save; `metadataReduced` (rhwp v0.9.0: e.g. the latent row grid of merged tables) does not.
      // Anything else, a report without a code, or a bare count blocks (unknown means refuse).
      const losses = Array.isArray(contentLoss?.losses) ? contentLoss.losses : [];
      if (losses.some(loss => loss?.code !== 'metadataReduced') || (contentLoss?.count ?? 0) > losses.length) throw new Error('저장하면 문서 일부가 빠질 수 있어 저장을 멈췄어요. 원본은 변경하지 않았어요.');
    });
    try { const fonts = await import('/android-fonts.mjs'); fontIntegration = await fonts.installAndroidFonts(studio, request); }
    catch (error) { announce('글꼴을 등록하지 못했어요: ' + error.message); }
    const config = button('Android · 글꼴', fontManager); config.className = 'android-host-config'; config.title = '기기에 저장할 글꼴 가져오기 및 관리';
    // A mouse toolbar action keeps the editor as the dialog's return focus, so
    // document shortcuts work immediately afterward. Keyboard activation still
    // returns focus to this button, preserving normal dialog accessibility.
    config.addEventListener('mousedown', event => { if (event.button === 0) event.preventDefault(); });
    document.body.append(config);
    void drainOpenRequests();
  }
  // Capable native + failed handshake = fail closed with a notice (routing stays on; nothing replaces the current document).
  async function startWorkspace(studio) {
    if (!workspace.enabled) return;
    try {
      const module = await import('/workspace-tabs.mjs');
      workspaceController = await module.installWorkspace({
        request, subscribe, studio, announce, hasDialog: () => !!currentDialog,
        onOpenPicker: callback => { pickerWatchers.add(callback); return () => pickerWatchers.delete(callback); },
      });
    } catch (error) {
      workspaceController = null;
      console.warn('Workspace tabs unavailable:', error?.message || error);
      void showError(new Error('문서 탭을 시작하지 못했어요. 새 문서와 열기는 현재 문서를 바꾸지 않아요. 앱을 다시 열어 주세요.'));
    }
  }
  Object.assign(host, {request, recovery, recoveryStore: recovery, history, recent, onReady, printPages, exportFile, launch});
  // Android Back first closes whatever the desktop Studio itself has open (dialog, context menu, menu-bar or split-button menu),
  // exactly as Escape would on a keyboard; only a Back with nothing open leaves the document. Escape is delivered as a normal
  // keydown so Studio's own handlers decide; a menu that ignores it (focus outside it) gets one outside press.
  const STUDIO_OPEN = '.modal-overlay, .context-menu, #menu-bar .menu-item.open, .tb-split.open';
  const frame = () => new Promise(resolve => requestAnimationFrame(() => resolve()));
  async function dismissStudioSurface() {
    if (!document.querySelector(STUDIO_OPEN)) return false;
    const focus = document.activeElement && document.activeElement !== document.body ? document.activeElement : document.body;
    focus.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true}));
    await frame();
    if (document.querySelector(STUDIO_OPEN)) {
      document.body.dispatchEvent(new MouseEvent('mousedown', {bubbles: true, cancelable: true, button: 0}));
      document.body.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true, button: 0}));
    }
    return true;
  }
  window.AppBack = async () => {
    if (currentDialog) { currentDialog.cancel(); return; }
    if (await dismissStudioSurface()) return;
    // Native owns the workspace close token and asks Core once. The legacy path
    // below already asks Core before exit, which would otherwise double-prompt.
    if (workspace.enabled) {
      try { await request('exit'); } catch (error) { await showError(error); }
      return;
    }
    const android = readyStudio?.android;
    if (!android) { await showError(new Error('편집기를 준비하고 있어요.')); return; }
    try { if (await (android.close || android.confirmClose).call(android)) await request('exit'); }
    catch (error) { await showError(error); }
  };
  function loaded() {
    installStyles();
    const started = Date.now(), timer = setInterval(() => {
      if (window.rhwpStudio?.android) { clearInterval(timer); onReady(window.rhwpStudio).catch(showError); }
      else if (Date.now() - started > 120000) { clearInterval(timer); showError(new Error('편집기를 시작하지 못했어요. 앱을 다시 열어 주세요.')); }
    }, 50);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', loaded, {once: true}); else loaded();
  document.addEventListener('visibilitychange', () => { if (document.hidden) readyStudio?.android?.flushRecovery().catch(showError); });
  host.startupState = 'ready';
  } catch (error) {
    host.startupState = 'failed';
    window.AppBack = () => OfflineNative.postMessage(JSON.stringify({id: 0, op: 'exit', args: {}}));
    // No partially installed adapter can write a document or leave a recovery copy.
    delete host.recoveryStore; delete host.recovery; delete host.history; delete host.recent; delete host.workspace;
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) {
      try { installWindowApi(name, unavailable); } catch { /* The blocking screen below also prevents editor use. */ }
    }
    // Studio's shortcuts listen on document, so inert DOM alone does not stop them.
    document.addEventListener('keydown', event => { event.preventDefault(); event.stopImmediatePropagation(); }, true);
    const showStartupFailure = () => {
      for (const child of document.body.children) child.inert = true;
      const panel = document.createElement('div');
      panel.setAttribute('role', 'alert'); panel.className = 'android-host-startup-error';
      panel.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:grid;place-content:center;padding:32px;background:Canvas;color:CanvasText;font:16px system-ui';
      panel.textContent = 'Android 파일 연결을 시작하지 못했어요. 앱을 닫았다가 다시 열어 주세요.';
      document.body.append(panel);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', showStartupFailure, {once: true}); else showStartupFailure();
    console.error('Android host startup failed:', error);
  }
})();
