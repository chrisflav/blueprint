// document.js — the linear reading order: "a blueprint still reads as a paper".
//
// What is in the document, in what order and under which number is decided by
// `documentOutline` in model.js (DESIGN.md §6): objects ordered by their
// `order` attribute then by id, recursively through the collapse order, with
// the objects that say nothing left to the graph and leaf edges with prose
// filed as *steps* under their source.  This module only sets it.
//
// Pages.  A real blueprint is a book, and one page holding the whole book is
// neither readable nor navigable, so the document is split along the collapse
// order: `#/document` is the top level, `#/document/<id>` is the page of one
// entry, and each page writes out its own entry and the entries `depth` levels
// below it (default 1: a chapter's page shows its sections, a section's page
// its statements).  Entries one level further down are reached through their
// own pages.  `depth=all` is the whole document on one page, as it used to be.
// A page has breadcrumbs up its chain, its previous and next siblings, and a
// contents list of what it shows.
//
// `?focus=<id>` scrolls to an entry.  A focus the page does not show — every
// link written before the split, `#/document?focus=x` — is redirected to the
// page the entry is read on (`documentPageOf`), replacing the history entry so
// Back does not bounce off the redirect.
//
// Size.  Even split, a page can be large (a section with hundreds of lemmas, or
// `depth=all`), and turning prose into HTML — marked, then KaTeX, then the
// `[slug]` pass — is the cost.  So a page is built lazily, in two ways:
//
//   * the section headings are appended in chunks, the first chunk
//     synchronously (so there is something to read straight away) and the rest
//     a frame at a time;
//   * a section's prose is rendered only when it comes near the viewport, via
//     an IntersectionObserver.  Scrolling through the whole page therefore
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
// Levels written out below a page when the route does not say.
const DEFAULT_LEVELS = 1;
// The choices offered by the depth control, besides "all".
const LEVEL_CHOICES = [1, 2, 3];

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

  const outline = M.documentOutline(m, kind);
  const levels = pickLevels(app);
  const pageId = app.route.id || null;
  const focus = app.route.params.get('focus');
  const href = (page, target) => docHref(kind, levels, page, target);

  // An entry this page does not write out is read somewhere else: go there.
  if (focus && !M.documentPageShows(outline, pageId, levels, focus)) {
    const home = M.documentPageOf(outline, focus);
    if (home !== undefined) {
      app.go('document', home, docQuery(kind, levels, focus), { replace: true });
      return;
    }
  }

  const pageEntry = pageId === null ? null : outline.byId.get(pageId);
  if (pageId !== null && !pageEntry) {
    const o = m.byId.get(pageId);
    root.appendChild(el('div.error-box',
      el('h1', o ? 'Not in the document' : 'No such object'),
      el('div.detail', pageId),
      el('p', o
        ? ['Along the ', el('code', kind), ' order this object has no page: it carries no prose and contains nothing. ',
          el('a', { href: app.objectHref(pageId) }, 'Its object page'), ' or ']
        : 'It may have been renamed. ',
      el('a', { href: href(null) }, 'the top of the document'), '.')));
    return;
  }

  const token = ++buildToken;
  resetDeferred();

  const known = app.knownIds();
  const entries = M.documentPageEntries(outline, pageId, levels);
  // Depths on this page count from the first level below the page's own
  // entry, which is set as the page's title.
  const base = pageEntry ? pageEntry.depth + 1 : 0;

  const page = el('div.page.wide');
  const body = el('div');
  const flow = el('div.doc-flow');
  const toc = el('nav.toc');
  page.appendChild(el('div.doc-layout', toc, body));
  root.appendChild(page);

  // ----------------------------------------------------------------- header
  const crumbs = breadcrumbs(app, outline, pageEntry, href);
  if (crumbs) body.appendChild(crumbs);
  if (!pageEntry) body.appendChild(el('h1', m.project.title || m.project.name || 'Blueprint'));
  body.appendChild(el('p.muted.doc-controls',
    'Reading order along the ',
    m.collapseKinds.length > 1
      ? el('select', {
          // The other order has other pages: open the current entry's page
          // there if it has one, and the top of the document otherwise.
          onchange: (e) => app.go('document', null, docQuery(e.target.value, levels, pageId)),
        }, ...m.collapseKinds.map((k) => el('option', { value: k, selected: k === kind }, k)))
      : el('code', kind),
    ' order, showing ',
    el('select', {
      title: 'how many levels below this page are written out on it',
      onchange: (e) => app.setParams({ depth: e.target.value === String(DEFAULT_LEVELS) ? null : e.target.value }),
    },
    // A depth typed into the URL is offered too, so the control shows it.
    ...[...new Set([...LEVEL_CHOICES, levels])].filter(Number.isFinite).sort((a, b) => a - b)
      .map((n) => el('option', { value: String(n), selected: n === levels }, String(n))),
    el('option', { value: 'all', selected: levels === Infinity }, 'all')),
    levels === 1 ? ' level.' : ' levels.'));
  const pagerTop = pager(app, outline, pageEntry, href);
  if (pagerTop) body.appendChild(pagerTop);
  body.appendChild(flow);

  if (!entries.length) {
    body.appendChild(el('p.empty', 'Nothing to read: no object carries prose.'));
    return;
  }

  // -------------------------------------------------------------------- toc
  const tocList = el('ul');
  const tocStructureOnly = entries.length > TOC_STRUCTURE_ONLY;

  // ------------------------------------------------------------------ body
  //
  // The numbers come with the outline; building the sections is chunked and
  // the prose inside them is deferred until it is scrolled to.
  const build = (entry) => {
    const o = entry.object;
    const num = entry.number;
    const isHead = entry === pageEntry;
    const rel = isHead ? -1 : entry.depth - base;
    // Below the page's own entry, how many levels further down its children
    // are: when they are not on this page, the entry links to its own.
    const leadsOn = !entry.duplicate && entry.children.length > 0 && entry.depth - base + 1 >= levels;

    const anchor = entry.duplicate ? null : 'doc-' + cssId(o.id);
    const hLevel = isHead ? 1 : Math.min(5, 2 + rel);
    const status = M.statusOf(m, o.id);
    const prog = M.progressOf(m, kind, o.id);

    // Sections are headings; everything else is a numbered statement in the
    // way a paper sets one: "Definition 1.2.14 (Title)." with the kind as the
    // lead word, and the body indented under it.  The number of an entry
    // with a page of its own is the link to that page.
    const isSection = o.kind === 'section';
    const numNode = entry.children.length && !entry.duplicate && !isHead
      ? el('a.num', { href: href(o.id), title: 'open ' + num + ' on its own page' }, num)
      : el('span.num', num);
    const head = el('div.head',
      isSection ? null : el('span.kindword', M.kindWord(o.kind)),
      numNode,
      el('h' + hLevel, el('a.objlink', { href: app.objectHref(o.id) }, M.titleOf(o))),
      isSection ? null : app.kindBadge(o.kind),
      status === null ? null : app.statusBadge(status),
      entry.duplicate ? el('span.chip', 'repeated') : null);
    // Titles carry maths too ("the $2$-colimit"); render it like the bodies.
    app.renderMath(head);
    const section = el('section', {
      class: 'doc-entry ' + (isHead ? 'page-head' : 'depth-' + Math.min(rel, 3)) +
        (entry.duplicate ? ' dup' : '') + (isSection ? ' is-section' : ' is-statement'),
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
      // Written out once, under its first parent; here it is a pointer there.
      const first = outline.byId.get(o.id);
      const where = first.parent
        ? [first.parent.number, ' ', M.titleOf(first.parent.object)]
        : ['the top level'];
      const back = el('p.muted.small', 'Written out under ',
        el('a', { href: href(M.documentPageOf(outline, o.id), o.id) }, ...where), '.');
      app.renderMath(back);
      section.appendChild(back);
    } else {
      if (o.body && o.body.trim()) {
        const prose = el('div.prose.body-prose');
        section.appendChild(prose);
        defer(prose, () => app.renderBody(prose, o.body, known));
      }
      for (const step of outline.steps.get(o.id) || []) {
        section.appendChild(stepBlock(app, step, known));
      }
    }

    if (leadsOn) {
      const n = entry.children.length;
      section.appendChild(el('p.doc-open',
        el('a', { href: href(o.id) }, 'Read ', num, ' →'),
        el('span.muted.small', ` ${n} ${n === 1 ? 'entry' : 'entries'}`)));
    }

    flow.appendChild(section);

    if (!isHead && rel <= 2 && !entry.duplicate && !(tocStructureOnly && !entry.children.length)) {
      const item = el('li', { class: 'lvl-' + rel },
        el('a', {
          // A real route, so the link survives middle-click and reload; the
          // click handler just scrolls without a re-render.
          href: href(pageId, o.id),
          onclick: scrollTo(anchor),
        }, el('span.muted', num + ' '), M.titleOf(o)));
      app.renderMath(item); // titles carry maths too
      tocList.appendChild(item);
    }
  };

  const eager = Math.min(entries.length, FIRST_CHUNK);
  for (let i = 0; i < eager; i += 1) build(entries[i]);
  if (tocList.firstChild) {
    toc.appendChild(el('h3', { class: 'toc-head' }, 'Contents'));
    toc.appendChild(tocList);
  }

  // Scrolling to a focused section has to wait until that section has been
  // built.  Sections are appended in order, so rather than building the whole
  // page up front we try after every chunk, and hurry the chunks along until
  // the target turns up.
  let wanted = focus || null;
  const tryScroll = () => {
    if (!wanted) return;
    const target = document.getElementById('doc-' + cssId(wanted));
    if (!target) return;
    wanted = null;
    requestAnimationFrame(() => target.scrollIntoView({ block: 'start' }));
  };
  tryScroll();

  const finish = () => {
    const pagerBottom = pager(app, outline, pageEntry, href);
    if (pagerBottom) body.appendChild(pagerBottom);
  };

  if (eager < entries.length) {
    const step = (from) => {
      if (token !== buildToken) return; // the reader went somewhere else
      const to = Math.min(entries.length, from + (wanted ? CHUNK * 4 : CHUNK));
      for (let i = from; i < to; i += 1) build(entries[i]);
      if (!toc.firstChild && tocList.firstChild) {
        toc.appendChild(el('h3', { class: 'toc-head' }, 'Contents'));
        toc.appendChild(tocList);
      }
      tryScroll();
      if (to < entries.length) schedule(() => step(to));
      else finish();
    };
    schedule(() => step(eager));
  } else {
    finish();
  }
}

/** `?collapse=…&depth=…&focus=…` for a document route. */
function docQuery(kind, levels, focus) {
  const q = new URLSearchParams({ collapse: kind });
  if (levels !== DEFAULT_LEVELS) q.set('depth', levels === Infinity ? 'all' : String(levels));
  if (focus) q.set('focus', focus);
  return q;
}

function docHref(kind, levels, pageId, focus) {
  return '#/document' + (pageId ? '/' + encodeURIComponent(pageId) : '') +
    '?' + docQuery(kind, levels, focus).toString();
}

/** "Contents › 2 Cohomology › 2.3 Étale sites", the page's chain upwards. */
function breadcrumbs(app, outline, pageEntry, href) {
  const { el } = app;
  if (!pageEntry) return null;
  const chain = [];
  for (let p = pageEntry.parent; p; p = p.parent) chain.unshift(p);
  const m = app.model;
  const nav = el('nav.doc-crumbs',
    el('a', { href: href(null) }, m.project.title || m.project.name || 'Contents'),
    ...chain.map((e) => [
      el('span.sep', '›'),
      el('a', { href: href(e.id) }, e.number, ' ', M.titleOf(e.object)),
    ]),
    el('span.sep', '›'),
    el('span.here', pageEntry.number, ' ', M.titleOf(pageEntry.object)));
  app.renderMath(nav);
  return nav;
}

/** Previous sibling, up, next sibling — the page's neighbours at its level. */
function pager(app, outline, pageEntry, href) {
  const { el } = app;
  if (!pageEntry) return null;
  const siblings = (pageEntry.parent ? pageEntry.parent.children : outline.roots)
    .filter((e) => !e.duplicate);
  const i = siblings.indexOf(pageEntry);
  const prev = i > 0 ? siblings[i - 1] : null;
  const next = i >= 0 && i + 1 < siblings.length ? siblings[i + 1] : null;
  const label = (e) => [el('span.num', e.number), ' ', M.titleOf(e.object)];
  const nav = el('nav.doc-pager',
    prev ? el('a.prev', { href: href(prev.id), rel: 'prev' }, '← ', ...label(prev)) : el('span'),
    el('a.up', { href: href(pageEntry.parent ? pageEntry.parent.id : null) },
      '↑ ', ...(pageEntry.parent ? label(pageEntry.parent) : ['Top'])),
    next ? el('a.next', { href: href(next.id), rel: 'next' }, ...label(next), ' →') : el('span'));
  app.renderMath(nav);
  return nav;
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
  // An id, so `?focus=` on a step lands on it.
  const block = el('div.step', { id: 'doc-' + cssId(o.id) },
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

/** `depth=` from the route: a positive whole number, or `all`. */
function pickLevels(app) {
  const raw = app.route.params.get('depth');
  if (raw === 'all') return Infinity;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : DEFAULT_LEVELS;
}

function cssId(id) {
  return String(id).replace(/[^A-Za-z0-9_-]/g, '_');
}
