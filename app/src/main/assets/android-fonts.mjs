/** Android private SFNT catalog -> Studio's real renderer font provider. */
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_FONTS = 64;
const ID = /^[0-9a-f]{64}$/;
const TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function aborted(signal) {
  if (signal?.aborted) throw new DOMException('Font request aborted', 'AbortError');
}

function safeName(value, allowEmpty = false) {
  return typeof value === 'string' && value.length <= 1024 && (allowEmpty || value.trim().length > 0);
}

function copySnapshot(value) {
  if (!value || !ID.test(value.revision) || !Array.isArray(value.faces) || value.faces.length > MAX_FONTS) {
    throw new Error('Invalid Android font catalog');
  }
  const ids = new Set();
  const faces = value.faces.map(face => {
    if (!face || !ID.test(face.id) || ids.has(face.id)
      || !safeName(face.family) || !safeName(face.fullName) || !safeName(face.postscriptName, true)
      || !safeName(face.style, true) || !Number.isInteger(face.weight) || face.weight < 1 || face.weight > 1000
      || !['normal', 'italic', 'oblique'].includes(face.slant)
      || !Array.isArray(face.aliases) || face.aliases.length > 32 || !face.aliases.every(name => safeName(name))) {
      throw new Error('Invalid Android font face');
    }
    ids.add(face.id);
    return Object.freeze({id: face.id, family: face.family, fullName: face.fullName,
      postscriptName: face.postscriptName, style: face.style, weight: face.weight, slant: face.slant,
      aliases: Object.freeze([...face.aliases])});
  });
  return Object.freeze({revision: value.revision, faces: Object.freeze(faces)});
}

async function readFont(response) {
  if (!response?.ok) throw new Error('Android font read failed');
  const declared = response.headers?.get('content-length');
  if (declared !== null && declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > MAX_BYTES)) {
    throw new Error('Invalid Android font size');
  }
  if (!response.body?.getReader) throw new Error('Android font stream is unavailable');
  const reader = response.body.getReader();
  const chunks = []; let length = 0;
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array) || value.length > MAX_BYTES - length) throw new Error('Invalid Android font size');
      chunks.push(value); length += value.length;
    }
  } catch (error) {await reader.cancel().catch(() => {}); throw error;}
  finally {reader.releaseLock();}
  if (length < 12) throw new Error('Invalid Android font size');
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) {bytes.set(chunk, offset); offset += chunk.length;}
  const view = new DataView(bytes.buffer);
  if (![0x00010000, 0x4f54544f].includes(view.getUint32(0))) throw new Error('Invalid Android font SFNT signature');
  return bytes.buffer;
}

/** request(op,args) is the existing opaque native bridge, never a URL/path reader. */
export function createAndroidFontProvider(request, fetchFont = globalThis.fetch) {
  if (typeof request !== 'function') throw new TypeError('Android native request is required');
  let snapshot = null;
  let epoch = 0;
  // Native document/font transports share a small bounded blob pool. Hold one font token at a time.
  let transport = Promise.resolve();
  const listeners = new Set();
  return {
    async getSnapshot(signal) {
      aborted(signal);
      const generation = epoch;
      const result = copySnapshot(await request('fontList', {}));
      aborted(signal);
      if (generation !== epoch) throw new DOMException('Font catalog changed', 'AbortError');
      snapshot = result;
      return result;
    },
    async readFace(id, revision, signal) {
      aborted(signal);
      if (!ID.test(id) || !snapshot || snapshot.revision !== revision || !snapshot.faces.some(face => face.id === id)) {
        throw new Error('Stale or unknown Android font');
      }
      const generation = epoch;
      const pending = transport.then(async () => {
        aborted(signal);
        if (generation !== epoch || snapshot?.revision !== revision) throw new DOMException('Font catalog changed', 'AbortError');
        const result = await request('fontRead', {id, revision});
        try {
          aborted(signal);
          if (generation !== epoch || snapshot?.revision !== revision) throw new DOMException('Font catalog changed', 'AbortError');
          if (!TOKEN.test(result?.token) || result.url !== `/document/${result.token}`) throw new Error('Invalid Android font resource');
          const response = await fetchFont(result.url, {cache: 'no-store', credentials: 'omit', redirect: 'error', signal});
          const bytes = await readFont(response);
          aborted(signal);
          if (generation !== epoch || snapshot?.revision !== revision) throw new DOMException('Font catalog changed', 'AbortError');
          return {bytes, faceIndex: 0};
        } finally {
          // Release native memory even when canceled, stale, malformed or rejected by a decoder.
          if (TOKEN.test(result?.token)) await request('release', {token: result.token}).catch(() => {});
        }
      });
      // A failed or aborted request cannot poison or block later generations.
      transport = pending.then(() => {}, () => {});
      return pending;
    },
    subscribe(onChange) {
      if (typeof onChange !== 'function') throw new TypeError('Font listener is required');
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    /** Call only after native import/delete has completed. Studio reloads its catalog and renderer caches. */
    refresh() {
      epoch++;
      snapshot = null;
      for (const listener of [...listeners]) listener();
    },
  };
}

export async function installAndroidFonts(studio, request) {
  if (typeof studio?.fonts?.setProvider !== 'function') throw new Error('Studio host font API is unavailable');
  const provider = createAndroidFontProvider(request);
  await studio.fonts.setProvider(provider);
  const state = studio.fonts.getState?.();
  if (state?.lastError) throw new Error(state.lastError);
  return provider;
}
