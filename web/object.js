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
  page.appendChild(el('div.obj-head',
    el('h1', M.titleOf(o)),
    el('div.row', app.kindBadge(o.kind), status === null ? null : app.statusBadge(status))));
  page.appendChild(el('div.obj-id', o.id));

  page.appendChild(el('div.row', { style: { marginTop: '.7rem' } },
    el('a', { href: graphHref(app, o.id) }, 'Show in graph →'),
    el('a', { href: '#/document?focus=' + encodeURIComponent(o.id) }, 'In the document →')));

  // ---------------------------------------------------------------- prose
  const prose = el('div.body-prose');
  page.appendChild(el('div.panel', prose));
  app.renderBody(prose, o.body, app.knownIds());

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
    .map((k) => [k, M.progressOf(m, k, o.id)])
    .filter(([, p]) => p);
  if (progs.length) {
    page.appendChild(el('div.panel',
      el('h3', 'Progress'),
      el('p.muted.small',
        'The fraction of countable leaves below this object whose derived status is ',
        el('code', 'proved'), '.'),
      el('dl.kv', ...progs.flatMap(([k, p]) => [el('dt', k), el('dd', app.progressBar(p))]))));
  }

  // ---------------------------------------------------------------- checks
  const checks = M.checksFor(m, o.id);
  if (checks.length) {
    page.appendChild(el('div.panel',
      el('h3', `Checks mentioning this object (${checks.length})`),
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
}

// ---------------------------------------------------------------------------

function cssId(id) {
  return String(id).replace(/[^A-Za-z0-9_-]/g, '_');
}

function kindOf(m, id) {
  const o = m.byId.get(id);
  return o ? o.kind : '?';
}

function statusChip(app, id) {
  const s = M.statusOf(app.model, id);
  return s === null ? null : app.statusBadge(s);
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
  return el('div.panel', el('h3', 'Declared attributes'), el('dl.kv', ...rows));
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
  return el('div.panel',
    el('h3', `Incident objects (${inc.length})`),
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
  return el('span.muted.small', src === selfId ? ' → ' : ' ← ', app.objLink(m, other));
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

  return el('div.panel',
    el('h3', `Position in the ${kind} order`),
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
