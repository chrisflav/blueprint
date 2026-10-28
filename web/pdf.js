// pdf.js — the Export PDF button and its dialog.
//
// The top bar's *Export PDF* button (and the one on every document page) opens
// a dialog that says what will be exported before anything is made:
//
//   * the part: by default the one being read — the document page's entry,
//     or, from an object page or a graph selection, the part the object is
//     read in — or the whole blueprint at the top of the document; the reader
//     can switch to the whole blueprint or pick any other part by its title;
//   * the hierarchy it is read along, when the snapshot has more than one;
//   * the detail: all levels (the default), or how many levels below the
//     part.  Proofs and steps come with their statements at any depth;
//   * appendices, when the part has any;
//   * the snapshot: the one on screen, including a historical one from the
//     time slider.
//
// The PDF is found, in this order:
//
//   1. made on demand by the local server behind `blueprint serve`
//      (`POST api/export`), when there is one: it files the PDF under
//      `data/exports/<snapshot>/`, and hands back what is already there when
//      that was made from the same TeX;
//   2. prepared when the site was built (`blueprint site --pdf`), listed in
//      `data/exports/<snapshot>/manifest.json`, where <snapshot> is the
//      SHA-256 of the very bytes the page loaded, so another revision's PDF is
//      never found;
//   3. neither: the dialog says so, and still hands out the TeX source, which
//      the page writes itself from the snapshot (`export/latex.js`, the same
//      code the build runs), for the reader to compile.
//
// Selection, order, numbering and the TeX all come from `export/latex.js` and
// `model.js`: the dialog only chooses.  The PDF that is fetched is checked to be
// one (`%PDF-`) before it is offered, so an HTML error page never passes for it.

import * as M from './model.js';
import { exportDirName } from './export/sha256.js';

let app = null;
let latex = null; // export/latex.js, loaded the first time the dialog opens
let dialog = null; // the open dialog's state
let serverCheck = null; // Promise<{available, reason}>
const manifests = new Map(); // snapshot hash -> Promise<manifest | null>

/** Forget what was learnt about the site (its manifests, its server): for the tests. */
export function resetExportState() {
  manifests.clear();
  serverCheck = null;
  closeExport();
}

async function loadLatex() {
  if (!latex) latex = await import('./export/latex.js');
  return latex;
}

/** Wire the top bar's button.  Called once, after the first snapshot loaded. */
export function setupExport(ctx) {
  app = ctx;
  const button = document.getElementById('export-pdf');
  if (button) {
    button.disabled = false;
    button.addEventListener('click', () => openExport());
  }
}

/** A button that opens the dialog, for the pages to place. */
export function exportButton(ctx, label = 'Export PDF') {
  return ctx.el('button.export-inline', {
    type: 'button',
    title: 'Export this part of the blueprint as a PDF',
    onclick: () => openExport(),
  }, exportIcon(ctx), label);
}

function exportIcon(ctx) {
  const svg = ctx.svgEl('svg', { class: 'export-icon', viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': 'true', focusable: 'false' },
    ctx.svgEl('path', { d: 'M4 1.5h5.5L13 5v9.5H4z', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.4', 'stroke-linejoin': 'round' }),
    ctx.svgEl('path', { d: 'M8.5 7v5m-2-2 2 2 2-2', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.4', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
  return svg;
}

// ---------------------------------------------------------------------------
// what the reader is looking at
// ---------------------------------------------------------------------------

function routeCollapse(m) {
  const wanted = app.route && app.route.params.get('collapse');
  if (wanted && m.kinds[wanted] && m.kinds[wanted].collapse) return wanted;
  return m.defaultCollapse || m.collapseKinds[0] || null;
}

/**
 * The part the reader is in: {id, because} or null for the top.  A document
 * page is its entry's part.  An object (its page, or the graph's selection)
 * is its own part when it has entries below it, and otherwise the part it is
 * read in, so its prose is in the PDF either way.
 */
export function contextPart(m, collapse, route) {
  if (!collapse) return null;
  const outline = M.documentOutline(m, collapse);
  let id = null;
  let from = null;
  if (route.view === 'document') id = route.id || null;
  else if (route.view === 'object') { id = route.id; from = id; }
  else if (route.view === 'graph') { id = route.params.get('sel') || null; from = id; }
  if (!id || !m.byId.has(id)) return null;
  if (outline.stepOf.has(id)) id = outline.stepOf.get(id);
  const entry = outline.byId.get(id);
  if (!entry) {
    return route.view === 'document' ? null : { id: null, from, missing: true };
  }
  if (entry.children.length && !entry.text && !entry.duplicate) return { id: entry.id, from };
  const page = M.documentPageOf(outline, id);
  return page ? { id: page, from } : { id: null, from };
}

// ---------------------------------------------------------------------------
// the dialog
// ---------------------------------------------------------------------------

/** Open the dialog, defaulting to the part being read. */
export async function openExport() {
  if (!app || !app.model) return;
  if (dialog) { focusFirst(); return; }
  const { el } = app;
  const m = app.model;
  // Focus goes back where it was, or to the top bar's button when a click
  // did not focus anything (Safari, and some headless browsers, do not).
  const active = document.activeElement;
  const opener = active && active !== document.body ? active : document.getElementById('export-pdf');
  const lib = await loadLatex();
  const collapse = routeCollapse(m);
  if (!collapse) {
    showSimpleError('This blueprint has no collapsible kind, so it has no document to export.');
    return;
  }
  const ctxPart = contextPart(m, collapse, app.route);
  const state = {
    collapse,
    contextId: ctxPart && ctxPart.id,
    from: ctxPart && ctxPart.from,
    choice: ctxPart && ctxPart.id ? 'part' : 'whole',
    otherId: null,
    depth: 'all',
    appendices: true,
    busy: false,
    opener,
  };

  const overlay = el('div.export-overlay', { onmousedown: (ev) => { if (ev.target === overlay) closeExport(); } });
  const panel = el('div.export-dialog', { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'export-title' });
  overlay.appendChild(panel);
  dialog = { overlay, panel, state, lib };
  panel.addEventListener('keydown', onKey);
  document.body.appendChild(overlay);
  drawDialog();
  focusFirst();
}

function showSimpleError(text) {
  const { el } = app;
  const overlay = el('div.export-overlay');
  const panel = el('div.export-dialog', { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'export-title' },
    el('h2#export-title', 'Export PDF'), el('p', text),
    el('div.export-actions', el('button', { type: 'button', onclick: () => closeExport() }, 'Close')));
  overlay.appendChild(panel);
  dialog = { overlay, panel, state: { opener: document.activeElement }, lib: null };
  panel.addEventListener('keydown', onKey);
  document.body.appendChild(overlay);
  focusFirst();
}

export function closeExport() {
  if (!dialog) return;
  const { overlay, state } = dialog;
  if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
  for (const u of dialog.urls || []) { try { URL.revokeObjectURL(u); } catch (e) { /* gone */ } }
  dialog = null;
  if (state.opener && typeof state.opener.focus === 'function') state.opener.focus();
}

function onKey(ev) {
  if (ev.key === 'Escape') {
    ev.preventDefault();
    closeExport();
    return;
  }
  if (ev.key !== 'Tab' || !dialog) return;
  // Keep the keyboard inside the dialog while it is open.
  const items = focusables();
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
  else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
}

function focusables() {
  if (!dialog) return [];
  return [...dialog.panel.querySelectorAll('button, select, input, a[href]')].filter((x) => !x.disabled);
}

function focusFirst() {
  const items = focusables();
  const pick = items.find((x) => x.checked) || items[0];
  if (pick && typeof pick.focus === 'function') pick.focus();
}

/** The request the dialog's controls describe, before checking. */
function rawRequest(state) {
  const scope = state.choice === 'part' ? state.contextId : state.choice === 'other' ? state.otherId : null;
  return { collapse: state.collapse, scope, depth: state.depth, appendices: state.appendices };
}

function drawDialog() {
  const { el, clear } = app;
  const { panel, state, lib } = dialog;
  const m = app.model;
  const outline = M.documentOutline(m, state.collapse);
  const scopes = lib.exportScopes(m, state.collapse);
  const named = (id) => {
    const s = scopes.find((x) => x.id === id);
    return s ? `${s.word} ${s.number} ${s.title}` : id;
  };
  if (state.choice === 'part' && !scopes.some((s) => s.id === state.contextId)) state.choice = 'whole';
  if (state.choice === 'other' && !scopes.some((s) => s.id === state.otherId && s.id !== null)) {
    state.otherId = (scopes.find((s) => s.id !== null) || {}).id || null;
  }
  let req;
  let problem = null;
  try {
    req = lib.resolveRequest(m, rawRequest(state));
  } catch (e) {
    problem = e.message;
  }

  clear(panel);
  panel.appendChild(el('h2#export-title', 'Export PDF'));
  panel.appendChild(el('p.export-from.muted.small', app.viewingSha
    ? ['From the snapshot you are viewing: ', el('strong', String(app.viewingSha).slice(0, 10)),
      app.viewingEntry && app.viewingEntry.date ? ' of ' + app.viewingEntry.date : '', '.']
    : 'From the current snapshot of the blueprint.'));

  // ----------------------------------------------------------------- scope
  const radio = (value, label, extra) => el('label.export-choice',
    el('input', {
      type: 'radio', name: 'export-scope', value, checked: state.choice === value,
      onchange: () => { state.choice = value; state.depth = 'all'; drawDialog(); restoreFocus('input[value="' + value + '"]'); },
    }),
    el('span', label), extra || null);
  const scopeSet = el('fieldset.export-scope', el('legend', 'What to export'));
  if (state.contextId) {
    const here = named(state.contextId);
    const fromObj = state.from && state.from !== state.contextId ? m.byId.get(state.from) : null;
    scopeSet.appendChild(radio('part', ['This part: ', el('strong.export-part-title', here)],
      fromObj ? el('span.muted.small.export-why', ` (where ${referenceText(outline, state.from)} is read)`) : null));
  }
  scopeSet.appendChild(radio('whole', ['The whole blueprint: ', el('strong.export-part-title', scopes[0].title)]));
  const parts = scopes.filter((s) => s.id !== null);
  if (parts.length) {
    // Picking a part in the menu chooses "another part" too.
    const select = el('select.export-other', {
      'aria-label': 'Another part to export',
      onchange: (ev) => { state.otherId = ev.target.value; state.choice = 'other'; state.depth = 'all'; drawDialog(); restoreFocus('select.export-other'); },
    }, ...parts.map((s) => el('option', { value: s.id, selected: s.id === (state.otherId || parts[0].id) },
      ' '.repeat(Math.max(0, s.depth)) + `${s.number} ${s.title}`)));
    scopeSet.appendChild(radio('other', 'Another part: ', select));
  }
  panel.appendChild(scopeSet);

  // ------------------------------------------------------------- hierarchy
  const opts = el('div.export-options');
  if (m.collapseKinds.length > 1) {
    opts.appendChild(el('label.export-field', el('span', 'Hierarchy'),
      el('select', {
        onchange: (ev) => {
          state.collapse = ev.target.value;
          // Parts are those of the order: keep the part only if it is one there too.
          state.depth = 'all';
          drawDialog();
          restoreFocus('.export-field select');
        },
      }, ...m.collapseKinds.map((k) => el('option', { value: k, selected: k === state.collapse }, k)))));
  }

  // ---------------------------------------------------------------- detail
  if (req) {
    const below = req.scope === null ? 'the top level' : named(req.scope).split(' ').slice(0, 2).join(' ');
    const depthOpts = [el('option', { value: 'all', selected: req.depth === 'all' }, 'All levels (complete)')];
    for (let d = 1; d < req.height; d += 1) {
      depthOpts.push(el('option', { value: String(d), selected: req.depth === d },
        req.scope === null && d === 1 ? 'Top level only' : `${d} ${d === 1 ? 'level' : 'levels'} below ${below}`));
    }
    opts.appendChild(el('label.export-field', el('span', 'Detail'),
      el('select.export-depth', {
        disabled: req.height <= 1,
        onchange: (ev) => { state.depth = ev.target.value === 'all' ? 'all' : Number(ev.target.value); drawDialog(); restoreFocus('select.export-depth'); },
      }, ...depthOpts)));
    if (req.hasAppendices) {
      opts.appendChild(el('label.export-check',
        el('input', { type: 'checkbox', checked: req.appendices, onchange: (ev) => { state.appendices = ev.target.checked; drawDialog(); restoreFocus('.export-check input'); } }),
        ' Include appendices'));
    }
  }
  panel.appendChild(opts);
  panel.appendChild(el('p.export-hint.muted.small',
    'The detail counts levels of the document below the part: a section’s statements are one level below it. ',
    'Proofs and steps always come with their statement, and an object shared with another part is written out in full the first time this PDF meets it. ',
    'Folded proofs and what this page has not drawn yet are included all the same.'));

  // --------------------------------------------------------------- summary
  if (req) {
    const plan = lib.planExport(m, req);
    const d = lib.describeRequest(m, req);
    panel.appendChild(el('p.export-summary',
      el('strong', d.scope), ', ', d.detail, d.appendices ? ', ' + d.appendices : '', ': ',
      `${plan.stats.entries} ${plan.stats.entries === 1 ? 'entry' : 'entries'}`,
      plan.stats.proofs ? `, ${plan.stats.proofs} ${plan.stats.proofs === 1 ? 'proof' : 'proofs'}` : '', '.'));
  } else if (problem) {
    panel.appendChild(el('p.export-error', problem));
  }

  const go = el('button.export-go', {
    type: 'button', disabled: !req || state.busy, 'aria-busy': state.busy ? 'true' : null,
    onclick: () => run(),
  }, state.busy ? 'Preparing…' : 'Export PDF');
  panel.appendChild(el('div.export-actions', go,
    el('button', { type: 'button', onclick: () => closeExport() }, state.result ? 'Close' : 'Cancel')));
  const status = el('div.export-status', { 'aria-live': 'polite', role: 'status' });
  panel.appendChild(status);
  dialog.status = status;
  dialog.go = go;
  if (state.result) drawResult(state.result);
  app.renderMath(panel);
}

function referenceText(outline, id) {
  const ref = M.referenceOf(outline, id);
  return ref ? `${ref.word} ${ref.number}` : id;
}

function restoreFocus(selector) {
  if (!dialog) return;
  const x = dialog.panel.querySelector(selector);
  if (x && typeof x.focus === 'function') x.focus();
}

function setStatus(...children) {
  if (!dialog || !dialog.status) return;
  app.clear(dialog.status);
  for (const c of children) if (c) dialog.status.appendChild(c);
}

function busyLine(text) {
  return app.el('p.export-busy', app.el('span.export-spinner', { 'aria-hidden': 'true' }), text);
}

// ---------------------------------------------------------------------------
// getting the PDF
// ---------------------------------------------------------------------------

/** The manifest of the snapshot's prepared exports, or null. */
function manifestFor(hash) {
  if (!manifests.has(hash)) {
    const url = new URL('data/exports/' + exportDirName(hash) + '/manifest.json', app.baseUrl).href;
    manifests.set(hash, fetch(url, { cache: 'no-cache' }).then(async (res) => {
      if (!res.ok) return null;
      const m = await res.json();
      // Only a manifest made for these very bytes counts.
      if (!m || !m.snapshot || m.snapshot.sha256 !== hash || !Array.isArray(m.exports)) return null;
      m.url = url;
      return m;
    }).catch(() => null));
  }
  return manifests.get(hash);
}

const sameRequest = (e, req) => e.collapse === req.collapse && (e.scope ?? null) === req.scope &&
  String(e.depth) === String(req.depth) && !!e.appendices === !!req.appendices;

/** Whether the server the site came from makes PDFs (`blueprint serve`). */
function exportServer() {
  if (!serverCheck) {
    serverCheck = fetch('api/export', { cache: 'no-cache', headers: { Accept: 'application/json' } })
      .then(async (res) => {
        const type = res.headers.get('Content-Type') || '';
        if (!res.ok || !type.includes('json')) return { available: false };
        const j = await res.json();
        return { available: !!j.available, reason: j.reason || null };
      })
      .catch(() => ({ available: false }));
  }
  return serverCheck;
}

/** The site-relative name of the snapshot on screen, as the server knows it, or null. */
function snapshotFile() {
  if (app.viewingEntry && app.viewingEntry.file) return app.viewingEntry.file;
  try {
    const here = new URL(app.dataUrl, location.href).href;
    if (here === new URL('blueprint.json', location.href).href) return 'blueprint.json';
  } catch (e) { /* no URL */ }
  return null;
}

async function run() {
  if (!dialog || dialog.state.busy) return; // one export at a time
  const { state, lib } = dialog;
  const m = app.model;
  let req;
  try {
    req = lib.resolveRequest(m, rawRequest(state));
  } catch (e) {
    state.result = { error: e.message };
    drawDialog();
    return;
  }
  state.busy = true;
  state.result = null;
  const mine = dialog;
  drawDialog();
  setStatus(busyLine('Looking for a prepared PDF…'));
  let result;
  try {
    result = await obtain(req, (text) => { if (dialog === mine) setStatus(busyLine(text)); });
  } catch (e) {
    result = { error: String((e && e.message) || e), req };
  }
  if (dialog !== mine) return; // closed meanwhile
  state.busy = false;
  state.result = result;
  drawDialog();
  if (result.pdfUrl && dialog) {
    const a = dialog.panel.querySelector('a.export-download');
    if (a && typeof a.click === 'function') a.click();
  }
}

/**
 * Find or make the PDF of `req` for the snapshot on screen.  Resolves to
 * {pdfUrl, fileName, pages, texUrl, texName, sourceUrl, warnings} or
 * {error, details, logUrl, texUrl…}.
 */
async function obtain(req, progress) {
  const hash = await app.snapshotHash;
  if (!hash) throw new Error('the page could not fingerprint the snapshot it loaded');
  // The local server, when there is one, is asked first: it hands back what
  // is prepared when that was made from the same TeX, and makes it again
  // otherwise, so a PDF left by an older version of the export is not used.
  const server = await exportServer();
  const manifest = server.available ? null : await manifestFor(hash);
  let entry = manifest ? manifest.exports.find((e) => sameRequest(e, req)) : null;
  let base = manifest ? new URL('.', manifest.url).href : null;

  if (!entry || entry.status !== 'ok') {
    if (server.available) {
      const file = snapshotFile();
      if (!file) {
        return failure(req, 'The local server can only make PDFs of the snapshots it serves, and this page loaded its snapshot from elsewhere.');
      }
      progress('Making the PDF on the local server… this takes a few seconds.');
      const res = await fetch('api/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ snapshot: file, sha256: hash, collapse: req.collapse, scope: req.scope, depth: req.depth, appendices: req.appendices }),
      });
      let j = null;
      try { j = await res.json(); } catch (e) { /* not JSON */ }
      if (!j) return failure(req, `The local server answered ${res.status} ${res.statusText}, not an export.`);
      if (j.entry) {
        entry = j.entry;
        base = new URL(j.base, location.href).href;
        manifests.delete(hash);
      }
      if (!res.ok || !j.ok) {
        return failure(req, j.error || (entry && entry.error) || `The local server could not make the PDF (${res.status}).`,
          entry && base ? { logUrl: entry.log ? new URL(entry.log, base).href : null, texUrl: entry.tex ? new URL(entry.tex, base).href : null, entry } : {});
      }
    } else if (entry && entry.status === 'failed') {
      return failure(req, 'Making this PDF failed when the site was built: ' + entry.error, {
        logUrl: entry.log ? new URL(entry.log, base).href : null,
        texUrl: entry.tex ? new URL(entry.tex, base).href : null,
        entry,
      });
    } else if (server.reason) {
      // `blueprint serve` is there, but cannot make PDFs on this machine.
      return failure(req, (manifest ? 'No PDF was prepared for this choice, and the' : 'No PDFs were prepared for this site, and the') +
        ' local server cannot make one: ' + server.reason + '.');
    } else {
      return failure(req, manifest
        ? 'No PDF was prepared for this choice when the site was built.'
        : app.viewingSha
          ? 'No PDFs were prepared for this snapshot: it is older than the history the site keeps PDFs for, or than the export itself.'
          : 'No PDFs were prepared for this site (it was built without `--pdf`), and it is not served by `blueprint serve`, which would make one.');
    }
  }

  progress('Downloading the PDF…');
  const pdfUrl = new URL(entry.pdf, base).href;
  const res = await fetch(pdfUrl, { cache: 'no-cache' });
  if (!res.ok) return failure(req, `The prepared PDF is missing from the site (${res.status} ${res.statusText}).`);
  const blob = await res.blob();
  const head = new Uint8Array(await blob.slice(0, 5).arrayBuffer());
  if (String.fromCharCode(...head) !== '%PDF-') {
    return failure(req, 'The site answered with something that is not a PDF (an error page?) where the PDF should be.');
  }
  const url = URL.createObjectURL(blob.type === 'application/pdf' ? blob : new Blob([blob], { type: 'application/pdf' }));
  (dialog.urls || (dialog.urls = [])).push(url);
  // A historical snapshot's PDF says which one in its name too.
  const name = entry.fileName + (app.viewingSha ? '-' + String(app.viewingSha).slice(0, 10) : '');
  return {
    req,
    pdfUrl: url,
    fileName: name + '.pdf',
    pages: entry.pages || null,
    bytes: blob.size,
    texUrl: entry.tex ? new URL(entry.tex, base).href : null,
    texName: name + '.tex',
    sourceUrl: entry.source ? new URL(entry.source, base).href : null,
    sourceName: name + '-source.zip',
    warnings: entry.warnings || [],
  };
}

function failure(req, error, extra = {}) {
  return { req, error, ...extra };
}

function drawResult(result) {
  const { el } = app;
  if (result.pdfUrl) {
    const size = result.bytes ? ` (${Math.max(1, Math.round(result.bytes / 1024))} KB)` : '';
    setStatus(
      el('p.export-done', 'The PDF is ready', result.pages ? `: ${result.pages} ${result.pages === 1 ? 'page' : 'pages'}` : '', size, '.'),
      el('div.export-links',
        el('a.export-download.button-link.primary', { href: result.pdfUrl, download: result.fileName }, 'Download PDF'),
        el('a.button-link', { href: result.pdfUrl, target: '_blank', rel: 'noopener' }, 'Open in a new tab'),
        result.sourceUrl
          ? el('a.button-link', { href: result.sourceUrl, download: result.sourceName, title: 'the .tex and its images' }, 'TeX source (.zip)')
          : result.texUrl ? el('a.button-link', { href: result.texUrl, download: result.texName }, 'TeX source (.tex)') : null),
      result.warnings && result.warnings.length
        ? el('details.export-warnings', el('summary', `${result.warnings.length} ${result.warnings.length === 1 ? 'note' : 'notes'} from the export`),
          el('ul', ...result.warnings.slice(0, 50).map((w) => el('li', w.object ? el('code', w.object) : null, w.object ? ': ' : '', w.message))))
        : null);
    return;
  }
  const texButton = el('button', { type: 'button', onclick: () => downloadGeneratedTex(result.req) }, 'Download the TeX source');
  setStatus(
    el('div.export-error', { role: 'alert' },
      el('p', el('strong', 'No PDF. '), result.error),
      result.logUrl ? el('p', el('a', { href: result.logUrl, target: '_blank', rel: 'noopener' }, 'The TeX log'), ' says where it stopped.') : null),
    el('p.small', 'The TeX source of this export is still available: compile it with ', el('code', 'latexmk -pdf'),
      ' (or run ', el('code', 'pdflatex'), ' twice), or prepare the PDFs with ', el('code', 'blueprint site --pdf'),
      ' or ', el('code', 'blueprint export'), '.'),
    el('div.export-links',
      result.texUrl ? el('a.button-link', { href: result.texUrl, download: '' }, 'TeX source (.tex)') : texButton));
}

/** Write the TeX in the page and hand it over. */
async function downloadGeneratedTex(rawReq) {
  const lib = await loadLatex();
  const m = app.model;
  const label = app.viewingSha ? `Snapshot ${app.viewingEntry && app.viewingEntry.date ? app.viewingEntry.date + ', ' : ''}revision ${String(app.viewingSha).slice(0, 10)}` : null;
  let res;
  try {
    res = lib.exportLatex(m, rawReq, { snapshot: { label } });
  } catch (e) {
    setStatus(app.el('div.export-error', { role: 'alert' }, app.el('p', 'The TeX could not be written: ', String(e.message || e))));
    return;
  }
  const url = URL.createObjectURL(new Blob([res.tex], { type: 'application/x-tex' }));
  if (dialog) (dialog.urls || (dialog.urls = [])).push(url);
  const name = res.fileName + (app.viewingSha ? '-' + String(app.viewingSha).slice(0, 10) : '') + '.tex';
  const a = app.el('a', { href: url, download: name });
  document.body.appendChild(a);
  if (typeof a.click === 'function') a.click();
  a.parentNode.removeChild(a);
}
