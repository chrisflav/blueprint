// export/markdown-tex.js — a body's Markdown, as LaTeX.
//
// The website hands a body to marked and then to KaTeX (`renderBody` in
// app.js); this is the same reading of the same text, written out as LaTeX
// instead of HTML, so that the PDF says what the page says.  Pure: no DOM, no
// node APIs, so the browser and the command line share it.
//
//   * Maths is lifted out first, exactly as `shieldMath` does it
//     (`model.mathRegExp`), and copied through untouched apart from its
//     delimiters, so `_`, `*` and blank lines inside a formula never reach the
//     Markdown reading.
//   * The Markdown is the CommonMark/GFM subset bodies use: paragraphs, ATX
//     and setext headings, emphasis, strong, strikethrough, code spans and
//     fences, links, autolinks, images, block quotes, ordered and bullet lists
//     (nested), GFM tables, thematic breaks, hard breaks, backslash escapes and
//     entities.  Raw HTML keeps its text and loses its markup, as marked's
//     output would after the comment sanitiser.
//   * `[slug]` references, images and maths are handed back to the caller
//     (`ctx.ref`, `ctx.image`, `ctx.math`), which knows the document they are
//     in.
//   * A `## Proof` heading opens a proof, up to the next heading of the same
//     or a higher level, as `foldProofs` reads it on the website.

import { mathRegExp, SLUG_PATTERN } from '../model.js';

const TOKEN_OPEN = '\uE000';
const TOKEN_CLOSE = '\uE001';
const TOKEN_RE = /\uE000(\d+)\uE001/g;

/**
 * Lift the maths out of `src`.  Returns the text with each maths span replaced
 * by a token, and the spans: {source, display, body} where `body` is what sits
 * between the delimiters.
 */
export function liftMath(src) {
  const spans = [];
  const text = String(src).replace(mathRegExp(), (whole, code, math) => {
    if (code !== undefined) return whole;
    let display = false;
    let body;
    if (math.startsWith('$$')) { display = true; body = math.slice(2, -2); }
    else if (math.startsWith('\\[')) { display = true; body = math.slice(2, -2); }
    else if (math.startsWith('\\(')) body = math.slice(2, -2);
    else body = math.slice(1, -1);
    spans.push({ source: math, display, body });
    return TOKEN_OPEN + (spans.length - 1) + TOKEN_CLOSE;
  });
  return { text, spans };
}

// ---------------------------------------------------------------------------
// text escaping
// ---------------------------------------------------------------------------

const TEXT_ESCAPES = {
  '\\': '\\textbackslash{}', '{': '\\{', '}': '\\}', '$': '\\$', '&': '\\&',
  '%': '\\%', '#': '\\#', '_': '\\_', '~': '\\textasciitilde{}', '^': '\\textasciicircum{}',
  '<': '\\textless{}', '>': '\\textgreater{}', '|': '\\textbar{}', '"': '\\textquotedbl{}',
};

/**
 * Ordinary text as LaTeX: the ten special characters escaped, and the
 * ligatures TeX would make of plain text (`--`, `''`, `<<`) broken, so the
 * PDF prints what the page prints.  Characters outside ASCII are left as they
 * are: the preamble declares the ones it knows (`unicode.js`).
 */
export function escapeText(s) {
  let out = '';
  const str = String(s);
  for (let i = 0; i < str.length; i += 1) {
    const c = str[i];
    if (TEXT_ESCAPES[c]) out += TEXT_ESCAPES[c];
    else if ((c === '-' || c === "'" || c === '`') && str[i + 1] === c) out += c + '{}';
    else if (c === '\u00A0') out += '~';
    else out += c;
  }
  return out;
}

/** Text inside `\texttt`: as `escapeText`, and breakable after `/`, `.`, `_`, `-`. */
export function escapeCode(s) {
  let out = '';
  for (const c of String(s)) {
    if (c === ' ') out += '\\ ';
    else if (TEXT_ESCAPES[c]) out += TEXT_ESCAPES[c];
    else if (c === '-') out += '-{}';
    else if (c === "'") out += '\\textquotesingle{}';
    else if (c === '`') out += '\\textasciigrave{}';
    else out += c;
    if (c === '/' || c === '.' || c === '_' || c === '-') out += '\\allowbreak{}';
  }
  return out;
}

/** A URL as the first argument of `\href` or the argument of `\url`. */
export function escapeUrl(u) {
  return String(u).replace(/[\\#%{}~^]/g, (c) => '\\' + c).replace(/\s/g, '%20');
}

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00A0', ndash: '\u2013',
  mdash: '\u2014', hellip: '\u2026', copy: '\u00A9', reg: '\u00AE', deg: '\u00B0',
  times: '\u00D7', middot: '\u00B7', laquo: '\u00AB', raquo: '\u00BB', rarr: '\u2192',
  larr: '\u2190', le: '\u2264', ge: '\u2265', ne: '\u2260', infin: '\u221E', thinsp: '\u2009',
  lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201C', rdquo: '\u201D', sect: '\u00A7',
};

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z]{2,8});/g, (whole, name) => {
    if (name[0] === '#') {
      const n = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10FFFF ? String.fromCodePoint(n) : whole;
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, name) ? ENTITIES[name] : whole;
  });
}

// ---------------------------------------------------------------------------
// blocks
// ---------------------------------------------------------------------------

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^`]*)$/;
const ATX_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const HR_RE = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const QUOTE_RE = /^ {0,3}> ?/;
const LIST_RE = /^( {0,3})([-+*]|\d{1,9}[.)])(?:([ \t]+)(.*)|[ \t]*)$/;
const TABLE_DELIM_RE = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const SETEXT_RE = /^ {0,3}(=+|-+)[ \t]*$/;
const HTML_BLOCK_RE = /^ {0,3}<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^>]*)?\/?>/;

const isBlank = (l) => /^[ \t]*$/.test(l);

function indentOf(line) {
  const m = /^ */.exec(line);
  return m[0].length;
}

/** Remove up to `n` columns of leading space. */
function dedent(line, n) {
  let i = 0;
  while (i < n && line[i] === ' ') i += 1;
  return line.slice(i);
}

/** Whether `line` starts a block that interrupts a paragraph. */
function startsBlock(line) {
  return FENCE_RE.test(line) || ATX_RE.test(line) || HR_RE.test(line) || QUOTE_RE.test(line) || listStarts(line);
}

/** A list marker that can interrupt a paragraph: a bullet, or an ordered list
 *  starting at 1, with content (CommonMark). */
function listStarts(line) {
  const m = LIST_RE.exec(line);
  if (!m || m[4] === undefined || !m[4].trim()) return false;
  return /^[-+*]$/.test(m[2]) || /^1[.)]$/.test(m[2]);
}

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] === '\\' && s[i + 1] === '|') { cur += '|'; i += 1; continue; }
    if (s[i] === '|') { cells.push(cur.trim()); cur = ''; continue; }
    cur += s[i];
  }
  cells.push(cur.trim());
  return cells;
}

/** Parse lines into blocks. */
export function parseBlocks(lines) {
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) { i += 1; continue; }

    let m;
    if ((m = FENCE_RE.exec(line))) {
      const fence = m[1];
      const info = m[2].trim();
      const ind = indentOf(line);
      const body = [];
      i += 1;
      while (i < lines.length) {
        const close = new RegExp('^ {0,3}' + (fence[0] === '`' ? '`' : '~') + '{' + fence.length + ',}[ \\t]*$');
        if (close.test(lines[i])) { i += 1; break; }
        body.push(dedent(lines[i], ind));
        i += 1;
      }
      blocks.push({ type: 'code', info, text: body.join('\n') });
      continue;
    }
    if ((m = ATX_RE.exec(line))) {
      blocks.push({ type: 'heading', level: m[1].length, text: (m[2] || '').trim() });
      i += 1;
      continue;
    }
    if (HR_RE.test(line)) {
      blocks.push({ type: 'hr' });
      i += 1;
      continue;
    }
    if (QUOTE_RE.test(line)) {
      const inner = [];
      while (i < lines.length && !isBlank(lines[i])) {
        if (QUOTE_RE.test(lines[i])) inner.push(lines[i].replace(QUOTE_RE, ''));
        else if (inner.length && !startsBlock(lines[i])) inner.push(lines[i]); // lazy continuation
        else break;
        i += 1;
      }
      blocks.push({ type: 'quote', blocks: parseBlocks(inner) });
      continue;
    }
    if ((m = LIST_RE.exec(line))) {
      const res = parseList(lines, i);
      blocks.push(res.block);
      i = res.next;
      continue;
    }
    if (indentOf(line) >= 4) {
      const body = [];
      while (i < lines.length && (indentOf(lines[i]) >= 4 || isBlank(lines[i]))) {
        body.push(dedent(lines[i], 4));
        i += 1;
      }
      while (body.length && isBlank(body[body.length - 1])) body.pop();
      blocks.push({ type: 'code', info: '', text: body.join('\n') });
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && TABLE_DELIM_RE.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const head = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map((c) => {
        const l = c.startsWith(':');
        const r = c.endsWith(':');
        return l && r ? 'c' : r ? 'r' : 'l';
      });
      const rows = [];
      i += 2;
      while (i < lines.length && !isBlank(lines[i]) && lines[i].includes('|') && !startsBlock(lines[i])) {
        rows.push(splitRow(lines[i]));
        i += 1;
      }
      blocks.push({ type: 'table', head, aligns, rows });
      continue;
    }
    if (HTML_BLOCK_RE.test(line)) {
      const body = [];
      while (i < lines.length && !isBlank(lines[i])) { body.push(lines[i]); i += 1; }
      blocks.push({ type: 'html', text: body.join('\n') });
      continue;
    }

    // A paragraph, possibly a setext heading.
    const para = [];
    while (i < lines.length && !isBlank(lines[i])) {
      if (para.length && SETEXT_RE.test(lines[i])) {
        const level = lines[i].trim()[0] === '=' ? 1 : 2;
        blocks.push({ type: 'heading', level, text: para.join(' ').trim() });
        para.length = 0;
        i += 1;
        break;
      }
      if (para.length && startsBlock(lines[i])) break;
      if (para.length && lines[i].includes('|') && i + 1 < lines.length && TABLE_DELIM_RE.test(lines[i + 1])) break;
      para.push(lines[i]);
      i += 1;
    }
    if (para.length) blocks.push({ type: 'paragraph', text: para.join('\n') });
  }
  return blocks;
}

function parseList(lines, start) {
  const first = LIST_RE.exec(lines[start]);
  const ordered = /\d/.test(first[2]);
  const delim = ordered ? first[2].slice(-1) : first[2];
  const startNumber = ordered ? parseInt(first[2], 10) : 1;
  const items = [];
  let i = start;
  while (i < lines.length) {
    const m = LIST_RE.exec(lines[i]);
    if (!m) break;
    const isOrdered = /\d/.test(m[2]);
    if (isOrdered !== ordered || (ordered ? m[2].slice(-1) : m[2]) !== delim) break;
    const markerWidth = m[1].length + m[2].length;
    const pad = m[3] === undefined ? 1 : m[3].length > 4 ? 1 : m[3].length;
    const contentIndent = markerWidth + pad;
    const itemLines = [m[4] === undefined ? '' : (m[3] && m[3].length > 4 ? ' '.repeat(m[3].length - 1) : '') + m[4]];
    i += 1;
    let lastBlank = false;
    while (i < lines.length) {
      const l = lines[i];
      if (isBlank(l)) { itemLines.push(''); lastBlank = true; i += 1; continue; }
      if (indentOf(l) >= contentIndent) { itemLines.push(dedent(l, contentIndent)); lastBlank = false; i += 1; continue; }
      if (lastBlank) break;
      if (LIST_RE.test(l) || startsBlock(l)) break;
      itemLines.push(l); // lazy continuation of the item's paragraph
      i += 1;
    }
    while (itemLines.length && isBlank(itemLines[itemLines.length - 1])) itemLines.pop();
    items.push(parseBlocks(itemLines));
    // A blank line between items is fine; anything else unindented ends the list.
    let j = i;
    while (j < lines.length && isBlank(lines[j])) j += 1;
    if (j < lines.length && LIST_RE.test(lines[j]) && indentOf(lines[j]) < 4) i = j;
    else break;
  }
  return { block: { type: 'list', ordered, start: startNumber, items }, next: i };
}

// ---------------------------------------------------------------------------
// inlines
// ---------------------------------------------------------------------------

const PUNCT_RE = /[!-/:-@[-`{-~\p{P}\p{S}]/u;
const SPACE_RE = /\s/u;
const SLUG_AT = new RegExp('^' + SLUG_PATTERN);
const URL_RE = /^(?:https?:\/\/|www\.)[^\s<]*[^\s<?!.,:*_~'")\]]/i;

/**
 * Parse inline Markdown into nodes: {t:'text', v}, {t:'code', v}, {t:'math', i},
 * {t:'ref', slug, before}, {t:'link', href, kids}, {t:'image', src, alt},
 * {t:'em'|'strong'|'del', kids}, {t:'br'}, {t:'url', href}.
 */
export function parseInline(src, { inLink = false } = {}) {
  const nodes = [];
  let text = '';
  let run = ''; // the plain text since the last node that was not text, for references
  const flush = () => {
    if (text) nodes.push({ t: 'text', v: text });
    text = '';
  };
  const push = (n) => { flush(); nodes.push(n); };
  let i = 0;
  const s = src;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') {
      const d = s[i + 1];
      if (d === '\n') { push({ t: 'br' }); run = ''; i += 2; continue; }
      if (d !== undefined && /[!-/:-@[-`{-~]/.test(d)) { text += d; run += d; i += 2; continue; }
      text += c; run += c; i += 1; continue;
    }
    if (c === TOKEN_OPEN) {
      const end = s.indexOf(TOKEN_CLOSE, i);
      push({ t: 'math', i: Number(s.slice(i + 1, end)) });
      run += ' ';
      i = end + 1;
      continue;
    }
    if (c === '`') {
      let n = 0;
      while (s[i + n] === '`') n += 1;
      const fence = '`'.repeat(n);
      let j = i + n;
      let found = -1;
      while (j < s.length) {
        const k = s.indexOf(fence, j);
        if (k < 0) break;
        if (s[k + n] !== '`' && s[k - 1] !== '`') { found = k; break; }
        j = k + 1;
        while (s[j] === '`') j += 1;
      }
      if (found >= 0) {
        let v = s.slice(i + n, found).replace(/\n/g, ' ');
        if (/^ .*[^ ] $|^ [^ ] $/.test(v) || (/^ /.test(v) && / $/.test(v) && v.trim())) v = v.slice(1, -1);
        push({ t: 'code', v });
        run = '';
        i = found + n;
        continue;
      }
      text += fence; run += fence; i += n; continue;
    }
    if (c === '!' && s[i + 1] === '[') {
      const link = parseLinkAt(s, i + 1);
      if (link) {
        push({ t: 'image', src: link.href, alt: plainOf(parseInline(link.label)) });
        run = '';
        i = link.end;
        continue;
      }
    }
    if (c === '[' && !inLink) {
      const link = parseLinkAt(s, i);
      if (link) {
        // Links do not nest: the text of one is not searched for others.
        push({ t: 'link', href: link.href, kids: parseInline(link.label, { inLink: true }) });
        run = '';
        i = link.end;
        continue;
      }
      const m = SLUG_AT.exec(s.slice(i));
      if (m) {
        push({ t: 'ref', slug: m[1], before: run });
        run = '';
        i += m[0].length;
        continue;
      }
    }
    if (c === '<') {
      const auto = /^<((?:https?|ftp|mailto):[^\s<>]*)>/i.exec(s.slice(i));
      if (auto) { push({ t: 'url', href: auto[1] }); run = ''; i += auto[0].length; continue; }
      const mail = /^<([A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)>/.exec(s.slice(i));
      if (mail) { push({ t: 'url', href: 'mailto:' + mail[1], text: mail[1] }); run = ''; i += mail[0].length; continue; }
      const tag = /^<(\/?)([A-Za-z][A-Za-z0-9]*)\b[^>]*?(\/?)>/.exec(s.slice(i));
      if (tag) {
        const name = tag[2].toLowerCase();
        if (name === 'br') { push({ t: 'br' }); run = ''; }
        else push({ t: 'tag', name, close: !!tag[1] });
        i += tag[0].length;
        continue;
      }
      const comment = /^<!--[\s\S]*?-->/.exec(s.slice(i));
      if (comment) { i += comment[0].length; continue; }
    }
    if (c === '&') {
      const ent = /^&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z]{2,8});/.exec(s.slice(i));
      if (ent) {
        const v = decodeEntities(ent[0]);
        text += v; run += v; i += ent[0].length; continue;
      }
    }
    if (!inLink && (c === 'h' || c === 'H' || c === 'w' || c === 'W') && (i === 0 || /[\s*_~(]/.test(s[i - 1]))) {
      const u = URL_RE.exec(s.slice(i));
      if (u) {
        push({ t: 'url', href: /^www\./i.test(u[0]) ? 'http://' + u[0] : u[0], text: u[0] });
        run = '';
        i += u[0].length;
        continue;
      }
    }
    if (c === '*' || c === '_' || c === '~') {
      let n = 0;
      while (s[i + n] === c) n += 1;
      const before = i === 0 ? ' ' : s[i - 1];
      const after = i + n >= s.length ? ' ' : s[i + n];
      // A maths token counts as a letter: `*$x$*` is emphasis.
      const ws = (x) => SPACE_RE.test(x);
      const pu = (x) => PUNCT_RE.test(x);
      const left = !ws(after) && (!pu(after) || ws(before) || pu(before));
      const right = !ws(before) && (!pu(before) || ws(after) || pu(after));
      let canOpen = left;
      let canClose = right;
      if (c === '_') {
        canOpen = left && (!right || pu(before));
        canClose = right && (!left || pu(after));
      }
      if (c === '~' && n > 2) { canOpen = false; canClose = false; }
      flush();
      nodes.push({ t: 'delim', c, n, orig: n, canOpen, canClose });
      run += c.repeat(n);
      i += n;
      continue;
    }
    if (c === '\n') {
      // Two spaces before a line end are a hard break; otherwise a space.
      if (/ {2,}$/.test(text)) { text = text.replace(/ +$/, ''); push({ t: 'br' }); run = ''; }
      else { text = text.replace(/ +$/, ''); text += ' '; run += ' '; }
      i += 1;
      while (s[i] === ' ') i += 1;
      continue;
    }
    text += c;
    run += c;
    i += 1;
  }
  flush();
  return resolveEmphasis(nodes);
}

/** `[label](href "title")` at `s[i] === '['`, or null. */
function parseLinkAt(s, i) {
  let depth = 0;
  let j = i;
  for (; j < s.length; j += 1) {
    if (s[j] === '\\') { j += 1; continue; }
    if (s[j] === '`') { const k = s.indexOf('`', j + 1); if (k > 0) j = k; continue; }
    if (s[j] === '[') depth += 1;
    else if (s[j] === ']') { depth -= 1; if (depth === 0) break; }
  }
  if (depth !== 0 || s[j + 1] !== '(') return null;
  const m = /^\(\s*(<[^>\n]*>|[^\s()]*(?:\([^\s()]*\)[^\s()]*)*)(?:\s+("[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/.exec(s.slice(j + 1));
  if (!m) return null;
  let href = m[1];
  if (href.startsWith('<')) href = href.slice(1, -1);
  return { label: s.slice(i + 1, j), href: decodeEntities(href.replace(/\\([!-/:-@[-`{-~])/g, '$1')), end: j + 1 + m[0].length };
}

/** CommonMark's "process emphasis", over the delimiter runs of `nodes`. */
function resolveEmphasis(nodes) {
  const list = nodes.slice();
  for (let ci = 0; ci < list.length; ci += 1) {
    const closer = list[ci];
    if (closer.t !== 'delim' || !closer.canClose || closer.n === 0) continue;
    for (let oi = ci - 1; oi >= 0; oi -= 1) {
      const opener = list[oi];
      if (opener.t !== 'delim' || opener.c !== closer.c || !opener.canOpen || opener.n === 0) continue;
      if (closer.c === '~') {
        if (opener.n !== closer.n) continue;
      } else if ((opener.canClose || closer.canOpen) && (opener.orig + closer.orig) % 3 === 0 &&
        !(opener.orig % 3 === 0 && closer.orig % 3 === 0)) {
        continue; // the rule of three
      }
      const use = closer.c === '~' ? closer.n : opener.n >= 2 && closer.n >= 2 ? 2 : 1;
      const type = closer.c === '~' ? 'del' : use === 2 ? 'strong' : 'em';
      const inner = list.slice(oi + 1, ci);
      opener.n -= use;
      closer.n -= use;
      const node = { t: type, kids: inner.map(delimToText) };
      list.splice(oi + 1, ci - oi - 1, node);
      ci = oi + 1;
      if (closer.n > 0) ci -= 1; // try the rest of the closer again
      break;
    }
  }
  return list.map(delimToText).filter((n) => !(n.t === 'text' && n.v === ''));
}

function delimToText(n) {
  return n.t === 'delim' ? { t: 'text', v: n.c.repeat(n.n) } : n;
}

/** The plain text of inline nodes (alt texts, the text before a reference). */
export function plainOf(nodes) {
  let out = '';
  for (const n of nodes) {
    if (n.t === 'text' || n.t === 'code') out += n.v;
    else if (n.kids) out += plainOf(n.kids);
    else if (n.t === 'url') out += n.text || n.href;
    else if (n.t === 'ref') out += n.slug;
  }
  return out;
}

// ---------------------------------------------------------------------------
// to LaTeX
// ---------------------------------------------------------------------------

/**
 * A Markdown body as LaTeX.  `ctx` answers for the parts that depend on the
 * document:
 *   ref(slug, before)       -> LaTeX for a `[slug]` reference
 *   math({display, body})   -> LaTeX for a maths span
 *   image(src, alt)         -> LaTeX for an image
 *   warn(code, message)     -> record a diagnostic
 */
export function markdownToLatex(src, ctx) {
  const { text, spans } = liftMath(String(src || '').replace(/\r\n?/g, '\n').replace(/\t/g, '    '));
  const blocks = parseBlocks(text.split('\n'));
  return renderBlocks(blocks, { ...ctx, spans }).trim();
}

/** A title (plain text with maths, as the website renders titles) as LaTeX. */
export function titleToLatex(title, ctx) {
  const { text, spans } = liftMath(String(title || ''));
  return text.split(TOKEN_RE).map((part, k) => (k % 2 ? ctx.math({ ...spans[Number(part)], display: false }) : escapeText(part))).join('');
}

/** A title as plain text for PDF bookmarks: maths without its delimiters. */
export function titleToPlain(title) {
  const { text, spans } = liftMath(String(title || ''));
  // Font and spacing commands go, their arguments stay; any other command is
  // its name ("\\alpha" reads "alpha"), which is what a bookmark can say.
  const plain = text.split(TOKEN_RE).map((part, k) => (k % 2
    ? spans[Number(part)].body
      .replace(/\\(?:math[a-z]+|text[a-z]*|operatorname\*?|mbox|left|right|[bB]ig+[lr]?|[,;:!]|quad|qquad)(?![A-Za-z])\s*/g, '')
      .replace(/\\([A-Za-z]+)/g, ' $1 ').replace(/[{}^_]/g, '').replace(/\s+/g, ' ').trim()
    : part)).join('');
  return plain;
}

function renderBlocks(blocks, ctx) {
  let out = '';
  for (let i = 0; i < blocks.length; i += 1) {
    const b = blocks[i];
    if (b.type === 'heading' && /^proof\b/i.test(plainOf(parseInline(b.text)).trim())) {
      // A proof still in the body: the heading and everything after it, up to
      // the next heading of the same level or above (`foldProofs`).
      let j = i + 1;
      while (j < blocks.length && !(blocks[j].type === 'heading' && blocks[j].level <= b.level)) j += 1;
      const label = inlineToLatex(parseInline(b.text), ctx).replace(/\.\s*$/, '');
      out += `\\begin{proof}[{${label}}]\n${renderBlocks(blocks.slice(i + 1, j), ctx).trim()}\n\\end{proof}\n\n`;
      i = j - 1;
      continue;
    }
    out += renderBlock(b, ctx) + '\n\n';
  }
  return out;
}

function renderBlock(b, ctx) {
  switch (b.type) {
    case 'paragraph': {
      const nodes = parseInline(b.text);
      // A paragraph that is one image is a figure.
      const real = nodes.filter((n) => !(n.t === 'text' && !n.v.trim()));
      if (real.length === 1 && real[0].t === 'image') return ctx.image(real[0].src, real[0].alt, { block: true });
      return inlineToLatex(nodes, ctx);
    }
    case 'heading':
      return `\\bpbodyheading{${inlineToLatex(parseInline(b.text), ctx)}}`;
    case 'hr':
      return '\\bprule';
    case 'quote':
      return `\\begin{quote}\n${renderBlocks(b.blocks, ctx).trim()}\n\\end{quote}`;
    case 'list': {
      const env = b.ordered ? 'enumerate' : 'itemize';
      const opt = b.ordered && b.start !== 1 ? `\\bpstartat{${b.start}}` : '';
      const items = b.items.map((blocks) => {
        const body = renderBlocks(blocks, ctx).trim();
        return '\\item ' + (body || '\\mbox{}');
      });
      return `\\begin{${env}}${opt}\n${items.join('\n')}\n\\end{${env}}`;
    }
    case 'code':
      return codeBlock(b.text, ctx);
    case 'table':
      return tableBlock(b, ctx);
    case 'html': {
      const stripped = b.text.replace(/<[^>]*>/g, ' ').replace(/[ \t]+/g, ' ').trim();
      if (b.text.replace(/<!--[\s\S]*?-->/g, '').trim()) {
        ctx.warn('html', 'raw HTML is set as its text');
      }
      return stripped ? inlineToLatex(parseInline(stripped), ctx) : '';
    }
    default:
      return '';
  }
}

const CODE_WIDTH = 78;

function codeBlock(text, ctx) {
  // Maths tokens inside a code block are its own text: put the source back.
  const raw = text.replace(TOKEN_RE, (_, k) => ctx.spans[Number(k)].source);
  const lines = [];
  for (const line of raw.split('\n')) {
    let l = line;
    // Verbatim cannot break a line; wrap long ones with a continuation mark.
    while (l.length > CODE_WIDTH) {
      lines.push(l.slice(0, CODE_WIDTH - 1) + '\u21A9');
      l = '  ' + l.slice(CODE_WIDTH - 1);
    }
    lines.push(l);
  }
  // Nothing inside may end the environment early.
  const safe = lines.map((l) => l.replace(/\\end\s*\{bpverbatim\}/g, '\\end {bpverbatim}'));
  return `\\begin{bpverbatim}\n${safe.join('\n')}\n\\end{bpverbatim}`;
}

function tableBlock(b, ctx) {
  const cols = Math.max(b.head.length, ...b.rows.map((r) => r.length));
  const aligns = Array.from({ length: cols }, (_, k) => b.aligns[k] || 'l');
  const cell = (c) => inlineToLatex(parseInline(c || ''), ctx);
  const row = (cells) => Array.from({ length: cols }, (_, k) => cell(cells[k])).join(' & ') + ' \\\\';
  const width = [b.head, ...b.rows].reduce((w, r) => Math.max(w, r.join('   ').length), 0);
  // A narrow table keeps its natural width; a wide one wraps its cells.
  const wide = width > 70;
  const spec = wide
    ? aligns.map((a) => (a === 'r' ? '>{\\raggedleft\\arraybackslash}X' : a === 'c' ? '>{\\centering\\arraybackslash}X' : '>{\\raggedright\\arraybackslash}X')).join('')
    : aligns.join('');
  const envOpen = wide ? `\\begin{tabularx}{\\linewidth}{${spec}}` : `\\begin{tabular}{${spec}}`;
  const envClose = wide ? '\\end{tabularx}' : '\\end{tabular}';
  return ['\\begin{center}\\small', envOpen, '\\toprule', row(b.head.map((h) => h)), '\\midrule',
    ...b.rows.map(row), '\\bottomrule', envClose, '\\end{center}'].join('\n');
}

export function inlineToLatex(nodes, ctx) {
  let out = '';
  const open = []; // raw HTML tags that map to something
  for (const n of nodes) {
    switch (n.t) {
      case 'text': out += escapeText(n.v); break;
      case 'code': out += `\\texttt{${escapeCode(n.v)}}`; break;
      case 'math': out += ctx.math(ctx.spans[n.i]); break;
      case 'ref': out += ctx.ref(n.slug, n.before); break;
      case 'em': out += `\\emph{${inlineToLatex(n.kids, ctx)}}`; break;
      case 'strong': out += `\\textbf{${inlineToLatex(n.kids, ctx)}}`; break;
      case 'del': out += `\\sout{${inlineToLatex(n.kids, ctx)}}`; break;
      case 'br': out += '\\\\\n'; break;
      case 'url': out += n.text && n.text !== n.href
        ? `\\href{${escapeUrl(n.href)}}{\\nolinkurl{${escapeUrl(n.text)}}}`
        : `\\url{${escapeUrl(n.href)}}`; break;
      case 'link': {
        const label = inlineToLatex(n.kids, ctx);
        if (/^(?:https?|ftp|mailto):/i.test(n.href)) out += `\\href{${escapeUrl(n.href)}}{${label}}`;
        else out += label; // a link into the website, or relative: its text
        break;
      }
      case 'image': out += ctx.image(n.src, n.alt, { block: false }); break;
      case 'tag': {
        const map = { em: 'emph', i: 'textit', b: 'textbf', strong: 'textbf', sup: 'textsuperscript',
          sub: 'textsubscript', code: 'texttt', kbd: 'texttt', u: 'uline', s: 'sout', del: 'sout' };
        if (!map[n.name]) break; // other markup: dropped, its text stays
        if (!n.close) { out += `\\${map[n.name]}{`; open.push(n.name); }
        else if (open.length && open[open.length - 1] === n.name) { out += '}'; open.pop(); }
        break;
      }
      default: break;
    }
  }
  while (open.length) { out += '}'; open.pop(); }
  return out;
}
