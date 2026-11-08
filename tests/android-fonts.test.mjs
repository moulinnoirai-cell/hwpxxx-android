import test from 'node:test';
import assert from 'node:assert/strict';
import {createAndroidFontProvider, installAndroidFonts} from '../app/src/main/assets/android-fonts.mjs';

const id = 'a'.repeat(64), revision = 'b'.repeat(64);
const face = {id, family: 'Test Font', fullName: 'Test Font Regular', postscriptName: 'TestFont-Regular',
  style: 'Regular', weight: 400, slant: 'normal', aliases: ['Test Font']};
const bytes = Buffer.alloc(12); bytes.writeUInt32BE(0x00010000);
const token = '01234567-1234-1234-1234-0123456789ab';
const resource = () => ({token, url: `/document/${token}`});
const fetchBytes = async () => new Response(bytes);
const catalog = () => ({revision, faces: [{...face, aliases: [...face.aliases], path: '/must-not-leak'}]});
const signal = () => new AbortController().signal;
const deferred = () => {let resolve; const promise = new Promise(done => {resolve = done;}); return {resolve, promise};};

test('catalog exposes only safe metadata and original SFNT bytes through actual provider contract', async () => {
  const calls = [];
  const provider = createAndroidFontProvider(async (op, args) => {
    calls.push({op, args}); return op === 'fontList' ? catalog() : resource();
  }, fetchBytes);
  const snapshot = await provider.getSnapshot(signal());
  assert(!('path' in snapshot.faces[0]));
  assert(Object.isFrozen(snapshot.faces[0].aliases));
  const data = await provider.readFace(id, revision, signal());
  assert(data.bytes instanceof ArrayBuffer);
  assert.equal(data.faceIndex, 0);
  assert.deepEqual(Buffer.from(data.bytes), bytes);
  assert.deepEqual(calls[1], {op: 'fontRead', args: {id, revision}});
  const second = await provider.readFace(id, revision, signal());
  assert.notEqual(data.bytes, second.bytes, 'read ownership is independent');
});

test('unknown faces, stale revisions and aborted reads never cross native boundary', async () => {
  let reads = 0;
  const provider = createAndroidFontProvider(async op => {if(op === 'fontList') return catalog(); reads++;});
  await provider.getSnapshot(signal());
  await assert.rejects(provider.readFace('../bad', revision, signal()), /Stale|unknown/);
  await assert.rejects(provider.readFace(id, 'old', signal()), /Stale|unknown/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(provider.readFace(id, revision, controller.signal), {name: 'AbortError'});
  assert.equal(reads, 0);
});

test('large font bytes stream outside native JavaScript IPC', async () => {
  const large = Buffer.alloc(2 * 1024 * 1024); large.writeUInt32BE(0x4f54544f);
  const provider = createAndroidFontProvider(async op => op === 'fontList' ? catalog() : resource(), async () => new Response(large));
  await provider.getSnapshot(signal());
  assert.deepEqual(Buffer.from((await provider.readFace(id, revision, signal())).bytes), large);
});

test('native catalog rejects malformed metadata, duplicate faces and excessive catalogs', async () => {
  for (const value of [null, {revision, faces: null}, {revision: '../bad', faces: []},
    {revision, faces: [face, face]}, {revision, faces: Array(65).fill(face)},
    ...[{weight: 1001}, {weight: 1.1}, {id: '../path'}, {slant: 'sideways'}, {family: ''},
      {aliases: Array(33).fill('x')}, {fullName: 'x'.repeat(1025)}].map(change => ({revision, faces: [{...face, ...change}]}))]) {
    const provider = createAndroidFontProvider(async () => value);
    await assert.rejects(provider.getSnapshot(signal()), /Invalid Android font/);
  }
});

test('native resource rejects external URLs, path traversal and malformed authority tokens', async () => {
  for (const value of [{token, url: 'https://example.com/font.ttf'}, {token, url: '/document/../escape'},
    {token: '../path', url: '/document/../path'}, {token, url: `/document/${token}?x=1`}]) {
    let fetches = 0;
    const provider = createAndroidFontProvider(async op => op === 'fontList' ? catalog() : value,
      async () => {fetches++; return new Response(bytes);});
    await provider.getSnapshot(signal());
    await assert.rejects(provider.readFace(id, revision, signal()), /Invalid Android font resource/);
    assert.equal(fetches, 0);
  }
});

test('invalid streams, signatures, excessive sizes and HTTP errors release native blob', async () => {
  for (const response of [() => new Response(new Uint8Array(0)), () => new Response(new Uint8Array(12)),
    () => new Response(null, {status: 404}), () => new Response(bytes, {headers: {'Content-Length': '16777217'}}),
    () => new Response(new ReadableStream({start(controller) {controller.enqueue(new Uint8Array(16 * 1024 * 1024));
      controller.enqueue(new Uint8Array(1)); controller.close();}}))]) {
    let releases = 0;
    const provider = createAndroidFontProvider(async op => {
      if(op === 'fontList') return catalog();
      if(op === 'release') {releases++; return true;}
      return resource();
    }, async () => response());
    await provider.getSnapshot(signal());
    await assert.rejects(provider.readFace(id, revision, signal()), /Android font/);
    assert.equal(releases, 1);
  }
});

test('refresh invalidates pending native bytes and propagates one notification with disposal', async () => {
  const pending = deferred(); let changes = 0;
  const provider = createAndroidFontProvider(async op => op === 'fontList' ? catalog() : pending.promise, fetchBytes);
  const off = provider.subscribe(() => changes++);
  await provider.getSnapshot(signal());
  const reading = provider.readFace(id, revision, signal());
  provider.refresh(); pending.resolve(resource());
  await assert.rejects(reading, {name: 'AbortError'});
  assert.equal(changes, 1);
  await assert.rejects(provider.readFace(id, revision, signal()), /Stale|unknown/);
  off(); provider.refresh(); assert.equal(changes, 1);
});

test('late catalog response cannot restore a deleted generation', async () => {
  const pending = deferred();
  const provider = createAndroidFontProvider(async () => pending.promise);
  const loading = provider.getSnapshot(signal()); provider.refresh(); pending.resolve(catalog());
  await assert.rejects(loading, {name: 'AbortError'});
  await assert.rejects(provider.readFace(id, revision, signal()), /Stale|unknown/);
});

test('three concurrent font faces serialize native blob ownership and all release', async () => {
  const faces = ['a', 'c', 'd'].map(character => ({...face, id: character.repeat(64)}));
  let active = 0, maximum = 0, reads = 0, releases = 0;
  const provider = createAndroidFontProvider(async op => {
    if(op === 'fontList') return {revision, faces};
    if(op === 'fontRead') {reads++; active++; maximum = Math.max(maximum, active); return resource();}
    if(op === 'release') {releases++; active--; return true;}
  }, async () => {await new Promise(resolve => setTimeout(resolve, 1));return new Response(bytes);});
  await provider.getSnapshot(signal());
  const data = await Promise.all(faces.map(value => provider.readFace(value.id, revision, signal())));
  assert.equal(data.length, 3); assert.equal(reads, 3); assert.equal(releases, 3);
  assert.equal(maximum, 1); assert.equal(active, 0);
});

test('stale queued reads never acquire a blob and do not poison the next generation', async () => {
  const pending = deferred(); let reads = 0, releases = 0;
  const provider = createAndroidFontProvider(async op => {
    if(op === 'fontList') return catalog();
    if(op === 'fontRead') {reads++; return reads === 1 ? pending.promise : resource();}
    if(op === 'release') {releases++;return true;}
  }, fetchBytes);
  await provider.getSnapshot(signal());
  const first = provider.readFace(id, revision, signal());
  const queued = provider.readFace(id, revision, signal());
  await Promise.resolve(); provider.refresh(); await provider.getSnapshot(signal());
  const next = provider.readFace(id, revision, signal());
  pending.resolve(resource());
  await assert.rejects(first, {name: 'AbortError'});
  await assert.rejects(queued, {name: 'AbortError'});
  assert.deepEqual(Buffer.from((await next).bytes), bytes);
  assert.equal(reads, 2); assert.equal(releases, 2);
});

test('abort during native read rejects without decoding or caching bytes', async () => {
  const pending = deferred();
  const provider = createAndroidFontProvider(async op => op === 'fontList' ? catalog() : pending.promise, fetchBytes);
  await provider.getSnapshot(signal());
  const controller = new AbortController();
  const loading = provider.readFace(id, revision, controller.signal);
  controller.abort(); pending.resolve(resource());
  await assert.rejects(loading, {name: 'AbortError'});
});

test('installer registers real renderer provider and reports errors surfaced by Studio', async () => {
  let installed;
  const provider = await installAndroidFonts({fonts: {
    async setProvider(value) {installed = value; await value.getSnapshot(signal());}, getState: () => ({lastError: null}),
  }}, async () => catalog());
  assert.equal(provider, installed);
  assert.equal(typeof provider.readFace, 'function');
  await assert.rejects(installAndroidFonts({}, async () => catalog()), /unavailable/);
  await assert.rejects(installAndroidFonts({fonts: {setProvider() {}, getState: () => ({lastError: 'native failure'})}}, async () => catalog()), /native failure/);
});
