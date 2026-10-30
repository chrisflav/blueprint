// search.js — the search page, after the Stacks project's
// (https://stacks.math.columbia.edu/search).
//
// `#/search?query=<keywords>&radius=all|statements&page=<n>&perpage=10|50|all`.
// A form, "Keywords", a Search button and the choice between all objects and
// the statements alone; under it the results, numbered and ordered as the
// document reads them (`model.fullTextSearch`), a page of them at a time, set
// as the document's tree: each result under the chapters and sections it is
// read in, which are repeated as context and fold.  A statement's line carries
// a magnifier that shows the statement itself in place of its line.  Beside
// it, the number of results per page and how to write a query.
//
// A query that is exactly an object's id goes to that object's page, as a
// Stacks tag does.  The top bar's box (app.js) asks this page, and the two
// boxes say the same while this page is on screen.

import * as M from './model.js';

/** Results per page, as the Stacks project offers them; `all` is its ∞. */
const PER_PAGE = ['10', '50', 'all'];
const DEFAULT_PER_PAGE = '10';

export function render(root, app) {
  const { el, clear } = app;
  const m = app.model;
  const params = app.route.params;
  const query = params.get('query') || '';
  const radius = M.SEARCH_RADII.includes(params.get('radius')) ? params.get('radius') : 'all';
  const perpage = PER_PAGE.includes(params.get('perpage')) ? params.get('perpage') : DEFAULT_PER_PAGE;

  // An id is a tag: straight to its page, and Back does not land here again.
  const id = query.trim();
  if (id && m.byId.has(id)) {
    app.go('object', id, null, { replace: true });
    return;
  }
  app.setQuickSearch(query);

  const kind = m.defaultCollapse || m.collapseKinds[0] || null;
  const outline = kind ? M.documentOutline(m, kind) : null;
  const hits = query.trim() ? M.fullTextSearch(m, query, { radius, kind }) : [];
  const size = perpage === 'all' ? Math.max(hits.length, 1) : Number(perpage);
  const pages = Math.max(1, Math.ceil(hits.length / size));
  const page = Math.min(pages, Math.max(1, Math.floor(Number(params.get('page'))) || 1));
  const from = (page - 1) * size;
  const shown = hits.slice(from, from + size);
  const href = (changes) => {
    const q = new URLSearchParams({ query, page: String(page), perpage, radius });
    for (const [k, v] of Object.entries(changes)) q.set(k, String(v));
    return '#/search?' + q.toString();
  };

  clear(root);
  const main = el('section.search-main');
  const aside = el('aside.search-aside');
  root.appendChild(el('div.page.wide.search-page', main, aside));

  main.appendChild(searchForm(app, query, radius, perpage));
  main.appendChild(el('hr'));

  if (query.trim()) {
    const pager = () => { if (pages > 1) main.appendChild(pagination(app, page, pages, href)); };
    pager();
    main.appendChild(el('h2.search-count', !hits.length ? 'No results'
      : [`${hits.length} ${hits.length === 1 ? 'result' : 'results'} `,
        el('span.search-showing', `(now showing results ${from + 1}–${from + shown.length})`)]));
    if (shown.length) main.appendChild(resultTree(app, outline, shown));
    pager();
    if (hits.length) aside.appendChild(perPageNav(app, perpage, href));
  }
  aside.appendChild(tips(app));
  if (!query.trim()) {
    const box = document.getElementById('search-query');
    if (box && typeof box.focus === 'function') box.focus();
  }
}

// ---------------------------------------------------------------- the form

function searchForm(app, query, radius, perpage) {
  const { el } = app;
  const input = el('input.search-query#search-query', {
    type: 'search', name: 'query', placeholder: 'keywords or an id',
    autocomplete: 'off', spellcheck: 'false',
    // The top bar's box says what this one does, as on the Stacks project.
    oninput: () => app.setQuickSearch(input.value),
  });
  input.value = query;
  const radio = (value, label) => {
    const r = el('input', { type: 'radio', name: 'radius', id: 'search-radius-' + value, value });
    r.value = value;
    r.checked = radius === value;
    // A choice made with a query in the box searches again at once.
    r.addEventListener('change', () => { if (input.value.trim()) submit(); });
    return el('div.search-radius', r, el('label', { for: 'search-radius-' + value }, label));
  };
  const radii = [radio('all', 'Search all objects'), radio('statements', 'Search only statements')];
  const submit = () => {
    const picked = radii.map((d) => d.querySelector('input')).find((r) => r.checked);
    app.go('search', null, new URLSearchParams({
      query: input.value.trim(), radius: picked ? picked.value : 'all', perpage,
    }));
  };
  return el('form.search-form#search', {
    role: 'search', action: '#/search',
    onsubmit: (ev) => { ev.preventDefault(); submit(); },
  },
  el('div.search-field', el('label', { for: 'search-query' }, 'Keywords'), input),
  el('div.search-options',
    el('button.search-submit', { type: 'submit' }, 'Search'),
    el('div.search-radii', ...radii)));
}

// ------------------------------------------------------------- pagination

/**
 * « 1 2 3 4 5 … 43 », as the Stacks project pages its results: the first
 * and the last page, the current one and its neighbours, five in a row at
 * either end, and arrows that keep their place when there is nowhere to go.
 */
export function pageNumbers(page, pages) {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1);
  if (page <= 4) return [1, 2, 3, 4, 5, null, pages];
  if (page >= pages - 3) return [1, null, pages - 4, pages - 3, pages - 2, pages - 1, pages];
  return [1, null, page - 1, page, page + 1, null, pages];
}

function pagination(app, page, pages, href) {
  const { el } = app;
  const arrow = (to, glyph, label, cls) => el('li', { class: cls + (to < 1 || to > pages ? ' inactive' : '') },
    el('a', { href: href({ page: to }), 'aria-label': label, tabindex: to < 1 || to > pages ? '-1' : null }, glyph));
  return el('nav.search-pager', { 'aria-label': 'Pages of results' },
    el('ul.search-pages',
      arrow(page - 1, '«', 'Previous page', 'search-prev'),
      ...pageNumbers(page, pages).map((n) => (n === null
        ? el('li.ellipsis', { 'aria-hidden': 'true' }, '…')
        : el('li', { class: n === page ? 'active' : null },
          el('a', { href: href({ page: n }), 'aria-current': n === page ? 'page' : null }, String(n))))),
      arrow(page + 1, '»', 'Next page', 'search-next')));
}

function perPageNav(app, perpage, href) {
  const { el } = app;
  return el('nav.search-perpage', { 'aria-label': 'Results per page' },
    el('ul.search-pages', ...PER_PAGE.map((n) => el('li', { class: n === perpage ? 'active' : null },
      el('a', { href: href({ perpage: n, page: 1 }), title: n === 'all' ? 'all results on one page' : null },
        n === 'all' ? '∞' : n)))),
    el('span.muted.small', 'results per page'));
}

function tips(app) {
  const { el } = app;
  const v = (s) => el('var', s);
  return el('div.search-tips',
    el('p', 'The search looks through ids, titles, Lean names and prose. Some suggestions:'),
    el('ul',
      el('li', 'use wildcards: ', v('ideal'), ' doesn’t match ', v('ideals'), ', but ', v('ideal*'), ' matches both;'),
      el('li', 'strings like ', v('quasi-compact'), ' should be enclosed by double quotes, otherwise you are looking for objects containing ',
        v('quasi'), ' but not ', v('compact'), ';'),
      el('li', v('OR'), ' between two words finds objects with either of them;'),
      el('li', 'an object’s id goes straight to its page.')));
}

// ------------------------------------------------------------ the results

/**
 * The results as the document's tree: each under the entries it is read in,
 * a proof or a step under what it is read with, and what the document does
 * not hold in a group of its own at the end.  `hits` is in document order, so
 * every parent is met before its children and the tree reads in that order
 * too.
 */
function resultNodes(outline, hits) {
  const roots = [];
  const nodes = new Map();
  const elsewhere = [];
  const nodeFor = (entry) => {
    if (nodes.has(entry.id)) return nodes.get(entry.id);
    const parent = entry.parent ? nodeFor(entry.parent) : null;
    const n = { object: entry.object, entry, match: false, children: [] };
    nodes.set(entry.id, n);
    (parent ? parent.children : roots).push(n);
    return n;
  };
  for (const o of hits) {
    const entry = outline && outline.byId.get(o.id);
    if (entry) { nodeFor(entry).match = true; continue; }
    const host = outline ? outline.byId.get(outline.stepOf.get(o.id)) : null;
    const n = { object: o, entry: null, match: true, children: [] };
    if (host) nodeFor(host).children.push(n);
    else elsewhere.push(n);
  }
  if (elsewhere.length) roots.push({ object: null, entry: null, match: false, children: elsewhere });
  return roots;
}

function resultTree(app, outline, hits) {
  const { el } = app;
  const tree = el('ul.search-tree', ...resultNodes(outline, hits).map((n) => treeItem(app, n)));
  const setAll = (open) => {
    for (const li of tree.querySelectorAll('li.has-children')) setOpen(li, open);
  };
  app.renderMath(tree); // titles carry maths
  return el('div.search-results#search-results',
    tree.querySelector('li.has-children')
      ? el('div.search-expand',
        el('button.linklike.all', { type: 'button', onclick: () => setAll(true) }, 'Expand all'),
        el('button.linklike.none', { type: 'button', onclick: () => setAll(false) }, 'Collapse all'))
      : null,
    tree);
}

function setOpen(li, open) {
  li.classList.toggle('expanded', open);
  li.classList.toggle('collapsed', !open);
  const thumb = li.querySelector('button.thumb');
  if (thumb) thumb.setAttribute('aria-expanded', open ? 'true' : 'false');
  for (const ul of li.children) if (ul.tagName === 'UL') ul.hidden = !open;
}

function treeItem(app, n) {
  const { el } = app;
  const o = n.object;
  const li = el('li', { class: 'expanded' + (n.match ? ' match' : '') + (o ? ' kind-' + o.kind : ' elsewhere') });
  if (n.children.length) {
    li.classList.add('has-children');
    li.appendChild(el('button.thumb', {
      type: 'button', 'aria-expanded': 'true', 'aria-label': 'fold or unfold',
      onclick: () => setOpen(li, li.classList.contains('collapsed')),
    }));
  }
  const title = el('span.preview-title', ...lineOf(app, n));
  if (n.match && o && o.body.trim() && !M.isSectionKind(o.kind)) {
    // The magnifier: the statement itself in place of its line, rendered the
    // first time it is asked for.
    const preview = el('div.search-preview');
    preview.hidden = true;
    const lens = el('button.previewable', {
      type: 'button', 'aria-expanded': 'false', title: 'show the statement', 'aria-label': 'show the statement',
      onclick: () => {
        if (!preview.firstChild) fillPreview(app, n, preview);
        const open = preview.hidden;
        preview.hidden = !open;
        title.hidden = open;
        lens.classList.toggle('previewing', open);
        lens.setAttribute('aria-expanded', open ? 'true' : 'false');
        lens.title = open ? 'show the line again' : 'show the statement';
      },
    });
    li.appendChild(lens);
    li.appendChild(title);
    li.appendChild(preview);
  } else {
    li.appendChild(title);
  }
  if (n.children.length) li.appendChild(el('ul', ...n.children.map((c) => treeItem(app, c))));
  return li;
}

const ownTitle = (o) => (typeof o.attrs.title === 'string' && o.attrs.title ? o.attrs.title : null);

/**
 * A result's line: "Section 1.2: Filters", "Lemma 1.2.3: Title", the number
 * being the link to the object's page, as the tag is on the Stacks project;
 * "Proof" or the kind of a step under what it is read with; the kind and the
 * title of what the document does not hold.
 */
function lineOf(app, n) {
  const { el } = app;
  const o = n.object;
  if (!o) return ['Not in the document'];
  const link = (text) => el('a', { href: app.objectHref(o.id), title: o.id }, text);
  const e = n.entry;
  if (e && e.text) return [link('Text')];
  if (e) {
    const t = ownTitle(o);
    return [M.kindWord(o.kind), ' ', link(e.number), t ? [': ', t] : null];
  }
  if (o.kind === 'proof') return [link('Proof'), ownTitle(o) ? ' (' + ownTitle(o) + ')' : null];
  return [link(M.kindWord(o.kind)), ': ', M.titleOf(o)];
}

/** The statement written out into `target`: "Lemma 1.2.3 (Title)." and its prose. */
function fillPreview(app, n, target) {
  const { el } = app;
  const o = n.object;
  const e = n.entry;
  const link = (text) => el('a.environment-identifier', { href: app.objectHref(o.id) }, text);
  const t = ownTitle(o);
  const word = e ? [M.kindWord(o.kind), ' ', e.number] : o.kind === 'proof' ? 'Proof' : M.kindWord(o.kind);
  const lead = e && e.text ? null : el('strong', link(word), t ? [' (', t, ')'] : null, '. ');
  const body = target.appendChild(el('div.prose.body-prose'));
  app.renderBody(body, o.body, app.knownIds());
  if (!lead) return;
  // Run in, as a paper sets it, when the prose opens with a paragraph.
  const first = body.firstChild;
  if (first && first.nodeType === 1 && first.tagName === 'P') first.insertBefore(lead, first.firstChild);
  else body.insertBefore(el('p', lead), first || null);
  app.renderMath(lead);
}
