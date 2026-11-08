// Browser-test ORACLE of the native WorkspaceModel (docs/DEX-WORKSPACE.md). This is a MOCK used by tests/preview-server.mjs and the browser tests.
// It is NOT the Java WorkspaceModel: a pass against it proves only how the JS/Studio side reacts to contract-shaped snapshots/events.
// Where CONTRACT.md leaves a choice (which hidden tab replaces a closed pane) the oracle picks the most recently used one; tests must
// assert contract invariants (checkInvariants), never that particular choice.
import { randomUUID } from 'node:crypto';
export const MAX_TABS = 8;
// Mirrors WorkspaceModel.java: canonical lowercase UUID ids, titles cut at 120 characters.
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const MAX_TITLE = 120;

export class WorkspaceOracle {
  constructor(max = MAX_TABS) {
    this.max = max; this.order = []; this.meta = new Map(); this.mru = [];
    this.primaryId = null; this.secondaryId = null; this.activeId = null; this.split = false;
  }
  has(id) { return this.meta.has(id); }
  need(id) { if (!this.has(id)) throw new Error('unknown tab ' + id); return id; }
  visible() { return [this.primaryId, this.secondaryId].filter(Boolean); }
  touch(id) { this.mru = [id, ...this.mru.filter(x => x !== id)]; }
  createTab(id) {
    if (!ID.test(id || '')) throw new Error('bad tab id');
    if (this.has(id)) throw new Error('duplicate tab ' + id);
    if (this.order.length >= this.max) throw new Error('tab limit ' + this.max);
    this.order.push(id); this.meta.set(id, { title: '새 문서', dirty: false, encrypted: false, ready: false });
    if (!this.primaryId) { this.primaryId = this.activeId = id; }
    this.mru.push(id);
    return id;
  }
  newTab(id, originId) { this.createTab(id); this.select(id, originId); return id; }
  select(targetId, originId) {
    this.need(targetId);
    if (!this.visible().includes(targetId)) {
      const origin = this.visible().includes(originId) ? originId : this.activeId;
      if (this.split && origin === this.secondaryId) this.secondaryId = targetId; else this.primaryId = targetId;
    }
    this.activeId = targetId; this.touch(targetId);
  }
  setActive(id) { this.need(id); if (!this.visible().includes(id)) throw new Error('tab not visible'); this.activeId = id; this.touch(id); }
  setSplit(enabled, originId) {
    if (!!enabled === this.split) return;
    if (enabled) {
      const other = this.mru.find(id => id !== this.primaryId && this.has(id));
      if (other) { this.secondaryId = other; this.split = true; }
      else { const id = this.createTab(randomUUID()); this.secondaryId = id; this.split = true; this.activeId = id; this.touch(id); }  // like splitWithNewTab: the new blank tab is active
    } else { this.primaryId = this.activeId; this.secondaryId = null; this.split = false; }
  }
  moveBefore(id, beforeId) {
    this.need(id);
    if (beforeId != null) this.need(beforeId);
    if (id === beforeId) return;
    this.order = this.order.filter(x => x !== id);
    if (beforeId == null) this.order.push(id); else this.order.splice(this.order.indexOf(beforeId), 0, id);
  }
  update(id, patch) {
    const m = this.meta.get(this.need(id));
    if (typeof patch.title === 'string') m.title = [...patch.title].slice(0, MAX_TITLE).join('').trim();
    for (const key of ['dirty', 'encrypted', 'ready']) if (typeof patch[key] === 'boolean') m[key] = patch[key];
  }
  removeConfirmed(id) {
    this.need(id);
    const wasActive = this.activeId === id, wasVisible = this.visible().includes(id);
    const other = this.visible().find(x => x !== id) || null;
    this.order = this.order.filter(x => x !== id); this.meta.delete(id); this.mru = this.mru.filter(x => x !== id);
    if (!this.order.length) { this.primaryId = this.secondaryId = this.activeId = null; this.split = false; return { closedAll: true }; }
    if (wasVisible) {
      const replacement = this.mru.find(x => x !== other) ?? null;
      if (replacement) { if (id === this.secondaryId) this.secondaryId = replacement; else this.primaryId = replacement; }
      else { this.primaryId = other; this.secondaryId = null; this.split = false; }
      if (wasActive) { this.activeId = replacement || other; this.touch(this.activeId); }
      if (!this.split) this.secondaryId = null;
      if (this.split && this.primaryId === this.secondaryId) throw new Error('oracle bug: duplicate pane');
    }
    return { closedAll: false };
  }
  snapshot(selfId) {
    return {
      enabled: true, selfId, activeId: this.activeId, primaryId: this.primaryId, secondaryId: this.secondaryId, split: this.split, maxTabs: this.max,
      tabs: this.order.map(id => ({ id, ...this.meta.get(id) })),
    };
  }
  checkInvariants() {
    const problems = [];
    if (new Set(this.order).size !== this.order.length) problems.push('duplicate ids');
    if (this.order.length > this.max) problems.push('over cap');
    if (this.order.length) {
      if (!this.has(this.primaryId)) problems.push('primary unknown');
      if (this.split !== (this.secondaryId !== null)) problems.push('split flag / secondary mismatch');
      if (this.secondaryId !== null && (!this.has(this.secondaryId) || this.secondaryId === this.primaryId)) problems.push('bad secondary');
      if (!this.visible().includes(this.activeId)) problems.push('active not visible');
    }
    return problems;
  }
}
