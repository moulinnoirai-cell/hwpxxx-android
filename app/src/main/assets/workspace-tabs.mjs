// Document-tab workspace UI for the Android shell (loaded by studio-host.js as '/workspace-tabs.mjs').
// One strip per WebView, installed inside Studio's EXISTING menu row: #menu-bar, right after .menu-item[data-menu="tool"] and before
// #toolbox-basic-toggle. It never adds a row/height. Native (EditorSession/WorkspaceModel) owns every tab; this file only renders the
// snapshot it is given and sends the user's intent back (docs/DEX-WORKSPACE.md). No innerHTML/outerHTML: titles go through textContent.
// Drag payloads carry only a private MIME with an opaque tab id; nothing is ever put on text/plain, so dropping into the editor is a no-op.

export const TAB_MIME = 'application/x-hwpxxx-workspace-tab';
export const MAX_TITLE = 200;
const ID = /^[A-Za-z0-9-]{1,64}$/;
const TOKEN = /^[A-Za-z0-9._:-]{1,128}$/;
const RECENT_ID = /^[A-Za-z0-9_-]{1,128}$/;
export const isTabId = value => typeof value === 'string' && ID.test(value);

// ---------- pure helpers (unit-tested without a DOM) ----------
export function normalizeSnapshot(raw) {
  const value = raw && typeof raw === 'object' && raw.snapshot && typeof raw.snapshot === 'object' ? raw.snapshot : raw;
  if (!value || typeof value !== 'object' || value.enabled !== true || !Array.isArray(value.tabs) || value.tabs.length > 64) return null;
  const tabs = [], seen = new Set();
  for (const tab of value.tabs) {
    if (!tab || !isTabId(tab.id) || seen.has(tab.id)) return null;
    seen.add(tab.id);
    tabs.push({id: tab.id, title: String(tab.title ?? '').slice(0, MAX_TITLE), dirty: tab.dirty === true, encrypted: tab.encrypted === true, ready: tab.ready !== false});
  }
  const known = id => (id == null ? null : seen.has(id) ? id : undefined);
  const activeId = known(value.activeId), primaryId = known(value.primaryId), secondaryId = known(value.secondaryId ?? null);
  if (activeId === undefined || primaryId === undefined || secondaryId === undefined) return null;
  const selfId = isTabId(value.selfId) && seen.has(value.selfId) ? value.selfId : null;
  const maxTabs = Number.isInteger(value.maxTabs) && value.maxTabs >= 1 && value.maxTabs <= 64 ? value.maxTabs : 8;
  const revision = Number.isSafeInteger(value.revision) ? value.revision : null;
  return {enabled: true, selfId, tabs, activeId, primaryId, secondaryId, split: value.split === true && secondaryId !== null, maxTabs, revision};
}
export function snapshotKey(snapshot) { return JSON.stringify(snapshot); }

/** CONTRACT.md: "blank"|"open" strings, or {kind:"blank"|"open"} / {kind:"recent",recentId}. Anything else is a blank tab. */
export function parseInitialAction(raw) {
  const kind = typeof raw === 'string' ? raw : raw && typeof raw === 'object' ? raw.kind : 'blank';
  if (kind === 'open') return {kind: 'open'};
  if (kind === 'recent') {
    const recentId = raw && typeof raw === 'object' ? raw.recentId : null;
    return typeof recentId === 'string' && RECENT_ID.test(recentId) ? {kind: 'recent', recentId} : {kind: 'blank'};
  }
  return {kind: 'blank'};
}

/** Insertion slot for a pointer at x given the tab centres in visual order: the number of centres left of the pointer. */
export function dropSlot(centres, x) { let slot = 0; while (slot < centres.length && x > centres[slot]) slot++; return slot; }
/** beforeId for dropping `dragId` at `slot` of `order` (the dragged tab removed first); null = end. noop when nothing would change. */
export function moveTarget(order, dragId, slot) {
  const from = order.indexOf(dragId);
  if (from < 0) return null;
  const rest = order.filter(id => id !== dragId), at = Math.max(0, Math.min(rest.length, slot > from ? slot - 1 : slot));
  const beforeId = at < rest.length ? rest[at] : null;
  return {beforeId, noop: at === from};
}
export function cycleId(order, currentId, delta) {
  if (order.length < 2) return null;
  const at = order.indexOf(currentId);
  return order[(((at < 0 ? 0 : at) + delta) % order.length + order.length) % order.length];
}
export const docStateKey = state => JSON.stringify([state.title, state.dirty, state.encrypted, state.ready]);
export function documentState(studioState) {
  const ready = !!studioState?.hasDocument;
  const name = ready ? String(studioState.fileName || '').trim() : '';
  return {title: (name || (ready ? '새 문서' : '여는 중…')).slice(0, MAX_TITLE), dirty: ready && studioState.dirty === true, encrypted: ready && studioState.encrypted === true, ready};
}

const CSS = `
#menu-bar .ws-tabs{display:flex;align-items:center;flex:1 1 0;min-width:0;align-self:stretch;gap:4px;margin:0 6px 0 8px;overflow:hidden;user-select:none}
#menu-bar .ws-tablist{display:flex;align-items:center;flex:0 1 auto;min-width:0;max-width:100%;gap:2px;overflow-x:auto;overflow-y:hidden;scrollbar-width:none;scroll-behavior:auto}
#menu-bar .ws-tablist::-webkit-scrollbar{display:none}
#menu-bar .ws-tabwrap{position:relative;display:flex;align-items:center;flex:0 1 150px;min-width:56px;max-width:180px;height:22px;box-sizing:border-box;border:1px solid var(--ui-border-light,#c4c9d2);border-radius:var(--radius-sm,3px);background:transparent;color:var(--color-text,inherit)}
#menu-bar .ws-tabwrap:hover{border-color:var(--accent-hover,#6b8fd6);background:var(--ui-accent-bg,#e8effc)}
#menu-bar .ws-tabwrap.is-visible{border-color:var(--accent-hover,#6b8fd6)}
#menu-bar .ws-tabwrap.is-self{font-weight:600;background:var(--ui-accent-bg,#e8effc)}
#menu-bar .ws-tabwrap.is-active{border-color:var(--color-primary-dark,#2a55b8);box-shadow:inset 0 -2px 0 var(--color-primary-dark,#2a55b8)}
#menu-bar .ws-tabwrap.is-pending{opacity:.6}
#menu-bar .ws-tabwrap.drop-before::before,#menu-bar .ws-tabwrap.drop-after::after{content:'';position:absolute;top:-1px;bottom:-1px;width:3px;background:var(--color-primary-dark,#2a55b8);border-radius:2px;pointer-events:none;z-index:3}
#menu-bar .ws-tabwrap.drop-before::before{left:-3px}
#menu-bar .ws-tabwrap.drop-after::after{right:-3px}
#menu-bar .ws-tabwrap.is-dragging{opacity:.45}
#menu-bar .ws-tab{all:unset;box-sizing:border-box;display:flex;align-items:center;gap:4px;flex:1 1 auto;min-width:0;height:100%;padding:0 4px 0 6px;cursor:pointer;font:inherit;font-size:12px;color:inherit}
#menu-bar .ws-tab:focus-visible{outline:2px solid var(--color-primary-dark,#2a55b8);outline-offset:1px;border-radius:var(--radius-sm,3px)}
#menu-bar .ws-title{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#menu-bar .ws-dirty{flex:0 0 auto;color:var(--color-primary-dark,#2a55b8);font-size:10px;line-height:1}
#menu-bar .ws-close{all:unset;box-sizing:border-box;display:flex;align-items:center;justify-content:center;flex:0 0 18px;width:18px;height:18px;margin-right:2px;border-radius:50%;cursor:pointer;font-size:12px;line-height:1;color:var(--color-text-muted,inherit)}
#menu-bar .ws-close:hover,#menu-bar .ws-close:focus-visible{background:var(--ui-accent-bg,#d6e2fa);color:var(--color-primary-dark,#2a55b8);outline:none}
#menu-bar .ws-actions{display:flex;align-items:center;flex:0 0 auto;gap:2px}
#menu-bar .ws-btn{all:unset;box-sizing:border-box;display:flex;align-items:center;justify-content:center;width:24px;height:22px;border:1px solid transparent;border-radius:var(--radius-sm,3px);cursor:pointer;color:var(--color-text-muted,inherit)}
#menu-bar .ws-btn:hover,#menu-bar .ws-btn:focus-visible{border-color:var(--accent-hover,#6b8fd6);background:var(--ui-accent-bg,#e8effc);color:var(--color-primary-dark,#2a55b8)}
#menu-bar .ws-btn:focus-visible{outline:2px solid var(--color-primary-dark,#2a55b8);outline-offset:1px}
#menu-bar .ws-btn[aria-pressed="true"]{border-color:var(--color-primary-dark,#2a55b8);background:var(--ui-accent-bg,#e8effc);color:var(--color-primary-dark,#2a55b8)}
#menu-bar .ws-btn[aria-disabled="true"]{opacity:.45;cursor:default}
#menu-bar .ws-btn svg{width:14px;height:14px;pointer-events:none}
@media (max-width:767px) and (hover:none) and (pointer:coarse){#menu-bar .ws-tabwrap{height:32px}#menu-bar .ws-btn{width:32px;height:32px}#menu-bar .ws-close{flex-basis:26px;width:26px;height:26px}}
`;

const SVG = 'http://www.w3.org/2000/svg';
function icon(doc, shapes) {
  const svg = doc.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16'); svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.5'); svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round'); svg.setAttribute('aria-hidden', 'true');
  for (const [tag, attributes] of shapes) { const node = doc.createElementNS(SVG, tag); for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value); svg.append(node); }
  return svg;
}
const ICONS = {
  plus: [['path', {d: 'M8 3v10M3 8h10'}]],
  open: [['path', {d: 'M2 5.5V4a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z'}]],
  split: [['rect', {x: 2, y: 3, width: 12, height: 10, rx: 1}], ['path', {d: 'M8 3v10'}]],
};

const MESSAGES = {
  limit: n => `탭은 최대 ${n}개까지 열 수 있어요.`,
  newTab: '새 문서 탭 (Ctrl+T)', open: '문서를 새 탭에서 열기 (Ctrl+O)', closeTab: '탭 닫기 (Ctrl+W)',
  split: '두 문서 나란히 보기', single: '한 문서만 보기', tabs: '열린 문서 탭', list: '열린 문서',
};

/**
 * Only called when native reported workspace capability synchronously (OfflineNative.workspaceEnabled()). A failed handshake REJECTS: the host
 * then fails closed with a notice (it never falls back to replacing the current document).
 * @param {object} ctx { request, subscribe, studio, announce, hasDialog, onOpenPicker?, document?, window? }
 * @returns {Promise<{dispose():void, snapshot():object, selfId:string, apply(raw):boolean, newTab, openRecent, ...}>}
 */
export async function installWorkspace(ctx) {
  const doc = ctx.document || globalThis.document, win = ctx.window || globalThis;
  const {request, subscribe, studio} = ctx;
  const announce = ctx.announce || (() => {});
  let reply;
  reply = await request('workspaceReady', {});
  const first = normalizeSnapshot(reply);
  if (!first || !first.selfId) throw new Error('작업 공간 상태를 확인하지 못했어요.');
  const selfId = first.selfId;
  const initialAction = parseInitialAction(reply && typeof reply === 'object' ? reply.initialAction : null);

  let snap = first, lastKey = snapshotKey(first), disposed = false, strip = null, tablist = null, controls = {}, observer = null;
  const rows = new Map(); // tabId -> {wrap, tab, title, dirty, close}
  const cleanups = [];
  const on = (target, type, handler, options) => { target.addEventListener(type, handler, options); cleanups.push(() => target.removeEventListener(type, handler, options)); };
  const fail = error => { const message = String(error?.message || error); announce(message); };

  // ----- snapshot handling -----
  function accept(raw) {
    const next = normalizeSnapshot(raw);
    if (!next || disposed) return false;
    if (!next.selfId) next.selfId = selfId;
    if (next.selfId !== selfId) return false; // a snapshot addressed to another session must never drive this one
    if (next.revision != null && snap.revision != null && next.revision < snap.revision) return false;
    const key = snapshotKey(next);
    if (key === lastKey) return true;
    lastKey = key; snap = next; render();
    return true;
  }
  const applyReply = value => { if (value && typeof value === 'object' && (value.tabs || value.snapshot)) accept(value); return value; };
  const send = (op, args) => request(op, args).then(applyReply);
  const refresh = () => send('workspaceState', {}).catch(() => {});

  // ----- DOM -----
  function button(label, shapes, onClick) {
    const node = doc.createElement('button');
    node.type = 'button'; node.className = 'ws-btn'; node.title = label; node.setAttribute('aria-label', label.replace(/ \(.*\)$/, ''));
    node.append(icon(doc, shapes));
    node.addEventListener('mousedown', event => { if (event.button === 0) event.preventDefault(); }); // keep the editor focused for mouse use
    node.addEventListener('click', () => { if (node.getAttribute('aria-disabled') === 'true') announce(node.title); else onClick(); }); // a disabled control explains itself
    return node;
  }
  const tabsFull = () => snap.tabs.length >= snap.maxTabs;
  const newTab = open => {
    if (tabsFull()) { announce(MESSAGES.limit(snap.maxTabs)); return Promise.resolve(); }
    return send('workspaceNew', {open}).catch(fail);
  };
  const openRecent = id => {
    if (!RECENT_ID.test(String(id))) return Promise.reject(new Error('최근 문서를 확인하지 못했어요.'));
    if (tabsFull()) { announce(MESSAGES.limit(snap.maxTabs)); return Promise.resolve(); }
    return send('workspaceOpenRecent', {recentId: String(id)}).catch(fail);
  };
  const closeTab = id => send('workspaceClose', {id}).catch(fail);
  const selectTab = id => send('workspaceSelect', {id}).catch(fail);
  const moveTab = (id, beforeId) => send('workspaceMove', {id, beforeId}).catch(fail);

  function build() {
    strip = doc.createElement('div'); strip.className = 'ws-tabs'; strip.setAttribute('role', 'group'); strip.setAttribute('aria-label', MESSAGES.tabs);
    tablist = doc.createElement('div'); tablist.className = 'ws-tablist'; tablist.setAttribute('role', 'tablist'); tablist.setAttribute('aria-label', MESSAGES.list); tablist.setAttribute('aria-orientation', 'horizontal');
    const actions = doc.createElement('div'); actions.className = 'ws-actions';
    controls.add = button(MESSAGES.newTab, ICONS.plus, () => newTab(false)); controls.add.dataset.wsAction = 'new';
    controls.open = button(MESSAGES.open, ICONS.open, () => newTab(true)); controls.open.dataset.wsAction = 'open';
    controls.split = button(MESSAGES.split, ICONS.split, () => send('workspaceSplit', {enabled: !snap.split}).catch(fail)); controls.split.dataset.wsAction = 'split';
    actions.append(controls.add, controls.open, controls.split);
    strip.append(tablist, actions);
    on(tablist, 'wheel', event => { if (event.deltaY && !event.deltaX) { tablist.scrollLeft += event.deltaY; event.preventDefault(); } }, {passive: false});
    on(tablist, 'keydown', onTabKey);
    installDrag();
  }

  function rowFor(tab) {
    let row = rows.get(tab.id);
    if (row) return row;
    const wrap = doc.createElement('div'); wrap.className = 'ws-tabwrap'; wrap.dataset.tabId = tab.id; wrap.draggable = true; wrap.setAttribute('role', 'presentation');
    const node = doc.createElement('button'); node.type = 'button'; node.className = 'ws-tab'; node.setAttribute('role', 'tab'); node.dataset.tabId = tab.id; node.tabIndex = -1;
    const dirty = doc.createElement('span'); dirty.className = 'ws-dirty'; dirty.setAttribute('aria-hidden', 'true'); dirty.textContent = '●';
    const title = doc.createElement('span'); title.className = 'ws-title';
    node.append(dirty, title);
    const close = doc.createElement('button'); close.type = 'button'; close.className = 'ws-close'; close.tabIndex = -1; close.textContent = '×'; close.dataset.tabId = tab.id;
    close.title = MESSAGES.closeTab;
    wrap.append(node, close);
    // No preventDefault on mousedown: it would cancel the native drag. Instead remember the editor focus and give it back after the click.
    let prior = null;
    node.addEventListener('pointerdown', () => { const active = doc.activeElement; prior = active && active !== doc.body && !tablist.contains(active) ? active : null; });
    node.addEventListener('click', event => {
      const id = node.dataset.tabId, restore = event.detail > 0 && prior && prior.isConnected ? prior : null; prior = null;
      if (!(id === snap.activeId && id === selfId)) selectTab(id);
      restore?.focus?.({preventScroll: true});
    });
    close.addEventListener('mousedown', event => { if (event.button === 0) event.preventDefault(); });
    close.addEventListener('click', event => { event.stopPropagation(); closeTab(close.dataset.tabId); });
    row = {wrap, tab: node, title, dirty, close}; rows.set(tab.id, row);
    return row;
  }

  function render() {
    if (!tablist) return;
    const focusedId = doc.activeElement?.dataset?.tabId && tablist.contains(doc.activeElement) && doc.activeElement.classList.contains('ws-tab') ? doc.activeElement.dataset.tabId : null;
    const visible = new Set([snap.primaryId, snap.secondaryId].filter(Boolean)), ids = new Set(snap.tabs.map(tab => tab.id));
    for (const [id, row] of rows) if (!ids.has(id)) { row.wrap.remove(); rows.delete(id); }
    const roving = focusedId && ids.has(focusedId) ? focusedId : snap.activeId && ids.has(snap.activeId) ? snap.activeId : snap.tabs[0]?.id;
    let cursor = null;
    const ordered = [];
    for (const tab of snap.tabs) {
      const row = rowFor(tab), isSelf = tab.id === selfId, isActive = tab.id === snap.activeId, isVisible = visible.has(tab.id);
      ordered.push(row.wrap);
      const label = tab.title || '새 문서';
      if (row.title.textContent !== label) row.title.textContent = label;
      row.dirty.hidden = !tab.dirty;
      const status = [isSelf ? '이 창의 문서' : isVisible ? '다른 창에 표시 중' : '', isActive ? '활성' : '', tab.dirty ? '저장하지 않음' : '', tab.encrypted ? '암호 문서' : '', tab.ready ? '' : '여는 중'].filter(Boolean).join(', ');
      row.tab.setAttribute('aria-label', status ? `${label} (${status})` : label);
      row.tab.title = status ? `${label}\n${status}` : label;
      row.tab.setAttribute('aria-selected', String(isActive));
      row.tab.tabIndex = tab.id === roving ? 0 : -1;
      row.close.setAttribute('aria-label', `${label} 탭 닫기`);
      row.wrap.classList.toggle('is-self', isSelf); row.wrap.classList.toggle('is-active', isActive); row.wrap.classList.toggle('is-visible', isVisible); row.wrap.classList.toggle('is-pending', !tab.ready);
      Object.assign(row.wrap.dataset, {self: String(isSelf), active: String(isActive), visible: String(isVisible), dirty: String(tab.dirty), encrypted: String(tab.encrypted), ready: String(tab.ready)});
    }
    // Reorder only what moved (keeps focus and an in-flight drag intact).
    ordered.forEach((wrap, index) => { if (tablist.children[index] !== wrap) tablist.insertBefore(wrap, tablist.children[index] || null); });
    cursor = rows.get(snap.activeId)?.wrap; // keep the active tab in view in this strip's own horizontal scroller
    if (cursor?.scrollIntoView) { const left = cursor.offsetLeft, right = left + cursor.offsetWidth; if (left < tablist.scrollLeft) tablist.scrollLeft = left; else if (right > tablist.scrollLeft + tablist.clientWidth) tablist.scrollLeft = right - tablist.clientWidth; }
    if (focusedId && rows.get(focusedId) && doc.activeElement !== rows.get(focusedId).tab) rows.get(focusedId).tab.focus({preventScroll: true});
    const full = tabsFull();
    for (const key of ['add', 'open']) { controls[key].setAttribute('aria-disabled', String(full)); controls[key].title = full ? MESSAGES.limit(snap.maxTabs) : key === 'add' ? MESSAGES.newTab : MESSAGES.open; }
    controls.split.setAttribute('aria-pressed', String(snap.split)); controls.split.title = snap.split ? MESSAGES.single : MESSAGES.split; controls.split.setAttribute('aria-label', snap.split ? MESSAGES.single : MESSAGES.split);
  }

  function place() {
    const bar = doc.getElementById('menu-bar');
    if (!bar || !strip) return false;
    const tool = bar.querySelector(':scope > .menu-item[data-menu="tool"]'), toggle = bar.querySelector(':scope > #toolbox-basic-toggle');
    if (!tool && !toggle) return false;
    if (tool) { if (strip.previousElementSibling !== tool || strip.parentNode !== bar) tool.after(strip); }
    else if (strip.nextElementSibling !== toggle || strip.parentNode !== bar) toggle.before(strip);
    return true;
  }

  // ----- keyboard on the strip (roving tabindex) -----
  function onTabKey(event) {
    const tab = event.target?.closest?.('.ws-tab'); if (!tab) return;
    const order = snap.tabs.map(item => item.id), at = order.indexOf(tab.dataset.tabId);
    const focusAt = index => { const row = rows.get(order[(index + order.length) % order.length]); if (row) { for (const other of rows.values()) other.tab.tabIndex = -1; row.tab.tabIndex = 0; row.tab.focus(); } };
    let handled = true;
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      const delta = event.key === 'ArrowLeft' ? -1 : 1, target = at + delta;
      if (target >= 0 && target < order.length) { const move = moveTarget(order, order[at], delta < 0 ? at - 1 : at + 2); if (move && !move.noop) moveTab(order[at], move.beforeId); }
    } else if (event.ctrlKey || event.metaKey || event.altKey) handled = false;
    else if (event.key === 'ArrowLeft') focusAt(at - 1);
    else if (event.key === 'ArrowRight') focusAt(at + 1);
    else if (event.key === 'Home') focusAt(0);
    else if (event.key === 'End') focusAt(order.length - 1);
    else if (event.key === 'Enter' || event.key === ' ') selectTab(tab.dataset.tabId);
    else if (event.key === 'Delete') closeTab(tab.dataset.tabId);
    else handled = false;
    if (handled) { event.preventDefault(); event.stopPropagation(); }
  }

  // ----- drag to reorder (private MIME, opaque id only) -----
  let dragId = null;
  function clearDrop() { for (const row of rows.values()) row.wrap.classList.remove('drop-before', 'drop-after', 'is-dragging'); }
  const hasTabType = event => { const types = event.dataTransfer?.types; return !!types && [...types].includes(TAB_MIME); };
  function slotAt(event) {
    const list = snap.tabs.map(tab => rows.get(tab.id)?.wrap).filter(Boolean);
    return dropSlot(list.map(wrap => { const box = wrap.getBoundingClientRect(); return box.left + box.width / 2; }), event.clientX);
  }
  function showDrop(slot) {
    clearDrop();
    const ids = snap.tabs.map(tab => tab.id);
    if (dragId) rows.get(dragId)?.wrap.classList.add('is-dragging');
    if (!ids.length) return;
    if (slot < ids.length) rows.get(ids[slot])?.wrap.classList.add('drop-before'); else rows.get(ids[ids.length - 1])?.wrap.classList.add('drop-after');
  }
  function installDrag() {
    on(tablist, 'dragstart', event => {
      const wrap = event.target?.closest?.('.ws-tabwrap');
      if (!wrap || !isTabId(wrap.dataset.tabId) || !event.dataTransfer) { event.preventDefault(); return; }
      dragId = wrap.dataset.tabId;
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData(TAB_MIME, dragId); // deliberately NOT text/plain
      wrap.classList.add('is-dragging');
    });
    on(tablist, 'dragover', event => {
      if (!hasTabType(event)) return;
      if (!dragId || !snap.tabs.some(tab => tab.id === dragId)) return; // stale/foreign drag: not a drop target
      event.preventDefault(); event.dataTransfer.dropEffect = 'move';
      showDrop(slotAt(event));
    });
    on(tablist, 'dragleave', event => { if (!tablist.contains(event.relatedTarget)) clearDrop(); });
    on(tablist, 'drop', event => {
      if (!hasTabType(event)) return;
      event.preventDefault(); event.stopPropagation();
      const id = (() => { try { return event.dataTransfer.getData(TAB_MIME); } catch { return ''; } })();
      const slot = slotAt(event);
      clearDrop(); dragId = null;
      if (!isTabId(id) || !snap.tabs.some(tab => tab.id === id)) return; // empty/stale payload: no jump
      const move = moveTarget(snap.tabs.map(tab => tab.id), id, slot);
      if (move && !move.noop) moveTab(id, move.beforeId);
    });
    on(tablist, 'dragend', () => { clearDrop(); dragId = null; });
    // A tab drag that ends anywhere else (editor, other pane) is swallowed: it must never reach Studio's own drop handlers.
    for (const type of ['dragover', 'drop']) on(doc, type, event => {
      if (!hasTabType(event) || (strip && strip.contains(event.target))) return;
      event.stopImmediatePropagation(); if (type === 'drop') { event.preventDefault(); clearDrop(); dragId = null; } else if (event.dataTransfer) event.dataTransfer.dropEffect = 'none';
    }, true);
    on(doc, 'keydown', event => { if (event.key === 'Escape' && dragId) { clearDrop(); dragId = null; } }, true);
  }

  // ----- global shortcuts (never while composing, in a dialog/modal, or when something else already handled the key) -----
  const blocked = () => !!(ctx.hasDialog?.() || doc.querySelector('.modal-overlay, dialog[open], .context-menu, #menu-bar .menu-item.open'));
  on(doc, 'keydown', event => {
    if (disposed || event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    const key = event.key;
    const swallow = () => { event.preventDefault(); event.stopPropagation(); };
    if (key === 'Tab') {
      if (blocked()) return;
      swallow();
      const target = cycleId(snap.tabs.map(tab => tab.id), selfId, event.shiftKey ? -1 : 1);
      if (target) selectTab(target);
    } else if (!event.shiftKey && (key === 't' || key === 'T')) {
      if (blocked()) return;
      swallow(); newTab(false);
    } else if (!event.shiftKey && (key === 'w' || key === 'W')) {
      if (blocked()) return;
      swallow(); closeTab(selfId);
    }
  }, true);

  // ----- focus -> native (debounced; only when this pane is not already the active one) -----
  let focusTimer = 0, lastFocusSent = 0;
  const wantFocus = () => {
    if (disposed || snap.activeId === selfId || win.document?.hidden) return;
    win.clearTimeout(focusTimer);
    focusTimer = win.setTimeout(() => {
      const now = Date.now();
      if (disposed || snap.activeId === selfId || now - lastFocusSent < 300) return;
      lastFocusSent = now; send('workspaceFocus', {}).catch(() => {});
    }, 150);
  };
  on(doc, 'focusin', wantFocus, true); on(doc, 'pointerdown', wantFocus, true);

  // ----- this document's state -> native, only when title/dirty/encrypted/ready change -----
  let sentKey = '', updating = false, pendingState = null;
  async function pushState() {
    if (updating || !pendingState) return;
    updating = true;
    try { while (pendingState) { const state = pendingState; pendingState = null; sentKey = docStateKey(state); await send('workspaceUpdate', state).catch(() => { sentKey = ''; }); } }
    finally { updating = false; }
  }
  function checkState() {
    if (disposed) return;
    let state; try { state = documentState(studio?.android?.getState?.()); } catch { return; }
    if (docStateKey(state) === sentKey || (pendingState && docStateKey(pendingState) === docStateKey(state))) return;
    pendingState = state; void pushState();
  }
  const stateTimer = win.setInterval(checkState, 400);
  cleanups.push(() => win.clearInterval(stateTimer));
  checkState();

  // ----- close request (native -> JS), answered at most once per token -----
  const answered = new Set(); let closing = false;
  win.AndroidWorkspaceCloseRequest = async token => {
    if (typeof token !== 'string' || !TOKEN.test(token) || answered.has(token)) return;
    answered.add(token); if (answered.size > 64) answered.delete(answered.values().next().value);
    let allow = false;
    if (!closing && !ctx.hasDialog?.()) {
      closing = true;
      try { allow = (await studio?.android?.confirmClose?.()) === true; } catch { allow = false; } finally { closing = false; }
    }
    try { await request('workspaceCloseResult', {token, allow}); } catch (error) { fail(error); }
  };

  // ----- native events -----
  cleanups.push(subscribe('workspaceChanged', data => { accept(data); }));
  cleanups.push(subscribe('resume', () => { void refresh(); }));

  // ----- install -----
  build(); render();
  const placed = place();
  if (!placed && typeof win.MutationObserver === 'function') {
    observer = new win.MutationObserver(() => { if (place()) { observer.disconnect(); observer = null; } });
    observer.observe(doc.documentElement, {childList: true, subtree: true});
    win.setTimeout(() => { observer?.disconnect(); observer = null; }, 15000);
  }
  // The menu row can be rebuilt by Studio; keep the strip in its slot.
  const bar = doc.getElementById('menu-bar');
  if (bar && typeof win.MutationObserver === 'function') { const keep = new win.MutationObserver(() => { if (strip && (strip.parentNode !== bar || strip.previousElementSibling?.dataset?.menu !== 'tool')) place(); }); keep.observe(bar, {childList: true}); cleanups.push(() => keep.disconnect()); }
  const style = doc.createElement('style'); style.dataset.workspaceTabs = ''; style.textContent = CSS; (doc.head || doc.documentElement).append(style); cleanups.push(() => style.remove());

  // ----- this tab's first action (open picker / recent entry): the core in-place command, once, with the routing bypass scoped to the call -----
  async function runInitialAction() {
    const action = initialAction;
    if (action.kind === 'blank') return;
    const execute = studio?.automation?.execute;
    if (typeof execute !== 'function') return;
    let outcome = null, stop = null;
    if (action.kind === 'open' && typeof ctx.onOpenPicker === 'function') outcome = new Promise(resolve => { stop = ctx.onOpenPicker(resolve); });
    // The bypass travels WITH the command (params marker accepted only by patch 0115's open/new/recent wrappers), never as shared state:
    // automation.execute may await readiness/middleware before it dispatches, so a flag cleared on return would already be gone.
    const params = action.kind === 'open' ? {androidWorkspaceInPlace: true} : {id: action.recentId, androidWorkspaceInPlace: true};
    const command = action.kind === 'open' ? 'file:open' : 'file:open-recent';
    let result;
    try { result = await execute.call(studio.automation, command, params, {allowDialog: true}); }
    catch (error) { result = {ok: false, message: String(error?.message || error)}; }
    if (action.kind !== 'open') { if (result && result.ok === false) fail(result.message || '문서를 열지 못했어요.'); return; }
    if (!result || result.ok === false) { stop?.(); if (result?.message) fail(result.message); await request('workspaceInitialDone', {cancelled: false}).catch(() => {}); return; }
    const picked = await outcome; // 'picked' | 'cancelled' | 'failed'
    await request('workspaceInitialDone', {cancelled: picked === 'cancelled'}).catch(() => {});
  }

  const controller = {
    selfId, initialAction, snapshot: () => snap, apply: accept, refresh, newTab, openRecent, closeTab, selectTab, moveTab,
    dispose() { disposed = true; observer?.disconnect(); for (const fn of cleanups.splice(0).reverse()) { try { fn(); } catch { /* best effort */ } } strip?.remove(); },
  };
  void refresh(); // events sent before the subscription existed are not replayed
  void runInitialAction().catch(fail);
  return controller;
}
