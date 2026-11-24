// preview.js — a card with an object's statement, shown while the pointer
// rests on a link to it.
//
// Every link to an object (`a.objlink`: a `[slug]` reference in prose, a title
// in a listing) previews what it leads to: the reference ("Lemma 2.3") and
// title, the status, the prose with its maths, a link on to the object page.
// The document's "object" link beside a heading, when the object has Lean
// names (`data-lean`), opens a card of the same kind with its Lean
// declarations instead; a click or a tap on it still goes to the object page.  The pointer can move into the card, to scroll it, open a
// folded proof or follow a link, and a link in the card opens a card of its
// own beside it, so a chain of references can be read without leaving the
// page.  Moving off the link and its cards closes them after a moment; so do
// Escape, a click, a scroll and a change of route.
//
// A Stacks link (`stacksLinks` in app.js) shows a card of the same kind, with
// the statement of its Stacks project tag, on a click with Ctrl held, not on
// hover.  Asked for, it stays when the pointer moves off, until Escape, a
// click elsewhere, a scroll or a change of route.
//
// It is one set of listeners on the document, so it covers links drawn at any
// time by any page without the pages knowing about it.  A touch has no hover:
// a tap on a link follows it, as before.  A link reached with the keyboard
// shows its card too.

import * as M from './model.js';

const SHOW_MS = 300; // resting on a link this long opens its card
const HIDE_MS = 250; // off the link and its cards this long closes them
const GAP = 6; // between a link and its card, px
const MARGIN = 8; // between a card and the edge of the window, px

let app = null;
// The open cards, outermost first: `stack[i + 1]` was opened from a link in
// `stack[i].card`.  Each entry is {anchor, id, build, card, keyboard, sticky},
// `anchor` being the link it was opened from, `sticky` saying a click asked
// for it (`showStacksCard`).
const stack = [];
let pending = null; // {anchor, id, build, level, keyboard}: waiting out SHOW_MS
let showTimer = null;
let hideTimer = null;
let untitled = null; // {anchor, title}: the tooltip taken off the hovered link
let pointer = null; // {x, y}: the last pointer position, to pick a wrapped link's line

/**
 * The id of the object a link previews, or null.  Only links to an object
 * that exists; not a broken reference, not a title in a heading (the document
 * writes the object out right under it).
 */
export function previewTarget(model, a) {
  if (!model || !a || a.tagName !== 'A' || !a.classList) return null;
  if (!a.classList.contains('objlink') || a.classList.contains('broken')) return null;
  for (let p = a.parentNode; p && p.nodeType === 1; p = p.parentNode) {
    // A citation in a statement's source is one, in its heading too.
    if (p.classList && p.classList.contains('heading-source')) break;
    if (/^H[1-6]$/.test(p.tagName)) return null;
    if (p.classList && p.classList.contains('preview')) break;
  }
  let id = a.getAttribute('data-ref');
  if (!id) {
    const m = String(a.getAttribute('href') || '').match(/^#\/object\/([^?]*)/);
    if (!m) return null;
    try {
      id = decodeURIComponent(m[1]);
    } catch (e) {
      return null;
    }
  }
  return model.byId.has(id) ? id : null;
}

/** The card for object `id`, not yet placed anywhere. */
export function previewCard(ctx, id) {
  const { el } = ctx;
  const m = ctx.model;
  const o = m.byId.get(id);
  const ref = ctx.referenceFor(id);
  const of = o.kind === 'proof' ? M.attachedTo(o) : null;
  const own = o.attrs && typeof o.attrs.title === 'string' && o.attrs.title ? o.attrs.title : null;
  const lead = of ? 'Proof' : ref && !ref.unnumbered ? M.referenceText(ref) : M.kindWord(o.kind);
  const title = of ? 'of ' + M.titleOf(m.byId.get(of)) + (own ? ' (' + own + ')' : '') : own;
  const status = M.badgeStatusOf(m, id);
  const head = el('div.preview-head',
    el('span.preview-lead', lead),
    title ? el('span.preview-title', title) : null,
    status === null ? null : ctx.statusBadge(status));

  // An edge says what it joins; a proof's title has said it already.
  const ends = !of && o.boundary.length
    ? el('div.preview-ends', ...o.boundary.map((b, i) => [
      i ? el('span.muted', ' · ') : null,
      el('span.role', b.role), ' ', ctx.objLink(m, b.id)]))
    : null;

  const body = el('div.preview-body.body-prose');
  ctx.renderBody(body, M.displayBody(o), ctx.knownIds(), undefined, { untrusted: ctx.untrustedOf(o) });
  // The statement is what a preview is for: a proof in it starts folded.
  for (const d of body.querySelectorAll('details.proof')) d.open = false;

  // The Lean names are left to the document's "object" link: a statement
  // with many of them would leave its prose no room.
  const foot = el('div.preview-foot',
    el('code.preview-id', o.id),
    el('a.preview-open', { href: ctx.objectHref(id) }, 'Open →'));

  const card = el('div.preview', { role: 'dialog', 'aria-label': `${lead}${title ? ' ' + title : ''}`, 'data-preview': id },
    head, ends, body, foot);
  ctx.renderMath(head);
  if (ends) ctx.renderMath(ends); // titles carry maths
  return card;
}

/**
 * The card of an object's Lean declarations: each name, linked to its
 * declaration on the object page, where its signature is, with its kind and
 * status from the Lean facts and a link to its documentation when the
 * snapshot says where that is (`project.docgen`).
 */
export function leanCard(ctx, id) {
  const { el } = ctx;
  const m = ctx.model;
  const o = m.byId.get(id);
  const ref = ctx.referenceFor(id);
  const facts = M.leanFactsFor(m, o);
  const docgen = m.project && m.project.docgen;
  const status = M.badgeStatusOf(m, id);
  const head = el('div.preview-head',
    el('span.preview-lead', facts.length === 1 ? 'Lean declaration' : `Lean declarations (${facts.length})`),
    el('span.preview-title', 'of ' + (ref ? M.referenceText(ref) : M.titleOf(o))),
    status === null ? null : ctx.statusBadge(status));
  const rows = facts.map(({ name, fact }) => el('li',
    el('a.lean-name', { href: ctx.objectHref(id, { lean: name }) }, el('code', name)),
    fact && fact.kind ? el('span.chip', fact.kind) : null,
    // Without any facts there is nothing to say of one name in particular.
    !m.facts || !ctx.showProgress ? null
      : !fact ? el('span.badge.status-absent', el('span.dot'), 'no facts')
        : fact.exists === false ? el('span.badge.status-missing', el('span.dot'), 'does not exist')
          : fact.status ? ctx.statusBadge(fact.status) : null,
    docgen && fact && fact.exists !== false && M.docgenUrl(docgen, name, fact.module)
      ? el('a.lean-docs', { href: M.docgenUrl(docgen, name, fact.module), target: '_blank', rel: 'noopener' }, 'docs \u2197')
      : null));
  const card = el('div.preview.lean-card', {
    role: 'dialog', 'aria-label': `Lean declarations of ${M.titleOf(o)}`, 'data-preview': id,
  },
  head,
  el('div.preview-body', el('ul.lean-names', ...rows)),
  el('div.preview-foot',
    el('code.preview-id', o.id),
    el('a.preview-open', { href: ctx.objectHref(id, { lean: '' }) }, 'Signatures →')));
  ctx.renderMath(head);
  return card;
}

// ---------------------------------------------------------------------------
// Stacks project statements
// ---------------------------------------------------------------------------

const STACKS = 'https://stacks.math.columbia.edu';

// The statements read out of a model's `stacks` (`stacksStatement`), per model:
// tag to the statement, null for a tag it does not have.
const stacksRead = new WeakMap();

/**
 * The statement of Stacks project tag `tag` that the snapshot carries, read:
 * {tag, kind, lead, name, body, item}, null when it has none.  `lead` is what
 * the Stacks project calls it, "Lemma 10.20.1", and `name` its name,
 * "Nakayama's lemma", or null; `body` is the rest of the article, its heading
 * taken out.  The tag of an item of a statement's list (`in`, the statement's
 * tag) stands for the whole statement: `item` is then the tag, the item being
 * the element of the article with that id, and `lead` says its number,
 * "Lemma 10.20.1 (1)"; for a statement it is null.
 * The article is what the Stacks project's API hands out, which `blueprint
 * stacks` fetched; it is parsed in an inert document, where nothing loads and
 * no script runs, and `stacksCard` copies only harmless markup out of it.
 */
export function stacksStatement(m, tag) {
  if (!m || !m.stacks || typeof DOMParser !== 'function') return null;
  let read = stacksRead.get(m);
  if (!read) stacksRead.set(m, (read = new Map()));
  if (read.has(tag)) return read.get(tag);
  const e = Object.prototype.hasOwnProperty.call(m.stacks, tag) ? m.stacks[tag] : null;
  let s = null;
  if (e && typeof e.html === 'string') {
    const doc = new DOMParser().parseFromString(e.html, 'text/html');
    const body = doc.body.querySelector('article') || doc.body;
    const id = body.querySelector('a.environment-identifier');
    let lead = '';
    let name = null;
    if (id) {
      const named = id.querySelector('.named');
      if (named) {
        name = named.textContent.replace(/\s+/g, ' ').trim().replace(/^\((.*)\)$/, '$1') || null;
        named.remove();
      }
      lead = id.textContent.replace(/\s+/g, ' ').replace(/\s*\.\s*$/, '').trim();
      id.remove();
    }
    const kind = typeof e.kind === 'string' ? e.kind : '';
    if (!lead) lead = (kind ? kind[0].toUpperCase() + kind.slice(1) : 'Statement') + ' ' + tag;
    const item = typeof e.in === 'string' && e.in
      ? [...body.querySelectorAll('[id]')].find((n) => n.getAttribute('id') === tag) : null;
    if (item && item.parentNode) {
      const n = [...item.parentNode.children].filter((c) => c.tagName === 'LI').indexOf(item) + 1;
      if (n > 0) lead += ` (${n})`;
    }
    s = { tag, kind, lead, name, body, item: item ? tag : null };
  }
  read.set(tag, s);
  return s;
}

// What a Stacks statement keeps of its markup in a card: paragraphs, lists,
// emphasis and the like.  Any other element keeps its text, as in a comment.
const STACKS_TAGS = new Set(['P', 'BR', 'EM', 'STRONG', 'I', 'B', 'U', 'SPAN', 'DIV', 'OL', 'UL',
  'LI', 'A', 'SUB', 'SUP', 'CODE', 'BLOCKQUOTE', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD']);

/** Where a link of a Stacks statement goes: on the Stacks project, or null. */
function stacksHref(h) {
  const v = String(h || '').trim();
  if (/^\/(?!\/)/.test(v)) return STACKS + v; // "/tag/016E", "/bibliography/LM-B"
  if (/^https?:\/\//i.test(v)) return v;
  return null;
}

/**
 * The prose of a Stacks statement for its card: `src`'s text, in new elements
 * of `STACKS_TAGS` alone, none of its attributes but a link's address, made
 * absolute, which opens the Stacks project in a tab of its own.  A displayed
 * formula is set as the Stacks project sets it, `\[ … \]` in its own block.
 * The element whose id is `item`, an item the link names, is marked.
 */
function stacksBody(src, item) {
  const out = document.createElement('div');
  out.className = 'preview-body body-prose stacks-body';
  const copy = (from, to) => {
    for (const c of from.childNodes) {
      if (c.nodeType === 3) {
        to.appendChild(document.createTextNode(c.nodeValue));
        continue;
      }
      if (c.nodeType !== 1 || c.tagName === 'SCRIPT' || c.tagName === 'STYLE') continue;
      if (!STACKS_TAGS.has(c.tagName)) {
        copy(c, to);
        continue;
      }
      const n = document.createElement(c.tagName.toLowerCase());
      if (c.tagName === 'A') {
        const href = stacksHref(c.getAttribute('href'));
        if (href) {
          n.setAttribute('href', href);
          n.setAttribute('target', '_blank');
          n.setAttribute('rel', 'noopener');
        }
      }
      if (c.tagName === 'DIV' && c.classList.contains('equation')) n.className = 'stacks-equation';
      if (item && c.getAttribute('id') === item) n.className = 'stacks-item';
      copy(c, n);
      to.appendChild(n);
    }
  };
  copy(src, out);
  return out;
}

/**
 * The card of Stacks project tag `tag`: what the Stacks project calls it and
 * its name, its statement with the maths set, and a link to its page there.
 * A tag whose statement the snapshot lacks (not fetched by `blueprint
 * stacks`) gets the link alone.
 */
export function stacksCard(ctx, tag) {
  const { el } = ctx;
  const s = stacksStatement(ctx.model, tag);
  const lead = s ? s.lead : 'Tag ' + tag;
  const head = el('div.preview-head',
    el('span.preview-lead', lead),
    s && s.name ? el('span.preview-title', s.name) : null,
    el('span.chip.stacks-chip', 'Stacks project'));
  const body = s ? stacksBody(s.body, s.item)
    : el('div.preview-body', el('p.muted', 'The statement of this tag was not fetched for this blueprint.'));
  const card = el('div.preview.stacks-card', {
    role: 'dialog', 'aria-label': `${lead}${s && s.name ? ' (' + s.name + ')' : ''}, Stacks project`,
    'data-preview': 'stacks:' + tag,
  },
  head,
  body,
  el('div.preview-foot',
    el('code.preview-id', 'Tag ' + tag),
    el('a.preview-open', { href: `${STACKS}/tag/${tag}`, target: '_blank', rel: 'noopener' }, 'On the Stacks project \u2197')));
  ctx.renderMath(head);
  ctx.renderMath(body);
  // A commutative diagram, `\xymatrix{…}`, is beyond KaTeX: rather than its
  // source in red, a word that the Stacks project draws it.
  for (const e of body.querySelectorAll('.katex-error')) {
    if (!/\\xymatrix/.test(e.textContent)) continue;
    e.replaceWith(el('a.stacks-diagram', { href: `${STACKS}/tag/${tag}`, target: '_blank', rel: 'noopener' },
      'A diagram, drawn on the Stacks project \u2197'));
  }
  // An item further down than the card shows is scrolled to, once the card
  // is placed and has its height.
  const mark = body.querySelector('.stacks-item');
  if (mark && typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => {
      if (!mark.isConnected) return;
      const b = body.getBoundingClientRect();
      const r = mark.getBoundingClientRect();
      if (r.bottom > b.bottom) body.scrollTop += r.top - b.top - 8;
    });
  }
  return card;
}

/**
 * Show the card of Stacks project tag `tag` against `anchor`, a Stacks link
 * clicked with Ctrl held: over the page, or beside the card the link is in.
 * It stays when the pointer moves off (`hover`).
 */
export function showStacksCard(anchor, tag) {
  if (!app || !anchor) return;
  cancelPending();
  clearTimeout(hideTimer);
  hideTimer = null;
  takeTitle(anchor);
  open({ anchor, id: 'stacks:' + tag, build: () => stacksCard(app, tag), level: levelOf(anchor) + 1,
    keyboard: false, sticky: true });
}

// ---------------------------------------------------------------------------
// the controller
// ---------------------------------------------------------------------------

/** Install the listeners.  `ctx` is the `app` object. */
export function setupPreviews(ctx) {
  app = ctx;
  // One set of listeners per page, however many copies of the app run in it:
  // a script importing app.js from another context (the browser sweep does)
  // gets a module of its own, whose cards would double every one of these.
  // The mark is on the DOM, the one thing both contexts share.
  const root = document.documentElement;
  if (root.hasAttribute('data-previews')) return;
  root.setAttribute('data-previews', '');
  const on = (type, fn, capture) => document.addEventListener(type, fn, capture);
  on('pointerover', (ev) => {
    if (ev.pointerType === 'touch') return;
    pointer = { x: ev.clientX, y: ev.clientY };
    hover(ev.target);
  });
  on('pointerout', (ev) => {
    // Out of the window: nothing is hovered any more.
    if (ev.pointerType !== 'touch' && !ev.relatedTarget) hover(null);
  });
  on('focusin', (ev) => focus(ev.target));
  on('keydown', (ev) => { if (ev.key === 'Escape' && stack.length) closePreviews(); });
  // A press anywhere but inside a card is the reader moving on.  A link in a
  // card closes the cards once it has been followed: closed on the press, the
  // card would be gone from under the pointer before the click, which would
  // land on whatever the card was covering.
  on('pointerdown', (ev) => { if (levelOf(ev.target) < 0) closePreviews(); }, true);
  on('click', (ev) => {
    const t = triggerOf(ev.target);
    // A Stacks link is not followed: clicked with Ctrl held, it shows a card.
    if (t && levelOf(t) >= 0 && !t.hasAttribute('data-stacks')) {
      setTimeout(closePreviews, 0);
    }
  });
  // A card is placed against its link; once the page moves under it, it is
  // somewhere else.  A card scrolling its own prose is fine.
  on('scroll', (ev) => { if (stack.length && levelOf(ev.target) < 0) closePreviews(); }, true);
  window.addEventListener('resize', () => closePreviews());
}

/** Close every card and forget a card about to open. */
export function closePreviews() {
  clearTimeout(showTimer);
  clearTimeout(hideTimer);
  showTimer = hideTimer = null;
  pending = null;
  closeFrom(0);
}

/** The open cards, outermost first, for the tests. */
export function openPreviews() {
  return stack.map((e) => ({ id: e.id, card: e.card, anchor: e.anchor }));
}

/**
 * The pointer is now over `target` (null: off the window).  Exported so the
 * tests, which have no pointer, can drive it.
 */
export function hover(target) {
  const a = triggerOf(target);
  if (!untitled || untitled.anchor !== a) restoreTitle();
  const level = levelOf(target);
  const opened = a ? stack.findIndex((e) => e.anchor === a) : -1;
  // Keep the cards up to the one the pointer is in, the one opened from the
  // link it is on and the last one a click asked for; the rest go once it has
  // been elsewhere a moment.
  const sticky = lastSticky();
  const keep = Math.max(level, opened, sticky);
  clearTimeout(hideTimer);
  hideTimer = keep < stack.length - 1 ? setTimeout(() => closeFrom(keep + 1), HIDE_MS) : null;

  const c = a && opened < 0 ? cardOf(a) : null;
  if (!c) {
    if (!pending || !pending.keyboard) cancelPending();
    return;
  }
  // Nor does a link the pointer passes over put a card in place of one a
  // click asked for.
  if (level + 1 <= sticky) {
    if (!pending || !pending.keyboard) cancelPending();
    return;
  }
  takeTitle(a);
  if (pending && pending.anchor === a) return;
  schedule({ anchor: a, ...c, level: level + 1, keyboard: false });
}

/** The index of the last card a click asked for (`showStacksCard`), -1 for none. */
function lastSticky() {
  for (let i = stack.length - 1; i >= 0; i -= 1) if (stack[i].sticky) return i;
  return -1;
}

function focus(target) {
  const c = cardOf(target);
  let visible = false;
  try {
    visible = !!(target && target.matches && target.matches(':focus-visible'));
  } catch (e) { /* a browser without :focus-visible: the keyboard gets no cards */ }
  if (c && visible) {
    schedule({ anchor: target, ...c, level: levelOf(target) + 1, keyboard: true });
    return;
  }
  // The focus moved on from a card the keyboard opened.
  if (levelOf(target) < 0 && stack.some((e) => e.keyboard)) closePreviews();
}

function schedule(p) {
  cancelPending();
  pending = p;
  showTimer = setTimeout(() => {
    showTimer = null;
    pending = null;
    open(p);
  }, SHOW_MS);
}

function cancelPending() {
  clearTimeout(showTimer);
  showTimer = null;
  pending = null;
}

function open({ anchor, id, build, level, keyboard, sticky = false }) {
  if (!app || !app.model || (!sticky && !app.model.byId.has(id))) return;
  if (anchor.isConnected === false) return; // the page was redrawn meanwhile
  if (level > stack.length) return; // the card it was in has gone
  closeFrom(level);
  let card;
  try {
    card = build();
  } catch (e) {
    // A preview is a convenience: the link still works without one.
    if (typeof console !== 'undefined' && console.error) console.error('preview failed:', e);
    return;
  }
  card.style.zIndex = String(60 + level);
  (document.body || document.documentElement).appendChild(card);
  place(card, anchor);
  stack.push({ anchor, id, build, card, keyboard, sticky });
}

function closeFrom(level) {
  while (stack.length > level) {
    const { card } = stack.pop();
    if (card.parentNode) card.parentNode.removeChild(card);
  }
}

/** Under the link, or above it when there is more room there; inside the window. */
function place(card, anchor) {
  const vw = window.innerWidth || document.documentElement.clientWidth || 1200;
  const vh = window.innerHeight || document.documentElement.clientHeight || 800;
  const r = lineOf(anchor);
  const w = card.offsetWidth || 0;
  const h = card.offsetHeight || 0;
  const below = vh - r.bottom - GAP - MARGIN;
  const above = r.top - GAP - MARGIN;
  const down = h <= below || below >= above;
  // Never over the link: on the side it opens, the card is at most as tall as
  // the room there, and its prose scrolls.
  const room = Math.max(0, down ? below : above);
  if (h > room) card.style.maxHeight = Math.round(room) + 'px';
  const top = down ? r.bottom + GAP : r.top - GAP - Math.min(h, room);
  const left = Math.max(MARGIN, Math.min(r.left, vw - w - MARGIN));
  card.style.left = Math.round(left) + 'px';
  card.style.top = Math.round(top) + 'px';
}

/** The box of the line of a wrapped link the pointer is on. */
function lineOf(anchor) {
  const rects = typeof anchor.getClientRects === 'function' ? [...anchor.getClientRects()] : [];
  if (rects.length > 1 && pointer) {
    const hit = rects.find((r) => pointer.y >= r.top - 1 && pointer.y <= r.bottom + 1);
    if (hit) return hit;
  }
  return anchor.getBoundingClientRect();
}

/** Which card `node` is in: its index in the stack, -1 for the page. */
function levelOf(node) {
  if (!node) return -1;
  for (let i = stack.length - 1; i >= 0; i -= 1) if (stack[i].card.contains(node)) return i;
  return -1;
}

/** The link `node` is in, or null. */
function triggerOf(node) {
  for (let p = node; p && p.nodeType; p = p.parentNode) {
    if (p.nodeType === 1 && p.tagName === 'A') return p;
  }
  return null;
}

/**
 * The object whose Lean declarations link `a` shows, or null: the document's
 * "object" link beside the heading of an object with Lean names says it in
 * `data-lean`.  (The object page's declarations carry a `data-lean` of their
 * own, a Lean name, on a `div`.)
 */
function leanTarget(a) {
  return a && a.tagName === 'A' && a.getAttribute ? a.getAttribute('data-lean') : null;
}

/** The card a link opens, as {id, build}, or null for none. */
function cardOf(t) {
  const m = app && app.model;
  if (!m || !t) return null;
  const lean = leanTarget(t);
  if (lean) return m.byId.has(lean) ? { id: lean, build: () => leanCard(app, lean) } : null;
  const id = previewTarget(m, t);
  return id ? { id, build: () => previewCard(app, id) } : null;
}

// The link's tooltip says its slug, which the card says too; left in place,
// the browser would draw it over the card a moment later.
function takeTitle(a) {
  if (untitled && untitled.anchor === a) return;
  restoreTitle();
  const title = a.getAttribute('title');
  if (title === null) return;
  untitled = { anchor: a, title };
  a.removeAttribute('title');
}

function restoreTitle() {
  if (!untitled) return;
  untitled.anchor.setAttribute('title', untitled.title);
  untitled = null;
}
