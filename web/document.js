// document.js — the linear reading order: "a blueprint still reads as a paper".
//
// Objects are ordered by their `order` attribute then by id, recursively
// through the collapse order (DESIGN.md §6).  Two rules keep the result
// readable rather than a dump of every object in the snapshot:
//
//   * an object appears in the flow when it has prose of its own or children
//     in the collapse order.  Sugar-created edges with neither are structure,
//     not content, and are left to the graph;
//   * a binary edge with prose or a title but no children of its own is a
//     *step* of its source object, rendered as an indented block under it —
//     "By induction on the dimension" belongs under the theorem it proves, not
//     as a chapter.  An edge that does have children keeps its own place: it is
//     a coarse object carrying its own prose, and its details nest under it.
//
// Edges of the collapse kind itself are never shown: they *are* the structure.

import * as M from './model.js';

export function render(root, app) {
  const { el, clear } = app;
  const m = app.model;
  const kind = pickKind(app);

  clear(root);
  if (!kind) {
    root.appendChild(el('div.error-box', el('h1', 'No collapsible kind'),
      el('p', 'The document view needs a kind with ', el('code', 'collapse = true'), '.')));
    return;
  }

  const order = M.collapseOrder(m, kind);
  const known = app.knownIds();
  const focus = app.route.params.get('focus');

  const hasProse = (o) => !!(o.body && o.body.trim());
  const hasTitle = (o) => !!(o.attrs && typeof o.attrs.title === 'string' && o.attrs.title);
  const hasKids = (id) => M.childrenOf(order, id).length > 0;

  // An object earns a place in the flow if it says something or contains
  // something.
  const inFlow = (o) => o.kind !== kind && (hasProse(o) || hasKids(o.id));

  // Steps: leaf binary edges with something to say, filed under their source.
  const stepsFor = new Map(); // src id -> [edge objects]
  const asStep = new Set();
  for (const o of m.objects) {
    if (o.kind === kind) continue;
    if (!M.isBinaryKind(m, o.kind)) continue;
    if (hasKids(o.id)) continue; // it heads its own part of the document
    if (!hasProse(o) && !hasTitle(o)) continue;
    const src = M.boundaryEntry(o, 'src');
    const srcObj = src && m.byId.get(src);
    if (!srcObj || !inFlow(srcObj)) continue; // nothing to file it under
    if (!stepsFor.has(src)) stepsFor.set(src, []);
    stepsFor.get(src).push(o);
    asStep.add(o.id);
  }

  const entries = M.readingOrder(m, kind)
    .filter((e) => e.object && inFlow(e.object) && !asStep.has(e.id));

  const page = el('div.page.wide');
  const body = el('div');
  const toc = el('nav.toc');
  page.appendChild(el('div.doc-layout', toc, body));
  root.appendChild(page);

  // ----------------------------------------------------------------- header
  body.appendChild(el('h1', m.project.title || m.project.name || 'Blueprint'));
  body.appendChild(el('p.muted',
    'Reading order along the ', el('code', kind), ' order.',
    m.collapseKinds.length > 1
      ? el('span', ' ', el('select', {
          onchange: (e) => app.setParams({ collapse: e.target.value, focus: null }),
        }, ...m.collapseKinds.map((k) => el('option', { value: k, selected: k === kind }, k))))
      : null));

  if (!entries.length) {
    body.appendChild(el('p.empty', 'Nothing to read: no object carries prose.'));
    return;
  }

  // -------------------------------------------------------------------- toc
  const tocList = el('ul');
  toc.appendChild(el('h3', { class: 'toc-head' }, 'Contents'));
  toc.appendChild(tocList);

  // ------------------------------------------------------------------ body
  const numbering = [];
  for (const entry of entries) {
    const o = entry.object;

    numbering.length = entry.depth + 1;
    numbering[entry.depth] = (numbering[entry.depth] || 0) + 1;
    const num = numbering.slice(0, entry.depth + 1).join('.');

    const anchor = 'doc-' + cssId(o.id);
    const hLevel = Math.min(5, 2 + entry.depth);
    const status = M.statusOf(m, o.id);
    const prog = M.progressOf(m, kind, o.id);

    const section = el('section', {
      class: 'doc-entry depth-' + Math.min(entry.depth, 3) + (entry.duplicate ? ' dup' : ''),
      id: anchor,
    }, el('div.head',
      el('span.num', num),
      el('h' + hLevel, el('a.objlink', { href: app.objectHref(o.id) }, M.titleOf(o))),
      app.kindBadge(o.kind),
      status === null ? null : app.statusBadge(status),
      entry.duplicate ? el('span.chip', 'repeated') : null));

    // A coarse edge object that heads its own part: say what it connects.
    if (o.boundary.length) {
      section.appendChild(el('p.muted.small',
        ...o.boundary.flatMap((b, i) => [
          i ? ', ' : null, el('span.role', b.role), ' ', app.objLink(m, b.id),
        ])));
    }

    if (prog && prog.total > 1) {
      section.appendChild(el('div.doc-progress', app.progressBar(prog)));
    }

    if (entry.duplicate) {
      section.appendChild(el('p.muted.small', 'Written out under ',
        app.objLink(m, M.parentsOf(order, o.id)[0] || o.id), '.'));
    } else {
      if (hasProse(o)) {
        const prose = el('div.prose.body-prose');
        section.appendChild(prose);
        app.renderBody(prose, o.body, known);
      }
      for (const step of stepsFor.get(o.id) || []) {
        section.appendChild(stepBlock(app, step, known));
      }
    }

    body.appendChild(section);

    if (entry.depth <= 2 && !entry.duplicate) {
      tocList.appendChild(el('li', { class: 'lvl-' + entry.depth },
        el('a', {
          // A real route, so the link survives middle-click and reload; the
          // click handler just scrolls without a re-render.
          href: '#/document?' + new URLSearchParams({ collapse: kind, focus: o.id }).toString(),
          onclick: scrollTo(anchor),
        }, el('span.muted', num + ' '), M.titleOf(o))));
    }
  }

  if (focus) {
    const target = document.getElementById('doc-' + cssId(focus));
    if (target) requestAnimationFrame(() => target.scrollIntoView({ block: 'start' }));
  }
}

function scrollTo(anchor) {
  return (ev) => {
    const target = document.getElementById(anchor);
    if (!target) return;
    ev.preventDefault();
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
}

function stepBlock(app, o, known) {
  const { el } = app;
  const m = app.model;
  const tgt = M.boundaryEntry(o, 'tgt');
  const status = M.statusOf(m, o.id);
  const block = el('div.step',
    el('div.step-head',
      el('span', o.kind),
      tgt ? el('span.step-target', '→ ', app.objLink(m, tgt)) : null,
      status === null ? null : app.statusBadge(status),
      el('a.small.step-link', { href: app.objectHref(o.id) }, 'object →')));
  if (o.attrs && o.attrs.title) block.appendChild(el('p.step-title', o.attrs.title));
  if (o.body && o.body.trim()) {
    const prose = el('div.body-prose.step-prose');
    block.appendChild(prose);
    app.renderBody(prose, o.body, known);
  }
  return block;
}

function pickKind(app) {
  const m = app.model;
  const wanted = app.route.params.get('collapse');
  if (wanted && m.kinds[wanted] && m.kinds[wanted].collapse) return wanted;
  return m.defaultCollapse || m.collapseKinds[0] || null;
}

function cssId(id) {
  return String(id).replace(/[^A-Za-z0-9_-]/g, '_');
}
