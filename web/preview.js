// preview.js — a card with an object's statement, shown while the pointer
// rests on a link to it.
//
// Every link to an object (`a.objlink`: a `[slug]` reference in prose, a title
// in a listing) previews what it leads to: the reference ("Lemma 2.3") and
// title, the status, the prose with its maths, a link on to the object page.
// The document's "Lean" mark beside a heading (`leanMark`) opens a card of the
// same kind with the object's Lean declarations; a tap opens that one too.  The pointer can move into the card, to scroll it, open a
// folded proof or follow a link, and a link in the card opens a card of its
// own beside it, so a chain of references can be read without leaving the
// page.  Moving off the link and its cards closes them after a moment; so do
// Escape, a click, a scroll and a change of route.
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
// `stack[i].card`.  Each entry is {anchor, id, build, card, keyboard}, `anchor`
// being the link or Lean mark it was opened from.
const stack = [];
let pending = null; // {anchor, id, build, level, keyboard}: waiting out SHOW_MS
let showTimer = null;
let hideTimer = null;
let untitled = null; // {anchor, title}: the tooltip taken off the hovered link
let pointer = null; // {x, y}: the last pointer position, to pick a wrapped link's line

/**
 * The id of the object a link previews, or null.  Only links to an object
 * that exists; not a broken reference, not a title in a heading (the document
 * writes the object out right under it), not the "Proof." that opens a proof.
 */
export function previewTarget(model, a) {
  if (!model || !a || a.tagName !== 'A' || !a.classList) return null;
  if (!a.classList.contains('objlink') || a.classList.contains('broken')) return null;
  if (a.classList.contains('proof-word')) return null;
  for (let p = a.parentNode; p && p.nodeType === 1; p = p.parentNode) {
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
  const lead = of ? 'Proof' : ref ? ref.word + ' ' + ref.number : M.kindWord(o.kind);
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
  ctx.renderBody(body, o.body, ctx.knownIds());
  // The statement is what a preview is for: a proof in it starts folded.
  for (const d of body.querySelectorAll('details.proof')) d.open = false;

  // The Lean names are left to the document's Lean mark: a statement with
  // many of them would leave its prose no room.
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
 * The mark the document sets beside the heading of an object with Lean
 * declarations; resting on it, focusing it or tapping it opens `leanCard`.
 * null for an object with none.
 */
export function leanMark(ctx, o) {
  const n = M.leanNamesOf(o).length;
  if (!n) return null;
  return ctx.el('button.lean-mark', {
    type: 'button', 'data-lean': o.id,
    'aria-label': n === 1 ? 'Its Lean declaration' : `Its ${n} Lean declarations`,
  }, 'Lean', n > 1 ? ctx.el('span.lean-count', String(n)) : null);
}

/**
 * The card of an object's Lean declarations: each name, linked to its
 * documentation when the snapshot says where that is (`project.docgen`), with
 * its kind and status from the Lean facts.  The signatures are on the object
 * page, one click on.
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
    el('span.preview-title', 'of ' + (ref ? ref.word + ' ' + ref.number : M.titleOf(o))),
    status === null ? null : ctx.statusBadge(status));
  const rows = facts.map(({ name, fact }) => el('li',
    docgen
      ? el('a', { href: M.docgenUrl(docgen, name), target: '_blank', rel: 'noopener' }, el('code', name))
      : el('code', name),
    fact && fact.kind ? el('span.chip', fact.kind) : null,
    // Without any facts there is nothing to say of one name in particular.
    !m.facts ? null
      : !fact ? el('span.badge.status-absent', el('span.dot'), 'no facts')
        : fact.exists === false ? el('span.badge.status-missing', el('span.dot'), 'does not exist')
          : fact.status ? ctx.statusBadge(fact.status) : null));
  const card = el('div.preview.lean-card', {
    role: 'dialog', 'aria-label': `Lean declarations of ${M.titleOf(o)}`, 'data-preview': id,
  },
  head,
  el('div.preview-body', el('ul.lean-names', ...rows)),
  el('div.preview-foot',
    el('code.preview-id', o.id),
    el('a.preview-open', { href: ctx.objectHref(id) }, 'Signatures →')));
  ctx.renderMath(head);
  return card;
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
    if (isLeanMark(t)) {
      // A tap has no hover to open the card, and a click is the plainest ask.
      const c = cardOf(t);
      if (!c) return;
      cancelPending();
      open({ anchor: t, ...c, level: levelOf(t) + 1, keyboard: false });
    } else if (t && levelOf(t) >= 0) {
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
  // Keep the cards up to the one the pointer is in, and the one opened from
  // the link it is on; the rest go once it has been elsewhere a moment.
  const keep = Math.max(level, opened);
  clearTimeout(hideTimer);
  hideTimer = keep < stack.length - 1 ? setTimeout(() => closeFrom(keep + 1), HIDE_MS) : null;

  const c = a && opened < 0 ? cardOf(a) : null;
  if (!c) {
    if (!pending || !pending.keyboard) cancelPending();
    return;
  }
  takeTitle(a);
  if (pending && pending.anchor === a) return;
  schedule({ anchor: a, ...c, level: level + 1, keyboard: false });
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

function open({ anchor, id, build, level, keyboard }) {
  if (!app || !app.model || !app.model.byId.has(id)) return;
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
  stack.push({ anchor, id, build, card, keyboard });
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

/** The link or Lean mark `node` is in, or null. */
function triggerOf(node) {
  for (let p = node; p && p.nodeType; p = p.parentNode) {
    if (p.nodeType === 1 && (p.tagName === 'A' || isLeanMark(p))) return p;
  }
  return null;
}

function isLeanMark(node) {
  return !!(node && node.classList && node.classList.contains('lean-mark'));
}

/** The card a link or Lean mark opens, as {id, build}, or null for none. */
function cardOf(t) {
  const m = app && app.model;
  if (!m || !t) return null;
  if (isLeanMark(t)) {
    const id = t.getAttribute('data-lean');
    return m.byId.has(id) ? { id, build: () => leanCard(app, id) } : null;
  }
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
