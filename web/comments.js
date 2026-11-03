// comments.js — the comment section at the foot of an object page and of
// every page of the document.
//
// Comments live beside the site, not in the snapshot, in one of two places.
//
// By default with the comment server that `blueprint serve` runs
// (comments-server.py), which answers
//   GET  api/comments/<id>  -> {"comments": [{n, name, body, date}, ...]}
//   POST api/comments/<id>  <- {"name": ..., "body": ...}
// and keeps them as one JSON file per object.  Served by a plain static
// server there is no such endpoint, and the section says so.
//
// Or on Zulip, when the site has a comments-config.json, which `blueprint
// site` writes for `[site.comments]`:
//   {"zulip": {"site": "https://…", "channel": "…", "email": "…", "key": "…"}}
// Every comment is then a message of that bot in the channel, in the topic of
// its object (`topicOf`), sent and read straight from the browser, which the
// Zulip server allows (CORS with an Authorization header).  The first line of
// the message says who wrote it and whether it is public or private
// (`headLine`); the section shows the bot's public messages of the topic, so a
// message edited or deleted on Zulip is a comment edited or deleted here.
// Private comments are only on Zulip.
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

/** Zulip's default limit on the length of a topic. */
const MAX_TOPIC = 60;

function commentsUrl(id) {
  return 'api/comments/' + encodeURIComponent(id);
}

function remembered(key) {
  try { return localStorage.getItem(key) || ''; } catch (e) { return ''; }
}

function remember(key, value) {
  try { localStorage.setItem(key, value); } catch (e) { /* private mode */ }
}

// ---------------------------------------------------------------- Zulip

let configPromise = null;

/** The Zulip of comments-config.json, or null for the comment server. */
function zulipConfig() {
  if (!configPromise) {
    configPromise = fetch('comments-config.json', { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((c) => {
        const z = c && c.zulip;
        return z && z.site && z.channel && z.email && z.key ? z : null;
      })
      .catch(() => null);
  }
  return configPromise;
}

/** Forget comments-config.json, so that the next panel reads it again: for the tests. */
export function resetCommentsConfig() {
  configPromise = null;
}

/** FNV-1a, as eight hex digits: tells apart ids cut to the same topic. */
function hash8(s) {
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(s)) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** The Zulip topic of an object's comments: its id, cut to fit with a hash. */
export function topicOf(id) {
  const t = id === DOCUMENT_THREAD ? 'document (top page)' : id;
  const chars = [...t];
  if (chars.length <= MAX_TOPIC) return t;
  return chars.slice(0, MAX_TOPIC - 10).join('') + '… ' + hash8(t);
}

/** Zulip's encoding of one part of a `#narrow/…` link. */
function narrowPart(s) {
  return encodeURIComponent(s)
    .replace(/[!'()*.]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
    .replace(/%/g, '.');
}

const MARKS = { public: '🌐 **Public**', private: '🔒 **Private**' };
const HEAD_RE = /^(?:🌐|🔒) \*\*(Public|Private)\*\* comment by \*\*([^*\n]*)\*\* on [^\n]*\n*/u;

/** The first line of a comment's message, which `parseMessage` reads back. */
export function headLine(visibility, name, title, url) {
  const label = title.replace(/[[\]\\]/g, (c) => '\\' + c);
  return `${MARKS[visibility]} comment by **${name}** on [${label}](${url})`;
}

/** {visibility, name, body} of a message posted for a comment, or null. */
export function parseMessage(content) {
  const m = HEAD_RE.exec(content);
  if (!m) return null;
  return { visibility: m[1].toLowerCase(), name: m[2], body: content.slice(m[0].length) };
}

async function zulip(z, method, path, params) {
  const url = new URL('api/v1/' + path, z.site.replace(/\/*$/, '/'));
  const query = new URLSearchParams(params);
  // Only the Authorization header, which the server's CORS rules admit; a
  // form body is a content type that needs no permission of its own.
  const init = { method, headers: { Authorization: 'Basic ' + btoa(z.email + ':' + z.key) }, cache: 'no-store' };
  if (method === 'GET') url.search = query.toString();
  else init.body = query;
  const res = await fetch(url, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.result !== 'success') throw new Error(data.msg || 'HTTP ' + res.status);
  return data;
}

/** The public comments of a topic, as the comment server lists them, and the channel's id. */
async function zulipComments(z, topic) {
  const [stream, data] = await Promise.all([
    zulip(z, 'GET', 'get_stream_id', { stream: z.channel }),
    zulip(z, 'GET', 'messages', {
      anchor: 'newest', num_before: '1000', num_after: '0', apply_markdown: 'false',
      narrow: JSON.stringify([
        { operator: 'channel', operand: z.channel },
        { operator: 'topic', operand: topic },
        { operator: 'sender', operand: z.email },
      ]),
    }),
  ]);
  const comments = [];
  for (const m of data.messages || []) {
    const c = parseMessage(String(m.content || ''));
    if (c && c.visibility === 'public') {
      comments.push({ n: m.id, name: c.name, body: c.body, date: new Date(m.timestamp * 1000).toISOString() });
    }
  }
  return { streamId: stream.stream_id, comments };
}

// ---------------------------------------------------------------- the panel

let panels = 0; // for the names of each panel's radio buttons

export function commentsPanel(app, id) {
  const { el, clear } = app;
  const heading = el('h3', 'Comments');
  const list = el('div.comment-list', el('p.muted.small', 'Loading comments…'));

  // ---- the form: name, public or private (Zulip only), Markdown + LaTeX, a
  // preview, post
  const name = el('input', {
    type: 'text', name: 'name', required: true, maxlength: '100', autocomplete: 'name',
    placeholder: 'Your name', 'aria-label': 'Name',
  });
  name.value = remembered(NAME_KEY);
  const group = 'comment-visibility-' + ++panels;
  const isPublic = el('input', { type: 'radio', name: group, value: 'public' });
  const isPrivate = el('input', { type: 'radio', name: group, value: 'private' });
  (remembered(VISIBILITY_KEY) === 'private' ? isPrivate : isPublic).checked = true;
  const visibility = el('div.comment-field.comment-visibility', { role: 'radiogroup', 'aria-label': 'Who sees it', hidden: true },
    el('span', 'Who sees it'),
    el('label', isPublic, ' Public: shown below this page and posted to Zulip'),
    el('label', isPrivate, ' Private: posted to Zulip only'));
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
    el('code', 'comments/*.json'), ' next to the blueprint.');
  const form = el('form.comment-form',
    el('h4', 'Add a comment'),
    el('label.comment-field', el('span', 'Name'), name),
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

  let z = null; // the Zulip of comments-config.json, once known
  const topic = topicOf(id);

  const draw = (comments) => {
    clear(list);
    heading.textContent = `Comments (${comments.length})`;
    if (!comments.length) {
      list.appendChild(el('p.muted.small', z ? 'No public comments yet.' : 'No comments yet.'));
      return;
    }
    for (const c of comments) {
      const body = el('div.comment-body.body-prose');
      app.renderBody(body, c.body, app.knownIds(), undefined, { untrusted: true });
      const when = c.date ? new Date(c.date) : null;
      list.appendChild(el('article.comment', { id: 'comment-' + c.n },
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
    for (const c of [name, text, previewBtn, post]) c.disabled = true;
  };

  /** Says where the comments go: the topic, a link once the channel's id is known. */
  const zulipWhere = (streamId) => {
    const label = `#${z.channel} › ${topic}`;
    clear(where);
    where.appendChild(el('span', 'Every comment is posted to Zulip, in ',
      streamId === undefined ? el('b', label) : el('a', {
        href: z.site.replace(/\/*$/, '') + '/#narrow/channel/'
          + narrowPart(streamId + '-' + z.channel) + '/topic/' + narrowPart(topic),
        target: '_blank', rel: 'noopener',
      }, label),
      '; public ones are also shown here.'));
  };

  const loadZulip = async () => {
    try {
      const { streamId, comments } = await zulipComments(z, topic);
      zulipWhere(streamId);
      draw(comments);
    } catch (e) {
      clear(list);
      heading.textContent = 'Comments';
      list.appendChild(el('p.muted.small', `Could not read the comments from Zulip (${e.message}).`));
    }
  };

  const load = async () => {
    z = await zulipConfig();
    if (z) {
      visibility.hidden = false;
      // Zulip takes 10000 characters a message, the first line included.
      text.setAttribute('maxlength', '9000');
      zulipWhere();
      return loadZulip();
    }
    try {
      const res = await fetch(commentsUrl(id), { cache: 'no-store' });
      const type = res.headers.get('content-type') || '';
      if (!res.ok || !type.includes('json')) {
        unavailable(res.ok ? '' : 'HTTP ' + res.status);
        return;
      }
      const data = await res.json();
      draw(Array.isArray(data.comments) ? data.comments : []);
    } catch (e) {
      unavailable('');
    }
  };

  /** Posts a comment to Zulip; true when it is to be shown here. */
  const postZulip = async (who, what) => {
    const vis = isPrivate.checked ? 'private' : 'public';
    const o = app.model && app.model.byId ? app.model.byId.get(id) : null;
    const title = id === DOCUMENT_THREAD ? 'the document' : (o && o.attrs && o.attrs.title) || id;
    const page = location.href.split('#')[0]
      + (id === DOCUMENT_THREAD ? '#/document' : '#/object/' + encodeURIComponent(id));
    // A name is set in bold on the first line, which `parseMessage` reads back.
    const shown = who.replace(/[*\r\n]+/g, ' ').trim();
    await zulip(z, 'POST', 'messages', {
      type: 'stream', to: z.channel, topic,
      content: headLine(vis, shown, title, page) + '\n\n' + what,
    });
    remember(VISIBILITY_KEY, vis);
    return vis === 'public';
  };

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const who = name.value.trim();
    const what = text.value.trim();
    if (!who || !what) {
      note.textContent = 'A name and a comment, please.';
      return;
    }
    post.disabled = true;
    note.textContent = 'Posting…';
    try {
      if (z) {
        const shownHere = await postZulip(who, what);
        remember(NAME_KEY, who);
        text.value = '';
        showPreview(false);
        note.textContent = shownHere ? 'Posted.' : 'Posted to Zulip (private: not shown here).';
        if (shownHere) await loadZulip();
        return;
      }
      const res = await fetch(commentsUrl(id), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: who, body: what }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
      remember(NAME_KEY, who);
      text.value = '';
      showPreview(false);
      note.textContent = 'Posted.';
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
