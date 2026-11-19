import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const source = readFileSync(new URL('../app/src/main/assets/studio-host.js', import.meta.url), 'utf8');
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

function startHost(handler = () => ({})) {
  const calls = [];
  const window = {
    AbortController, DOMException, Uint8Array, setTimeout, clearTimeout, btoa,
    navigator: {}, HTMLInputElement: class {},
    document: {readyState: 'loading', addEventListener() {}},
    OfflineNative: {postMessage(message) {
      const {id, op, args} = JSON.parse(message);
      calls.push({op, args});
      queueMicrotask(() => window.NativeReply(id, {ok: true, data: true, ...handler(op, args)}));
    }},
  };
  window.window = window;
  runInNewContext(source, window);
  assert.equal(window.AndroidStudioHost.startupState, 'ready');
  return {print: window.AndroidStudioHost.printPages, event: window.NativeEvent, calls};
}

async function untilCall(calls, predicate) {
  for (let turn = 0; turn < 30; turn++) {
    const found = calls.find(predicate);
    if (found) return found;
    await nextTurn();
  }
  assert.fail('Missing expected native request');
}

function pageEvent(job, token, index, dpi = 300) {
  return {job, token, index, widthPt: 400, heightPt: 500, dpi};
}

test('120-page print waits for native ranges and serializes only selected pages, with per-write print settings', async () => {
  const {print, event, calls} = startHost();
  const png = new Uint8Array(196609); png[0] = 137; png[png.length - 1] = 42;
  const rendered = [];
  const done = print({
    fileName: '보고서.hwp', intent: 'print', pageCount: 120,
    renderPage: async (index, target) => {
      rendered.push([index, target.widthPt, target.heightPt, target.dpi]);
      return {png, width: 794, height: 1123};
    },
  });
  const [start] = calls;
  const {job} = start.args;
  assert.deepEqual(start, {op: 'startPrint', args: {job, count: 120, name: '보고서.hwp'}});
  await nextTurn();
  assert.deepEqual(rendered, []);

  event('printPage', pageEvent(job, 'a', 119, 150));
  await untilCall(calls, call => call.op === 'printPageEnd' && call.args.token === 'a');
  event('printPage', pageEvent(job, 'b', 119, 600));
  await untilCall(calls, call => call.op === 'printPageEnd' && call.args.token === 'b');
  event('printPage', pageEvent(job, 'c', 4));
  await untilCall(calls, call => call.op === 'printPageEnd' && call.args.token === 'c');
  event('printEnd', {job});
  await done;
  assert.deepEqual(rendered, [[119, 400, 500, 150], [119, 400, 500, 600], [4, 400, 500, 300]]);
  assert.deepEqual(calls.slice(1, 5).map(call => call.op), ['printPageBegin', 'printPageChunk', 'printPageChunk', 'printPageEnd']);
  const chunks = calls.filter(call => call.op === 'printPageChunk' && call.args.token === 'a');
  assert.deepEqual(chunks.map(call => call.args.seq), [0, 1]);
  const received = Buffer.concat(chunks.map(call => Buffer.from(call.args.base64, 'base64')));
  assert.deepEqual(received, Buffer.from(png));
});

test('cancelled preview drops its pending page before a new request, and render failures reach native', async () => {
  const {print, event, calls} = startHost();
  let finishPage, pageSignal, renderCount = 0;
  const png = new Uint8Array(8);
  const done = print({
    intent: 'print', pageCount: 3,
    renderPage: async (index, {signal}) => {
      renderCount++;
      if (index === 0) {
        pageSignal = signal;
        await new Promise(resolve => { finishPage = resolve; });
      }
      if (index === 1) throw new Error('페이지 렌더 실패');
      return {png, width: 400, height: 500};
    },
  });
  const {job} = calls[0].args;
  event('printPage', pageEvent(job, 'cancel', 0));
  await nextTurn();
  event('printPageCancelled', {job, token: 'cancel'});
  assert.equal(pageSignal.aborted, true);
  event('printPage', pageEvent(job, 'bad', 1));
  assert.equal(renderCount, 1);
  finishPage();
  const failed = await untilCall(calls, call => call.op === 'printPageFail');
  assert.deepEqual(failed.args, {token: 'bad', message: '페이지 렌더 실패'});
  assert.equal(calls.some(call => call.args.token === 'cancel'), false);

  event('printPage', pageEvent(job, 'good', 2));
  await untilCall(calls, call => call.op === 'printPageEnd' && call.args.token === 'good');
  event('printEnd', {job});
  await done;
  assert.equal(renderCount, 3);
});

test('print abort and launch failure release the host job slot', async () => {
  let failures = 1;
  const {print, event, calls} = startHost(op => op === 'startPrint' && failures-- > 0
    ? {ok: false, error: '인쇄 창을 열지 못했어요.'} : {});
  const data = {intent: 'print', pageCount: 101, renderPage: () => assert.fail('Rendering must be on demand')};
  await assert.rejects(print(data), /인쇄 창/);
  await assert.rejects(print({...data, pageCount: 0}), /쪽 수/);
  const signal = new AbortController();
  const aborted = print({...data, signal: signal.signal});
  signal.abort();
  await assert.rejects(aborted, {name: 'AbortError'});
  const reopened = print(data);
  event('printEnd', {job: calls.at(-1).args.job});
  await reopened;
  assert.deepEqual(calls.map(call => call.op), ['startPrint', 'startPrint', 'startPrint']);
});
