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
// The top of the document is the top level written out, its parts and the
// text between them (an abstract, an introduction).  The table of contents of
// the whole document is a page of its own, `#/contents` (contents.js).
//
// `?focus=<id>` scrolls to an entry.  A focus the page does not show — every
// link written before the split, `#/document?focus=x` — is redirected to the
// entry's level (`documentLevelOf`), replacing the history entry so Back does
// not bounce off the redirect.
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
import { commentsPanel, DOCUMENT_THREAD } from './comments.js';

// How much is built before the first paint, and how much per frame afterwards.
const FIRST_CHUNK = 40;
const CHUNK = 120;
// Levels written out below a page when the route does not say.
const DEFAULT_LEVELS = 1;

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
  // The page that writes out the level an entry is on (`documentLevelOf`),
  // scrolled to it: its parent's page, or the top of the document.  Every
  // link to an entry leads there: its heading, a reference to it, the
  // contents.
  const levelPage = (id) => M.documentLevelOf(outline, id);
  const levelHref = (id) => href(levelPage(id), id);
  // The page an entry heads (`documentPageOf`), where the contents lead:
  // chapter 2 to the page of 2 with 2.1, 2.2, …; something with nothing under
  // it heads none and is read among its siblings, scrolled to.
  const pageHref = (id) => {
    const page = M.documentPageOf(outline, id);
    return href(page, page === id ? null : id);
  };
  const shown = levels;

  // An entry this page does not write out is read somewhere else: go to its
  // level.
  if (focus && !M.documentPageShows(outline, pageId, shown, focus)) {
    const home = M.documentLevelOf(outline, focus);
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
  const entries = M.documentPageEntries(outline, pageId, shown);

  // Cross references in the prose read "Lemma 2.3" in this order's numbers,
  // and stay in the paper: they lead to the level of the entry, as its heading
  // does.  A reader who wants the object page has the "object" link beside the
  // entry's heading for that.  Objects the document does not number keep their
  // slug and their object-page link.
  const refs = (slug) => {
    const ref = M.referenceOf(outline, slug);
    if (!ref) return null;
    return { ...ref, href: levelHref(slug) };
  };
  // Depths on this page count from the first level below the page's own
  // entry, which is set as the page's title.
  const base = pageEntry ? pageEntry.depth + 1 : 0;

  const page = el('div.page.wide');
  const body = el('div');
  const flow = el('div.doc-flow');
  const toc = el('nav.toc');
  page.appendChild(el('div.doc-layout', toc, body));
  root.appendChild(page);

  // A heading stays on this page: a click brings it to the top, wherever it
  // is, a repeated entry's heading too.  A reference whose level is this page
  // jumps to the entry instead of rebuilding the page around the same place.
  // A jump rather than a smooth scroll, and pinned: on the way past, bodies
  // render and move the target, and a smooth scroll in Chromium then ends
  // wherever the target used to be.
  flow.addEventListener('click', (ev) => {
    if (ev.button || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return; // a new tab or window
    const a = ev.target && ev.target.closest ? ev.target.closest('a.ref[data-ref], a.doc-title[data-here]') : null;
    if (!a) return;
    if (a.classList.contains('doc-title')) {
      const here = a.closest('section.doc-entry');
      if (!here) return;
      ev.preventDefault();
      here.scrollIntoView({ block: 'start' });
      pin(here);
      flash(here);
      // The link says so too, for a reload or a copy of it.
      if (!here.classList.contains('dup')) app.setParams({ focus: a.getAttribute('data-here') }, { silent: true });
      return;
    }
    const id = a.getAttribute('data-ref');
    if (levelPage(id) !== pageId) return;
    const target = document.getElementById('doc-' + cssId(id));
    if (!target) return; // not built yet: let the route build the page to it
    ev.preventDefault();
    target.scrollIntoView({ block: 'start' });
    pin(target);
    flash(target);
  });

  // ----------------------------------------------------------------- header
  const crumbs = breadcrumbs(app, outline, pageEntry, href);
  if (crumbs) body.appendChild(crumbs);
  if (!pageEntry) body.appendChild(el('h1', m.project.title || m.project.name || 'Blueprint'));
  const pagerTop = pager(app, outline, pageEntry, href);
  if (pagerTop) body.appendChild(pagerTop);
  body.appendChild(flow);

  // The comments of the page's own entry, the thread its object page shows
  // too; the top of the document has a thread of its own.  Under everything
  // else, once the page is built.
  const comments = () => commentsPanel(app, pageEntry ? pageEntry.object.id : DOCUMENT_THREAD);

  if (!entries.length) {
    body.appendChild(el('p.empty', 'Nothing to read: no object carries prose.'));
    body.appendChild(comments());
    return;
  }

  // ------------------------------------------------------------------ body
  //
  // The numbers come with the outline; building the sections is chunked and
  // the prose inside them is deferred until it is scrolled to.
  let previous = null; // the entry built last, for a proof right after its statement
  const build = (entry) => {
    const before = previous;
    previous = entry;
    const o = entry.object;
    // A piece of text belonging to no statement (the lines that open a
    // section, a paragraph between two lemmas) is read where it stands: its
    // prose and nothing else, no heading, no number, not in the contents.
    if (entry.text) {
      if (entry.duplicate) return; // said once, under its first parent
      // A bibliography entry: its label in the margin, "[Del74]", and the
      // entry in the order and punctuation of BibTeX's `alpha` beside it.
      if (entry.reference) {
        const item = el('section', { class: 'doc-entry is-text is-reference kind-' + o.kind, id: 'doc-' + cssId(o.id) });
        item.appendChild(el('span.bib-label', '[' + (entry.label || o.id) + ']'));
        const prose = item.appendChild(el('div.prose.body-prose.bib-text'));
        defer(prose, () => app.renderBody(prose, M.referenceMarkdown(o), known, refs));
        flow.appendChild(item);
        return;
      }
      const text = el('section', { class: 'doc-entry is-text kind-' + o.kind, id: 'doc-' + cssId(o.id) });
      const prose = text.appendChild(el('div.prose.body-prose'));
      defer(prose, () => app.renderBody(prose, o.body, known, refs));
      for (const step of outline.steps.get(o.id) || []) text.appendChild(stepBlock(app, step, outline, known, refs));
      flow.appendChild(text);
      return;
    }
    // A proof read in its section (`M.proofPlacement`) is set as any proof is:
    // "Proof." right after its statement, and where it is read away from it,
    // "Proof of Theorem 2.1.".  No heading, no number, not in the contents.
    if (entry.proof) {
      if (entry.duplicate) return; // read once, where it is placed
      const of = M.attachedTo(o);
      const right = before && before.object.id === of;
      flow.appendChild(proofBlock(app, o, outline, known, refs,
        right ? M.proofLeadRest(o) : M.proofLeadAway(m, outline, o)));
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
    // way a paper sets one: "Definition 1.14 (Title)." with the kind as the
    // lead word, and the body indented under it.  The heading, kind, number
    // and title, is one link, to this very place on this page: clicked, it
    // stays here, scrolled to the top (the handler above), whatever entry it
    // is; the page's own heading too.  "Show details 1.2 →" beside it
    // leads on.
    const isSection = M.isSectionKind(o.kind);
    const head = el('div.head',
      el('h' + hLevel, el('a.doc-title', { href: href(pageId, o.id), 'data-here': o.id },
        isSection ? null : [el('span.kindword', M.kindWord(o.kind)), ' '],
        numbered(el, num, o.kind),
        el('span.doc-title-text', M.titleOf(o)))),
      // An entry whose children are on a page of their own leads on there,
      // beside its title.
      leadsOn ? el('a.doc-open', { href: href(o.id) }, 'Show details ', num == null ? M.titleOf(o) : num, ' →') : null,
      // The heading leads into the paper; the object page is a step aside.
      // Resting on the link shows the object's Lean names, when it has any,
      // in a card (preview.js), so the heading keeps one word.
      el('a.doc-object', {
        href: app.objectHref(o.id),
        title: 'the object page of ' + (num == null ? M.titleOf(o) : num),
        'data-lean': M.leanNamesOf(o).length ? o.id : null,
      }, 'object'),
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
        ? [numbered(null, first.parent.number, first.parent.object.kind), M.titleOf(first.parent.object)]
        : ['the top level'];
      const back = el('p.muted.small', 'Written out under ',
        el('a', { href: levelHref(o.id) }, ...where), '.');
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

  let tocShown = false;
  const showToc = () => {
    if (tocShown) return;
    // The contents one level at a time, in every style; the Outline style
    // sets it its own way.
    if (sidebarMode() === 'outline') toc.classList.add('toc-outline');
    tocShown = true;
    levelSidebar(app, outline, pageEntry, focus, pageHref, toc);
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
    body.appendChild(comments());
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

/** Mark the entry a link led to, briefly. */
function flash(target) {
  target.classList.remove('flash');
  // Restart the animation when the same entry is picked twice in a row.
  void target.offsetWidth;
  target.classList.add('flash');
}

/** `?collapse=…&depth=…&focus=…` for a document route; the depth only when
 *  it is not the default. */
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
      el('a', { href: href(e.id) }, numbered(null, e.number, e.object.kind), M.titleOf(e.object)),
    ]),
    el('span.sep', '›'),
    el('span.here', numbered(null, pageEntry.number, pageEntry.object.kind), M.titleOf(pageEntry.object)));
  app.renderMath(nav);
  return nav;
}

/** Previous sibling, up, next sibling — the page's neighbours at its level. */
function pager(app, outline, pageEntry, href) {
  const { el } = app;
  if (!pageEntry) return null;
  // Its neighbours in its own layer, as its number counts them: a heading's
  // among the headings, a statement's among the statements.  Section 4.1 is
  // the first of chapter 4's sections, and has no previous one, whatever
  // statements stand before it in the chapter.
  const heading = M.isSectionKind(pageEntry.object.kind);
  const siblings = (pageEntry.parent ? pageEntry.parent.children : outline.roots)
    .filter((e) => !e.duplicate && !e.text && !e.proof && M.isSectionKind(e.object.kind) === heading);
  const i = siblings.indexOf(pageEntry);
  const prev = i > 0 ? siblings[i - 1] : null;
  const next = i >= 0 && i + 1 < siblings.length ? siblings[i + 1] : null;
  const label = (e) => [numbered(el, e.number, e.object.kind), M.titleOf(e.object)];
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
function proofBlock(app, o, outline, known, refs, rest = M.proofLeadRest(o)) {
  const { el } = app;
  // The lead words are the disclosure's summary: a click on them folds or
  // unfolds the proof, rather than leaving the page.
  const head = el('span.proof-word-wrap', el('span.proof-word', 'Proof' + rest));
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
 * The Outline style (`toc-outline`) has the contents unfolded down to the
 * level instead: every level along the chain listed whole, so on the page of
 * 2.1 the sidebar is 1, 2, 3, … with 2 unfolded on 2.1, 2.2, …, and 2.1 on
 * 2.1.1, 2.1.2, ….  There a click on the page's own entry folds its entries
 * away, and another unfolds them again.
 *
 * Either way it lists only the headings, chapters, sections and subsections,
 * as the contents page does; a statement is read on the page its heading
 * leads to, and a focus on one opens that heading.
 *
 * Every entry, in the list or in the chain, leads to the page it heads, as
 * the contents do (`pageHref`): chapter 2 to the page of 2 with 2.1, 2.2, ….
 * A heading with nothing under it heads no page and leads to the page it is
 * read on, scrolled to it and opened; when that is this page the sidebar only
 * scrolls the page there.  The page's own entry scrolls to the top.
 */
function levelSidebar(app, outline, pageEntry, focus, pageHref, toc) {
  const { el, clear } = app;
  const pageId = pageEntry ? pageEntry.id : null;
  // The contents unfolded, every level whole (the Outline style), and whether
  // the reader has folded the page's own entries away there.
  const whole = toc.classList.contains('toc-outline');
  let shut = false;
  // Only the headings have rows, as on the contents page (`M.isContentsEntry`):
  // the statements are read on the pages they lead to.
  const listed = (e) => M.isContentsEntry(e) && !e.duplicate;
  const kids = (e) => (e ? e.children : outline.roots).filter(listed);
  // What the page is scrolled to: the heading it is under opens there; a
  // step or a proof stands for what it is filed under.
  const fid = focus && outline.stepOf.has(focus) ? outline.stepOf.get(focus) : focus;
  let f = fid ? outline.byId.get(fid) : null;
  while (f && !listed(f)) f = f.parent;
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
    // The page it heads, or is read on, is this page: scroll there, without a
    // rebuild.  Anywhere else the link goes there.
    if (M.documentPageOf(outline, e.id) !== pageId) return;
    const t = document.getElementById('doc-' + cssId(e.id));
    if (!t) return;
    ev.preventDefault();
    t.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (e === pageEntry) {
      if (whole && kids(e).length) {
        shut = !shut;
        draw();
        const a = toc.querySelector('a[data-id="' + e.id + '"]');
        if (a && typeof a.focus === 'function') a.focus({ preventScroll: true });
      }
      return;
    }
    level = e.parent;
    opened = e;
    redraw(e, e.id);
  };
  const item = (e, cls) => el('li', {
    class: cls + (kids(e).length ? ' has-kids' : '') + (e === pageEntry ? ' current' : '') +
      (e === opened ? ' open' : '') + (e === pageEntry && shut ? ' shut' : ''),
  }, el('a', { href: pageHref(e.id), 'data-id': e.id, onclick: go(e) },
    numbered(el, e.number, e.object.kind), M.titleOf(e.object)));

  // The contents unfolded down to the level: the chain, `toc-up`, unfolded
  // where it stands among its siblings, and the opened entry; the page's own
  // entry stays folded while the reader keeps it so.
  const drawWhole = () => {
    const chain = new Set();
    for (let e = level; e; e = e.parent) chain.add(e);
    const list = (parent, ul) => {
      for (const e of kids(parent)) {
        const li = ul.appendChild(item(e, chain.has(e) ? 'toc-up' : 'toc-entry'));
        const unfolded = (chain.has(e) || e === opened) && !(e === pageEntry && shut);
        if (unfolded && kids(e).length) list(e, li.appendChild(el('ul')));
      }
      return ul;
    };
    return list(null, el('ul.toc-levels'));
  };

  const draw = () => {
    clear(toc);
    toc.appendChild(el('h3', { class: 'toc-head' }, 'Contents'));
    if (whole) {
      const top = drawWhole();
      app.renderMath(top); // titles carry maths
      toc.appendChild(top);
      return;
    }
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

/**
 * An entry's number and the space after it, before its title; nothing for an
 * entry its `serial` leaves unnumbered.  In a `span.num` when `el` is given.
 * A part's number is read with its word, "Part I" (`M.headingWord`).
 */
function numbered(el, number, kind) {
  if (number == null) return null;
  const word = kind ? M.headingWord(kind) : null;
  const text = word ? word + ' ' + number : number;
  return [el ? el('span.num', text) : text, ' '];
}

function cssId(id) {
  return String(id).replace(/[^A-Za-z0-9_-]/g, '_');
}
