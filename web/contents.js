// contents.js — the table of contents, a page of its own (`#/contents`).
//
// The whole document as a tree, along the same collapse order and under the
// same numbers as the document (`documentOutline` in model.js): a row per
// entry, a section or a statement, each a link into the document: to the
// page the entry heads, chapter 2 to the page of 2 with 2.1, 2.2, …, and a
// statement, which heads none, to the page it is read on, scrolled to it
// (`app.documentPageHref`).  A row with entries below it has a small
// triangle beside it that unfolds them, and folds them again; the top level
// starts unfolded no further.  What the reader unfolded is kept while the
// site is open, so coming back from the document finds the tree as it was
// left.
//
// The text at the top of a level (an abstract, the lines that open a
// section) has no row: it has no number or title, and is read where it
// stands.  An entry repeated under a second parent is listed there too,
// dimmed, leading to where it is written out, with nothing to unfold.

import * as M from './model.js';

// What is unfolded, per collapse order: kind -> Set of entry ids.
const unfolded = new Map();

export function render(root, app) {
  const { el, clear } = app;
  const m = app.model;
  const kind = pickKind(app);

  clear(root);
  const page = el('div.page.contents-page');
  root.appendChild(page);
  page.appendChild(el('h1', m.project.title || m.project.name || 'Blueprint'));
  if (!kind) {
    page.appendChild(el('p.empty', 'The contents need a kind with ', el('code', 'collapse = true'), '.'));
    return;
  }

  const outline = M.documentOutline(m, kind);
  if (!unfolded.has(kind)) unfolded.set(kind, new Set());
  const open = unfolded.get(kind);
  const listed = (e) => !e.text;
  const kids = (e) => (e.duplicate ? [] : e.children.filter((c) => listed(c)));

  const tree = el('ol.contents-tree');
  const rows = new Map(); // entry id -> its drawn <li>

  const setOpen = (e, on) => {
    if (on) open.add(e.id); else open.delete(e.id);
    const li = rows.get(e.id);
    if (!li) return;
    draw(li, e);
    // The row is drawn anew: keep the focus on its triangle.
    const toggle = li.querySelector('.contents-toggle');
    if (toggle && typeof toggle.focus === 'function') toggle.focus({ preventScroll: true });
  };

  /** The row of `e`, and its entries below it when it is unfolded. */
  const item = (e) => {
    const li = el('li', { class: 'kind-' + e.object.kind + (e.duplicate ? ' dup' : '') });
    draw(li, e);
    return li;
  };

  // A row's entries are built the first time it is unfolded, so a book with
  // thousands of statements costs only what the reader opens.
  const draw = (li, e) => {
    clear(li);
    const below = kids(e);
    const isOpen = below.length > 0 && open.has(e.id);
    li.classList.toggle('open', isOpen);
    const toggle = below.length
      ? el('button.contents-toggle', {
          type: 'button',
          'aria-expanded': isOpen ? 'true' : 'false',
          'aria-label': (isOpen ? 'Fold ' : 'Unfold ') + e.number,
          title: isOpen ? 'Fold its entries' : `Unfold its ${below.length} entr${below.length === 1 ? 'y' : 'ies'}`,
          onclick: () => setOpen(e, !open.has(e.id)),
        })
      : el('span.contents-toggle.none', { 'aria-hidden': 'true' });
    li.appendChild(el('div.contents-row', toggle, link(e)));
    rows.set(e.id, li);
    if (isOpen) {
      const sub = el('ol');
      for (const c of below) sub.appendChild(item(c));
      li.appendChild(sub);
    }
  };

  const link = (e) => {
    const o = e.object;
    const isSection = M.isSectionKind(o.kind);
    const prog = M.progressMixOf(m, kind, o.id);
    const status = M.badgeStatusOf(m, o.id);
    const a = el('a.contents-link', { href: app.documentPageHref(outline, kind, o.id) || app.objectHref(o.id) },
      el('span.num', e.number),
      el('span.contents-title',
        isSection ? null : [el('span.kindword', M.kindWord(o.kind)), ' '],
        M.titleOf(o)),
      el('span.contents-meta',
        prog && prog.total > 1 ? app.progressBar(prog)
          : status === null ? null : app.statusBadge(status)));
    app.renderMath(a); // titles carry maths too
    return a;
  };

  if (!outline.roots.some(listed)) {
    page.appendChild(el('p.empty', 'Nothing to read: no object carries prose.'));
    return;
  }
  for (const e of outline.roots) if (listed(e)) tree.appendChild(item(e));
  page.appendChild(tree);
}

function pickKind(app) {
  const m = app.model;
  const wanted = app.route.params.get('collapse');
  if (wanted && m.kinds[wanted] && m.kinds[wanted].collapse) return wanted;
  return m.defaultCollapse || m.collapseKinds[0] || null;
}
