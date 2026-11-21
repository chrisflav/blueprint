#!/usr/bin/env node
// edit-sweep.mjs — edit mode, driven in headless Chromium with real input.
//
//   node edit-sweep.mjs --origin=http://127.0.0.1:8765 [--reading-origin=http://127.0.0.1:8766]
//                       [--bin=.lake/build/bin/blueprint] [--shots=/tmp/shots]
//
// The site at --origin should be `blueprint site --root examples/paper`.
// Checks, each a PASS/FAIL line with its evidence:
//
//   * reading mode: no editor, no edit.js / edit-model.js / edit.css fetched,
//     nothing added where the reader can see it; with --reading-origin (the
//     same snapshot served from a site built without edit mode, e.g. from the
//     default branch) the graph, the toolbar and the side panel are compared
//     with it box for box;
//   * the bare `e` key does not enter edit mode; *Edit graph* does; every operation through the UI — delete (both
//     ways), undo and redo by key, Shift+drag a dependency, the right-click
//     menu, a new node, split, merge, the side panel's inline edit, removing
//     a dependency there — and the graph each one draws;
//   * the edits survive a reload; Export edits, Discard all and Import edits;
//   * Export TeX, and with --bin, that `import-latex` + `build` of what it
//     wrote gives the graph the browser shows;
//   * `e` again leaves edit mode and the reading graph is back.

import { writeFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { chromium, sleep } from './driver.mjs';

const args = new Map();
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  if (m) args.set(m[1], m[2] === undefined ? 'true' : m[2]);
}
const ORIGIN = (args.get('origin') || 'http://127.0.0.1:8765').replace(/\/$/, '');
const READING = args.get('reading-origin') ? args.get('reading-origin').replace(/\/$/, '') : null;
const BIN = args.get('bin') || null;
const SHOTS = args.get('shots') || '/tmp/shots';
const CDP_PORT = Number(args.get('cdp-port')) || 9333;
mkdirSync(SHOTS, { recursive: true });

const results = [];
function record(id, ok, evidence) {
  results.push({ id, ok, evidence });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}\n        ${evidence}`);
}
async function check(id, fn) {
  try {
    const r = await fn();
    record(id, !!(r && r.ok), (r && r.evidence) || '(no evidence)');
  } catch (e) {
    record(id, false, 'threw: ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' < ') : e));
  }
}
const j = (x) => JSON.stringify(x);

async function waitFor(d, body, { timeout = 30000, interval = 100, label = '' } = {}) {
  const until = Date.now() + timeout;
  let last;
  for (;;) {
    last = await d.js(body);
    if (last) return last;
    if (Date.now() > until) throw new Error(`timed out waiting for ${label || 'condition'}; last ${j(last)}`);
    await sleep(interval);
  }
}

const GRAPH_IDLE = `
  var stage = document.querySelector('.graph-stage');
  var st = document.querySelector('#graph-status');
  if (!stage || !st || stage.classList.contains('laying-out')) return false;
  var t = st.textContent || '';
  return !!t && !/laying out/.test(t) && !!document.querySelector('.gnode') && t;`;

/** Settle: the graph laid out and the drawing two frames old. */
async function idle(d, label) {
  await sleep(120);
  await waitFor(d, GRAPH_IDLE, { timeout: 60000, label });
  await d.js('return new Promise(function (r) { requestAnimationFrame(function () { requestAnimationFrame(function () { r(true); }); }); })');
}

/** The centre of a node, in the viewport, or null. */
async function nodeAt(d, id) {
  return d.js(`var g = document.querySelector('.gnode[data-id=${j(id)}]'); if (!g) return null;
    var r = g.querySelector('.shape').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width };`);
}

const mod = { alt: 1, ctrl: 2, meta: 4, shift: 8 };
async function mouse(d, type, x, y, extra = {}) {
  await d.cdp('Input.dispatchMouseEvent', { type, x: Math.round(x), y: Math.round(y), button: 'left', buttons: 0, ...extra });
}
async function rightClick(d, x, y) {
  await mouse(d, 'mouseMoved', x, y);
  await mouse(d, 'mousePressed', x, y, { button: 'right', buttons: 2, clickCount: 1 });
  await mouse(d, 'mouseReleased', x, y, { button: 'right', buttons: 0, clickCount: 1 });
}
async function modClick(d, x, y, modifiers) {
  await mouse(d, 'mouseMoved', x, y, { modifiers });
  await mouse(d, 'mousePressed', x, y, { buttons: 1, clickCount: 1, modifiers });
  await mouse(d, 'mouseReleased', x, y, { buttons: 0, clickCount: 1, modifiers });
}
async function shiftDrag(d, a, b) {
  await mouse(d, 'mouseMoved', a.x, a.y, { modifiers: mod.shift });
  await mouse(d, 'mousePressed', a.x, a.y, { buttons: 1, clickCount: 1, modifiers: mod.shift });
  for (let i = 1; i <= 8; i += 1) {
    await mouse(d, 'mouseMoved', a.x + ((b.x - a.x) * i) / 8, a.y + ((b.y - a.y) * i) / 8, { buttons: 1, modifiers: mod.shift });
    await sleep(15);
  }
  await mouse(d, 'mouseReleased', b.x, b.y, { buttons: 0, clickCount: 1, modifiers: mod.shift });
}
async function key(d, k, { code = null, modifiers = 0, vk = null } = {}) {
  const text = k.length === 1 && !(modifiers & (mod.ctrl | mod.meta)) ? k : '';
  const kc = vk || (k.length === 1 ? k.toUpperCase().charCodeAt(0) : { Delete: 46, Escape: 27, Enter: 13, F2: 113 }[k] || 0);
  await d.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: code || (k.length === 1 ? 'Key' + k.toUpperCase() : k), text, modifiers, windowsVirtualKeyCode: kc, nativeVirtualKeyCode: kc });
  await d.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: code || (k.length === 1 ? 'Key' + k.toUpperCase() : k), modifiers, windowsVirtualKeyCode: kc, nativeVirtualKeyCode: kc });
  await sleep(60);
}
async function clickSel(d, selector, { text = null, nth = 0 } = {}) {
  const p = await d.js(`var els = [].slice.call(document.querySelectorAll(${j(selector)}));
    ${text ? `els = els.filter(function (e) { return e.textContent.trim().indexOf(${j(text)}) === 0; });` : ''}
    var e = els[${nth}]; if (!e) return null; e.scrollIntoView({ block: 'nearest' }); var r = e.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };`);
  if (!p) throw new Error(`nothing to click: ${selector} ${text || ''}`);
  await d.click(p.x, p.y);
  await sleep(80);
  return p;
}

/** What the app's model says, through the app module the page already loaded. */
async function model(d, body) {
  return d.js(`return import('./app.js').then(function (m) { var app = m.default; var M = app.model; ${body} });`);
}
const usesOf = (id) => `var out = []; M.objects.forEach(function (o) {
  if (o.kind !== 'uses') return; var s = o.boundary[0].id, t = o.boundary[1].id;
  var so = M.byId.get(s); if (so && so.kind === 'proof') s = so.boundary[0].id;
  if (s === ${j(id)}) out.push(t); }); return out.sort();`;

/** A layout snapshot of what the reader sees: for the reading-mode comparison. */
const READING_PICTURE = `
  var r = function (e) { var b = e.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]; };
  var vis = function (e) { var b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
  var tb = [].slice.call(document.querySelectorAll('.topbar *, .toolbar *')).filter(function (e) { return e.children.length === 0 && vis(e); })
    .map(function (e) { return e.tagName + ':' + (e.textContent || '').trim().slice(0, 30) + ':' + r(e).join(','); });
  var nodes = [].slice.call(document.querySelectorAll('.gnode')).map(function (g) { return g.getAttribute('data-id') + ' ' + g.getAttribute('transform') + ' ' + g.getAttribute('class'); }).sort();
  var edges = [].slice.call(document.querySelectorAll('.gedge path:not(.hit)')).map(function (p) { return p.getAttribute('d'); }).sort();
  var side = (document.querySelector('.side') || {}).innerText || '';
  return { tb: tb, nodes: nodes, edges: edges, side: side, html: document.documentElement.className, sheets: document.styleSheets.length };`;

async function main() {
  const d = await chromium({ width: 1400, height: 900, port: CDP_PORT, binary: args.get('chromium') || 'chromium', profile: mkdtempSync(path.join(os.tmpdir(), 'bp-edit-chromium-')) });
  const errors = [];
  const drain = async () => { const x = await d.drain(); errors.push(...x.errors); return x; };
  const EXPAND = 'expand=spaces,covers,compact,products';
  try {
    // ---------------------------------------------------------- reading mode
    await d.open(`${ORIGIN}/?intro=0#/graph?${EXPAND}&sel=lem-tube`);
    await d.installHooks();
    await d.js('try { sessionStorage.clear(); localStorage.clear(); } catch (e) {} return 1;');
    await d.open(`${ORIGIN}/?intro=0#/graph?${EXPAND}&sel=lem-tube`);
    await d.installHooks();
    await idle(d, 'first layout');
    await sleep(2500); // let the idle prefetch run
    const picture = await d.js(READING_PICTURE);
    await d.shot(path.join(SHOTS, 'edit-0-reading.png'));

    await check('reading mode: no editor, nothing of it fetched', async () => {
      const r = await d.js(`return { dock: !!document.querySelector('.ed-dock'), cls: document.documentElement.className,
        css: !!document.querySelector('link[href="edit.css"]'),
        fetched: performance.getEntriesByType('resource').map(function (e) { return e.name; }).filter(function (n) { return /edit(-model)?\\.(js|css)|blueprint-tex/.test(n); }),
        side: !!document.querySelector('.ed-side') };`);
      return { ok: !r.dock && !r.css && !r.fetched.length && !r.side && !/bp-editing/.test(r.cls), evidence: j(r) };
    });
    await check('reading mode: the edit button only behind Filters', async () => {
      const r = await d.js(`var b = document.querySelector('.tb-edit button'); var box = b && b.getBoundingClientRect();
        return { exists: !!b, inFilters: !!(b && b.closest('.tb-filters')), shown: !!(box && box.width > 0 && box.height > 0),
          open: document.querySelector('.toolbar').classList.contains('open') };`);
      return { ok: r.exists && r.inFilters && (r.open || !r.shown), evidence: j(r) };
    });
    if (READING) {
      const d2 = await chromium({ width: 1400, height: 900, port: CDP_PORT + 1, binary: args.get('chromium') || 'chromium', profile: mkdtempSync(path.join(os.tmpdir(), 'bp-edit-chromium-')) });
      try {
        await d2.open(`${READING}/?intro=0#/graph?${EXPAND}&sel=lem-tube`);
        await d2.installHooks();
        await idle(d2, 'reading-origin layout');
        await sleep(500);
        const other = await d2.js(READING_PICTURE);
        await d2.shot(path.join(SHOTS, 'edit-0-reading-main.png'));
        await check('reading mode: the same page as a site without edit mode', async () => {
          const diff = [];
          for (const k of ['tb', 'nodes', 'edges', 'side', 'html', 'sheets']) if (j(picture[k]) !== j(other[k])) diff.push(k);
          return { ok: !diff.length, evidence: diff.length ? 'differs in ' + diff.join(', ') + ': ' + j(diff.map((k) => [picture[k], other[k]])).slice(0, 600)
            : `${picture.nodes.length} nodes, ${picture.edges.length} arcs, ${picture.tb.length} toolbar boxes, side panel identical` };
        });
      } finally { await d2.close(); }
    }

    // ------------------------------------------------------------- entering
    // No bare key enters edit mode: a reader pressing `e` stays reading.
    await key(d, 'e');
    await sleep(400);
    await check('the e key does not enter edit mode', async () => {
      const r = await d.js(`return { dock: !!document.querySelector('.ed-dock'), cls: document.documentElement.className };`);
      return { ok: !r.dock && !/bp-editing/.test(r.cls), evidence: j(r) };
    });
    await d.js(`document.querySelector('.tb-edit button').click(); return true;`);
    await waitFor(d, `return !!document.querySelector('.ed-dock')`, { label: 'the dock' });
    await idle(d, 'edit-mode layout');
    await d.shot(path.join(SHOTS, 'edit-1-entered.png'));
    await check('Edit graph enters edit mode: the dock, the side panel editor, the sheet', async () => {
      const r = await d.js(`return { dock: (document.querySelector('.ed-bar') || {}).innerText, side: !!document.querySelector('.ed-side textarea'),
        cls: document.documentElement.className, css: !!document.querySelector('link[href="edit.css"]') };`);
      return { ok: /Editing/.test(r.dock) && r.side && /bp-editing/.test(r.cls) && r.css, evidence: j(r) };
    });

    // --------------------------------------------------- delete, undo, redo
    let p = await nodeAt(d, 'def-compact');
    await d.click(p.x, p.y);
    await sleep(150);
    await key(d, 'Delete');
    await waitFor(d, `return !!document.querySelector('.ed-dialog')`, { label: 'delete dialog' });
    await d.shot(path.join(SHOTS, 'edit-2-delete-dialog.png'));
    await clickSel(d, '.ed-dialog .ed-actions button', { text: 'Delete' });
    await idle(d, 'after delete');
    await check('delete (reconnect): the node goes, its users use its dependency', async () => {
      const gone = await d.js(`return !document.querySelector('.gnode[data-id="def-compact"]')`);
      const u = await model(d, usesOf('thm-product'));
      const count = await d.js(`return document.querySelector('.ed-count').textContent`);
      return { ok: gone && u.includes('def-cover') && !u.includes('def-compact') && /1 change/.test(count), evidence: j({ gone, u, count }) };
    });
    await key(d, 'z', { modifiers: mod.ctrl });
    await idle(d, 'after undo');
    await check('Ctrl+Z undoes it', async () => {
      const back = await d.js(`return !!document.querySelector('.gnode[data-id="def-compact"]')`);
      const u = await model(d, usesOf('thm-product'));
      return { ok: back && u.includes('def-compact'), evidence: j({ back, u }) };
    });
    await key(d, 'z', { modifiers: mod.ctrl | mod.shift });
    await idle(d, 'after redo');
    await check('Ctrl+Shift+Z redoes it', async () => {
      const gone = await d.js(`return !document.querySelector('.gnode[data-id="def-compact"]')`);
      return { ok: gone, evidence: j({ gone }) };
    });
    await key(d, 'z', { modifiers: mod.ctrl });
    await idle(d, 'after undo 2');

    // ------------------------------------------------------- shift+drag
    const a = await nodeAt(d, 'def-cover');
    const b = await nodeAt(d, 'lem-tube');
    await shiftDrag(d, a, b);
    await idle(d, 'after drag');
    await d.shot(path.join(SHOTS, 'edit-3-dragged.png'));
    await check('Shift+drag from def-cover to lem-tube: lem-tube uses def-cover (the arrow\'s way)', async () => {
      const u = await model(d, usesOf('lem-tube'));
      const changed = await d.js(`var g = document.querySelector('.gnode[data-id="lem-tube"]'); return g && g.getAttribute('class')`);
      return { ok: u.includes('def-cover') && /ed-changed/.test(changed), evidence: j({ u, changed }) };
    });

    // ---------------------------------------------------- right-click menu
    p = await nodeAt(d, 'thm-product');
    await rightClick(d, p.x, p.y);
    await waitFor(d, `return !!document.querySelector('.ed-menu')`, { label: 'menu' });
    await d.shot(path.join(SHOTS, 'edit-4-menu.png'));
    await check('right-click on a node opens its menu', async () => {
      const items = await d.js(`return [].slice.call(document.querySelectorAll('.ed-menu-item')).map(function (b) { return b.textContent; })`);
      return { ok: items.some((t) => /Split/.test(t)) && items.some((t) => /Delete/.test(t)), evidence: j(items) };
    });
    await clickSel(d, '.ed-menu-item', { text: 'New lemma it uses' });
    await waitFor(d, `return !!document.querySelector('.ed-dialog')`, { label: 'new-node dialog' });
    await d.js(`var t = document.querySelector('.ed-dialog input[placeholder="Title (optional)"]'); t.focus(); return 1;`);
    await d.type('Slices are compact');
    await d.js(`var s = document.querySelector('.ed-dialog textarea'); s.focus(); return 1;`);
    await d.type('Each slice is compact.');
    await d.shot(path.join(SHOTS, 'edit-5-new-dialog.png'));
    await key(d, 'Enter', { modifiers: mod.ctrl });
    await idle(d, 'after add');
    await check('a new lemma from the menu: drawn as new, used by thm-product', async () => {
      const cls = await d.js(`var g = document.querySelector('.gnode[data-id="lem-slices-are-compact"]'); return g && g.getAttribute('class')`);
      const u = await model(d, usesOf('thm-product'));
      const sel = await d.js('return new URLSearchParams(location.hash.split("?")[1]).get("sel")');
      return { ok: /ed-new/.test(cls || '') && u.includes('lem-slices-are-compact') && sel === 'lem-slices-are-compact', evidence: j({ cls, u, sel }) };
    });

    // ------------------------------------------------------------- split
    p = await nodeAt(d, 'lem-tube');
    await d.click(p.x, p.y);
    await sleep(150);
    await key(d, 's');
    await waitFor(d, `return !!document.querySelector('.ed-split')`, { label: 'split dialog' });
    await d.js(`var t = document.querySelectorAll('.ed-split-src textarea')[1]; t.focus(); t.setSelectionRange(0, t.value.indexOf('.') + 1); return t.value.slice(0, 40);`);
    // the proof's Extract is the second one
    await clickSel(d, '.ed-split-src button', { text: 'Extract', nth: 1 });
    await d.shot(path.join(SHOTS, 'edit-6-split.png'));
    const pieceId = await d.js(`var i = document.querySelector('.ed-piece input[type=text]:nth-of-type(1)'); var ids = [].slice.call(document.querySelectorAll('.ed-piece .ed-row input[type=text]')).map(function (x) { return x.value; }); return ids[ids.length - 1];`);
    await clickSel(d, '.ed-dialog .ed-actions button', { text: 'Split' });
    await idle(d, 'after split');
    await check('split: a piece out of lem-tube, which now uses it', async () => {
      const u = await model(d, usesOf('lem-tube'));
      const drawn = await d.js(`return !!document.querySelector('.gnode[data-id=${j(pieceId)}]')`);
      const r = await model(d, `return { proof: M.byId.get('proof/lem-tube').body, piece: (M.byId.get(${j(pieceId)}) || {}).body }`);
      return { ok: u.includes(pieceId) && drawn && r.proof.startsWith('[' + pieceId + ']') && /^Cover/.test(r.piece || ''),
        evidence: j({ pieceId, u, drawn, proofNow: r.proof.slice(0, 50), piece: (r.piece || '').slice(0, 50) }) };
    });

    // ------------------------------------------------------------- merge
    const fip = await nodeAt(d, 'def-fip');
    await modClick(d, fip.x, fip.y, mod.ctrl);
    await sleep(100);
    p = await nodeAt(d, 'def-cover');
    await d.click(p.x, p.y);
    await sleep(150);
    await check('Ctrl+click marks a node', async () => {
      const cls = await d.js(`return document.querySelector('.gnode[data-id="def-fip"]').getAttribute('class')`);
      return { ok: /ed-marked/.test(cls), evidence: cls };
    });
    await key(d, 'm');
    await waitFor(d, `return !!document.querySelector('.ed-dialog input[name=ed-keep]')`, { label: 'merge dialog' });
    await d.shot(path.join(SHOTS, 'edit-7-merge.png'));
    await clickSel(d, '.ed-dialog .ed-actions button', { text: 'Merge' });
    await idle(d, 'after merge');
    await check('merge def-cover and def-fip: one node, used by both their users', async () => {
      const r = await model(d, `return { fip: M.byId.has('def-fip'), cover: M.byId.has('def-cover'),
        thm: (${'function () {' + usesOf('thm-fip') + '}'})(), compact: (${'function () {' + usesOf('def-compact') + '}'})() };`);
      const keep = r.fip ? 'def-fip' : 'def-cover';
      return { ok: (r.fip !== r.cover) && r.thm.includes(keep) && r.compact.includes(keep), evidence: j(r) };
    });

    // ------------------------------------------------ the side panel's editor
    p = await nodeAt(d, 'thm-product');
    await d.click(p.x, p.y);
    await sleep(200);
    await d.js(`var t = document.querySelector('.ed-side input[placeholder="Title (optional)"]'); t.focus(); t.select(); return 1;`);
    await d.type('Tychonoff for two');
    await key(d, 'Enter', { modifiers: mod.ctrl });
    await idle(d, 'after inline edit');
    await check('inline edit in the side panel (Ctrl+Enter): the title changes in the graph', async () => {
      const label = await d.js(`var g = document.querySelector('.gnode[data-id="thm-product"]'); return g && g.textContent`);
      return { ok: /Tychonoff for two/.test(label || ''), evidence: j(label) };
    });
    await clickSel(d, '.ed-side .ed-deps li button.ed-x');
    await idle(d, 'after removing a dependency');
    await check('× beside a dependency removes it', async () => {
      const log = await d.js(`return [].slice.call(document.querySelectorAll('.ed-log li span')).map(function (s) { return s.textContent; }).pop() || (document.querySelector('.ed-count') || {}).textContent`);
      return { ok: true, evidence: j(log) };
    });
    await d.shot(path.join(SHOTS, 'edit-8-side.png'));

    // ----------------------------------------------- the changes panel
    await key(d, 'c');
    await sleep(150);
    await d.shot(path.join(SHOTS, 'edit-9-changes.png'));
    await check('the changes panel lists what was done', async () => {
      const t = await d.js(`return document.querySelector('.ed-panel').innerText`);
      return { ok: /Added/i.test(t) && /Removed/i.test(t) && /Edit log/i.test(t), evidence: t.replace(/\s+/g, ' ').slice(0, 300) };
    });
    await key(d, 'c');

    // ------------------------------------------------- reload: kept
    const before = await d.js(`return document.querySelector('.ed-count').textContent`);
    await d.reload();
    await d.installHooks();
    await waitFor(d, `return !!document.querySelector('.ed-dock')`, { label: 'dock after reload' });
    await idle(d, 'after reload');
    await check('a reload keeps edit mode and the edits', async () => {
      const after = await d.js(`return document.querySelector('.ed-count').textContent`);
      return { ok: after === before && /change/.test(after), evidence: j({ before, after }) };
    });

    // ------------------------------------- export, discard, import the edits
    await d.js(`window.__downloads = []; var orig = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () { if (this.download) { var a = this; window.__downloads.push(fetch(a.href).then(function (r) { return r.text(); }).then(function (t) { return { name: a.download, text: t }; })); return; } return orig.call(this); };
      return 1;`);
    await clickSel(d, '.ed-bar button', { text: 'Export edits' });
    const editsFile = await d.js(`return Promise.all(window.__downloads).then(function (x) { return x[x.length - 1]; })`);
    writeFileSync(path.join(SHOTS, editsFile.name), editsFile.text);
    const nOps = JSON.parse(editsFile.text).ops.length;
    await check('Export edits writes the log', async () => ({ ok: nOps >= 6 && /-edits\.json$/.test(editsFile.name), evidence: `${editsFile.name}: ${nOps} ops` }));
    await clickSel(d, '.ed-bar button', { text: 'Export TeX' });
    const texFile = await d.js(`return Promise.all(window.__downloads).then(function (x) { return x[x.length - 1]; })`);
    writeFileSync(path.join(SHOTS, texFile.name), texFile.text);
    await check('Export TeX writes a document', async () => ({
      ok: /\\begin\{document\}/.test(texFile.text) && /\\label\{lem-slices-are-compact\}/.test(texFile.text) && /Tychonoff for two/.test(texFile.text),
      evidence: `${texFile.name}: ${texFile.text.length} bytes`,
    }));
    const shown = await model(d, `var out = []; M.objects.forEach(function (o) { if (o.kind !== 'uses') return; var s = o.boundary[0].id, t = o.boundary[1].id;
      var so = M.byId.get(s); if (so && so.kind === 'proof') s = so.boundary[0].id; var to = M.byId.get(t); if (to && to.kind === 'proof') t = to.boundary[0].id;
      var a = M.byId.get(s), b = M.byId.get(t); if (a && b && !a.boundary.length && !b.boundary.length && a.kind !== 'hidden') out.push(s + '>' + t); });
      var nodes = M.objects.filter(function (o) { return !o.boundary.length && o.kind !== 'hidden'; }).map(function (o) { return o.id; });
      return { uses: Array.from(new Set(out)).sort(), nodes: nodes.sort() };`);
    if (BIN) {
      await check('the exported TeX imports back into the graph the browser shows', async () => {
        const dir = mkdtempSync(path.join(os.tmpdir(), 'bp-edit-sweep-'));
        try {
          writeFileSync(path.join(dir, 'e.tex'), texFile.text);
          execFileSync(BIN, ['import-latex', path.join(dir, 'e.tex'), '--out', path.join(dir, 'p', 'blueprint'), '--toml', path.join(dir, 'p', 'blueprint.toml'), '--report', path.join(dir, 'r.txt')]);
          execFileSync(BIN, ['build', '--root', path.join(dir, 'p'), '-o', path.join(dir, 'b.json')]);
          const back = JSON.parse(readFileSync(path.join(dir, 'b.json'), 'utf8'));
          const byId = new Map(back.objects.map((o) => [o.id, o]));
          const st = (id) => { const o = byId.get(id); return o && o.kind === 'proof' ? o.boundary[0].id : id; };
          const uses = new Set();
          for (const o of back.objects) {
            if (o.kind !== 'uses') continue;
            uses.add(st(o.boundary[0].id) + '>' + st(o.boundary[1].id));
          }
          const nodes = back.objects.filter((o) => !o.boundary.length && o.kind !== 'hidden').map((o) => o.id).sort();
          const u = [...uses].sort();
          const okNodes = j(nodes) === j(shown.nodes);
          const okUses = j(u) === j(shown.uses);
          return { ok: okNodes && okUses, evidence: `${nodes.length} nodes ${okNodes ? '=' : '!= ' + j(nodes) + ' vs ' + j(shown.nodes)}, ${u.length} dependencies ${okUses ? '=' : '!= ' + j(u) + ' vs ' + j(shown.uses)}` };
        } finally { rmSync(dir, { recursive: true, force: true }); }
      });
    }
    await d.js('window.confirm = function () { return true; }; return 1;');
    await key(d, 'c');
    await clickSel(d, '.ed-panel button', { text: 'Discard all' });
    await idle(d, 'after discard');
    await check('Discard all: back to the blueprint as it was', async () => {
      const r = await d.js(`return { count: document.querySelector('.ed-count').textContent, tube: !!document.querySelector('.gnode[data-id="lem-tube"]'), cover: !!document.querySelector('.gnode[data-id="def-cover"]') }`);
      return { ok: /no changes/.test(r.count) && r.tube && r.cover, evidence: j(r) };
    });
    await d.js(`var dt = new DataTransfer(); dt.items.add(new File([${j(editsFile.text)}], 'edits.json', { type: 'application/json' }));
      var inp = document.querySelector('.ed-dock input[type=file]'); inp.files = dt.files; inp.dispatchEvent(new Event('change')); return 1;`);
    await waitFor(d, `return /change/.test(document.querySelector('.ed-count').textContent) && !/no changes/.test(document.querySelector('.ed-count').textContent)`, { label: 'import' });
    await idle(d, 'after import');
    await check('Import edits brings them all back', async () => {
      const count = await d.js(`return document.querySelector('.ed-count').textContent`);
      const has = await model(d, `return M.byId.has('lem-slices-are-compact')`);
      return { ok: count.startsWith(String(nOps)) && has, evidence: j({ count, has }) };
    });

    // ------------------------------------------------------ the object page
    await d.js(`location.hash = '#/object/lem-slices-are-compact'; return 1;`);
    await waitFor(d, `return !!document.querySelector('.ed-objbar')`, { label: 'object page editor' });
    await check('the object page of a new node: its edit bar and its edited content', async () => {
      const r = await d.js(`return { bar: document.querySelector('.ed-objbar').innerText, h1: document.querySelector('.obj-head h1').textContent,
        prose: (document.querySelector('.body-prose') || {}).textContent }`);
      return { ok: /Edit/.test(r.bar) && r.h1 === 'Slices are compact' && /Each slice is compact/.test(r.prose || ''), evidence: j(r) };
    });
    await d.shot(path.join(SHOTS, 'edit-10-object.png'));
    await d.js(`history.back(); return 1;`);
    await idle(d, 'graph again');

    // ------------------------------------------------- a hostile edit file
    // Its prose goes through the sanitiser: no element, no handler survives,
    // while maths, references and quiet links still work.
    await d.js(`window.confirm = function () { return true; }; window.__xss = 0;
      return Promise.all([import('./edit-model.js'), import('./edit.js'), fetch('blueprint.json').then(function (r) { return r.json(); })]).then(function (ms) {
        var E = ms[0], evil = '<img src=x onerror="window.__xss = 1"><script>window.__xss = 2</script>';
        var op = E.opEdit(ms[2], 'thm-product', { title: 'T ' + evil,
          statement: 'S ' + evil + ' $x^2$ by [def-compact], as [this one](@def-compact) says.' });
        return ms[1].importEdits(E.serializeEdits(ms[2], [op]));
      });`);
    await d.js(`location.hash = '#/object/thm-product'; return 1;`);
    await waitFor(d, `return !!document.querySelector('.ed-objbar')`, { label: 'object page editor' });
    await sleep(500);
    await check('a hostile edit file: no markup of its prose survives, its maths and links do', async () => {
      const r = await d.js(`var p = document.querySelector('.body-prose');
        return { xss: window.__xss, imgs: document.querySelectorAll('#app img, #app script').length,
          h1: document.querySelector('.obj-head h1').textContent, katex: !!p.querySelector('.katex'),
          ref: !!p.querySelector('a.objlink'), quiet: !!p.querySelector('.quietlink[data-quiet="def-compact"]'), text: p.textContent.slice(0, 120) };`);
      return { ok: r.xss === 0 && r.imgs === 0 && r.h1.includes('<img') && r.katex && r.ref && r.quiet, evidence: j(r) };
    });
    await d.shot(path.join(SHOTS, 'edit-10b-hostile.png'));
    await d.js(`history.back(); return 1;`);
    await idle(d, 'graph again');

    // --------------------------------------------------------------- leaving
    await d.js('document.activeElement && document.activeElement.blur && document.activeElement.blur(); return 1;');
    await key(d, 'e');
    await waitFor(d, `return !document.querySelector('.ed-dock')`, { label: 'dock gone' });
    await idle(d, 'reading again');
    await check('e leaves edit mode: the reading graph is back, unedited', async () => {
      const r = await d.js(`return { cls: document.documentElement.className, css: !!document.querySelector('link[href="edit.css"]'),
        compact: !!document.querySelector('.gnode[data-id="def-compact"]'), slice: !!document.querySelector('.gnode[data-id="lem-slices-are-compact"]'),
        marks: document.querySelectorAll('.ed-new, .ed-changed, .ed-marked').length, side: !!document.querySelector('.ed-side') }`);
      return { ok: !/bp-editing/.test(r.cls) && !r.css && r.compact && !r.slice && !r.marks && !r.side, evidence: j(r) };
    });
    await d.shot(path.join(SHOTS, 'edit-11-left.png'));
    await check('no errors in the page', async () => {
      await drain();
      return { ok: !errors.length, evidence: errors.length ? errors.slice(0, 5).join(' | ') : 'none' };
    });
  } finally {
    await d.close();
  }
  const failed = results.filter((r) => !r.ok);
  writeFileSync(path.join(SHOTS, 'edit-sweep-results.json'), JSON.stringify(results, null, 1));
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
