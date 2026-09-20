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
//
// Size.  A real blueprint is a few thousand objects, and turning all of their
// prose into HTML — marked, then KaTeX, then the `[slug]` pass — takes tens of
// seconds.  So the page is built lazily, in two ways:
//
//   * the section headings are appended in chunks, the first chunk
//     synchronously (so there is something to read straight away) and the rest
//     a frame at a time;
//   * a section's prose is rendered only when it comes near the viewport, via
//     an IntersectionObserver.  Scrolling through the whole document therefore
//     costs exactly as much as reading all of it would, spread over the
//     reading, and jumping to one section costs one section.
//
// Both degrade: without an IntersectionObserver every body is rendered as it is
// appended, which is what the page used to do.

import * as M from './model.js';

// How much is built before the first paint, and how much per frame afterwards.
const FIRST_CHUNK = 40;
const CHUNK = 120;
// Above this many entries the contents list is restricted to objects that
// actually contain something; a thousand-line table of contents helps nobody.
const TOC_STRUCTURE_ONLY = 400;

// Guards the chunked append and the observer against a route change landing
// mid-build.
let buildToken = 0;
let observer = null;
let deferred = new Map(); // placeholder element -> the render to run when seen

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

  const token = ++buildToken;
  resetDeferred();

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
  //
  // The numbering has to run over the whole list up front — an entry's number
  // depends on everything before it — but building the sections is chunked and
  // the prose inside them is deferred until it is scrolled to.
  const tocStructureOnly = entries.length > TOC_STRUCTURE_ONLY;
  const numbering = [];
  const build = (entry) => {
    const o = entry.object;

    numbering.length = entry.depth + 1;
    numbering[entry.depth] = (numbering[entry.depth] || 0) + 1;
    const num = numbering.slice(0, entry.depth + 1).join('.');

    const anchor = 'doc-' + cssId(o.id);
    const hLevel = Math.min(5, 2 + entry.depth);
    const status = M.statusOf(m, o.id);
    const prog = M.progressOf(m, kind, o.id);

    // Sections are headings; everything else is a numbered statement in the
    // way a paper sets one: "Definition 1.2.14 (Title)." with the kind as the
    // lead word, and the body indented under it.
    const isSection = o.kind === 'section';
    const kindWord = o.kind.charAt(0).toUpperCase() + o.kind.slice(1).replace(/_/g, ' ');
    const head = el('div.head',
      isSection ? null : el('span.kindword', kindWord),
      el('span.num', num),
      el('h' + hLevel, el('a.objlink', { href: app.objectHref(o.id) }, M.titleOf(o))),
      isSection ? null : app.kindBadge(o.kind),
      status === null ? null : app.statusBadge(status),
      entry.duplicate ? el('span.chip', 'repeated') : null);
    // Titles carry maths too ("the $2$-colimit"); render it like the bodies.
    app.renderMath(head);
    const section = el('section', {
      class: 'doc-entry depth-' + Math.min(entry.depth, 3) + (entry.duplicate ? ' dup' : '') +
        (isSection ? ' is-section' : ' is-statement'),
      id: anchor,
    }, head);

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
        defer(prose, () => app.renderBody(prose, o.body, known));
      }
      for (const step of stepsFor.get(o.id) || []) {
        section.appendChild(stepBlock(app, step, known));
      }
    }

    body.appendChild(section);

    if (entry.depth <= 2 && !entry.duplicate && !(tocStructureOnly && !hasKids(o.id))) {
      const item = el('li', { class: 'lvl-' + entry.depth },
        el('a', {
          // A real route, so the link survives middle-click and reload; the
          // click handler just scrolls without a re-render.
          href: '#/document?' + new URLSearchParams({ collapse: kind, focus: o.id }).toString(),
          onclick: scrollTo(anchor),
        }, el('span.muted', num + ' '), M.titleOf(o)));
      app.renderMath(item); // titles carry maths too
      tocList.appendChild(item);
    }
  };

  const eager = Math.min(entries.length, FIRST_CHUNK);
  for (let i = 0; i < eager; i += 1) build(entries[i]);

  // Scrolling to a focused section has to wait until that section has been
  // built.  Sections are appended in order, so rather than building the whole
  // document up front we try after every chunk, and hurry the chunks along
  // until the target turns up.
  let wanted = focus || null;
  const tryScroll = () => {
    if (!wanted) return;
    const target = document.getElementById('doc-' + cssId(wanted));
    if (!target) return;
    wanted = null;
    requestAnimationFrame(() => target.scrollIntoView({ block: 'start' }));
  };
  tryScroll();

  if (eager < entries.length) {
    const step = (from) => {
      if (token !== buildToken) return; // the reader went somewhere else
      const to = Math.min(entries.length, from + (wanted ? CHUNK * 4 : CHUNK));
      for (let i = from; i < to; i += 1) build(entries[i]);
      tryScroll();
      if (to < entries.length) schedule(() => step(to));
    };
    schedule(() => step(eager));
  }
}

function schedule(fn) {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => fn());
  else setTimeout(fn, 0);
}

// ---------------------------------------------------------------------------
// deferred prose
// ---------------------------------------------------------------------------

function resetDeferred() {
  if (observer) observer.disconnect();
  observer = null;
  deferred = new Map();
}

/**
 * Render `fn` into `node` when `node` is about to come into view.  Without an
 * IntersectionObserver there is no honest way to know, so everything is
 * rendered immediately, exactly as the page used to behave.
 */
function defer(node, fn) {
  if (typeof IntersectionObserver !== 'function') {
    fn();
    return;
  }
  if (!observer) {
    observer = new IntersectionObserver((records, obs) => {
      for (const r of records) {
        if (!r.isIntersecting) continue;
        const run = deferred.get(r.target);
        obs.unobserve(r.target);
        deferred.delete(r.target);
        if (run) run();
      }
    }, { rootMargin: '800px 0px' });
  }
  deferred.set(node, fn);
  observer.observe(node);
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
    defer(prose, () => app.renderBody(prose, o.body, known));
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
