// TEST STUB of the Android shell's studio-host.js (served as /studio-host.js by tests/studio-smoke.py only; never packaged).
// It implements the host contract just enough to exercise the real desktop Studio build in a browser:
// AndroidStudioHost (recovery store, printPages, exportFile, onReady), launchQueue, and an in-memory File System Access adapter.
(() => {
  const log = { ready: 0, writes: [], drafts: new Map(), prints: [], exports: [], deletes: [] };
  const files = new Map(); // name -> Uint8Array (the "native" files)
  const handleFor = (name) => ({
    kind: 'file', name,
    async getFile() { return new File([files.get(name)], name); },
    async createWritable() {
      if (window.__failWrites) throw new DOMException('native write refused (stub)', 'NotAllowedError');
      const parts = [];
      return {
        async write(data) { parts.push(data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : data?.data instanceof Blob ? new Uint8Array(await data.data.arrayBuffer()) : data); },
        async close() { const n = parts.reduce((s, p) => s + p.length, 0), out = new Uint8Array(n); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } files.set(name, out); log.writes.push({ name, bytes: out }); },
        async abort() {},
      };
    },
    async isSameEntry(other) { return other && other.name === name; },
    async queryPermission() { return 'granted'; }, async requestPermission() { return 'granted'; },
  });
  // In-memory stand-ins for the host's private history / recent providers (contract: builder-persistence-contract.md). NOT the real native store.
  log.history = new Map(); log.historyCalls = []; log.recent = new Map(); log.recentCalls = []; log.pickerCalls = 0; let recentFail = null, recentSeq = 0;
  let consumer = null, queued = null; log.consumerSet = 0;
  // Chromium may already define launchQueue as a native read-only attribute: assignment is silently ignored, defineProperty is not.
  Object.defineProperty(window, 'launchQueue', { configurable: true, value: { setConsumer(fn) { consumer = fn; log.consumerSet += 1; if (queued) { const q = queued; queued = null; fn(q); } } } });
  window.AndroidStudioHost = {
    version: 1,
    onReady(studio) { log.ready += 1; log.studio = studio; },
    recovery: {
      async saveDraft(d) { log.drafts.set(d.id, { ...d, data: new Uint8Array(d.data) }); },
      async getDraft(id) { return log.drafts.get(id) ?? null; },
      async listDrafts() { return [...log.drafts.values()]; },
      async deleteDraft(id) { log.deletes.push(id); log.drafts.delete(id); },
      async clearDrafts() { log.drafts.clear(); },
    },
    history: {
      async list() { log.historyCalls.push('list'); return [...log.history.values()].map(r => r.meta); },
      async put(meta, data) { log.historyCalls.push('put'); log.history.set(meta.id, { meta, data: new Uint8Array(data) }); },
      async get(id) { log.historyCalls.push('get'); return log.history.get(id)?.data ?? null; },
      async delete(id) { log.historyCalls.push('delete'); log.history.delete(id); },
      async clear() { log.historyCalls.push('clear'); log.history.clear(); },
    },
    recent: {
      async list() { return [...log.recent.values()].map(r => ({ id: r.id, fileName: r.fileName, sourceFormat: r.sourceFormat, openedAt: r.openedAt, reopenable: r.reopenable })); },
      async add(entry, handle) {
        log.recentCalls.push(['add', entry.fileName, !!handle]);
        for (const [id, r] of log.recent) if (r.fileName === entry.fileName) log.recent.delete(id);
        const id = 'r' + (++recentSeq); log.recent.set(id, { id, ...entry, openedAt: Date.now() + recentSeq, reopenable: !!handle && files.has(entry.fileName) });
      },
      async open(id) {
        log.recentCalls.push(['open', id]);
        if (recentFail) throw new DOMException('stub: ' + recentFail, recentFail);
        const r = log.recent.get(id); if (!r) throw new DOMException('gone', 'NotFoundError'); return handleFor(r.fileName);
      },
      async remove(id) { log.recentCalls.push(['remove', id]); log.recent.delete(id); },
      async clear() { log.recentCalls.push(['clear']); log.recent.clear(); },
    },
    // Accepts BOTH contracts: the streaming one (pageCount + renderPage(i) -> {png,width,height}; Studio's production path) and the legacy
    // array form (pages:[{svg,width,height}]). PNG pages are decoded and their ink counted so the test can prove real rendering.
    async printPages(request) {
      const entry = { fileName: request.fileName, intent: request.intent, mode: typeof request.renderPage === 'function' ? 'stream' : 'array', pages: [] };
      if (entry.mode === 'stream') {
        entry.pageCount = request.pageCount; entry.hasSignal = !!request.signal;
        for (let i = 0; i < request.pageCount; i++) {
          const r = await request.renderPage(i);
          const png = r.png instanceof Uint8Array ? r.png : new Uint8Array(r.png);
          const bmp = await createImageBitmap(new Blob([png], { type: 'image/png' }));
          const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
          const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(bmp, 0, 0);
          const d = x.getImageData(0, 0, c.width, c.height).data; let ink = 0;
          for (let k = 0; k < d.length; k += 4) if (d[k] < 200 || d[k + 1] < 200 || d[k + 2] < 200) ink++;
          entry.pages.push({ width: r.width, height: r.height, pngLength: png.length, signature: Array.from(png.slice(0, 4)), bitmap: [bmp.width, bmp.height], ink });
          bmp.close();
        }
      } else {
        entry.pages = request.pages.map(p => ({ width: p.width, height: p.height, svgLength: p.svg.length, svgHead: p.svg.slice(0, 40) }));
      }
      log.prints.push(entry);
    },
    async exportFile(blob, name) { log.exports.push({ name, size: blob.size, type: blob.type }); },
  };
  // Host file picker stand-in (re-pick after a revoked grant): hands out the handle of the file named `pickName`.
  window.showOpenFilePicker = async () => { log.pickerCalls += 1; return [handleFor(window.__host.pickName)]; };
  window.__host = {
    log,
    put(name, bytes) { files.set(name, Uint8Array.from(bytes)); },
    get(name) { return files.get(name); },
    open(name) { const params = { files: [handleFor(name)] }; if (consumer) consumer(params); else queued = params; },
    failWrites(on) { window.__failWrites = on; },
    failRecentOpen(name) { recentFail = name; },
  };
})();
