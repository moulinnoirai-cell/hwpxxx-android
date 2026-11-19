import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {runInNewContext} from 'node:vm';

const script = readFileSync(new URL('../app/src/main/assets/studio-host.js', import.meta.url), 'utf8');
const pdf = {id: 'pdf', name: '보고서.PDF', format: 'pdf'};
const hwp = {id: 'hwp', name: '구형.hwp', format: 'hwp', path: '/storage/구형.hwp', folder: '/storage'};
const pdfBytes = Buffer.from('%PDF-1.7\n');
const hwp3Bytes = Buffer.from('HWP Document File V3.00');

class Element {
  children = [];
  listeners = new Map();
  value = '';
  constructor(tag) { this.tag = tag; }
  append(...children) {
    for (const child of children) child.parent = this;
    this.children.push(...children);
    if (this.tag === 'select' && !this.value) this.value = children[0]?.value ?? '';
  }
  prepend(...children) { this.children.unshift(...children); }
  replaceChildren(...children) { this.children = children; }
  get childElementCount() { return this.children.length; }
  setAttribute() {}
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  click() { return this.listeners.get('click')?.(); }
  showModal() {}
  close() {}
  remove() { this.parent.children = this.parent.children.filter(child => child !== this); }
}

function setup() {
  const calls = [], body = new Element('body');
  const find = (node, predicate) => predicate(node) ? node : node.children.map(child => find(child, predicate)).find(Boolean);
  const replies = {
    status: () => ({permission: true, volumes: [{path: '/storage', name: '내장 저장공간'}]}),
    scan: () => { context.NativeEvent('scanBatch', [pdf, hwp]); return {}; },
    pickFile: () => pdf,
    read: ({id}) => ({
      url: id, token: id, sha: 'a'.repeat(64),
      meta: id === 'pdf' ? pdf : {...hwp, readOnly: true},
    }),
    listDirs: () => ({path: '/storage', files: [hwp.name], folders: []}),
    beginSave: () => 'save',
    finishSave: () => ({
      meta: {...hwp, id: 'copy', name: '구형 (2).hwp', path: '/storage/구형 (2).hwp'},
      sha: 'b'.repeat(64),
    }),
  };
  const context = {
    document: {body, readyState: 'loading', createElement: tag => new Element(tag), addEventListener() {}},
    HTMLInputElement: class extends Element {},
    OfflineNative: {postMessage(message) {
      const {id, op, args} = JSON.parse(message);
      calls.push({op, args});
      queueMicrotask(() => context.NativeReply(id, {ok: true, data: replies[op]?.(args)}));
    }},
    fetch: async id => new Response(id === 'pdf' ? pdfBytes : hwp3Bytes),
    setTimeout, clearTimeout, File, Blob, DOMException, btoa, confirm: () => true,
  };
  context.window = context;
  runInNewContext(script, context);
  assert.equal(context.AndroidStudioHost.startupState, 'ready');
  return {
    context, calls,
    button: label => find(body, node => node.tag === 'button' && node.textContent === label),
    nameField: () => find(body, node => node.tag === 'input'),
  };
}

const settleUi = () => new Promise(resolve => setImmediate(resolve));

test('the open picker filters the scan and forwards PDF acceptance to SAF', async () => {
  const {context, calls, button} = setup();
  const opening = context.showOpenFilePicker({types: [{accept: {'application/pdf': []}}]});
  await settleUi();
  assert.ok(button(pdf.name));
  assert.equal(button(hwp.name), undefined);
  await button('파일 선택').click();
  const [handle] = await opening;
  assert.deepEqual(calls.find(call => call.op === 'pickFile').args, {kind: 'document', formats: ['pdf']});
  const file = await handle.getFile();
  assert.equal(file.name, pdf.name);
  assert.equal(file.type, 'application/pdf');
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), pdfBytes);
  await assert.rejects(handle.createWritable(), {name: 'NotAllowedError'});
  assert.ok(calls.some(call => call.op === 'release' && call.args.token === pdf.id));
  assert.equal(calls.some(call => call.op === 'beginSave'), false);
});

test('saving an HWP 3.0 handle creates a new file and the next save targets that copy', async () => {
  const {context, calls, button, nameField} = setup();
  const opening = context.showOpenFilePicker({types: [{accept: {'application/x-hwp': ['.hwp']}}]});
  await settleUi();
  assert.equal(button(pdf.name), undefined);
  await button(hwp.name).click();
  const [handle] = await opening;
  assert.deepEqual(Buffer.from(await (await handle.getFile()).arrayBuffer()), hwp3Bytes);
  const first = await handle.createWritable();
  await first.write(new Blob(['HWP5 output']));
  const saving = first.close();
  await settleUi();
  assert.equal(nameField().value, '구형 (2).hwp');
  nameField().value = hwp.name;
  await button('저장').click();
  assert.equal(calls.some(call => call.op === 'beginSave'), false);
  nameField().value = '구형 (2).hwp';
  await button('저장').click();
  await saving;
  const next = await handle.createWritable();
  await next.write(new Blob(['HWP5 output']));
  await next.close();
  const saves = calls.filter(call => call.op === 'beginSave').map(call => call.args);
  assert.deepEqual(saves.map(({id, target, replace, overwrite}) => ({id, target, replace, overwrite})), [
    {id: 'hwp', target: '/storage/구형 (2).hwp', replace: false, overwrite: false},
    {id: 'copy', target: '/storage/구형 (2).hwp', replace: true, overwrite: false},
  ]);
  assert.equal(saves[1].sha, 'b'.repeat(64));
});
