// highlight.js — syntax highlighting for a body's fenced code.
//
// A body's ```` ```lean ```` block is a `<pre><code class="language-lean">`
// once marked has run; `tokens` cuts its text into the runs that are coloured
// (`app.highlightCode` puts them on the page as `span.hl-<type>`, `style.css`
// colours them).  Pure: no DOM, no dependencies.  Small on purpose: a
// highlighter for the snippets a blueprint shows, not a parser.  A language it
// does not know is left as it is, plain monospace.

/**
 * The kinds of run: `keyword`, `comment`, `string`, `number`, `sorry`,
 * `attribute` (`@[simp]`) and `symbol` (`→`, `∀`, `⟨`, …); everything else is
 * `text`.
 */
export const TOKEN_TYPES = ['keyword', 'comment', 'string', 'number', 'sorry', 'attribute', 'symbol'];

// ---------------------------------------------------------------------- Lean

const LEAN_KEYWORDS = new Set((
  'def theorem lemma example abbrev instance structure class inductive coinductive where extends ' +
  'deriving namespace section end open export import variable universe noncomputable private ' +
  'protected partial unsafe mutual axiom opaque irreducible_def set_option attribute local scoped ' +
  'macro macro_rules syntax elab elab_rules notation infix infixl infixr prefix postfix ' +
  'by fun λ let have show from at do then else if match with return for in mut unless break ' +
  'continue calc suffices obtain termination_by decreasing_by try catch finally nomatch nofun ' +
  'Type Sort Prop'
).split(' '));

const LEAN_SORRY = new Set(['sorry', 'admit']);

// An identifier: letters (Greek and the rest of Unicode's), digits, `_`, `'`,
// `!` and `?`, subscripts; dotted (`Nat.succ_le`).  λ is a letter to Unicode
// but a keyword to Lean, so it is a word of its own.
const LEAN_IDENT = /(?:λ|«[^»\n]*»|[\p{L}_](?:[\p{L}\p{N}_'!?₀-ₜᵢ-ᵪⱼ])*)(?:\.(?:«[^»\n]*»|[\p{L}_](?:[\p{L}\p{N}_'!?₀-ₜᵢ-ᵪⱼ])*))*/uy;
const LEAN_NUMBER = /(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)/y;
const LEAN_STRING = /"(?:[^"\\]|\\[\s\S])*(?:"|$)/y;
const LEAN_RAW_STRING = /r(#*)"[\s\S]*?(?:"\1|$)/y;
const LEAN_CHAR = /'(?:[^'\\\n]|\\(?:x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|.))'/y;
const LEAN_COMMAND = /#[a-z_]+/y;

/** A `/- … -/` comment from `i` (nested ones included), to its end or the text's. */
function leanBlockComment(s, i) {
  let depth = 0;
  let j = i;
  while (j < s.length) {
    if (s.startsWith('/-', j)) { depth += 1; j += 2; continue; }
    if (s.startsWith('-/', j)) { depth -= 1; j += 2; if (depth === 0) return j; continue; }
    j += 1;
  }
  return j;
}

/** An `@[…]` attribute from `i`, brackets balanced, to its end or the line's. */
function leanAttribute(s, i) {
  let depth = 0;
  for (let j = i + 1; j < s.length; j += 1) {
    const c = s[j];
    if (c === '\n') return j;
    if (c === '[') depth += 1;
    else if (c === ']') { depth -= 1; if (depth === 0) return j + 1; }
  }
  return s.length;
}

function at(re, s, i) {
  re.lastIndex = i;
  const m = re.exec(s);
  return m ? m[0] : null;
}

const IDENT_CHAR = /[\p{L}\p{N}_'!?]/u;

function leanTokens(s) {
  const out = [];
  const push = (type, text) => {
    const last = out[out.length - 1];
    if (last && last.type === type) last.text += text;
    else out.push({ type, text });
  };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    const prev = i > 0 ? s[i - 1] : '';
    let m;
    if (s.startsWith('/-', i)) {
      const j = leanBlockComment(s, i);
      push('comment', s.slice(i, j)); i = j; continue;
    }
    if (s.startsWith('--', i)) {
      let j = s.indexOf('\n', i);
      if (j < 0) j = s.length;
      push('comment', s.slice(i, j)); i = j; continue;
    }
    if (s.startsWith('@[', i)) {
      const j = leanAttribute(s, i);
      push('attribute', s.slice(i, j)); i = j; continue;
    }
    if (c === '"') {
      m = at(LEAN_STRING, s, i);
      push('string', m); i += m.length; continue;
    }
    if (c === 'r' && (m = at(LEAN_RAW_STRING, s, i)) && !IDENT_CHAR.test(prev)) {
      push('string', m); i += m.length; continue;
    }
    if (c === "'" && !IDENT_CHAR.test(prev) && (m = at(LEAN_CHAR, s, i))) {
      push('string', m); i += m.length; continue;
    }
    if (c === '#' && (m = at(LEAN_COMMAND, s, i))) {
      push('keyword', m); i += m.length; continue;
    }
    if ((m = at(LEAN_IDENT, s, i))) {
      push(LEAN_SORRY.has(m) ? 'sorry' : LEAN_KEYWORDS.has(m) ? 'keyword' : 'text', m);
      i += m.length; continue;
    }
    if (/\d/.test(c) && (m = at(LEAN_NUMBER, s, i))) {
      push('number', m); i += m.length; continue;
    }
    const cp = s.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    // What is not ASCII and no letter or digit: →, ∀, ⟨, ≤, ∘, ×, …
    push(cp > 0x7f && !/[\p{L}\p{N}\s]/u.test(ch) ? 'symbol' : 'text', ch);
    i += ch.length;
  }
  return out;
}

// ------------------------------------------------------------------ registry

// The languages known, by the name an info string gives them.
const LANGUAGES = new Map([
  ['lean', leanTokens],
  ['lean4', leanTokens],
]);

/** Whether `lang` (an info string's first word, any case) is highlighted. */
export function knowsLanguage(lang) {
  return LANGUAGES.has(String(lang || '').toLowerCase());
}

/**
 * The runs of `code` in `lang`: [{type, text}], whose texts put together are
 * `code` again, neighbours never of the same type.  null for a language
 * `knowsLanguage` does not know.
 */
export function tokens(code, lang) {
  const f = LANGUAGES.get(String(lang || '').toLowerCase());
  return f ? f(String(code)) : null;
}

/**
 * The language of a `<code>` element marked has written, from its class:
 * `language-lean` is `lean`.  null for none.
 */
export function languageOfClass(className) {
  const m = /(?:^|\s)language-(\S+)/.exec(String(className || ''));
  return m ? m[1] : null;
}
