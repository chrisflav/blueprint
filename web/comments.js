// comments.js — the comment section at the foot of an object page and of
// every page of the document.
//
// Comments live beside the site, not in the snapshot, with the comment server
// that `blueprint serve` runs (comments-server.py), which answers
//   GET  api/comments/<id>  -> {"comments": [{n, name, title, body, date, topic?}, ...],
//                               "maxBody": n, "zulip": {site, channel, topic, streamId}?}
//   POST api/comments/<id>  <- {"name", "title", "body", "visibility": "public" | "private", "page"}
//                           -> {"comments": [...], "shown": true | false}
// A comment is public, listed below the page, or private, kept but never
// listed: the server answers with the public ones alone.  It keeps them as
// one JSON file per object, or, for a site with `[site.comments]`, on Zulip,
// as messages of a bot it holds itself, each comment a topic of its own named
// by its title: the browser never sees the bot, and `zulip` above (and the
// `topic` of a comment) only says where the comments go.  Served by a plain static
// server there is no such endpoint, and the section says so.
//
// A site served elsewhere (a static host) finds its comment server in
// comments-config.json, `{"server": "https://…/"}`, which `blueprint site`
// writes for `[site.comments] server`; the server must name the site with
// `--allow-origin`.
//
// One object has one thread, wherever it is read: an object page and the
// document's page of the same object show the same comments.  The top of the
// document is no object, and has the thread `DOCUMENT_THREAD`: a colon is no
// slug character, so no `[slug]` link or bare `@[blueprint …]` id can name an
// object so, and no blueprint is expected to have one.

/** The thread of the top page of the document; the server knows it too. */
export const DOCUMENT_THREAD = ':document';

const NAME_KEY = 'blueprint.commentName';
const VISIBILITY_KEY = 'blueprint.commentVisibility';

function remembered(key) {
  try { return localStorage.getItem(key) || ''; } catch (e) { return ''; }
}

function remember(key, value) {
  try { localStorage.setItem(key, value); } catch (e) { /* private mode */ }
}

let basePromise = null;

/** Where the comment API is: `server` of comments-config.json, or this site. */
function apiBase() {
  if (!basePromise) {
    basePromise = fetch('comments-config.json', { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((c) => {
        const s = c && typeof c.server === 'string' ? c.server.trim() : '';
        return /^https?:\/\//.test(s) ? s.replace(/\/*$/, '/') : '';
      })
      .catch(() => '');
  }
  return basePromise;
}

/** Forget comments-config.json, so that the next panel reads it again: for the tests. */
export function resetCommentsConfig() {
  basePromise = null;
}

async function commentsUrl(id) {
  return (await apiBase()) + 'api/comments/' + encodeURIComponent(id);
}

/** Zulip's encoding of one part of a `#narrow/…` link. */
function narrowPart(s) {
  return encodeURIComponent(s)
    .replace(/[!'()*.]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
    .replace(/%/g, '.');
}

// ---------------------------------------------------------------- the panel

let panels = 0; // for the names of each panel's radio buttons

export function commentsPanel(app, id) {
  const { el, clear } = app;
  const heading = el('h3', 'Comments');
  const list = el('div.comment-list', el('p.muted.small', 'Loading comments…'));

  // ---- the form: name, title, public or private, Markdown + LaTeX, a preview, post
  const name = el('input', {
    type: 'text', name: 'name', required: true, maxlength: '100', autocomplete: 'name',
    placeholder: 'Your name', 'aria-label': 'Name',
  });
  // On Zulip the title is the comment's topic, which holds 60 characters.
  const title = el('input', {
    type: 'text', name: 'title', required: true, maxlength: '60', autocomplete: 'off',
    placeholder: 'What the comment is about, in a few words', 'aria-label': 'Title',
  });
  name.value = remembered(NAME_KEY);
  const group = 'comment-visibility-' + ++panels;
  const isPublic = el('input', { type: 'radio', name: group, value: 'public' });
  const isPrivate = el('input', { type: 'radio', name: group, value: 'private' });
  (remembered(VISIBILITY_KEY) === 'private' ? isPrivate : isPublic).checked = true;
  // What each choice means depends on where the comments are kept (`setWhere`).
  const publicText = el('span', ' Public: shown below this page');
  const privateText = el('span', ' Private: kept for the blueprint\'s authors, not shown here');
  const visibility = el('div.comment-field.comment-visibility', { role: 'radiogroup', 'aria-label': 'Who sees it' },
    el('span', 'Who sees it'),
    el('label', isPublic, publicText),
    el('label', isPrivate, privateText));
  const text = el('textarea', {
    name: 'body', required: true, rows: '7', maxlength: '20000',
    placeholder: 'Markdown and LaTeX: $\\pi$, $$\\int_X f$$, and [label] to refer to an object.',
    'aria-label': 'Comment',
  });
  const preview = el('div.comment-preview.body-prose', { hidden: true });
  const previewBtn = el('button', { type: 'button', 'aria-pressed': 'false' }, 'Preview');
  const post = el('button.primary', { type: 'submit' }, 'Post comment');
  const note = el('span.comment-note.muted.small');
  const where = el('span', 'Comments are kept with this copy of the site, as ',
    el('code', 'comments/*.json'), ' next to the blueprint, private ones too.');
  const form = el('form.comment-form',
    el('h4', 'Add a comment'),
    el('label.comment-field', el('span', 'Name'), name),
    el('label.comment-field', el('span', 'Title'), title),
    visibility,
    el('label.comment-field', el('span', 'Comment'), text),
    preview,
    el('p.muted.small', 'You can use Markdown and LaTeX style mathematics; ',
      el('code', '[label]'), ' links to the object with that label. ', where),
    el('div.row', previewBtn, post, note));

  const showPreview = (on) => {
    preview.hidden = !on;
    text.hidden = on;
    previewBtn.textContent = on ? 'Edit' : 'Preview';
    previewBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    if (on) {
      app.renderBody(preview, text.value.trim() ? text.value : '*Nothing to preview yet.*',
        app.knownIds(), undefined, { untrusted: true });
    }
  };
  previewBtn.addEventListener('click', () => showPreview(preview.hidden));

  let onZulip = false; // the server keeps the comments on Zulip
  let zulipAt = null; // and where: {site, channel, streamId}

  /** A link to a channel, or to one of its topics, on the Zulip of the comments. */
  const zulipLink = (topic) => String(zulipAt.site).replace(/\/*$/, '') + '/#narrow/channel/'
    + narrowPart(zulipAt.streamId + '-' + zulipAt.channel) + (topic == null ? '' : '/topic/' + narrowPart(topic));

  const draw = (comments) => {
    clear(list);
    heading.textContent = `Comments (${comments.length})`;
    if (!comments.length) {
      list.appendChild(el('p.muted.small', 'No public comments yet.'));
      return;
    }
    for (const c of comments) {
      const body = el('div.comment-body.body-prose');
      app.renderBody(body, c.body, app.knownIds(), undefined, { untrusted: true });
      const when = c.date ? new Date(c.date) : null;
      // The title, which on Zulip leads to the comment's own topic.
      const head = !c.title ? null
        : zulipAt && typeof zulipAt.streamId === 'number' && typeof c.topic === 'string'
          ? el('a.comment-title', { href: zulipLink(c.topic), target: '_blank', rel: 'noopener' }, c.title)
          : el('span.comment-title', c.title);
      list.appendChild(el('article.comment', { id: 'comment-' + c.n },
        head ? el('div.comment-title-row', head) : null,
        el('div.comment-head',
          el('b', c.name),
          when && !Number.isNaN(when.getTime())
            ? el('time.muted.small', { datetime: c.date }, when.toLocaleString())
            : null,
          el('span.muted.small.comment-anchor', '#' + c.n)),
        body));
    }
  };

  const unavailable = (why) => {
    clear(list);
    heading.textContent = 'Comments';
    list.appendChild(el('p.muted.small',
      'Comments need the comment server, which ', el('code', 'lake exe blueprint serve'),
      ' starts; this copy of the site is served without it', why ? ` (${why})` : '', '.'));
    for (const c of [name, title, text, previewBtn, post, isPublic, isPrivate]) c.disabled = true;
  };

  /** Says where the comments go, as the server answers it: on Zulip, the topic,
   *  a link once the channel's id is known; else the comment files. */
  const setWhere = (data) => {
    if (typeof data.maxBody === 'number') text.setAttribute('maxlength', String(data.maxBody));
    const z = data.zulip;
    onZulip = !!z;
    zulipAt = z || null;
    if (!z) return;
    publicText.textContent = ' Public: shown below this page and posted to Zulip';
    privateText.textContent = ' Private: posted to Zulip only';
    const label = `#${z.channel}`;
    clear(where);
    where.appendChild(el('span', 'Every comment is posted to Zulip, in ',
      typeof z.streamId !== 'number' ? el('b', label) : el('a', {
        href: zulipLink(null), target: '_blank', rel: 'noopener',
      }, label),
      ', as a topic of its own named by its title; public ones are also shown here.'));
  };

  const load = async () => {
    try {
      const res = await fetch(await commentsUrl(id), { cache: 'no-store' });
      const type = res.headers.get('content-type') || '';
      if (!type.includes('json')) {
        unavailable(res.ok ? '' : 'HTTP ' + res.status);
        return;
      }
      const data = await res.json();
      if (!res.ok) {
        clear(list);
        heading.textContent = 'Comments';
        list.appendChild(el('p.muted.small', `Could not read the comments (${data.error || 'HTTP ' + res.status}).`));
        return;
      }
      setWhere(data);
      draw(Array.isArray(data.comments) ? data.comments : []);
    } catch (e) {
      unavailable('');
    }
  };

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const who = name.value.trim();
    const about = title.value.trim().replace(/\s+/g, ' ');
    const what = text.value.trim();
    if (!who || !about || !what) {
      note.textContent = 'A name, a title and a comment, please.';
      return;
    }
    const vis = isPrivate.checked ? 'private' : 'public';
    // The page it is written on, which a comment on Zulip links to.
    const page = location.href.split('#')[0]
      + (id === DOCUMENT_THREAD ? '#/document' : '#/object/' + encodeURIComponent(id));
    post.disabled = true;
    note.textContent = 'Posting…';
    try {
      const res = await fetch(await commentsUrl(id), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: who, title: about, body: what, visibility: vis, page }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
      remember(NAME_KEY, who);
      remember(VISIBILITY_KEY, vis);
      text.value = '';
      title.value = '';
      showPreview(false);
      note.textContent = data.shown === false
        ? (onZulip ? 'Posted to Zulip (private: not shown here).' : 'Posted (private: not shown here).')
        : 'Posted.';
      draw(Array.isArray(data.comments) ? data.comments : []);
    } catch (e) {
      note.textContent = 'Not posted: ' + e.message;
    } finally {
      post.disabled = false;
    }
  });

  load();
  return el('div.panel.comments', { id: 'comments' }, heading, list, form);
}
