// comments.js — the comment section at the foot of an object page and of
// every page of the document.
//
// Comments live beside the site, not in the snapshot: the comment server that
// `blueprint serve` runs (comments-server.py) answers
//   GET  api/comments/<id>  -> {"comments": [{n, name, body, date}, ...]}
//   POST api/comments/<id>  <- {"name": ..., "body": ...}
// and keeps them as one JSON file per object.  Served by a plain static
// server there is no such endpoint, and the section says so.
//
// One object has one thread, wherever it is read: an object page and the
// document's page of the same object show the same comments.  The top of the
// document is no object, and has the thread `DOCUMENT_THREAD`: a colon is no
// slug character, so no `[slug]` link or bare `@[blueprint …]` id can name an
// object so, and no blueprint is expected to have one.

/** The thread of the top page of the document; the server knows it too. */
export const DOCUMENT_THREAD = ':document';

const NAME_KEY = 'blueprint.commentName';

function commentsUrl(id) {
  return 'api/comments/' + encodeURIComponent(id);
}

function rememberedName() {
  try { return localStorage.getItem(NAME_KEY) || ''; } catch (e) { return ''; }
}

export function commentsPanel(app, id) {
  const { el, clear } = app;
  const heading = el('h3', 'Comments');
  const list = el('div.comment-list', el('p.muted.small', 'Loading comments…'));

  // ---- the form: name, Markdown + LaTeX, a preview, post
  const name = el('input', {
    type: 'text', name: 'name', required: true, maxlength: '100', autocomplete: 'name',
    placeholder: 'Your name', 'aria-label': 'Name',
  });
  name.value = rememberedName();
  const text = el('textarea', {
    name: 'body', required: true, rows: '7', maxlength: '20000',
    placeholder: 'Markdown and LaTeX: $\\pi$, $$\\int_X f$$, and [label] to refer to an object.',
    'aria-label': 'Comment',
  });
  const preview = el('div.comment-preview.body-prose', { hidden: true });
  const previewBtn = el('button', { type: 'button', 'aria-pressed': 'false' }, 'Preview');
  const post = el('button.primary', { type: 'submit' }, 'Post comment');
  const note = el('span.comment-note.muted.small');
  const form = el('form.comment-form',
    el('h4', 'Add a comment'),
    el('label.comment-field', el('span', 'Name'), name),
    el('label.comment-field', el('span', 'Comment'), text),
    preview,
    el('p.muted.small', 'You can use Markdown and LaTeX style mathematics; ',
      el('code', '[label]'), ' links to the object with that label. Comments are kept with this copy of the site, as ',
      el('code', 'comments/*.json'), ' next to the blueprint.'),
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

  const draw = (comments) => {
    clear(list);
    heading.textContent = `Comments (${comments.length})`;
    if (!comments.length) {
      list.appendChild(el('p.muted.small', 'No comments yet.'));
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

  const load = async () => {
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
      const res = await fetch(commentsUrl(id), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: who, body: what }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
      try { localStorage.setItem(NAME_KEY, who); } catch (e) { /* private mode */ }
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
