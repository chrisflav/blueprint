// object.js — the page for a single object.

import * as M from './model.js';

export function render(root, app) {
  const { el, clear } = app;
  const m = app.model;
  const id = app.route.id;
  const o = id ? m.byId.get(id) : null;

  clear(root);
  if (!o) {
    root.appendChild(el('div.error-box',
      el('h1', 'No such object'),
      el('div.detail', String(id)),
      el('p', 'It may have been renamed. ',
        el('a', { href: '#/document' }, 'Browse the document'), ' or ',
        el('a', { href: '#/graph' }, 'the graph'), '.')));
    return;
  }

  const page = el('div.page');
  root.appendChild(page);

  const status = M.statusOf(m, o.id);
  // A proof is named after what it proves: "Proof of <statement>", or, for
  // one titled "of the detailed form", "Proof of the detailed form: <statement>".
  const of = o.kind === 'proof' ? M.attachedTo(o) : null;
  const ofTitle = of ? M.titleOf(m.byId.get(of)) : null;
  const own = o.attrs && o.attrs.title;
  const heading = !of ? M.titleOf(o)
    : !own ? 'Proof of ' + ofTitle
    : /^of\s/.test(own) ? 'Proof ' + own + ': ' + ofTitle
    : 'Proof (' + own + ') of ' + ofTitle;
  page.appendChild(el('div.obj-head',
    el('h1', heading),
    el('div.row', app.kindBadge(o.kind), status === null ? null : app.statusBadge(status))));
  page.appendChild(el('div.obj-id', o.id));

  // The toggle where there is a proof to fold: one of its own, or a section
  // of the body headed "Proof".
  const hasProof = /^#{1,6}\s*proof\b/im.test(o.body || '') ||
    M.incidentTo(m, o.id).some(({ object, role }) => object.kind === 'proof' && role === 'of');
  page.appendChild(el('div.row', { style: { marginTop: '.7rem' } },
    el('a', { href: graphHref(app, o.id) }, 'Show in graph →'),
    documentLink(app, o),
    hasProof ? el('span.spacer') : null,
    hasProof ? app.proofToggle() : null));

  // ---------------------------------------------------------------- prose
  const prose = el('div.body-prose');
  page.appendChild(el('div.panel', prose));
  app.renderBody(prose, o.body, app.knownIds());

  // ---------------------------------------------------- its proofs, if any
  // A statement's proofs follow it, as in the document, each leading to its
  // own object page.
  const proofs = M.incidentTo(m, o.id)
    .filter(({ object, role }) => object.kind === 'proof' && role === 'of')
    .map(({ object }) => object);
  for (const p of proofs) {
    const prose = el('div.body-prose.proof-prose');
    page.appendChild(el('div.panel', app.proofDisclosure(
      el('a.objlink.proof-word', { href: app.objectHref(p.id) }, 'Proof' + M.proofLeadRest(p)),
      el('div.proof-body', prose))));
    app.renderBody(prose, p.body, app.knownIds());
  }

  // ------------------------------------------------------------ attributes
  page.appendChild(attrsPanel(app, o));

  // ------------------------------------------------------ Lean declarations
  const facts = M.leanFactsFor(m, o);
  if (facts.length) page.appendChild(leanPanel(app, o, facts));

  // ---------------------------------------------------------- the boundary
  if (o.boundary.length) {
    page.appendChild(el('div.panel',
      el('h3', 'Boundary'),
      el('p.muted.small', 'The objects this one is a relation between; depth ' + o.depth + '.'),
      el('ul.objlist', ...o.boundary.map((b) =>
        el('li', el('span.role', b.role), app.objLink(m, b.id),
          el('span.chip', kindOf(m, b.id)), statusChip(app, b.id))))));
  }

  // --------------------------------------------------- everything incident
  page.appendChild(incidencePanel(app, o));

  // ------------------------------------------- position in collapse orders
  for (const kind of m.collapseKinds) page.appendChild(collapsePanel(app, o, kind));

  // ------------------------------------------------------------- progress
  const progs = m.collapseKinds
    .map((k) => [k, M.progressMixOf(m, k, o.id)])
    .filter(([, p]) => p);
  if (progs.length) {
    page.appendChild(el('div.panel',
      el('h3', 'Progress'),
      el('p.muted.small',
        'The fraction of countable leaves below this object whose derived status is ',
        el('code', 'proved'), '; for a top-level object, of its direct children.'),
      el('dl.kv', ...progs.flatMap(([k, p]) => [el('dt', k), el('dd', app.progressBar(p))]))));
  }

  // ---------------------------------------------------------------- checks
  const checks = M.checksFor(m, o.id);
  if (checks.length) {
    page.appendChild(foldPanel(app, 'checks', `Checks mentioning this object (${checks.length})`,
      ...checks.map((c) => el('div', { class: 'check level-' + c.level },
        app.levelBadge(c.level),
        el('span.code', c.code),
        el('div.msg', c.message),
        el('div.objs', ...(c.objects || []).filter((x) => x !== o.id).map((x) => app.objLink(m, x)))))));
  }

  // ---------------------------------------------------------------- source
  if (o.source && o.source.file) {
    page.appendChild(el('p.muted.small',
      'Source: ', el('code', o.source.file),
      o.source.anonymous ? ' (created by front-matter sugar)' : ''));
  }

  // -------------------------------------------------------------- comments
  page.appendChild(commentsPanel(app, o));
}

// ---------------------------------------------------------------------------
// comments
// ---------------------------------------------------------------------------

// Comments live beside the site, not in the snapshot: the comment server that
// `blueprint serve` runs (comments-server.py) answers
//   GET  api/comments/<id>  -> {"comments": [{n, name, body, date}, ...]}
//   POST api/comments/<id>  <- {"name": ..., "body": ...}
// and keeps them as one JSON file per object.  Served by a plain static
// server there is no such endpoint, and the section says so.
const NAME_KEY = 'blueprint.commentName';

function commentsUrl(id) {
  return 'api/comments/' + encodeURIComponent(id);
}

function rememberedName() {
  try { return localStorage.getItem(NAME_KEY) || ''; } catch (e) { return ''; }
}

function commentsPanel(app, o) {
  const { el, clear } = app;
  const heading = el('h3', 'Comments');
  const list = el('div.comment-list', el('p.muted.small', 'Loading comments…'));

  // ---- the form: name, Markdown + LaTeX, a preview, post
  const name = el('input', {
    type: 'text', name: 'name', required: true, maxlength: '100', autocomplete: 'name',
    placeholder: 'Your name', 'aria-label': 'Name',
  });
  name.value = rememberedName();
  const text = el('textarea', {
    name: 'body', required: true, rows: '7', maxlength: '20000',
    placeholder: 'Markdown and LaTeX: $\\pi$, $$\\int_X f$$, and [label] to refer to an object.',
    'aria-label': 'Comment',
  });
  const preview = el('div.comment-preview.body-prose', { hidden: true });
  const previewBtn = el('button', { type: 'button', 'aria-pressed': 'false' }, 'Preview');
  const post = el('button.primary', { type: 'submit' }, 'Post comment');
  const note = el('span.comment-note.muted.small');
  const form = el('form.comment-form',
    el('h4', 'Add a comment'),
    el('label.comment-field', el('span', 'Name'), name),
    el('label.comment-field', el('span', 'Comment'), text),
    preview,
    el('p.muted.small', 'You can use Markdown and LaTeX style mathematics; ',
      el('code', '[label]'), ' links to the object with that label. Comments are kept with this copy of the site, as ',
      el('code', 'comments/*.json'), ' next to the blueprint.'),
    el('div.row', previewBtn, post, note));

  const showPreview = (on) => {
    preview.hidden = !on;
    text.hidden = on;
    previewBtn.textContent = on ? 'Edit' : 'Preview';
    previewBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    if (on) {
      app.renderBody(preview, text.value.trim() ? text.value : '*Nothing to preview yet.*',
        app.knownIds(), undefined, { untrusted: true });
    }
  };
  previewBtn.addEventListener('click', () => showPreview(preview.hidden));

  const draw = (comments) => {
    clear(list);
    heading.textContent = `Comments (${comments.length})`;
    if (!comments.length) {
      list.appendChild(el('p.muted.small', 'No comments yet.'));
      return;
    }
    for (const c of comments) {
      const body = el('div.comment-body.body-prose');
      app.renderBody(body, c.body, app.knownIds(), undefined, { untrusted: true });
      const when = c.date ? new Date(c.date) : null;
      list.appendChild(el('article.comment', { id: 'comment-' + c.n },
        el('div.comment-head',
          el('b', c.name),
          when && !Number.isNaN(when.getTime())
            ? el('time.muted.small', { datetime: c.date }, when.toLocaleString())
            : null,
          el('span.muted.small.comment-anchor', '#' + c.n)),
        body));
    }
  };

  const unavailable = (why) => {
    clear(list);
    heading.textContent = 'Comments';
    list.appendChild(el('p.muted.small',
      'Comments need the comment server, which ', el('code', 'lake exe blueprint serve'),
      ' starts; this copy of the site is served without it', why ? ` (${why})` : '', '.'));
    for (const c of [name, text, previewBtn, post]) c.disabled = true;
  };

  const load = async () => {
    try {
      const res = await fetch(commentsUrl(o.id), { cache: 'no-store' });
      const type = res.headers.get('content-type') || '';
      if (!res.ok || !type.includes('json')) {
        unavailable(res.ok ? '' : 'HTTP ' + res.status);
        return;
      }
      const data = await res.json();
      draw(Array.isArray(data.comments) ? data.comments : []);
    } catch (e) {
      unavailable('');
    }
  };

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const who = name.value.trim();
    const what = text.value.trim();
    if (!who || !what) {
      note.textContent = 'A name and a comment, please.';
      return;
    }
    post.disabled = true;
    note.textContent = 'Posting…';
    try {
      const res = await fetch(commentsUrl(o.id), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: who, body: what }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
      try { localStorage.setItem(NAME_KEY, who); } catch (e) { /* private mode */ }
      text.value = '';
      showPreview(false);
      note.textContent = 'Posted.';
      draw(Array.isArray(data.comments) ? data.comments : []);
    } catch (e) {
      note.textContent = 'Not posted: ' + e.message;
    } finally {
      post.disabled = false;
    }
  });

  load();
  return el('div.panel.comments', { id: 'comments' }, heading, list, form);
}

// ---------------------------------------------------------------------------

function cssId(id) {
  return String(id).replace(/[^A-Za-z0-9_-]/g, '_');
}

// The panels the reader has opened, by key.  The page is rebuilt on every
// visit, and a reader going from object to object to follow the incident
// objects should not have to open that listing again each time.
const opened = new Set();

/**
 * A panel behind a disclosure, shut until the reader opens it: the long and
 * secondary listings (incident objects, attributes, the positions in the
 * collapse orders, checks), so that what the object says comes first and the
 * page is not a scroll through hundreds of rows to reach it.
 */
function foldPanel(app, key, title, ...children) {
  return app.el('details.panel.fold', {
    open: opened.has(key),
    'data-fold': key,
    ontoggle: (ev) => {
      if (ev.target.open) opened.add(key);
      else opened.delete(key);
    },
  }, app.el('summary', app.el('h3', title)), ...children);
}

function kindOf(m, id) {
  const o = m.byId.get(id);
  return o ? o.kind : '?';
}

function statusChip(app, id) {
  const s = M.statusOf(app.model, id);
  return s === null ? null : app.statusBadge(s);
}

/**
 * The page of the split document this object is read on, scrolled to it.
 * Nothing at all for an object the document leaves out (a plain sugar edge,
 * say): a link to the top of the document would only look like an answer.
 */
function documentLink(app, o) {
  const kind = app.model.defaultCollapse;
  if (!kind) return null;
  const page = M.documentPageOf(M.documentOutline(app.model, kind), o.id);
  if (page === undefined) return null;
  const q = new URLSearchParams({ collapse: kind, focus: o.id });
  const href = '#/document' + (page ? '/' + encodeURIComponent(page) : '') + '?' + q.toString();
  return app.el('a', { href }, 'In the document →');
}

function graphHref(app, id) {
  // Open the graph with the ancestors of this object expanded, so it is on
  // screen rather than hidden inside a collapsed section.
  const kind = app.model.defaultCollapse;
  if (!kind) return '#/graph';
  const order = M.collapseOrder(app.model, kind);
  const expand = M.expandableAncestorsOf(order, id);
  const p = new URLSearchParams();
  p.set('collapse', kind);
  if (expand.length) p.set('expand', expand.join(','));
  p.set('sel', id);
  return '#/graph?' + p.toString();
}

function attrsPanel(app, o) {
  const { el } = app;
  const rows = [];
  const entries = Object.entries(o.attrs || {}).filter(([k]) => k !== 'lean');
  for (const [k, v] of entries) {
    rows.push(el('dt', k));
    rows.push(el('dd', Array.isArray(v)
      ? el('div.row', ...v.map((x) => el('span.chip', String(x))))
      : String(v)));
  }
  rows.push(el('dt', 'kind'), el('dd', el('code', o.kind)));
  rows.push(el('dt', 'depth'), el('dd', String(o.depth)));
  return foldPanel(app, 'attrs', `Declared attributes (${rows.length / 2})`, el('dl.kv', ...rows));
}

function leanPanel(app, o, facts) {
  const { el } = app;
  const docgen = app.model.project && app.model.project.docgen;
  const items = facts.map(({ name, fact }) => {
    const head = docgen
      ? el('a', { href: docgenUrl(docgen, name), target: '_blank', rel: 'noopener' }, el('code', name))
      : el('code', name);
    if (!fact) {
      return el('div.lean-decl', head, ' ', el('span.badge.status-absent', el('span.dot'), 'no facts'));
    }
    if (fact.exists === false) {
      return el('div.lean-decl', head, ' ',
        el('span.badge.status-missing', el('span.dot'), 'does not exist'));
    }
    const r = fact.range;
    return el('div.lean-decl',
      el('div.row', head,
        fact.kind ? el('span.chip', fact.kind) : null,
        fact.status ? app.statusBadge(fact.status) : null),
      fact.signature ? el('pre', el('code', fact.signature)) : null,
      el('div.where',
        fact.module ? el('span', 'module ', el('code', fact.module)) : null,
        r ? el('span', ' · ', el('code', `${r.file}:${r.startLine}–${r.endLine}`)) : null),
      Array.isArray(fact.axioms) && fact.axioms.length
        ? el('div.where', 'axioms: ', ...fact.axioms.map((a) => el('code', a)))
        : null,
      fact.doc ? el('div.doc', fact.doc) : null,
      Array.isArray(fact.deps) && fact.deps.length
        ? el('div.where', 'depends on: ', ...fact.deps.map((d) => el('code', d)))
        : null);
  });
  return el('div.panel',
    el('h3', 'Lean declarations'),
    docgen ? null : el('p.muted.small', 'No ', el('code', 'project.docgen'), ' in the snapshot, so names are not linked.'),
    ...items);
}

function docgenUrl(base, name) {
  const parts = String(name).split('.');
  const decl = parts.pop();
  const mod = parts.join('/');
  const b = base.endsWith('/') ? base : base + '/';
  return `${b}${mod}.html#${encodeURIComponent(name)}`;
}

function incidencePanel(app, o) {
  const { el } = app;
  const m = app.model;
  const inc = M.incidentTo(m, o.id);
  if (!inc.length) {
    return el('div.panel', el('h3', 'Incident objects'),
      el('p.muted.small', 'Nothing has this object in its boundary.'));
  }
  // group by kind, then by role
  const byKind = new Map();
  for (const r of inc) {
    if (!byKind.has(r.object.kind)) byKind.set(r.object.kind, new Map());
    const byRole = byKind.get(r.object.kind);
    if (!byRole.has(r.role)) byRole.set(r.role, []);
    byRole.get(r.role).push(r.object);
  }
  const groups = [...byKind.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return foldPanel(app, 'incident', `Incident objects (${inc.length})`,
    el('p.muted.small', 'Every object whose boundary mentions this one, grouped by kind and role.'),
    ...groups.map(([kind, byRole]) =>
      el('div', { style: { marginTop: '.6rem' } },
        el('h4', { style: { margin: '0 0 .2rem' } }, kind),
        ...[...byRole.entries()].map(([role, objs]) =>
          el('ul.objlist', ...objs.map((x) =>
            el('li', el('span.role', role), app.objLink(m, x.id),
              otherEnd(app, x, o.id))))))));
}

/** For a binary edge, show what is at the other end. */
function otherEnd(app, edgeObj, selfId) {
  const { el } = app;
  const m = app.model;
  if (!M.isBinaryKind(m, edgeObj.kind)) return null;
  const src = M.boundaryEntry(edgeObj, 'src');
  const tgt = M.boundaryEntry(edgeObj, 'tgt');
  const other = src === selfId ? tgt : src;
  if (!other || other === selfId) return null;
  // the arrow points the way the graph draws it
  const outward = (src === selfId) !== M.isReversedKind(m, edgeObj.kind);
  return el('span.muted.small', outward ? ' → ' : ' ← ', app.objLink(m, other));
}

function collapsePanel(app, o, kind) {
  const { el } = app;
  const m = app.model;
  const order = M.collapseOrder(m, kind);
  const chains = M.ancestorChains(order, o.id);
  const kids = M.childrenOf(order, o.id);
  const isRoot = M.parentsOf(order, o.id).length === 0;

  if (isRoot && kids.length === 0) {
    return el('div.panel',
      el('h3', `Position in the ${kind} order`),
      el('p.muted.small', 'Isolated: no ', el('code', kind), ' edge touches this object.'));
  }

  return foldPanel(app, 'order:' + kind, `Position in the ${kind} order`,
    chains.length
      ? el('div',
          el('h4', { style: { margin: '.2rem 0' } }, chains.length > 1 ? 'Ancestors (several branches)' : 'Ancestors'),
          ...chains.map((c) => el('div.chain',
            ...c.flatMap((x, i) => [i ? el('span.sep', '›') : null, app.objLink(m, x)]),
            el('span.sep', '›'), el('b', M.titleOf(o)))))
      : el('p.muted.small', 'A root of this order.'),
    kids.length
      ? el('div', { style: { marginTop: '.7rem' } },
          el('h4', { style: { margin: '.2rem 0' } }, `Children (${kids.length})`),
          el('ul.objlist', ...kids.map((c) =>
            el('li', app.objLink(m, c), el('span.chip', kindOf(m, c)), statusChip(app, c)))))
      : null);
}
