// Self-test of the browser-test ORACLE (tests/workspace-oracle.mjs). It checks the oracle against CONTRACT.md invariants only;
// it says nothing about the Java WorkspaceModel (that is covered by the JVM tests).
import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkspaceOracle } from './workspace-oracle.mjs';

const id = i => `00000000-0000-4000-8000-0000000000${String(i).padStart(2, '0')}`;
const make = n => { const m = new WorkspaceOracle(); for (let i = 0; i < n; i++) m.createTab(id(i)); return m; };
const view = m => JSON.stringify([m.activeId, m.primaryId, m.secondaryId, m.split]);

test('cap of eight tabs; ids unique and validated', () => {
  const m = make(8);
  assert.throws(() => m.createTab(id(8)), /limit/);
  assert.throws(() => m.createTab(id(0)), /duplicate/);
  assert.throws(() => m.createTab('../x'), /bad tab id/);
  assert.throws(() => m.createTab('AAAAAAAA-0000-4000-8000-000000000000'), /bad tab id/, 'only canonical lowercase UUIDs');
});

test('moveBefore changes only the global order, never active/primary/secondary/split', () => {
  const m = make(5); m.setSplit(true, id(0)); m.select(id(3), id(0));
  const before = view(m), meta = JSON.stringify([...m.meta]);
  m.moveBefore(id(4), id(0)); assert.deepEqual(m.order, [id(4), id(0), id(1), id(2), id(3)]);
  m.moveBefore(id(4), null); assert.deepEqual(m.order, [id(0), id(1), id(2), id(3), id(4)]);
  m.moveBefore(id(1), id(1)); assert.deepEqual(m.order, [id(0), id(1), id(2), id(3), id(4)]);
  assert.throws(() => m.moveBefore(id(1), 'nope'), /unknown/);
  assert.equal(view(m), before); assert.equal(JSON.stringify([...m.meta]), meta); assert.deepEqual(m.checkInvariants(), []);
});

test('select of a visible tab focuses it; a hidden one replaces only the origin pane', () => {
  const m = make(4); m.setSplit(true, id(0));
  assert.equal(m.split, true); assert.equal(m.primaryId, id(0)); assert.notEqual(m.secondaryId, id(0));
  const secondary = m.secondaryId, hidden = m.order.find(id => !m.visible().includes(id));
  m.select(secondary, id(0)); assert.equal(m.activeId, secondary); assert.equal(m.primaryId, id(0));
  m.select(hidden, secondary); assert.equal(m.secondaryId, hidden); assert.equal(m.primaryId, id(0)); assert.equal(m.activeId, hidden);
  assert.deepEqual(m.checkInvariants(), []);
});

test('split on a single tab creates a blank one; collapse keeps active doc and every tab', () => {
  const m = make(1); m.setSplit(true, id(0)); assert.equal(m.order.length, 2); assert.equal(m.split, true); assert.equal(m.activeId, m.secondaryId, 'new blank tab is active');
  const active = m.activeId; m.setSplit(false, active);
  assert.equal(m.order.length, 2); assert.equal(m.primaryId, active); assert.equal(m.secondaryId, null); assert.equal(m.split, false);
});

test('removing a pane never leaves the model inconsistent; last tab reports closedAll', () => {
  const m = make(3); m.setSplit(true, id(0));
  for (const id of [...m.order]) { const r = m.removeConfirmed(id); assert.deepEqual(m.checkInvariants(), [], 'after removing ' + id); if (m.order.length === 0) assert.equal(r.closedAll, true); }
  assert.equal(m.order.length, 0);
});

test('metadata update touches only the named tab; snapshot carries selfId', () => {
  const m = make(2); m.update(id(1), { title: 'B', dirty: true, ignored: 5 });
  m.update(id(0), { title: 'x'.repeat(500) }); assert.equal(m.meta.get(id(0)).title.length, 120);
  const snap = m.snapshot(id(0));
  assert.equal(snap.selfId, id(0)); assert.equal(snap.maxTabs, 8);
  assert.deepEqual(snap.tabs.map(t => [t.id, t.title.slice(0, 3), t.dirty]), [[id(0), 'xxx', false], [id(1), 'B', true]]);
});
