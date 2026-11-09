// blog.js — the Blog page (`#/blog`, `#/blog/<id>`): the posts of `[site]
// blog`, words and PDFs, which `blueprint site` lists in blog.json beside the
// snapshot and copies into the site as `blog/` (`readBlog` in Site.lean).
//
// It is set as the document is: the posts in a sidebar on the left, one row
// each in the order of their file names, and the post opened on the right.
// `#/blog` lists them all, with their authors and dates; `#/blog/<id>` is one
// post, its
// words — Markdown with maths and `[slug]` references, rendered as an
// object's prose is — then its PDF, read in the page, with a link to open it
// on its own, and its neighbours in the list.  A post's pictures and links
// are read in `blog/`, where they are in the site.  On a site with `[site]
// visits` a post's page counts its visit and says, under the date, how many
// it has had (`postVisits` in comments.js).
//
// A site without a blog has no blog.json: its tab stays hidden (`loadBlog`
// in app.js), and the page, opened all the same, says so.

import { resolveUrls, snapshotBase } from './intro.js';
import { postVisits } from './comments.js';

// Guards against a route change landing while blog.json is on its way.
let drawToken = 0;

export function render(root, app) {
  const token = ++drawToken;
  // Known already, from an earlier visit or the tab: drawn at once.
  if (app.blogData !== undefined) {
    draw(root, app, app.blogData);
    return;
  }
  app.clear(root);
  root.appendChild(app.el('div.loading', 'Loading the blog…'));
  return app.blog().then((blog) => {
    if (token === drawToken) draw(root, app, blog);
  });
}

/** The address of a post's page. */
function postHref(id) {
  return '#/blog/' + encodeURIComponent(id);
}

function draw(root, app, blog) {
  const { el, clear } = app;
  clear(root);
  const posts = (blog && blog.posts) || [];
  const id = app.route.id;
  const post = id == null ? null : posts.find((p) => p.id === id) || null;

  if (!posts.length) {
    root.appendChild(el('div.error-box', el('h1', 'No blog'),
      el('p', 'This site has no posts. ', el('code', '[site] blog'),
        ' in blueprint.toml names a directory of Markdown files and PDFs, which ',
        el('code', 'blueprint site'), ' puts here.')));
    return;
  }
  if (id != null && !post) {
    root.appendChild(el('div.error-box', el('h1', 'No such post'),
      el('div.detail', id),
      el('p', 'It may have been renamed. ', el('a', { href: '#/blog' }, 'All the posts'), '.')));
    return;
  }

  // Where the blog's files are in the site, for a post's pictures, links and
  // PDF.
  const base = new URL('blog/', snapshotBase(app) || location.href).href;
  const page = el('div.page.wide.blog-page');
  const body = el('div');
  page.appendChild(el('div.doc-layout', sidebar(app, posts, post), body));
  root.appendChild(page);
  if (post) body.appendChild(article(app, posts, post, base));
  else body.appendChild(listing(app, posts));
}

/** The sidebar: every post, one row each, the one opened marked. */
function sidebar(app, posts, post) {
  const { el } = app;
  const list = el('ul.toc-levels',
    posts.map((p) => el('li', { class: 'toc-entry' + (p === post ? ' current' : '') },
      el('a', { href: postHref(p.id), 'data-id': p.id, 'aria-current': p === post ? 'page' : null }, p.title))));
  app.renderMath(list); // titles carry maths
  return el('nav.toc.blog-toc', { 'aria-label': 'Posts' },
    el('h3.toc-head', el('a', { href: '#/blog' }, 'Blog')), list);
}

/** `#/blog`: the posts, with their authors, dates and whether they hold a PDF. */
function listing(app, posts) {
  const { el } = app;
  const list = el('ul.blog-list',
    posts.map((p) => el('li',
      el('a.blog-title', { href: postHref(p.id) }, p.title),
      p.author ? el('span.blog-author', p.author) : null,
      p.date ? el('span.blog-date', p.date) : null,
      p.pdf ? el('span.blog-tag', 'PDF') : null)));
  app.renderMath(list);
  return el('div', el('h1', 'Blog'), list);
}

/** `#/blog/<id>`: a post, its words, then its PDF, then its neighbours. */
function article(app, posts, post, base) {
  const { el } = app;
  const head = el('header.blog-head', el('h1', post.title),
    post.author ? el('p.blog-author', post.author) : null,
    post.date ? el('p.blog-date', post.date) : null);
  app.renderMath(head);
  // On a site with `[site] visits`, the post's visits, this one counted
  // (comments.js); nothing on a site that does not count them.
  const visits = el('p.blog-visits');
  visits.hidden = true;
  head.appendChild(visits);
  postVisits(post.id).then((n) => {
    if (n === null) return;
    visits.textContent = n === 1 ? '1 visit' : `${n} visits`;
    visits.hidden = false;
  });
  const node = el('article.blog-post', head);
  if (post.body && post.body.trim()) {
    const prose = el('div.prose.body-prose');
    app.renderBody(prose, post.body, app.knownIds());
    resolveUrls(prose, base);
    node.appendChild(prose);
  }
  if (post.pdf) {
    const href = new URL(encodeURIComponent(post.pdf), base).href;
    node.appendChild(el('div.blog-pdf',
      el('p.blog-pdf-links',
        el('a', { href, target: '_blank', rel: 'noopener' }, 'Open the PDF'), ' · ',
        el('a', { href, download: post.pdf }, 'Download')),
      el('iframe', { src: href, title: post.title, loading: 'lazy' })));
  }
  const i = posts.indexOf(post);
  const prev = i > 0 ? posts[i - 1] : null;
  const next = i + 1 < posts.length ? posts[i + 1] : null;
  const pager = el('nav.doc-pager.blog-pager', { 'aria-label': 'Posts' },
    el('div.prev', prev ? el('a.prev', { href: postHref(prev.id) }, '← ', prev.title) : null),
    el('div.up', el('a.up', { href: '#/blog' }, 'All posts')),
    el('div.next', next ? el('a.next', { href: postHref(next.id) }, next.title, ' →') : null));
  app.renderMath(pager);
  node.appendChild(pager);
  return node;
}
