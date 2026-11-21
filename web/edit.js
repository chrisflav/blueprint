// edit.js — edit mode: reorganising the dependency graph in the browser.
//
// Loaded only when the reader asks for it (*Edit graph* behind the graph's
// Filters, or `?edit=1` in the page's URL; app.js, `setEditing`), so reading
// mode downloads, draws and does nothing new.
//
// The snapshot is never changed.  What the reader does is an op of
// `edit-model.js`, kept in a log: the edited snapshot is the base with the log
// replayed, and it takes the base's place as `app.snapshot` / `app.model`
// while edit mode is on, so the graph, the side panel, the object pages and
// the document all show the reorganised blueprint.  Leaving edit mode puts the
// base back.  The log is kept in `localStorage` per blueprint, and can be
// exported and imported as an edit file; *Export TeX* writes the edited
// blueprint as a leanblueprint LaTeX document (`export/blueprint-tex.js`).
//
// The log is untrusted: an edit file can come from anyone, so whatever it
// holds is checked (`E.checkOps`) and the prose of every object it puts in
// place is rendered through app.js's sanitiser (`untrusted`).
//
// The pages call in through `app.editor` (null in reading mode):
//   untrusted(object)                 'edited' for an object of the log, else false
//   decorateNode(g, object, {strip})  a node of the graph, before graph.js wires it
//   decorateEdge(g, entity)           an arc of the graph
//   sidePanel(side, object|null)      the graph's side panel, once it is built
//   objectPage(page, object)          an object page, once it is built

import * as M from './model.js';
import * as E from './edit-model.js';
import { exportBlueprintTex } from './export/blueprint-tex.js';

const STORE_PREFIX = 'blueprint.edits:';
const CSS_HREF = 'edit.css';

let S = null; // the session, while edit mode is on

// ---------------------------------------------------------------------------
// entering and leaving
// ---------------------------------------------------------------------------

export function enter(app) {
  const base = app.snapshot;
  const project = (app.model.project && (app.model.project.name || app.model.project.title)) || '';
  S = {
    app,
    base,
    baseModel: app.model,
    baseById: new Map(base.objects.map((o) => [o.id, o])),
    trust: new WeakMap(), // object -> untrusted(object), once asked
    baseCycles: new Set(E.findCycles(E.usesRelation(base)).map((c) => [...c].sort().join(' '))),
    key: STORE_PREFIX + project + ':' + (app.dataUrlOriginal || app.dataUrl || ''),
    ops: [],
    redo: [],
    marked: new Set(),
    pending: null, // {kind: 'uses'|'usedBy', from}
    summary: null,
    check: null,
    panelOpen: false,
    cleanup: [],
  };
  loadStored();
  if (!document.querySelector(`link[href="${CSS_HREF}"]`)) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = CSS_HREF;
    link.dataset.edit = '1';
    document.head.appendChild(link);
  }
  document.documentElement.classList.add('bp-editing');
  buildDock();
  const on = (target, type, fn, opts) => {
    target.addEventListener(type, fn, opts);
    S.cleanup.push(() => target.removeEventListener(type, fn, opts));
  };
  on(document, 'keydown', onKey);
  on(document, 'pointerdown', (ev) => { if (!ev.target.closest || !ev.target.closest('.ed-menu')) closeMenu(); }, true);
  on(document, 'contextmenu', onStageMenu);
  on(window, 'blur', closeMenu);
  recompute();
  return {
    untrusted, decorateNode, decorateEdge, sidePanel, objectPage,
    exit,
    // for tests and the console
    get ops() { return S ? S.ops.slice() : []; },
    undo, redo,
  };
}

function exit() {
  if (!S) return;
  closeMenu();
  closeDialog();
  for (const f of S.cleanup) f();
  S.dock.remove();
  if (S.rubber) S.rubber.remove();
  document.documentElement.classList.remove('bp-editing', 'ed-picking');
  const link = document.querySelector(`link[data-edit="1"]`);
  if (link) link.remove();
  S.app.snapshot = S.base;
  S.app.model = S.baseModel;
  S = null;
}

// ---------------------------------------------------------------------------
// the log: storage, replay, undo
// ---------------------------------------------------------------------------

function storage() {
  try { return window.localStorage || null; } catch (e) { return null; }
}

function loadStored() {
  let data;
  try {
    const store = storage();
    const raw = store && store.getItem(S.key);
    if (!raw) return;
    data = JSON.parse(raw);
  } catch (e) { return; /* unreadable: start afresh */ }
  try {
    // As untrusted as an edit file: anything on this origin could have written it.
    E.checkOps(data && data.ops);
    if (data.redo !== undefined) E.checkOps(data.redo);
  } catch (e) {
    setTimeout(() => toast('The edits kept in this browser could not be read and were dropped: ' + e.message, 'warn'), 0);
    return;
  }
  S.ops = data.ops;
  S.redo = data.redo || [];
  const other = !!data.base && !E.sameBase(data.base, E.fingerprint(S.base));
  if (S.ops.length) setTimeout(() => { if (S) replayNotice('Your edits kept in this browser', other); }, 0);
}

/**
 * Say what replaying the log onto this snapshot undoes: the objects changed
 * upstream since the edits were made, which the edits put back as they were
 * (`E.replayConflicts`).  `lead` names the edits, `other` says they were made
 * on another version of the blueprint.  Silent when there is nothing to say.
 */
function replayNotice(lead, other, { loaded = '' } = {}) {
  const all = E.replayConflicts(S.base, S.ops);
  // A change recorded without the version it was made on can only be told
  // apart on another snapshot.
  const list = all.filter((c) => c.how !== 'unknown' || other);
  if (!list.length) {
    if (other) toast(`${lead} were made on another version of this blueprint and have been replayed onto this one; none of the objects they change has changed since.`);
    else if (loaded) toast(loaded);
    return;
  }
  const { el } = S.app;
  const how = {
    changed: 'changed since the edit',
    removed: 'removed since the edit',
    added: 'added since, under the id the edit gives a new object',
    unknown: 'not checked: the edit did not record the version it was made on',
  };
  const shown = list.slice(0, 30);
  openDialog('Edits replayed onto a newer blueprint', el('div',
    el('p', `${lead} put whole objects in place, as they were when the edits were made${other ? ', on another version of this blueprint' : ''}. ` +
      `${list.length === 1 ? 'This object has' : `These ${list.length} objects have`} changed upstream since, and the edited blueprint shows ` +
      'the edits\' version, without the upstream change:'),
    el('ul.ed-conflicts', ...shown.map((c) => el('li', el('code', c.id), ` — ${how[c.how]} (${c.label})`)),
      list.length > shown.length ? el('li', `and ${list.length - shown.length} more`) : null),
    el('p.ed-fhint', 'Check them, or undo the edits that touch them and make those again on this version.')),
  [{ label: 'OK', primary: true, run: () => true }]);
}

/** 'edited' when the prose of `o` is not the snapshot's but the log's, for app.js to sanitise. */
function untrusted(o) {
  if (!S || !o) return false;
  const b = S.baseById.get(o.id);
  if (b === o) return false;
  let v = S.trust.get(o);
  if (v === undefined) {
    const same = !!b && b.kind === o.kind && b.body === o.body && JSON.stringify(b.attrs) === JSON.stringify(o.attrs);
    v = same ? false : 'edited';
    S.trust.set(o, v);
  }
  return v;
}

function saveStored() {
  try {
    const store = storage();
    if (!store) return;
    if (!S.ops.length && !S.redo.length) store.removeItem(S.key);
    else store.setItem(S.key, JSON.stringify({ base: E.fingerprint(S.base), ops: S.ops, redo: S.redo }));
  } catch (e) {
    toast('Your browser would not keep the edits (storage full or blocked): export them to keep them.');
  }
}

/** Put the edited snapshot in the base's place. */
function recompute() {
  const app = S.app;
  let edited = S.base;
  let model = S.baseModel;
  let summary = null;
  try {
    // All of it here, so that a log the model cannot be built from leaves
    // the base on screen rather than edit mode half entered.
    const e = E.applyOps(S.base, S.ops);
    if (e !== S.base) {
      model = M.buildModel(e);
      summary = E.summarize(S.base, e);
      edited = e;
    }
  } catch (e) {
    console.error(e);
    toast('The edits could not be replayed: ' + e.message, 'warn');
    S.ops = [];
    edited = S.base;
    model = S.baseModel;
    summary = null;
  }
  app.snapshot = edited;
  app.model = model;
  S.summary = summary || { added: [], removed: [], changed: [], usesAdded: [], usesRemoved: [], marks: new Map() };
  S.check = E.checkGraph(app.snapshot);
  for (const id of [...S.marked]) if (!app.model.byId.has(id)) S.marked.delete(id);
  saveStored();
  renderDock();
}

/** Apply a new op, then show `select` (or keep the view). */
function commit(op, { select = null } = {}) {
  S.ops.push(op);
  S.redo = [];
  recompute();
  const fresh = S.check.cycles.filter((c) => !S.baseCycles.has([...c].sort().join(' ')));
  if (fresh.length) toast(`Warning: this makes a dependency cycle (${fresh[0].join(' → ')}).`, 'warn');
  reveal(select);
}

/** Try an operation; a refusal is said, not thrown. */
function attempt(fn, opts) {
  try {
    const op = fn(S.app.snapshot);
    commit(op, typeof opts === 'function' ? opts(op) : opts);
    return op;
  } catch (e) {
    if (!(e instanceof E.EditError)) console.error(e);
    toast(e.message, 'warn');
    return null;
  }
}

function undo() {
  if (!S.ops.length) { toast('Nothing to undo.'); return; }
  const op = S.ops.pop();
  S.redo.push(op);
  recompute();
  toast('Undone: ' + op.label);
  reveal(null);
}

function redo() {
  if (!S.redo.length) { toast('Nothing to redo.'); return; }
  const op = S.redo.pop();
  S.ops.push(op);
  recompute();
  toast('Redone: ' + op.label);
  reveal(null);
}

/** Redraw the page; on the graph, open the sections down to `id` and select it. */
function reveal(id) {
  const app = S.app;
  const route = app.route || {};
  if (route.view === 'object') {
    if (id && id !== route.id) { app.go('object', id); return; }
    if (route.id && !app.model.byId.has(route.id)) { app.go('graph', null, null); return; }
    app.refresh();
    return;
  }
  if (route.view === 'graph' && id && app.model.byId.has(id)) {
    const kind = route.params.get('collapse') || app.model.defaultCollapse;
    let expand = (route.params.get('expand') || '').split(',').filter(Boolean);
    try {
      const order = M.collapseOrder(app.model, kind);
      expand = [...new Set(expand.concat(M.expandableAncestorsOf(order, id)))].filter((x) => app.model.byId.has(x));
    } catch (e) { /* no such order: leave the view */ }
    const before = app.route.raw;
    app.setParams({ sel: id, expand: expand.join(',') || null });
    if (app.route.raw === before) app.refresh();
    return;
  }
  if (route.view === 'graph' && route.params.get('sel') && !app.model.byId.has(route.params.get('sel'))) {
    // what was selected is gone (deleted, merged away, undone)
    app.setParams({ sel: null });
    return;
  }
  app.refresh();
}

// ---------------------------------------------------------------------------
// what is selected
// ---------------------------------------------------------------------------

function selectedId() {
  const r = S.app.route;
  if (!r) return null;
  const id = r.view === 'graph' ? r.params.get('sel') : r.view === 'object' ? r.id : null;
  return id && S.app.model.byId.has(id) ? id : null;
}

function obj(id) { return S.app.model.byId.get(id) || null; }
function titleOf(id) { return M.titleOf(obj(id)); }
function draft() { return new E.Draft(S.app.snapshot); }
function isEditableNode(o) { return !!o && !o.boundary.length; }
function isSection(o) { return !!o && M.isSectionKind(o.kind); }

// ---------------------------------------------------------------------------
// the dock: what has changed, and the editor's commands
// ---------------------------------------------------------------------------

/** Append the children that are there: `null` and `false` are left out, as `el` leaves them. */
function put(node, ...kids) {
  for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) node.append(k);
  return node;
}

function button(label, attrs = {}) {
  return S.app.el('button', { type: 'button', ...attrs }, label);
}

function buildDock() {
  const { el } = S.app;
  const dock = el('div.ed-dock', { role: 'region', 'aria-label': 'Graph editor' });
  const file = el('input', { type: 'file', accept: '.json,application/json', hidden: true, onchange: onImportFile });
  S.fileInput = file;
  S.dock = dock;
  S.dockBar = el('div.ed-bar');
  S.dockHint = el('div.ed-hint', { hidden: true });
  S.dockPanel = el('div.ed-panel', { hidden: true });
  S.datalist = el('datalist', { id: 'ed-ids' });
  S.toasts = el('div.ed-toasts', { 'aria-live': 'polite' });
  dock.append(S.toasts, S.dockHint, S.dockPanel, S.dockBar, file, S.datalist);
  document.body.appendChild(dock);
}

function renderDock() {
  if (!S) return;
  const { el, clear } = S.app;
  const n = S.ops.length;
  const fresh = S.check.cycles.filter((c) => !S.baseCycles.has([...c].sort().join(' ')));
  const bar = clear(S.dockBar);
  put(bar,
    el('span.ed-title', { title: 'Edit mode: the blueprint is unchanged; your edits are a log kept in this browser' }, '✎ Editing'),
    button(n ? `${n} change${n === 1 ? '' : 's'}` : 'no changes', {
      class: 'ed-count' + (S.panelOpen ? ' active' : ''), 'aria-expanded': S.panelOpen ? 'true' : 'false',
      title: 'what has changed (C)', onclick: togglePanel,
    }),
    fresh.length ? el('span.ed-warn', { title: fresh.map((c) => c.join(' → ')).join('\n') },
      `⚠ ${fresh.length} cycle${fresh.length === 1 ? '' : 's'}`) : null,
    button('↶', { title: 'Undo (Ctrl+Z)', 'aria-label': 'Undo', disabled: !n, onclick: undo }),
    button('↷', { title: 'Redo (Ctrl+Shift+Z)', 'aria-label': 'Redo', disabled: !S.redo.length, onclick: redo }),
    button('+ Node', { title: 'Add a node (N)', onclick: () => openNodeDialog(null) }),
    button('Export TeX', { class: 'ed-primary', title: 'The reorganised blueprint as a LaTeX document that import-latex reads back', onclick: exportTex }),
    button('Export edits', { title: 'Save the edit log as a file, to share or resume', onclick: exportEdits }),
    button('Import edits', { title: 'Load an edit file', onclick: () => S.fileInput.click() }),
    button('?', { title: 'Keyboard shortcuts (?)', 'aria-label': 'Help', onclick: openHelp }),
    button('Done', { title: 'Back to reading mode (E); your edits are kept', onclick: () => S.app.setEditing(false) }),
  );
  // the hint for a pending pick
  S.dockHint.hidden = !S.pending;
  document.documentElement.classList.toggle('ed-picking', !!S.pending);
  if (S.pending) {
    clear(S.dockHint).append(
      S.pending.kind === 'uses'
        ? `Click the node that ${titleOf(S.pending.from)} should use`
        : `Click the node that should use ${titleOf(S.pending.from)}`,
      ' ', button('Cancel (Esc)', { onclick: () => { S.pending = null; renderDock(); } }));
  }
  // the datalist every id field offers
  const opts = [];
  for (const o of S.app.model.objects) {
    if (!isEditableNode(o) || o.kind === M.TEXT_KIND) continue;
    opts.push(el('option', { value: o.id }, M.titleOf(o) === o.id ? o.kind : `${M.titleOf(o)} (${o.kind})`));
  }
  clear(S.datalist).append(...opts);
  renderPanel();
}

function togglePanel() {
  S.panelOpen = !S.panelOpen;
  renderDock();
}

function idLink(id, { removed = false } = {}) {
  const { el } = S.app;
  if (removed || !obj(id)) return el('span.ed-id' + (removed ? '.ed-gone' : ''), { title: id }, id);
  return el('a.ed-id', {
    href: '#', title: titleOf(id),
    onclick: (ev) => { ev.preventDefault(); goTo(id); },
  }, id);
}

function goTo(id) {
  const app = S.app;
  if (app.route.view !== 'graph') {
    app.go('graph', null, new URLSearchParams({ sel: id }));
    return;
  }
  reveal(id);
}

function renderPanel() {
  const { el, clear } = S.app;
  const panel = clear(S.dockPanel);
  panel.hidden = !S.panelOpen;
  if (!S.panelOpen) return;
  const s = S.summary;
  const list = (title, items, render) => (items.length
    ? el('section', el('h4', `${title} (${items.length})`), el('ul', ...items.slice(0, 60).map((x) => el('li', render(x))),
      items.length > 60 ? el('li.muted', `+${items.length - 60} more`) : null))
    : null);
  const fresh = S.check.cycles.filter((c) => !S.baseCycles.has([...c].sort().join(' ')));
  put(panel,
    el('div.ed-panel-head', el('h3', 'Changes'),
      S.ops.length ? button('Discard all', { title: 'Undo every edit (Redo brings them back)', onclick: discardAll }) : null),
    !S.ops.length ? el('p.muted', 'Nothing edited yet. Right-click a node, or select it and use the side panel. Press ? for the shortcuts.') : null,
    fresh.length ? el('section.ed-warnings', el('h4', 'Dependency cycles'),
      el('ul', ...fresh.map((c) => el('li', ...c.flatMap((id, i) => [i ? ' → ' : null, idLink(id)])))) ) : null,
    S.check.dangling.length ? el('section.ed-warnings', el('h4', 'Dangling references'),
      el('ul', ...S.check.dangling.map((d) => el('li', `${d.id} → ${d.ref}`)))) : null,
    list('Added', s.added, (id) => [el('span.ed-tag.ed-tag-new', 'new'), ' ', idLink(id), ' ', el('span.muted', titleOf(id) !== id ? titleOf(id) : '')]),
    list('Removed', s.removed, (id) => [el('span.ed-tag.ed-tag-del', 'deleted'), ' ', idLink(id, { removed: true })]),
    list('Changed', s.changed, (c) => [el('span.ed-tag.ed-tag-chg', 'changed'), ' ', idLink(c.id), ' ', el('span.muted', c.what.join(', '))]),
    list('Dependencies added', s.usesAdded, ([a, b]) => [idLink(a), ' uses ', idLink(b)]),
    list('Dependencies removed', s.usesRemoved, ([a, b]) => [idLink(a, { removed: !obj(a) }), ' no longer uses ', idLink(b, { removed: !obj(b) })]),
    S.ops.length ? el('section', el('h4', `Edit log (${S.ops.length})`),
      el('ol.ed-log', ...S.ops.map((op, i) => el('li', { class: i === S.ops.length - 1 ? 'last' : null },
        el('span', op.label),
        i === S.ops.length - 1 ? button('undo', { class: 'ed-link', onclick: undo }) : null)))) : null,
  );
}

function discardAll() {
  if (!S.ops.length) return;
  if (!window.confirm(`Undo all ${S.ops.length} edits? (Redo brings them back one by one.)`)) return;
  S.redo = S.redo.concat(S.ops.slice().reverse());
  S.ops = [];
  recompute();
  reveal(null);
}

// ---------------------------------------------------------------------------
// files: Export TeX, Export edits, Import edits
// ---------------------------------------------------------------------------

function download(name, text, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function projectSlug() {
  const p = S.app.model.project || {};
  return String(p.name || p.title || 'blueprint').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'blueprint';
}

function exportTex() {
  try {
    const r = exportBlueprintTex(S.app.snapshot);
    download(r.fileName, r.tex, 'application/x-tex');
    S.lastTex = r;
    const notes = r.diagnostics.length ? ` (${r.diagnostics.length} note${r.diagnostics.length === 1 ? '' : 's'}: ${r.diagnostics.slice(0, 2).map((d) => d.message).join('; ')}${r.diagnostics.length > 2 ? '; …' : ''})` : '';
    toast(`Exported ${r.fileName}: ${r.stats.headings} headings, ${r.stats.statements} statements, ${r.stats.proofs} proofs, ${r.stats.uses} dependencies${notes}.`);
  } catch (e) {
    console.error(e);
    toast('The TeX export failed: ' + e.message, 'warn');
  }
}

function exportEdits() {
  if (!S.ops.length) { toast('There are no edits to export yet.'); return; }
  download(`${projectSlug()}-edits.json`, E.serializeEdits(S.base, S.ops), 'application/json');
  toast(`Exported ${S.ops.length} edit${S.ops.length === 1 ? '' : 's'}.`);
}

function onImportFile(ev) {
  const f = ev.target.files && ev.target.files[0];
  ev.target.value = '';
  if (!f) return;
  f.text().then((text) => importEdits(text)).catch((e) => toast('Could not read the file: ' + e.message, 'warn'));
}

/** Load an edit file's text in place of the current log. */
export function importEdits(text) {
  let parsed;
  try {
    parsed = E.parseEdits(text, { snapshot: S.base });
  } catch (e) {
    toast('Not loaded: ' + e.message, 'warn');
    return false;
  }
  if (S.ops.length && !window.confirm(`Replace your ${S.ops.length} current edits with the ${parsed.ops.length} in this file?`)) return false;
  S.ops = parsed.ops;
  S.redo = [];
  recompute();
  const other = !!parsed.base && !E.sameBase(parsed.base, E.fingerprint(S.base));
  const n = `${parsed.ops.length} edit${parsed.ops.length === 1 ? '' : 's'}`;
  reveal(null);
  replayNotice(`The ${n} loaded`, other, { loaded: `Loaded ${n}.` });
  return true;
}

// ---------------------------------------------------------------------------
// messages
// ---------------------------------------------------------------------------

function toast(message, level = 'info') {
  if (!S) return;
  const { el } = S.app;
  const t = el('div.ed-toast' + (level === 'warn' ? '.warn' : ''), { role: 'status' }, message);
  S.toasts.appendChild(t);
  while (S.toasts.children.length > 3) S.toasts.firstChild.remove();
  setTimeout(() => t.classList.add('gone'), level === 'warn' ? 6000 : 3800);
  setTimeout(() => t.remove(), level === 'warn' ? 6600 : 4400);
}

// ---------------------------------------------------------------------------
// the graph: marks, menus, picking and dragging dependencies
// ---------------------------------------------------------------------------

function decorateNode(g, o, { strip = false } = {}) {
  if (!S) return;
  const id = o.id;
  if (!strip) {
    const mark = S.summary.marks.get(id) || (inside(id) ? 'inner' : null);
    if (mark) g.classList.add('ed-' + mark);
    if (S.marked.has(id)) g.classList.add('ed-marked');
  }
  // Before graph.js's own click (which selects): a pick in progress, or a
  // mark, takes the click instead.
  g.addEventListener('click', (ev) => {
    if (!S) return;
    if (S.pending) {
      ev.stopImmediatePropagation();
      ev.stopPropagation();
      finishPick(id);
      return;
    }
    if (ev.ctrlKey || ev.metaKey || ev.shiftKey) {
      ev.stopImmediatePropagation();
      ev.stopPropagation();
      toggleMark(id);
    }
  });
  g.addEventListener('contextmenu', (ev) => {
    if (!S) return;
    ev.preventDefault();
    ev.stopPropagation();
    openNodeMenu(id, ev.clientX, ev.clientY);
  });
  g.addEventListener('pointerdown', (ev) => {
    if (!S || !ev.shiftKey || ev.button !== 0) return;
    ev.stopPropagation(); // no pan
    startDrag(id, ev);
  });
}

/** Whether a collapsed node holds something edited. */
function inside(id) {
  if (!S.summary.marks.size) return false;
  const o = obj(id);
  if (!o || !isSection(o)) return false;
  try {
    const order = M.collapseOrder(S.app.model, S.app.model.defaultCollapse);
    return M.descendantsOf(order, id).some((d) => S.summary.marks.has(d));
  } catch (e) { return false; }
}

function decorateEdge(g, entity) {
  if (!S || !entity) return;
  g.addEventListener('contextmenu', (ev) => {
    if (!S) return;
    ev.preventDefault();
    ev.stopPropagation();
    const usesKind = E.editKinds(S.app.snapshot).uses;
    const members = (entity.members || []).filter((m) => m && m.kind === usesKind).map((m) => m.id);
    openMenu(ev.clientX, ev.clientY, [
      { label: `${entity.src} ↔ ${entity.tgt}`, header: true },
      { label: members.length > 1 ? `Remove these ${members.length} dependencies` : 'Remove this dependency', key: 'Del',
        disabled: !members.length, run: () => attempt((snap) => E.opRemoveEdges(snap, members)) },
    ]);
  });
}

function toggleMark(id) {
  if (S.marked.has(id)) S.marked.delete(id); else S.marked.add(id);
  for (const g of document.querySelectorAll('.gnode')) {
    if (g.getAttribute('data-id') === id) g.classList.toggle('ed-marked', S.marked.has(id));
  }
  toast(S.marked.size ? `${S.marked.size} marked for merging (M merges them with the selection)` : 'No node marked');
}

function startPick(kind, from) {
  S.pending = { kind, from };
  closeMenu();
  renderDock();
  if (S.app.route.view !== 'graph') S.app.go('graph', null, new URLSearchParams({ sel: from }));
}

function finishPick(target) {
  const p = S.pending;
  S.pending = null;
  renderDock();
  if (!p || target === p.from) return;
  if (p.kind === 'uses') attempt((snap) => E.opAddUse(snap, p.from, target), { select: p.from });
  else attempt((snap) => E.opAddUse(snap, target, p.from), { select: target });
}

/**
 * Shift-drag from one node to another draws the arc as the graph will draw
 * it: from a dependency to what uses it (the `uses` arrow points that way),
 * so the drag goes the way of the arrow.
 */
function startDrag(from, ev) {
  const { svgEl } = S.app;
  const box = ev.currentTarget.getBoundingClientRect();
  const x0 = box.left + box.width / 2;
  const y0 = box.top + box.height / 2;
  if (!S.rubber) {
    S.rubber = svgEl('svg', { class: 'ed-rubber', 'aria-hidden': 'true' },
      svgEl('defs', svgEl('marker', { id: 'ed-head', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 8, markerHeight: 8, orient: 'auto' },
        svgEl('path', { d: 'M0,0 L10,5 L0,10 z' }))),
      svgEl('line', { 'marker-end': 'url(#ed-head)' }));
    document.body.appendChild(S.rubber);
  }
  const line = S.rubber.querySelector('line');
  const reversed = M.isReversedKind(S.app.model, E.editKinds(S.app.snapshot).uses);
  S.rubber.style.display = 'block';
  const set = (x, y) => {
    line.setAttribute('x1', x0); line.setAttribute('y1', y0);
    line.setAttribute('x2', x); line.setAttribute('y2', y);
  };
  set(x0, y0);
  let moved = false;
  const move = (e) => {
    if (Math.abs(e.clientX - x0) + Math.abs(e.clientY - y0) > 6) moved = true;
    set(e.clientX, e.clientY);
    const t = nodeAt(e.clientX, e.clientY);
    S.dockHint.hidden = false;
    S.dockHint.textContent = t && t !== from
      ? (reversed ? `${t} will use ${from}` : `${from} will use ${t}`)
      : 'Drop on the node at the arrow’s end';
  };
  const up = (e) => {
    window.removeEventListener('pointermove', move, true);
    window.removeEventListener('pointerup', up, true);
    S.rubber.style.display = 'none';
    renderDock();
    if (!moved) return; // a shift-click: the click marks it
    // the click the drag would end in must not select or mark anything
    const swallow = (c) => { c.stopImmediatePropagation(); c.stopPropagation(); c.preventDefault(); };
    window.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0);
    const t = nodeAt(e.clientX, e.clientY);
    if (!t || t === from) return;
    if (reversed) attempt((snap) => E.opAddUse(snap, t, from), { select: t });
    else attempt((snap) => E.opAddUse(snap, from, t), { select: from });
  };
  window.addEventListener('pointermove', move, true);
  window.addEventListener('pointerup', up, true);
}

function nodeAt(x, y) {
  const els = document.elementsFromPoint ? document.elementsFromPoint(x, y) : [document.elementFromPoint(x, y)];
  for (const e of els) {
    const g = e && e.closest && e.closest('.gnode, .gtitle');
    if (g) {
      const id = g.getAttribute('data-id');
      if (id) return id;
      // a section's title strip carries only the layout id
      const nid = g.getAttribute('data-nid');
      const twin = nid && document.querySelector(`.gnode[data-nid="${CSS.escape(nid)}"]`);
      if (twin) return twin.getAttribute('data-id');
    }
  }
  return null;
}

// --- menus -------------------------------------------------------------------

function nodeActions(id) {
  const o = obj(id);
  const sec = isSection(o);
  const others = [...S.marked].filter((x) => x !== id);
  return [
    { label: M.titleOf(o), header: true },
    { label: 'Edit…', key: 'F2', run: () => openNodeDialog(id) },
    !sec ? { label: 'Add a dependency…', key: 'U', title: 'then click what it uses', run: () => startPick('uses', id) } : null,
    !sec ? { label: 'Add a dependent…', key: 'D', title: 'then click what uses it', run: () => startPick('usedBy', id) } : null,
    { label: sec ? 'New node in this section…' : 'New node beside it…', key: 'N', run: () => openNodeDialog(null, { near: id }) },
    !sec ? { label: 'New lemma it uses…', run: () => openNodeDialog(null, { near: id, usedBy: [id], kind: 'lemma' }) } : null,
    !sec ? { label: 'Split…', key: 'S', run: () => openSplitDialog(id) } : null,
    !sec ? { label: others.length ? `Merge with ${others.length} marked…` : 'Merge… (mark nodes first)', key: 'M',
      disabled: !others.length, run: () => openMergeDialog([id, ...others]) } : null,
    !sec ? { label: S.marked.has(id) ? 'Unmark' : 'Mark for merging', key: 'X', run: () => toggleMark(id) } : null,
    { label: 'Delete…', key: 'Del', danger: true, run: () => openDeleteDialog(id) },
    { label: 'Open object page', run: () => S.app.go('object', id) },
  ].filter(Boolean);
}

function openNodeMenu(id, x, y) {
  openMenu(x, y, nodeActions(id));
}

function onStageMenu(ev) {
  if (!S || !ev.target.closest) return;
  const stage = ev.target.closest('.graph-stage');
  if (!stage || ev.target.closest('.gnode, .gedge, .gtitle, button, a')) return;
  ev.preventDefault();
  openMenu(ev.clientX, ev.clientY, [
    { label: 'New node…', key: 'N', run: () => openNodeDialog(null) },
    { label: 'Export TeX', run: exportTex },
    { label: 'Undo', key: 'Ctrl+Z', disabled: !S.ops.length, run: undo },
  ]);
}

function openMenu(x, y, items) {
  closeMenu();
  const { el } = S.app;
  const menu = el('div.ed-menu', { role: 'menu' });
  for (const it of items) {
    if (it.header) { menu.appendChild(el('div.ed-menu-head', it.label)); continue; }
    menu.appendChild(el('button.ed-menu-item', {
      type: 'button', role: 'menuitem', disabled: !!it.disabled, title: it.title || null,
      class: it.danger ? 'danger' : null,
      onclick: () => { closeMenu(); it.run(); },
    }, el('span', it.label), it.key ? el('kbd', it.key) : null));
  }
  document.body.appendChild(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.max(4, Math.min(x, window.innerWidth - r.width - 4)) + 'px';
  menu.style.top = Math.max(4, Math.min(y, window.innerHeight - r.height - 4)) + 'px';
  S.menu = menu;
  const first = menu.querySelector('button:not([disabled])');
  if (first) first.focus();
}

function closeMenu() {
  if (S && S.menu) { S.menu.remove(); S.menu = null; }
}

// ---------------------------------------------------------------------------
// keys
// ---------------------------------------------------------------------------

function typing(t) {
  if (!t || t.nodeType !== 1) return false;
  return t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || !!t.isContentEditable ||
    (t.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'submit', 'file', 'range'].includes(String(t.type).toLowerCase()));
}

function onKey(ev) {
  if (!S || ev.defaultPrevented) return;
  const mod = ev.ctrlKey || ev.metaKey;
  if (ev.key === 'Escape') {
    if (S.menu) { closeMenu(); ev.preventDefault(); return; }
    if (S.dialog) { closeDialog(); ev.preventDefault(); return; }
    if (S.pending) { S.pending = null; renderDock(); ev.preventDefault(); return; }
    return;
  }
  if (S.menu && (ev.key === 'ArrowDown' || ev.key === 'ArrowUp')) {
    const items = [...S.menu.querySelectorAll('button:not([disabled])')];
    const i = items.indexOf(document.activeElement);
    const next = items[(i + (ev.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length];
    if (next) next.focus();
    ev.preventDefault();
    return;
  }
  if (S.dialog) return; // the dialog's own keys
  if (typing(ev.target)) return;
  if (mod && !ev.altKey && (ev.key === 'z' || ev.key === 'Z')) {
    ev.preventDefault();
    if (ev.shiftKey) redo(); else undo();
    return;
  }
  if (mod && !ev.altKey && (ev.key === 'y' || ev.key === 'Y')) { ev.preventDefault(); redo(); return; }
  if (mod || ev.altKey) return;
  const id = selectedId();
  const o = id ? obj(id) : null;
  const sec = isSection(o);
  const k = ev.key;
  const act = (fn) => { ev.preventDefault(); fn(); };
  if (k === '?') return act(openHelp);
  if (k === 'n' || k === 'N') return act(() => openNodeDialog(null, id ? { near: id } : {}));
  if (k === 'c' || k === 'C') return act(togglePanel);
  // Leaving by key, once in; no key enters (app.js).
  if (k === 'e' || k === 'E') return act(() => S.app.setEditing(false));
  if (!o) return;
  if (k === 'Delete' || k === 'Backspace') return act(() => openDeleteDialog(id));
  if (k === 'F2' || k === 'r' || k === 'R') return act(() => openNodeDialog(id));
  if (sec) return;
  if (k === 'u' || k === 'U') return act(() => startPick('uses', id));
  if (k === 'd' || k === 'D') return act(() => startPick('usedBy', id));
  if (k === 's' || k === 'S') return act(() => openSplitDialog(id));
  if (k === 'x' || k === 'X') return act(() => toggleMark(id));
  if (k === 'm' || k === 'M') {
    const ids = [...new Set([id, ...S.marked])];
    return act(() => (ids.length > 1 ? openMergeDialog(ids) : toast('Mark the nodes to merge with Ctrl+click (or X) first.')));
  }
}

function openHelp() {
  const { el } = S.app;
  const row = (k, what) => el('tr', el('td', ...k.split(' / ').flatMap((x, i) => [i ? ' / ' : null, el('kbd', x)])), el('td', what));
  openDialog('Editing the graph', el('div',
    el('p', 'The blueprint itself is never changed: every edit is a step of a log kept in this browser, ',
      'which can be undone, exported and imported. ', el('b', 'Export TeX'), ' writes the reorganised argument.'),
    el('table.ed-keys',
      row('Right-click', 'a node or an arc: what can be done to it'),
      row('Shift+drag', 'from one node to another: a dependency, in the direction of the arrow'),
      row('Ctrl+click / X', 'mark a node for merging'),
      row('F2 / R', 'edit the selected node (id, kind, title, statement, proof)'),
      row('U', 'the selected node uses … (then click it)'),
      row('D', '… uses the selected node (then click it)'),
      row('N', 'a new node, beside the selected one'),
      row('S', 'split the selected node into smaller ones'),
      row('M', 'merge the selected node with the marked ones'),
      row('Delete', 'delete the selected node'),
      row('Ctrl+Z / Ctrl+Shift+Z', 'undo / redo'),
      row('C', 'show what has changed'),
      row('E', 'leave edit mode (your edits are kept)'),
      row('Esc', 'cancel'))), [{ label: 'Close', primary: true, run: () => true }]);
}

// ---------------------------------------------------------------------------
// dialogs
// ---------------------------------------------------------------------------

/**
 * A modal dialog.  `actions`: [{label, primary, danger, run}] where `run`
 * returns true (or a truthy op) to close it.  Ctrl+Enter runs the primary one.
 */
function openDialog(title, body, actions, { wide = false } = {}) {
  closeDialog();
  closeMenu();
  const { el } = S.app;
  const prev = document.activeElement;
  const go = (a) => { const r = a.run(); if (r) closeDialog(); };
  const primary = actions.find((a) => a.primary);
  const dialog = el('div.ed-dialog' + (wide ? '.wide' : ''), { role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    el('h2', title), body,
    el('div.ed-actions', ...actions.map((a) => button(a.label, {
      class: a.primary ? 'ed-primary' : a.danger ? 'danger' : null, onclick: () => go(a),
    })), button('Cancel', { onclick: closeDialog })));
  const overlay = el('div.ed-overlay', {
    onpointerdown: (ev) => { if (ev.target === overlay) closeDialog(); },
  }, dialog);
  dialog.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey) && primary) { ev.preventDefault(); go(primary); }
    else if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); closeDialog(); }
  });
  document.body.appendChild(overlay);
  S.dialog = { overlay, prev };
  const first = dialog.querySelector('[data-autofocus]') || dialog.querySelector('input:not([type=hidden]):not([type=radio]):not([type=checkbox]), textarea, select');
  if (first) first.focus();
  return dialog;
}

function closeDialog() {
  if (!S || !S.dialog) return;
  const { overlay, prev } = S.dialog;
  overlay.remove();
  S.dialog = null;
  if (prev && prev.isConnected && typeof prev.focus === 'function') prev.focus();
}

// --- form pieces ---------------------------------------------------------------

function field(label, input, hint) {
  const { el } = S.app;
  return el('label.ed-field', el('span.ed-label', label), input, hint ? el('span.ed-fhint', hint) : null);
}

function textInput(value, attrs = {}) {
  return S.app.el('input', { type: 'text', value: value || '', spellcheck: 'false', ...attrs });
}

function textArea(value, attrs = {}) {
  const t = S.app.el('textarea', { rows: 5, spellcheck: 'true', ...attrs }, value || '');
  return t;
}

function kindSelect(value, { section = false } = {}) {
  const { el } = S.app;
  const kinds = section
    ? Object.keys(S.app.model.kinds).filter((k) => M.isSectionKind(k))
    : E.statementKinds(S.app.snapshot);
  if (value && !kinds.includes(value)) kinds.unshift(value);
  return el('select', ...kinds.map((k) => el('option', { value: k, selected: k === value }, k)));
}

/** A list of ids with a remove button each and a field to add one. */
function idChips(initial, { placeholder = 'add by id…', exclude = [] } = {}) {
  const { el, clear } = S.app;
  const ids = [...initial];
  const list = el('span.ed-chips');
  const input = textInput('', { list: 'ed-ids', placeholder, class: 'ed-chip-input' });
  const draw = () => {
    clear(list).append(...ids.map((id) => el('span.ed-chip', { title: obj(id) ? titleOf(id) : id }, id,
      button('×', { class: 'ed-x', 'aria-label': 'remove ' + id, onclick: () => { ids.splice(ids.indexOf(id), 1); draw(); } }))));
  };
  const add = () => {
    const v = input.value.trim();
    if (!v) return;
    if (!obj(v)) { toast(`No node "${v}"`, 'warn'); return; }
    if (exclude.includes(v)) return;
    if (!ids.includes(v)) ids.push(v);
    input.value = '';
    draw();
  };
  input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && !ev.ctrlKey && !ev.metaKey) { ev.preventDefault(); add(); } });
  input.addEventListener('change', add);
  draw();
  const node = el('span.ed-chipbox', list, input);
  node.value = () => { add(); return ids.slice(); };
  return node;
}

function sectionSelect(value) {
  const { el } = S.app;
  const outline = M.documentOutline(S.app.model, S.app.model.defaultCollapse);
  const opts = [el('option', { value: '' }, '(top level)')];
  for (const e of outline.entries) {
    if (e.duplicate || !M.isSectionKind(e.object.kind)) continue;
    opts.push(el('option', { value: e.id, selected: e.id === value },
      ' '.repeat(e.depth) + (e.number ? e.number + ' ' : '') + M.titleOf(e.object)));
  }
  return el('select', ...opts);
}

function preview(textarea) {
  const { el } = S.app;
  const box = el('div.ed-preview.body-prose', { hidden: true });
  const toggle = button('Preview', {
    class: 'ed-link',
    onclick: () => {
      box.hidden = !box.hidden;
      toggle.textContent = box.hidden ? 'Preview' : 'Hide preview';
      if (!box.hidden) draw();
    },
  });
  // What is typed here goes into the log, and is shown as it will be: sanitised.
  const draw = () => S.app.renderBody(S.app.clear(box), textarea.value, S.app.knownIds(), undefined, { untrusted: 'edited' });
  textarea.addEventListener('input', () => { if (!box.hidden) draw(); });
  return [toggle, box];
}

// --- add and edit ----------------------------------------------------------------

/** The editable fields of a node, filled from `id` (or blank for a new one). */
function nodeFields(id, init = {}) {
  const { el } = S.app;
  const d = draft();
  const o = id ? obj(id) : null;
  const sec = o ? isSection(o) : false;
  const proof = o ? d.proofsOf(id)[0] : null;
  const f = {};
  f.kind = kindSelect(o ? o.kind : (init.kind || 'lemma'), { section: sec });
  f.title = textInput(o ? (o.attrs.title || '') : (init.title || ''), { placeholder: 'Title (optional)', 'data-autofocus': '' });
  f.id = textInput(o ? id : '', { placeholder: 'from the title' });
  let idTouched = !!o;
  f.id.addEventListener('input', () => { idTouched = true; });
  const suggest = () => { if (!idTouched) f.id.value = d.suggestId(f.kind.value, f.title.value); };
  f.title.addEventListener('input', suggest);
  f.kind.addEventListener('change', suggest);
  if (!o) suggest();
  f.statement = textArea(o ? o.body : (init.statement || ''), { rows: 6, placeholder: 'Statement: Markdown with $maths$ and [slug] references' });
  f.proof = sec ? null : textArea(proof ? proof.body : (init.proof || ''), { rows: 6, placeholder: 'Proof (optional)' });
  f.lean = textInput(o ? (o.attrs.lean || []).join(', ') : '', { placeholder: 'Lean declarations, comma separated' });
  // A name that is not one is marked as it is typed; saving refuses it
  // (`E.LEAN_NAME_RE`, `Draft.checkLean`), unless the blueprint has it already.
  const leanNow = new Set(o ? o.attrs.lean || [] : []);
  f.lean.addEventListener('input', () => {
    const bad = f.lean.value.split(',').map((x) => x.trim()).filter((x) => x && !leanNow.has(x) && !E.LEAN_NAME_RE.test(x));
    f.lean.setCustomValidity(bad.length ? `Not a Lean name: ${bad.join(', ')}` : '');
    f.lean.title = bad.length ? `Not a Lean name: ${bad.join(', ')}` : '';
  });
  const grid = el('div.ed-form',
    el('div.ed-row', field('Kind', f.kind), field('Title', f.title), field('Id', f.id)),
    field(sec ? 'Text' : 'Statement', f.statement), el('div.ed-under', ...preview(f.statement)),
    f.proof ? field('Proof', f.proof) : null, f.proof ? el('div.ed-under', ...preview(f.proof)) : null,
    sec ? null : field('Lean', f.lean));
  f.node = grid;
  f.values = () => ({
    kind: f.kind.value,
    title: f.title.value,
    id: f.id.value.trim(),
    statement: f.statement.value,
    proof: f.proof ? f.proof.value : undefined,
    lean: sec ? undefined : f.lean.value.split(',').map((x) => x.trim()).filter(Boolean),
  });
  return f;
}

/** The dialog to add a node (`id` null) or edit one. */
function openNodeDialog(id, init = {}) {
  const { el } = S.app;
  if (id && !obj(id)) return;
  const f = nodeFields(id, init);
  if (id) {
    openDialog(`Edit ${titleOf(id)}`, el('div', f.node,
      el('p.ed-fhint', 'Changing the id renames the node everywhere: its edges, its proof and the [references] to it.')),
    [{ label: 'Save', primary: true, run: () => {
      const v = f.values();
      return attempt((snap) => E.opEdit(snap, id, { ...v, id: v.id || id }), (op) => ({ select: op.ids[0] }));
    } }]);
    return;
  }
  const d = draft();
  const near = init.near && obj(init.near) ? init.near : null;
  const nearSec = near ? (isSection(obj(near)) ? near : d.sectionOf(near)) : null;
  const section = sectionSelect(nearSec);
  const uses = idChips(init.uses || []);
  const usedBy = idChips(init.usedBy || []);
  openDialog('New node', el('div', f.node,
    el('div.ed-row', field('Section', section)),
    field('Uses', uses, 'what it depends on'),
    field('Used by', usedBy, 'what depends on it')),
  [{ label: 'Add', primary: true, run: () => {
    const v = f.values();
    const sec = section.value || null;
    const spec = { ...v, id: v.id || undefined, section: sec, uses: uses.value(), usedBy: usedBy.value() };
    if (near && !isSection(obj(near)) && sec === nearSec) spec.order = d.orderNear(near, { before: false });
    return attempt((snap) => E.opAdd(snap, spec), (op) => ({ select: op.ids[0] }));
  } }]);
}

// --- delete --------------------------------------------------------------------------

function openDeleteDialog(id) {
  const { el } = S.app;
  const d = draft();
  const o = obj(id);
  if (!o) return;
  const deps = d.allDepsOf(id);
  const users = d.dependentsOf(id);
  const kids = d.childrenOf(id).length;
  const radio = (value, checked, text) => el('label.ed-choice',
    el('input', { type: 'radio', name: 'ed-del', value, checked }), el('span', text));
  const bridge = radio('bridge', true, [el('b', 'Reconnect'), ` — the ${users.length} node${users.length === 1 ? '' : 's'} using it will use its ${deps.length} dependenc${deps.length === 1 ? 'y' : 'ies'} directly`]);
  const drop = radio('drop', false, [el('b', 'Drop its edges'), ' — only remove it and its arcs']);
  const body = el('div',
    el('p', 'Delete ', el('b', M.titleOf(o)), ` (${o.kind} `, el('code', id), ')?'),
    users.length || deps.length ? el('div.ed-choices', bridge, drop) : null,
    kids ? el('p.ed-fhint', `The ${kids} object${kids === 1 ? '' : 's'} inside it move up to its own section.`) : null,
    el('p.ed-fhint', 'References to it in prose are left as its title. Undo brings everything back.'));
  openDialog('Delete', body, [{ label: 'Delete', danger: true, primary: true, run: () => {
    const checked = body.querySelector('input[name=ed-del]:checked');
    const mode = checked ? checked.value : 'drop';
    S.marked.delete(id);
    return attempt((snap) => E.opDelete(snap, id, { mode }), { select: null });
  } }]);
}

// --- split ---------------------------------------------------------------------------

function openSplitDialog(id) {
  const { el, clear } = S.app;
  const o = obj(id);
  if (!o || isSection(o)) return;
  const d = draft();
  const proof = d.proofsOf(id)[0];
  const deps = d.allDepsOf(id);
  const stmt = textArea(o.body, { rows: 8, class: 'ed-src' });
  const prf = textArea(proof ? proof.body : '', { rows: 8, class: 'ed-src' });
  const leaveRef = el('input', { type: 'checkbox', checked: true });
  const dropMoved = el('input', { type: 'checkbox', checked: true });
  const replace = el('input', { type: 'checkbox' });
  const pieces = [];
  const piecesBox = el('div.ed-pieces');
  const taken = new Set();
  // An untitled piece is named after the original: `lem-tube-part`.
  const stem = id.replace(/^(?:lem|thm|def|prop|cor|rem|ex)-/, '');
  const pieceId = (kind, title) => {
    let x = d.suggestId(kind, title || `${stem} part`);
    for (let k = 2; taken.has(x); k += 1) x = d.suggestId(kind, (title || `${stem} part`) + ' ' + k);
    return x;
  };

  const drawPieces = () => {
    clear(piecesBox);
    if (!pieces.length) {
      piecesBox.appendChild(el('p.muted', 'Select a part of the statement or the proof on the left and press ',
        el('b', 'Extract'), ', or add an empty piece. Each piece becomes a node of its own that the original uses, and that others can use too.'));
    }
    pieces.forEach((p, i) => {
      const depBoxes = deps.map((t) => {
        const cb = el('input', { type: 'checkbox', checked: p.deps.includes(t) });
        cb.addEventListener('change', () => { if (cb.checked) p.deps.push(t); else p.deps.splice(p.deps.indexOf(t), 1); });
        return el('label.ed-check', cb, ' ', t);
      });
      const kind = kindSelect(p.kind);
      kind.addEventListener('change', () => { p.kind = kind.value; });
      const title = textInput(p.title, { placeholder: 'Title' });
      title.addEventListener('input', () => { p.title = title.value; });
      const pid = textInput(p.id);
      pid.addEventListener('input', () => { p.id = pid.value.trim(); });
      const st = textArea(p.statement, { rows: 4 });
      st.addEventListener('input', () => { p.statement = st.value; });
      const pp = textArea(p.proof, { rows: 3, placeholder: 'Proof (optional)' });
      pp.addEventListener('input', () => { p.proof = pp.value; });
      p.usedByBox = idChips(p.usedBy, { placeholder: 'other nodes that use it…', exclude: [id] });
      piecesBox.appendChild(el('div.ed-piece',
        el('div.ed-piece-head', el('b', `Piece ${i + 1}`), el('span.muted', p.from === 'proof' ? ' from the proof' : p.from === 'statement' ? ' from the statement' : ''),
          button('Remove', { class: 'ed-link', onclick: () => { taken.delete(p.id); pieces.splice(i, 1); drawPieces(); } })),
        el('div.ed-row', field('Kind', kind), field('Title', title), field('Id', pid)),
        field('Statement', st), field('Proof', pp),
        deps.length ? field('Uses', el('span.ed-checks', ...depBoxes), 'dependencies of the original it needs') : null,
        field('Also used by', p.usedByBox)));
    });
  };

  const extract = (area, from) => {
    const a = area.selectionStart;
    const b = area.selectionEnd;
    const text = area.value.slice(a, b).trim();
    if (!text) { toast('Select the text to move into a piece of its own first (or add an empty piece).', 'warn'); area.focus(); return; }
    const p = { kind: 'lemma', title: '', id: '', statement: text, proof: '', from, deps: [], usedBy: [] };
    p.id = pieceId(p.kind, text ? text.replace(/\$[^$]*\$/g, ' ').split(/\s+/).slice(0, 4).join(' ') : '');
    taken.add(p.id);
    if (text && leaveRef.checked) {
      area.value = area.value.slice(0, a) + `[${p.id}]` + area.value.slice(b);
    }
    pieces.push(p);
    drawPieces();
  };
  const addEmpty = () => {
    const p = { kind: 'lemma', title: '', id: pieceId('lemma', ''), statement: '', proof: '', from: proof ? 'proof' : 'statement', deps: [], usedBy: [] };
    taken.add(p.id);
    pieces.push(p);
    drawPieces();
  };
  drawPieces();
  const body = el('div.ed-split',
    el('div.ed-split-src',
      el('h3', 'The original: ', el('code', id)),
      field('Statement', stmt), el('div.ed-under', button('Extract selection →', { onclick: () => extract(stmt, 'statement') })),
      field('Proof', prf), el('div.ed-under', button('Extract selection →', { onclick: () => extract(prf, 'proof') })),
      el('label.ed-check', leaveRef, ' leave a [reference] where the text was'),
      el('label.ed-check', dropMoved, ' the original stops using what a piece now uses for it'),
      el('label.ed-check', replace, ' replace the original by the pieces (it goes; what used it uses them)')),
    el('div.ed-split-pieces', el('h3', 'New pieces'), piecesBox, button('+ Empty piece', { onclick: addEmpty })));
  openDialog(`Split ${titleOf(id)}`, body, [{ label: 'Split', primary: true, run: () => {
    if (!pieces.length) { toast('Extract or add a piece first.', 'warn'); return false; }
    const spec = {
      pieces: pieces.map((p) => ({ id: p.id || undefined, kind: p.kind, title: p.title, statement: p.statement, proof: p.proof,
        from: p.from, deps: p.deps.slice(), usedBy: p.usedByBox ? p.usedByBox.value() : p.usedBy })),
      statement: stmt.value, proof: prf.value,
      dropMovedDeps: dropMoved.checked, replaceOriginal: replace.checked,
    };
    return attempt((snap) => E.opSplit(snap, id, spec), (op) => ({ select: replace.checked ? op.ids[0] : id }));
  } }], { wide: true });
}

// --- merge ----------------------------------------------------------------------------

function openMergeDialog(ids) {
  const { el } = S.app;
  const d = draft();
  const nodes = [...new Set(ids)].filter((x) => obj(x) && !isSection(obj(x)));
  if (nodes.length < 2) { toast('Mark at least two nodes to merge.', 'warn'); return; }
  // Keep, by default, the one the others lead up to: the last in dependency order.
  const rel = E.usesRelation(S.app.snapshot);
  const usesAny = (a) => nodes.some((b) => b !== a && rel.get(a) && rel.get(a).has(b));
  const keep0 = nodes.find(usesAny) || nodes[0];
  const radios = nodes.map((x) => el('label.ed-choice',
    el('input', { type: 'radio', name: 'ed-keep', value: x, checked: x === keep0 }),
    el('span', el('code', x), ' ', el('span.muted', titleOf(x)))));
  const ordered = [...nodes.filter((x) => x !== keep0), keep0];
  const joined = ordered.map((x) => obj(x).body).filter((b) => b && b.trim()).join('\n\n');
  const proofs = ordered.map((x) => (d.proofsOf(x)[0] || {}).body).filter((b) => b && b.trim()).join('\n\n');
  const f = nodeFields(keep0, {});
  f.statement.value = joined;
  if (f.proof) f.proof.value = proofs;
  const body = el('div',
    el('p', 'What the merged nodes use, the merged node uses; what used them uses it; a [reference] to one of them is one to it.'),
    field('Keep the id of', el('div.ed-choices', ...radios)),
    f.node);
  for (const r of body.querySelectorAll('input[name=ed-keep]')) {
    r.addEventListener('change', () => {
      const o = obj(r.value);
      f.id.value = r.value;
      f.kind.value = o.kind;
      if (!f.title.value) f.title.value = o.attrs.title || '';
    });
  }
  openDialog(`Merge ${nodes.length} nodes`, body, [{ label: 'Merge', primary: true, run: () => {
    const keep = (body.querySelector('input[name=ed-keep]:checked') || {}).value || keep0;
    const v = f.values();
    const op = attempt((snap) => E.opMerge(snap, nodes, { keep, ...v, id: v.id || keep }), (o) => ({ select: o.ids[0] }));
    if (op) S.marked.clear();
    return op;
  } }], { wide: true });
}

// ---------------------------------------------------------------------------
// the side panel and the object page
// ---------------------------------------------------------------------------

function sidePanel(side, o) {
  if (!S) return;
  const { el } = S.app;
  if (!o) {
    side.appendChild(el('section.ed-side',
      el('h3', 'Edit mode'),
      el('p.hint', 'Right-click a node for what can be done to it, or select it to edit it here. ',
        'Shift+drag from a node to another adds a dependency; Ctrl+click marks nodes to merge. ',
        'Press ', el('kbd', '?'), ' for every shortcut.'),
      el('div.ed-actions', button('+ New node', { onclick: () => openNodeDialog(null) }))));
    return;
  }
  if (!isEditableNode(o)) return; // a relation: edited through its ends
  const id = o.id;
  const sec = isSection(o);
  const d = draft();
  const f = nodeFields(id);
  f.title.removeAttribute('data-autofocus');
  const save = button('Save', { class: 'ed-primary', title: 'Ctrl+Enter', onclick: () => {
    const v = f.values();
    attempt((snap) => E.opEdit(snap, id, { ...v, id: v.id || id }), (op) => ({ select: op.ids[0] }));
  } });
  const box = el('section.ed-side',
    el('h3', 'Edit'),
    el('div.ed-actions',
      sec ? null : button('Split…', { title: 'S', onclick: () => openSplitDialog(id) }),
      sec ? null : button(S.marked.size && !(S.marked.size === 1 && S.marked.has(id)) ? 'Merge with marked…' : 'Mark', {
        title: 'Ctrl+click nodes to mark them, then merge (M)',
        onclick: () => {
          const others = [...S.marked].filter((x) => x !== id);
          if (others.length) openMergeDialog([id, ...others]); else toggleMark(id);
        },
      }),
      button('New beside…', { title: 'N', onclick: () => openNodeDialog(null, { near: id }) }),
      button('Delete…', { class: 'danger', title: 'Delete', onclick: () => openDeleteDialog(id) })),
    f.node,
    el('div.ed-actions', save));
  box.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); save.click(); }
  });
  if (!sec) {
    const deps = d.depsOf(id);
    const users = d.dependentsOf(id);
    const row = (t, where) => el('li', S.app.objLink(S.app.model, t), where ? el('span.chip', where) : null,
      button('×', { class: 'ed-x', title: `stop using ${t}`, onclick: () => attempt((snap) => E.opRemoveUse(snap, id, t), { select: id }) }));
    const urow = (u) => el('li', S.app.objLink(S.app.model, u),
      button('×', { class: 'ed-x', title: `${u} stops using this`, onclick: () => attempt((snap) => E.opRemoveUse(snap, u, id), { select: id }) }));
    const add = textInput('', { list: 'ed-ids', placeholder: 'id…' });
    const where = S.app.el('select', S.app.el('option', { value: 'auto' }, 'auto'), S.app.el('option', { value: 'statement' }, 'statement'), S.app.el('option', { value: 'proof' }, 'proof'));
    const addUse = () => {
      const t = add.value.trim();
      if (!t) return;
      attempt((snap) => E.opAddUse(snap, id, t, { where: where.value }), { select: id });
    };
    add.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); addUse(); } });
    const addBy = textInput('', { list: 'ed-ids', placeholder: 'id…' });
    const addUser = () => {
      const u = addBy.value.trim();
      if (!u) return;
      attempt((snap) => E.opAddUse(snap, u, id), { select: id });
    };
    addBy.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); addUser(); } });
    put(box,
      el('h4', `Uses (${deps.statement.length + deps.proof.length})`),
      el('ul.ed-deps', ...deps.statement.map((t) => row(t, null)), ...deps.proof.filter((t) => !deps.statement.includes(t)).map((t) => row(t, 'proof'))),
      el('div.ed-add', add, where, button('Add', { onclick: addUse }), button('Pick…', { title: 'U: click it in the graph', onclick: () => startPick('uses', id) })),
      el('h4', `Used by (${users.length})`),
      el('ul.ed-deps', ...users.map(urow)),
      el('div.ed-add', addBy, button('Add', { onclick: addUser }), button('Pick…', { title: 'D: click it in the graph', onclick: () => startPick('usedBy', id) })));
  }
  const anchor = side.querySelector('.side-open') || side.querySelector('.side-head');
  if (anchor && anchor.nextSibling) side.insertBefore(box, anchor.nextSibling);
  else side.appendChild(box);
  for (const a of box.querySelectorAll('a')) S.app.renderMath(a);
}

function objectPage(page, o) {
  if (!S || !o) return;
  const { el } = S.app;
  const id = o.id;
  const editable = isEditableNode(o) || isSection(o);
  const box = el('div.ed-objbar',
    el('span.ed-title', '✎ Edit mode'),
    editable ? button('Edit…', { onclick: () => openNodeDialog(id) }) : null,
    editable && !isSection(o) ? button('Split…', { onclick: () => openSplitDialog(id) }) : null,
    editable ? button('Delete…', { class: 'danger', onclick: () => openDeleteDialog(id) }) : null,
    S.summary.marks.has(id) ? el('span.ed-tag' + (S.summary.marks.get(id) === 'new' ? '.ed-tag-new' : '.ed-tag-chg'), S.summary.marks.get(id)) : null);
  const head = page.querySelector('.obj-head');
  if (head) page.insertBefore(box, head); else page.prepend(box);
}
