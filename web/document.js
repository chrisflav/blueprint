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
// The top of the document is its contents: a row per top-level entry, each
// leading to its level, and nothing written out — not even the text at the
// top level (an abstract, an introduction), which is read on the top level
// written out, where a row leads.  A `depth=` on the top page writes the top
// levels out instead.
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
  // The page that writes out the level an entry is on, scrolled to it: its
  // parent's page, or the top level written out, which says its depth (the
  // top page without one is the contents).
  const levelHref = (e) => (e.parent ? href(e.parent.id, e.id)
    : '#/document?' + docQuery(kind, levels, e.id, true).toString());
  // The top page with no `depth=` is the contents, which write out no level.
  const contents = pageId === null && !app.route.params.has('depth');
  const shown = contents ? 0 : levels;

  // An entry this page does not write out is read somewhere else: go there.
  if (focus && !M.documentPageShows(outline, pageId, shown, focus)) {
    const home = M.documentPageOf(outline, focus);
    if (home !== undefined) {
      // Read at the top level: written out, since the contents write nothing.
      app.go('document', home, docQuery(kind, levels, focus, home === null), { replace: true });
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
  const entries = M.documentPageEntries(outline, pageId, shown);

  // Cross references in the prose read "Lemma 2.3.1" in this order's numbers,
  // and stay in the paper: they lead to the level of the entry, its own page
  // when it has entries below it, and otherwise where it is written out, on
  // this page if it is here.  A reader who wants
  // the object page has the entry's title for that.  Objects the document
  // does not number keep their slug and their object-page link.
  const refPage = (slug) => {
    const own = M.documentPageOf(outline, slug);
    if (own === slug) return own;
    return M.documentPageShows(outline, pageId, shown, slug) ? pageId : own;
  };
  const refs = (slug) => {
    const ref = M.referenceOf(outline, slug);
    if (!ref) return null;
    return { ...ref, href: href(refPage(slug), slug) };
  };
  // Depths on this page count from the first level below the page's own
  // entry, which is set as the page's title.
  const base = pageEntry ? pageEntry.depth + 1 : 0;

  // The contents need no sidebar: they are one.
  const page = el(contents ? 'div.page' : 'div.page.wide');
  const body = el('div');
  const flow = el('div.doc-flow');
  const toc = el('nav.toc');
  page.appendChild(contents ? body : el('div.doc-layout', toc, body));
  root.appendChild(page);

  // A reference to an entry already built on this page jumps to it instead of
  // rebuilding the page around the same place.  A jump rather than a smooth
  // scroll, and pinned: on the way past, bodies render and move the target,
  // and a smooth scroll in Chromium then ends wherever the target used to be.
  flow.addEventListener('click', (ev) => {
    const a = ev.target && ev.target.closest ? ev.target.closest('a.ref[data-ref]') : null;
    if (!a || refPage(a.getAttribute('data-ref')) !== pageId) return;
    const target = document.getElementById('doc-' + cssId(a.getAttribute('data-ref')));
    if (!target) return; // not built yet: let the route build the page to it
    ev.preventDefault();
    target.scrollIntoView({ block: 'start' });
    pin(target);
  });

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
      // On the top page no `depth=` is the contents, so a depth is always
      // said there; elsewhere the default goes without saying.
      onchange: (e) => app.setParams({
        depth: e.target.value === 'contents' ? null
          : pageId !== null && e.target.value === String(DEFAULT_LEVELS) ? null : e.target.value,
      }),
    },
    pageId === null ? el('option', { value: 'contents', selected: contents }, 'contents') : null,
    // A depth typed into the URL is offered too, so the control shows it.
    ...[...new Set([...LEVEL_CHOICES, levels])].filter(Number.isFinite).sort((a, b) => a - b)
      .map((n) => el('option', { value: String(n), selected: !contents && n === levels }, String(n))),
    el('option', { value: 'all', selected: !contents && levels === Infinity }, 'all')),
    contents ? ' only.' : levels === 1 ? ' level.' : ' levels.',
    // The contents set out no proofs to fold.
    contents ? null : [' ', app.proofToggle()],
    // This page's part, as a PDF: the dialog opens on it.
    app.exportButton ? [' ', app.exportButton('Export PDF')] : null));
  const pagerTop = pager(app, outline, pageEntry, href);
  if (pagerTop) body.appendChild(pagerTop);
  body.appendChild(flow);

  if (!(contents ? outline.roots : entries).length) {
    body.appendChild(el('p.empty', 'Nothing to read: no object carries prose.'));
    return;
  }

  // ------------------------------------------------------------------ body
  //
  // The numbers come with the outline; building the sections is chunked and
  // the prose inside them is deferred until it is scrolled to.
  const build = (entry) => {
    const o = entry.object;
    // A piece of text belonging to no statement (the lines that open a
    // section, a paragraph between two lemmas) is read where it stands: its
    // prose and nothing else, no heading, no number, not in the contents.
    if (entry.text) {
      if (entry.duplicate) return; // said once, under its first parent
      const text = el('section', { class: 'doc-entry is-text kind-' + o.kind, id: 'doc-' + cssId(o.id) });
      const prose = text.appendChild(el('div.prose.body-prose'));
      defer(prose, () => app.renderBody(prose, o.body, known, refs));
      for (const step of outline.steps.get(o.id) || []) text.appendChild(stepBlock(app, step, outline, known, refs));
      flow.appendChild(text);
      return;
    }
    const num = entry.number;
    const isHead = entry === pageEntry;
    const rel = isHead ? -1 : entry.depth - base;
    // Below the page's own entry, how many levels further down its children
    // are: when they are not on this page, the entry links to its own.
    const leadsOn = !entry.duplicate && entry.children.length > 0 && entry.depth - base + 1 >= levels;

    const anchor = entry.duplicate ? null : 'doc-' + cssId(o.id);
    const hLevel = isHead ? 1 : Math.min(5, 2 + rel);
    const status = M.badgeStatusOf(m, o.id);
    const prog = app.showProgress ? M.progressMixOf(m, kind, o.id) : null;

    // Sections are headings; everything else is a numbered statement in the
    // way a paper sets one: "Definition 1.2.14 (Title)." with the kind as the
    // lead word, and the body indented under it.  The number of an entry
    // with a page of its own is the link to that page.
    const isSection = M.isSectionKind(o.kind);
    const numNode = entry.children.length && !entry.duplicate && !isHead
      ? el('a.num', { href: href(o.id), title: 'open ' + num + ' on its own page' }, num)
      : el('span.num', num);
    const head = el('div.head',
      isSection ? null : el('span.kindword', M.kindWord(o.kind)),
      numNode,
      el('h' + hLevel, el('a.objlink', { href: app.objectHref(o.id) }, M.titleOf(o))),
      // An entry whose children are on a page of their own leads on there,
      // beside its title.
      leadsOn ? el('a.doc-open', { href: href(o.id) }, 'Read ', num, ' →') : null,
      // Its Lean names, in a card of their own, so the heading keeps one word.
      // Before the badges: themes set the last of them apart.
      app.leanMark(o),
      isSection ? null : app.kindBadge(o.kind),
      status === null ? null : app.statusBadge(status),
      entry.duplicate ? el('span.chip', 'repeated') : null);
    // Titles carry maths too ("the $2$-colimit"); render it like the bodies.
    app.renderMath(head);
    const section = el('section', {
      class: 'doc-entry ' + (isHead ? 'page-head' : 'depth-' + Math.min(rel, 3)) +
        (entry.duplicate ? ' dup' : '') + (isSection ? ' is-section' : ' is-statement') +
        ' kind-' + o.kind,
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
        defer(prose, () => app.renderBody(prose, o.body, known, refs));
      }
      for (const proof of outline.proofs.get(o.id) || []) {
        section.appendChild(proofBlock(app, proof, outline, known, refs));
      }
      for (const step of outline.steps.get(o.id) || []) {
        section.appendChild(stepBlock(app, step, outline, known, refs));
      }
    }

    flow.appendChild(section);
  };

  // --------------------------------------------------------------- contents
  //
  // The top of the document: a row per top-level entry, each leading to its
  // level.  The text at the top level is not here but on that level, read
  // where it stands once the reader goes in.
  if (contents) {
    flow.appendChild(el('h2.toc-head', 'Contents'));
    const list = el('ol.doc-contents');
    for (const entry of outline.roots) {
      if (!entry.text) list.appendChild(contentsRow(app, outline, entry, href, levelHref));
    }
    flow.appendChild(list);
    return;
  }

  let tocShown = false;
  const showToc = () => {
    if (tocShown) return;
    // The whole document's outline, opened along the way to this page, when
    // the site asks for it; else the contents one level at a time.
    if (sidebarMode() === 'outline') {
      tocShown = true;
      toc.classList.add('toc-outline');
      toc.appendChild(el('h3', { class: 'toc-head' }, 'Contents'));
      toc.appendChild(outlineSidebar(app, outline, pageEntry, levels, href, scrollTo));
      // This page's entry in view inside the sidebar, which scrolls on its
      // own: the page itself does not move.  The sidebar is the entry's
      // offset parent (it is sticky), so `offsetTop` is already from its top.
      const here = toc.querySelector('li.current');
      if (here && typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => {
          toc.scrollTop = Math.max(0, here.offsetTop - toc.clientHeight / 3);
        });
      }
      return;
    }
    tocShown = true;
    levelSidebar(app, outline, pageEntry, focus, levelHref, toc);
  };

  const eager = Math.min(entries.length, FIRST_CHUNK);
  for (let i = 0; i < eager; i += 1) build(entries[i]);
  showToc();

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
    land(target);
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
      showToc();
      tryScroll();
      if (to < entries.length) schedule(() => step(to));
      else finish();
    };
    schedule(() => step(eager));
  } else {
    finish();
  }
}

/** Take the reader to the entry a link led to, and hold it there. */
function land(target) {
  pin(target);
  flash(target);
  requestAnimationFrame(() => target.scrollIntoView({ block: 'start' }));
}

/**
 * One row of the contents: the entry's number and title, its progress (or,
 * for a statement, its status), all a link to its level: the top level
 * written out, scrolled to it.  An entry repeated at the top level leads to
 * where it is written out.
 */
function contentsRow(app, outline, entry, href, levelHref) {
  const { el } = app;
  const m = app.model;
  const o = entry.object;
  const page = M.documentPageOf(outline, o.id);
  const isSection = M.isSectionKind(o.kind);
  const prog = M.progressMixOf(m, outline.kind, o.id);
  const status = M.badgeStatusOf(m, o.id);
  const row = el('li', { class: 'kind-' + o.kind + (entry.duplicate ? ' dup' : '') },
    el('a', { href: entry.duplicate ? href(page, page === o.id ? null : o.id) : levelHref(entry) },
      el('span.num', entry.number),
      el('span.doc-contents-title',
        isSection ? null : el('span.kindword', M.kindWord(o.kind), ' '),
        M.titleOf(o)),
      el('span.doc-contents-meta',
        prog && prog.total > 1 ? app.progressBar(prog)
          : status === null ? null : app.statusBadge(status))));
  app.renderMath(row); // titles carry maths too
  return row;
}

/** Mark the entry a link led to, briefly. */
function flash(target) {
  target.classList.remove('flash');
  // Restart the animation when the same entry is picked twice in a row.
  void target.offsetWidth;
  target.classList.add('flash');
}

/** `?collapse=…&depth=…&focus=…` for a document route; the depth only when
 *  it is not the default, or when `sayDepth`. */
function docQuery(kind, levels, focus, sayDepth = false) {
  const q = new URLSearchParams({ collapse: kind });
  if (sayDepth || levels !== DEFAULT_LEVELS) q.set('depth', levels === Infinity ? 'all' : String(levels));
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
    .filter((e) => !e.duplicate && !e.text);
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
  pinned = null;
}

// The entry a focus or a contents link scrolled to, kept in place while the
// prose around it renders, until the reader scrolls on their own.
let pinned = null;
const UNPIN = ['wheel', 'touchstart', 'keydown', 'mousedown'];

function pin(target) {
  pinned = target;
  if (typeof window === 'undefined' || !window.addEventListener) return;
  const release = () => {
    pinned = null;
    for (const t of UNPIN) window.removeEventListener(t, release, true);
  };
  for (const t of UNPIN) window.addEventListener(t, release, true);
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
      // Prose rendered above the entry the reader was taken to pushes it down
      // the page; hold it where it was, as scroll anchoring would if the
      // browser did it from the top of a page (it does not, at scrollY 0).
      const held = pinned && pinned.isConnected && pinned.getBoundingClientRect &&
        typeof window.scrollBy === 'function' ? pinned : null;
      const before = held ? held.getBoundingClientRect().top : 0;
      for (const r of records) {
        if (!r.isIntersecting) continue;
        const run = deferred.get(r.target);
        obs.unobserve(r.target);
        deferred.delete(r.target);
        if (run) run();
      }
      if (held) {
        const moved = held.getBoundingClientRect().top - before;
        if (Math.abs(moved) > 1) window.scrollBy(0, moved);
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

/** A step, and the steps filed under it in turn: a relation between two
 *  relations ("the fine dependency generalises the coarse one") is read with
 *  the relation it starts from. */
function stepBlock(app, o, outline, known, refs, seen = new Set()) {
  const { el } = app;
  const m = app.model;
  const tgt = M.boundaryEntry(o, 'tgt');
  const status = M.badgeStatusOf(m, o.id);
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
    defer(prose, () => app.renderBody(prose, o.body, known, refs));
  }
  seen.add(o.id);
  for (const step of outline.steps.get(o.id) || []) {
    if (!seen.has(step.id)) block.appendChild(stepBlock(app, step, outline, known, refs, seen));
  }
  return block;
}

/** A proof, set after its statement as a paper sets it: "Proof." run in,
 *  the prose, the steps filed under it, and an end mark; it folds away with
 *  the reader's "Fold proofs". */
function proofBlock(app, o, outline, known, refs) {
  const { el } = app;
  const rest = M.proofLeadRest(o);
  // The lead words link to the proof's object page, as a statement's title
  // links to the statement's.
  const head = el('span.proof-word-wrap',
    el('a.objlink.proof-word', { href: app.objectHref(o.id) }, 'Proof' + rest));
  if (rest !== '.') app.renderMath(head);
  const body = el('div.proof-body');
  if (o.body && o.body.trim()) {
    const prose = el('div.body-prose.proof-prose');
    body.appendChild(prose);
    defer(prose, () => app.renderBody(prose, o.body, known, refs));
  }
  for (const step of outline.steps.get(o.id) || []) {
    body.appendChild(stepBlock(app, step, outline, known, refs));
  }
  const block = app.proofDisclosure(head, body);
  // An id, so `?focus=` on a proof lands on it.
  block.setAttribute('id', 'doc-' + cssId(o.id));
  return block;
}

/**
 * The sidebar, the contents one level at a time, kept with the page: the page
 * writes out a level (an entry's entries, or the top level), and the sidebar
 * lists that level under the chain down to it, as headings, with the entry
 * the reader went to (`?focus=`) opened on its own entries.  So after a click
 * on chapter 1 the page is the chapters, 1, 2, 3, …, and the sidebar 1 with
 * 1.1, 1.2, … under it, then 2, 3, …; after a click on 1.1 the page is 1.1,
 * 1.2, …, and the sidebar 1 as a heading over 1.1, with 1.1.1, 1.1.2, … under
 * it, then 1.2, ….
 *
 * Every entry, in the list or in the chain, leads to its level that way
 * (`levelHref`): the page of its parent, scrolled to it, and opened.  When
 * that is this page the sidebar only scrolls the page there and opens it.
 * The opened entry, clicked again, folds its entries away.
 */
function levelSidebar(app, outline, pageEntry, focus, levelHref, toc) {
  const { el, clear } = app;
  const pageId = pageEntry ? pageEntry.id : null;
  const kids = (e) => (e ? e.children : outline.roots).filter((c) => !c.duplicate && !c.text);
  const listed = (e) => !!e && !e.duplicate && !e.text;
  // What the page is scrolled to: an entry below it opens there; a step or
  // a proof stands for what it is filed under.
  const fid = focus && outline.stepOf.has(focus) ? outline.stepOf.get(focus) : focus;
  const f = fid ? outline.byId.get(fid) : null;
  const below = (e) => {
    for (let p = e.parent; p; p = p.parent) if (p === pageEntry) return true;
    return pageEntry === null;
  };
  let level = pageEntry;
  let opened = null;
  if (listed(f) && f !== pageEntry && below(f)) {
    level = f.parent;
    opened = f;
  } else if (pageEntry && !kids(pageEntry).length) {
    // A page with no entries of its own is read among its siblings.
    level = pageEntry.parent;
    opened = pageEntry;
  }

  const redraw = (e, focusId) => {
    draw();
    // The link says so too, for a reload or a copy of it.
    app.setParams({ focus: focusId }, { silent: true });
    const a = toc.querySelector('a[data-id="' + e.id + '"]');
    if (a && typeof a.focus === 'function') a.focus({ preventScroll: true });
  };
  const go = (e) => (ev) => {
    if (ev.button || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return; // a new tab or window
    if (e === opened && kids(e).length) {
      // Clicked again: fold it, and leave the page where it is.
      ev.preventDefault();
      opened = null;
      redraw(e, null);
      return;
    }
    // Its level is this page: scroll there and open it, without a rebuild.
    const t = (e.parent ? e.parent.id : null) === pageId && document.getElementById('doc-' + cssId(e.id));
    if (!t) return; // the link goes to its level
    ev.preventDefault();
    t.scrollIntoView({ behavior: 'smooth', block: 'start' });
    level = e.parent;
    opened = e;
    redraw(e, e.id);
  };
  const item = (e, cls) => el('li', {
    class: cls + (kids(e).length ? ' has-kids' : '') + (e === pageEntry ? ' current' : '') +
      (e === opened ? ' open' : ''),
  }, el('a', { href: levelHref(e), 'data-id': e.id, onclick: go(e) },
    el('span.num', e.number), ' ', M.titleOf(e.object)));

  const draw = () => {
    clear(toc);
    toc.appendChild(el('h3', { class: 'toc-head' }, 'Contents'));
    const top = el('ul.toc-levels');
    let into = top;
    const chain = [];
    for (let e = level; e; e = e.parent) chain.unshift(e);
    for (const e of chain) {
      const li = into.appendChild(item(e, 'toc-up'));
      into = li.appendChild(el('ul'));
    }
    for (const e of kids(level)) {
      const li = into.appendChild(item(e, 'toc-entry'));
      if (e === opened && kids(e).length) {
        const sub = li.appendChild(el('ul'));
        for (const c of kids(e)) sub.appendChild(item(c, 'toc-entry'));
      }
    }
    app.renderMath(top); // titles carry maths
    toc.appendChild(top);
  };
  draw();
}

/** Which sidebar the site asks for: `outline` when its page says
 *  `<html data-sidebar="outline">`, else the default. */
function sidebarMode() {
  try {
    const root = document.documentElement;
    return (root && typeof root.getAttribute === 'function' && root.getAttribute('data-sidebar')) || '';
  } catch (e) {
    return '';
  }
}

/**
 * The outline sidebar: every top-level entry of the document, and under each
 * entry on the way down to this page its own entries, so the reader sees
 * where the page sits and what is next to it.  The page itself is marked;
 * an entry on this page scrolls to it, any other opens its page.
 */
function outlineSidebar(app, outline, pageEntry, levels, href, scrollTo) {
  const { el } = app;
  const pageId = pageEntry ? pageEntry.id : null;
  const path = new Set();
  for (let e = pageEntry; e; e = e.parent) path.add(e.id);
  const link = (e) => {
    // Written out on this page (whatever `depth=` says): scroll there.
    // Otherwise its own page if it has one, else the page it is read on.
    const onPage = e !== pageEntry && M.documentPageShows(outline, pageId, levels, e.id);
    const target = e.children.length ? href(e.id) : href(M.documentPageOf(outline, e.id), e.id);
    return el('a', onPage
      ? { href: href(pageId, e.id), onclick: scrollTo('doc-' + cssId(e.id)) }
      : { href: target },
    el('span.num', e.number), ' ', M.titleOf(e.object));
  };
  const list = (entries) => {
    const ul = el('ul');
    for (const e of entries) {
      if (e.duplicate || e.text) continue;
      const open = path.has(e.id) && e.children.length > 0;
      const li = el('li', {
        class: 'depth-' + e.depth + (open ? ' open' : '') + (pageEntry && e === pageEntry ? ' current' : '') +
          (path.has(e.id) ? ' on-path' : ''),
      }, link(e));
      if (open) li.appendChild(list(e.children));
      ul.appendChild(li);
    }
    return ul;
  };
  const nav = list(outline.roots);
  app.renderMath(nav); // titles carry maths
  return nav;
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
