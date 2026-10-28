// export/latex.js — a blueprint, or part of it, as a LaTeX document.
//
// What is in the document, in what order and under which number is not decided
// here: it is the website's document (`documentOutline` in model.js, DESIGN.md
// §6), read along the same collapse order, with the same numbers, the same
// proofs filed after their statements, the same steps and the same text.  This
// module chooses a part of that document and writes it out:
//
//   * the scope is the whole blueprint or one entry of the outline, with
//     everything below it;
//   * the depth is how many levels below the scope are written out, counted as
//     the document's pages count them (`documentPageEntries`): `all`, or n.
//     A proof and a step belong to their statement and come with it at any
//     depth; a proof with details of its own is an entry, and its details are
//     one level below it;
//   * an appendix (a kind the graph may hide, `graph = "optional"`) inside the
//     scope can be left out;
//   * an object with several parents is written out once, where this export
//     first meets it, with what is below it, and is a pointer to that place
//     everywhere else.  When its first place in the full document is outside
//     the export (a lemma shared with another section), it is still written
//     out here, never left as a pointer to a page that is not in the PDF.
//
// Pure: no DOM, no node APIs.  The command line (`cli.mjs`) and the browser
// both import it, so the PDF and the TeX a reader downloads come from one
// reading of the snapshot.

import * as M from '../model.js';
import { markdownToLatex, titleToLatex, titleToPlain, escapeText, escapeCode } from './markdown-tex.js';
import { unicodeDeclarations, isTextLetter } from './unicode.js';

/** Changes whenever the TeX written for the same request could change. */
export const GENERATOR = 'blueprint-pdf/1';

/** A request that cannot be met, with a code the command line maps to an exit status. */
export class ExportError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ExportError';
    this.code = code; // 'invalid' (a bad request) | 'empty' (nothing to export)
  }
}

// ---------------------------------------------------------------------------
// requests and scopes
// ---------------------------------------------------------------------------

/** Whether objects of a kind are appendices: drawn unless hidden (`optional`). */
function isAppendix(model, o) {
  return M.graphHint(model, o.kind) === 'optional';
}

/**
 * The parts a reader can export along `collapse`: the whole blueprint first
 * (`id: null`), then every entry of the document with entries below it, in
 * reading order, as {id, number, title, word, depth, appendix}.  These are the
 * document's pages, so a section, a subsection and a refined statement or
 * relation are all parts.
 */
export function exportScopes(model, collapse) {
  const kind = pickCollapse(model, collapse);
  const outline = M.documentOutline(model, kind);
  const out = [{ id: null, number: null, title: projectTitle(model), word: null, depth: -1, appendix: false }];
  for (const e of outline.entries) {
    if (e.duplicate || e.text || !e.children.length) continue;
    out.push({ id: e.id, number: e.number, title: entryTitle(model, outline, e), word: M.kindWord(e.object.kind),
      depth: e.depth, appendix: isAppendix(model, e.object) });
  }
  return out;
}

/**
 * How an entry is named in a heading, the contents and the export dialog: its
 * title, or for an untitled proof with details of its own, what it proves
 * ("Proof of Theorem 2.2"), rather than its id.
 */
export function entryTitle(model, outline, entry) {
  const o = entry.object;
  const t = o.attrs && typeof o.attrs.title === 'string' && o.attrs.title;
  if (!t && o.kind === 'proof') {
    const of = M.attachedTo(o);
    const ref = of ? M.referenceOf(outline, of) : null;
    if (ref) return `Proof of ${ref.word} ${ref.number}`;
  }
  return M.titleOf(o);
}

function projectTitle(model) {
  return model.project.title || model.project.name || 'Blueprint';
}

function pickCollapse(model, wanted) {
  if (wanted === undefined || wanted === null || wanted === '') {
    const k = model.defaultCollapse || model.collapseKinds[0];
    if (!k) throw new ExportError('invalid', 'the blueprint has no collapsible kind, so it has no document to export');
    return k;
  }
  if (!model.collapseKinds.includes(wanted)) {
    throw new ExportError('invalid', `'${wanted}' is not a collapse kind of this blueprint` +
      (model.collapseKinds.length ? ` (it has ${model.collapseKinds.map((k) => `'${k}'`).join(', ')})` : ''));
  }
  return wanted;
}

function parseDepth(raw) {
  if (raw === undefined || raw === null || raw === '' || raw === 'all' || raw === Infinity) return Infinity;
  const n = typeof raw === 'number' ? raw : /^\d+$/.test(String(raw)) ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > 1000) {
    throw new ExportError('invalid', `the depth must be 'all' or a whole number of levels from 1, not '${raw}'`);
  }
  return n;
}

/**
 * Check a request against the snapshot and put it in its one canonical form:
 * {collapse, scope, depth, appendices}, `scope` an id or null for the whole
 * blueprint, `depth` 'all' or the number of levels below the scope, where a
 * depth that cuts nothing is 'all' and the appendix choice is true when the
 * scope has no appendix to leave out.  Two requests with the same canonical
 * form write the same document, which is what makes it a cache key.
 * Throws an ExportError('invalid') naming what is wrong.
 */
export function resolveRequest(model, raw = {}) {
  const collapse = pickCollapse(model, raw.collapse);
  const outline = M.documentOutline(model, collapse);
  let scope = raw.scope === undefined || raw.scope === '' ? null : raw.scope;
  if (scope !== null && typeof scope !== 'string') throw new ExportError('invalid', 'the scope must be an object id');
  let entry = null;
  if (scope !== null) {
    if (!model.byId.has(scope)) throw new ExportError('invalid', `there is no object '${scope}' in this blueprint`);
    if (outline.stepOf.has(scope)) {
      const of = outline.stepOf.get(scope);
      throw new ExportError('invalid', `'${scope}' is read as part of '${of}'; export '${of}' instead`);
    }
    entry = outline.byId.get(scope);
    if (!entry) {
      throw new ExportError('invalid', `'${scope}' is not in the document along '${collapse}': it carries no prose and contains nothing`);
    }
    if (entry.text) {
      const where = entry.parent ? entry.parent.id : null;
      throw new ExportError('invalid', `'${scope}' is text read in place` + (where ? ` inside '${where}'; export '${where}' instead` : '; export the whole blueprint instead'));
    }
  }
  const wanted = parseDepth(raw.depth);
  const appendicesWanted = raw.appendices === undefined ? true : raw.appendices !== false && raw.appendices !== 'false' && raw.appendices !== '0';
  const full = planTree(model, outline, entry, Infinity, true);
  if (!full.nodes.length) throw new ExportError('empty', 'nothing to export: no object of this blueprint carries prose');
  const depth = wanted >= full.height ? 'all' : wanted;
  const appendices = full.appendices ? appendicesWanted : true;
  return { collapse, scope, depth, appendices, height: full.height, hasAppendices: full.appendices };
}

/** The canonical form of a request as one string, for caches and manifests. */
export function requestKey(req) {
  return [req.collapse, req.scope === null ? '' : req.scope, String(req.depth), req.appendices ? 'a' : 'n'].join('\u001F');
}

// ---------------------------------------------------------------------------
// the plan: which entries, in what order, written out where
// ---------------------------------------------------------------------------

/**
 * The export as a tree of nodes, in reading order:
 *   {type: 'entry', entry, rel, children, parent, omitted, displaced}
 *   {type: 'text', entry, rel, parent}
 *   {type: 'pointer', entry, rel, parent, target}
 * `rel` is the level below the scope (the scope is 0; for the whole blueprint
 * the top-level entries are 1).  `entry` is always the first, written-out
 * entry of the outline, so its number, children and parent are the full
 * document's; `displaced` says the full document writes it out somewhere
 * else.  Returns {nodes, written, height, appendices}: `written` maps an id
 * to its node, `height` is the deepest `rel` written with depth all (at
 * least 1), `appendices` whether an appendix other than the scope was met.
 */
function planTree(model, outline, scopeEntry, depth, appendices) {
  const written = new Map();
  let height = 1;
  let sawAppendix = false;
  const visit = (e, rel, parent) => {
    if (e.text) {
      if (e.duplicate || written.has(e.id)) return null; // said once, under its first parent
      const node = { type: 'text', entry: e, rel, parent };
      written.set(e.id, node);
      return node;
    }
    const real = e.duplicate ? outline.byId.get(e.id) : e;
    if (!real) return null;
    if (written.has(real.id)) return { type: 'pointer', entry: real, rel, parent, target: written.get(real.id) };
    if (real !== scopeEntry && isAppendix(model, real.object)) {
      sawAppendix = true;
      if (!appendices) return null;
    }
    const node = { type: 'entry', entry: real, rel, parent, children: [], omitted: 0, displaced: e !== real };
    written.set(real.id, node);
    height = Math.max(height, rel);
    if (rel < depth) {
      for (const c of real.children) {
        const n = visit(c, rel + 1, node);
        if (n) node.children.push(n);
      }
    } else {
      node.omitted = countBelow(real, new Set());
    }
    return node;
  };
  const nodes = [];
  if (scopeEntry) {
    const n = visit(scopeEntry, 0, null);
    if (n) nodes.push(n);
  } else {
    for (const r of outline.roots) {
      const n = visit(r, 1, null);
      if (n) nodes.push(n);
    }
  }
  return { nodes, written, height, appendices: sawAppendix };
}

/** How many entries, other than text, are below an entry. */
function countBelow(entry, seen) {
  let n = 0;
  for (const c of entry.children) {
    if (c.text || seen.has(c.id)) continue;
    seen.add(c.id);
    n += 1;
    if (!c.duplicate) n += countBelow(c, seen);
  }
  return n;
}

/**
 * What an export of `request` writes out, without writing it: the plan tree
 * and the canonical request.  The website's export dialog uses this to say
 * how much a choice covers.
 */
export function planExport(model, request) {
  const req = resolveRequest(model, request);
  const outline = M.documentOutline(model, req.collapse);
  const scopeEntry = req.scope === null ? null : outline.byId.get(req.scope);
  const plan = planTree(model, outline, scopeEntry, req.depth === 'all' ? Infinity : req.depth, req.appendices);
  let entries = 0;
  let proofs = 0;
  const walk = (nodes) => {
    for (const n of nodes) {
      if (n.type !== 'entry') continue;
      entries += 1;
      proofs += (outline.proofs.get(n.entry.id) || []).length + (n.entry.object.kind === 'proof' ? 1 : 0);
      walk(n.children);
    }
  };
  walk(plan.nodes);
  return { request: req, outline, scopeEntry, plan, stats: { entries, proofs } };
}

// ---------------------------------------------------------------------------
// names
// ---------------------------------------------------------------------------

/** A file-name-safe ASCII slug. */
export function slugify(s, max = 48) {
  const out = String(s || '')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\$[^$]*\$/g, ' ')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return (out.slice(0, max).replace(/-+$/, '')) || 'part';
}

/** The file name, without extension, an export is downloaded as. */
export function exportFileName(model, req) {
  const project = slugify(model.project.name || model.project.title || 'blueprint', 32);
  let scope = 'whole';
  if (req.scope !== null) {
    const e = M.documentOutline(model, req.collapse).byId.get(req.scope);
    scope = (e && e.number ? e.number.replace(/\./g, '-') + '-' : '') + slugify(e ? entryTitle(model, M.documentOutline(model, req.collapse), e) : req.scope);
  }
  const parts = [project, scope];
  if (req.depth !== 'all') parts.push('depth-' + req.depth);
  if (req.collapse !== (model.defaultCollapse || model.collapseKinds[0])) parts.push(slugify(req.collapse, 24));
  if (!req.appendices) parts.push('no-appendix');
  return parts.join('-');
}

/** How a choice reads to a person: the scope and the detail. */
export function describeRequest(model, req) {
  const outline = M.documentOutline(model, req.collapse);
  const e = req.scope === null ? null : outline.byId.get(req.scope);
  const scope = e
    ? `${M.kindWord(e.object.kind)} ${e.number} ${entryTitle(model, outline, e)}`
    : 'The whole blueprint';
  const below = e ? `${M.kindWord(e.object.kind)} ${e.number}` : 'the top level';
  const detail = req.depth === 'all'
    ? 'all levels'
    : req.depth === 1 && !e ? 'the top level only'
      : `${req.depth} ${req.depth === 1 ? 'level' : 'levels'} below ${below}`;
  return { scope, detail, appendices: req.hasAppendices ? (req.appendices ? 'appendices included' : 'appendices left out') : null };
}

// ---------------------------------------------------------------------------
// LaTeX
// ---------------------------------------------------------------------------

/** Kinds set as theorems are (italic statement); every other kind is upright. */
const ITALIC_KINDS = new Set(['theorem', 'lemma', 'proposition', 'corollary', 'conjecture', 'claim']);

const HEADINGS = ['section', 'subsection', 'subsubsection', 'paragraph'];

// Names a project's macros must not take over: TeX and LaTeX would stop
// working, not merely print differently.
const RESERVED_MACROS = new Set(('begin end par relax def edef gdef xdef let global long outer item label ref ' +
  'pageref section subsection subsubsection paragraph chapter part document documentclass usepackage ' +
  'newcommand renewcommand providecommand newenvironment renewenvironment input include includeonly ' +
  'catcode makeatletter makeatother protect empty space hbox vbox mbox the else fi if ifx ifnum ifdim ' +
  'csname endcsname expandafter noexpand string number romannumeral write immediate openout openin ' +
  'read special shipout output everypar ensuremath left right hyperref href url hypertarget hyperlink ' +
  'phantomsection addcontentsline tableofcontents maketitle text frac sqrt textbf textit emph texttt ' +
  'mathrm mathbf mathcal mathbb mathfrak operatorname DeclareUnicodeCharacter newline linebreak ' +
  'pagebreak newpage clearpage vspace hspace quad qquad').split(' ').map((n) => '\\' + n));

/** The project's KaTeX macros as LaTeX definitions, and what was left out. */
export function macroDefinitions(macros, warn) {
  const lines = [];
  if (!macros || typeof macros !== 'object') return lines;
  for (const name of Object.keys(macros).sort()) {
    const def = macros[name];
    if (typeof def !== 'string') continue;
    if (!/^\\[A-Za-z]+$/.test(name)) { warn('macro-skipped', `the macro ${name} is not a LaTeX control word; left out`); continue; }
    if (RESERVED_MACROS.has(name)) { warn('macro-skipped', `the macro ${name} would replace a LaTeX command; left out`); continue; }
    let depth = 0;
    let balanced = true;
    for (let i = 0; i < def.length; i += 1) {
      if (def[i] === '\\') { i += 1; continue; }
      if (def[i] === '{') depth += 1;
      else if (def[i] === '}') { depth -= 1; if (depth < 0) balanced = false; }
    }
    if (!balanced || depth !== 0) { warn('macro-skipped', `the macro ${name} has unbalanced braces; left out`); continue; }
    let args = 0;
    for (const m of def.matchAll(/#([1-9])/g)) args = Math.max(args, Number(m[1]));
    lines.push(`\\providecommand{${name}}{}\\renewcommand{${name}}${args ? `[${args}]` : ''}{${def}}`);
  }
  return lines;
}

// Commands KaTeX has that LaTeX with these packages lacks, so that a formula
// the website renders also compiles.  Each only where LaTeX has none.
const COMPAT = String.raw`\providecommand{\R}{\mathbb{R}}\providecommand{\N}{\mathbb{N}}\providecommand{\Z}{\mathbb{Z}}
\providecommand{\Q}{\mathbb{Q}}\providecommand{\C}{\mathbb{C}}
\providecommand{\Reals}{\mathbb{R}}\providecommand{\reals}{\mathbb{R}}\providecommand{\Complex}{\mathbb{C}}
\providecommand{\cnums}{\mathbb{C}}\providecommand{\natnums}{\mathbb{N}}\providecommand{\Bbb}[1]{\mathbb{#1}}
\providecommand{\bold}[1]{\mathbf{#1}}\providecommand{\frak}[1]{\mathfrak{#1}}\providecommand{\mathbbm}[1]{\mathbb{#1}}
\providecommand{\lang}{\langle}\providecommand{\rang}{\rangle}\providecommand{\bra}[1]{\langle #1\rvert}
\providecommand{\ket}[1]{\lvert #1\rangle}\providecommand{\braket}[1]{\langle #1\rangle}
\providecommand{\set}[1]{\{#1\}}\providecommand{\Set}[1]{\left\{#1\right\}}
\providecommand{\infin}{\infty}\providecommand{\isin}{\in}\providecommand{\plusmn}{\pm}\providecommand{\sub}{\subset}
\providecommand{\sube}{\subseteq}\providecommand{\supe}{\supseteq}\providecommand{\exist}{\exists}
\providecommand{\bull}{\bullet}\providecommand{\larr}{\leftarrow}\providecommand{\rarr}{\rightarrow}
\providecommand{\lrarr}{\leftrightarrow}\providecommand{\Larr}{\Leftarrow}\providecommand{\Rarr}{\Rightarrow}
\providecommand{\Lrarr}{\Leftrightarrow}\providecommand{\uarr}{\uparrow}\providecommand{\darr}{\downarrow}
\providecommand{\harr}{\leftrightarrow}\providecommand{\lArr}{\Leftarrow}\providecommand{\rArr}{\Rightarrow}
\providecommand{\hArr}{\Leftrightarrow}\providecommand{\alef}{\aleph}\providecommand{\alefsym}{\aleph}
\providecommand{\real}{\Re}\providecommand{\image}{\Im}\providecommand{\weierp}{\wp}
\providecommand{\Alpha}{\mathrm{A}}\providecommand{\Beta}{\mathrm{B}}\providecommand{\Epsilon}{\mathrm{E}}
\providecommand{\Zeta}{\mathrm{Z}}\providecommand{\Eta}{\mathrm{H}}\providecommand{\Iota}{\mathrm{I}}
\providecommand{\Kappa}{\mathrm{K}}\providecommand{\Mu}{\mathrm{M}}\providecommand{\Nu}{\mathrm{N}}
\providecommand{\Omicron}{\mathrm{O}}\providecommand{\Rho}{\mathrm{P}}\providecommand{\Tau}{\mathrm{T}}
\providecommand{\Chi}{\mathrm{X}}\providecommand{\omicron}{o}\providecommand{\gt}{>}\providecommand{\lt}{<}
\providecommand{\And}{\&}\providecommand{\hdashline}{\hline}\providecommand{\operatornamewithlimits}[1]{\operatorname*{#1}}
\providecommand{\llbracket}{[\![}\providecommand{\rrbracket}{]\!]}\providecommand{\cancel}[1]{#1}
\providecommand{\mathscr}{\mathcal}`;

const PREAMBLE = String.raw`\usepackage[T1]{fontenc}
\usepackage[utf8]{inputenc}
\usepackage{lmodern}
\usepackage{textcomp}
\usepackage[a4paper,margin=2.5cm,headheight=14pt]{geometry}
\usepackage{amsmath,amssymb,amsthm}
\usepackage{mathtools}
\usepackage{bm}
\usepackage{graphicx}
\usepackage{xcolor}
\usepackage{array,booktabs,tabularx}
\usepackage{fancyvrb}
\usepackage[normalem]{ulem}
\usepackage{microtype}
% Optional, and only with their fonts: a small TeX installation has the
% packages without the fonts, which fails at the first formula.
\IfFileExists{mathrsfs.sty}{\IfFileExists{rsfs10.tfm}{\usepackage{mathrsfs}}{}}{}
\IfFileExists{stmaryrd.sty}{\IfFileExists{stmary10.tfm}{\usepackage{stmaryrd}}{}}{}
\IfFileExists{cancel.sty}{\usepackage{cancel}}{}
\usepackage[hyphens]{url}
\usepackage[pdfusetitle,bookmarksnumbered=false]{hyperref}
\usepackage{bookmark}
\definecolor{bplink}{HTML}{1F4E9C}
\definecolor{bpmuted}{HTML}{5F676E}
\hypersetup{colorlinks=true,linkcolor=bplink,urlcolor=bplink,citecolor=bplink}
\setlength{\parindent}{0pt}
\setlength{\parskip}{0.55em plus 0.2em minus 0.1em}
% Lists as tight as the page's.
\makeatletter
\def\@listi{\leftmargin\leftmargini\parsep 0pt\topsep 0.3em plus 0.1em\itemsep 0.1em plus 0.1em}
\let\@listI\@listi
\def\@listii{\leftmargin\leftmarginii\labelwidth\leftmarginii\advance\labelwidth-\labelsep\parsep 0pt\topsep 0.1em\itemsep 0.1em}
% An ordered list that does not start at 1.
\newcommand{\bpstartat}[1]{\setcounter{\@enumctr}{\numexpr#1-1\relax}}
\makeatother
\setcounter{tocdepth}{3}
\emergencystretch=3em
\allowdisplaybreaks

% A numbered statement, set as a paper sets one: "Theorem 2.1 (Title)."
% #1 is the lead ("Theorem~2.1"), #2 what follows it in roman.
\newenvironment{bpstatement}[2]{\par\addvspace{0.6\baselineskip}\noindent\textbf{#1}#2\textbf{.}\enspace\ignorespaces}
  {\par\addvspace{0.4\baselineskip}}
\newenvironment{bpstatementit}[2]{\begin{bpstatement}{#1}{#2}\itshape\ignorespaces}{\end{bpstatement}}
% A step: a relation with prose of its own, read under the object it starts from.
\newenvironment{bpstep}[1]{\par\addvspace{0.3\baselineskip}\begin{list}{}{\leftmargin=1.6em\rightmargin=0pt\topsep=0pt}\item\relax
  {\small\color{bpmuted}#1}\par\nopagebreak}{\end{list}\par}
% Notes about where an object is written out.
\newenvironment{bpnote}{\par\small\color{bpmuted}\itshape}{\par}
\newcommand{\bpomitted}[1]{\par{\small\color{bpmuted}\itshape #1\par}}
\newcommand{\bpbodyheading}[1]{\par\addvspace{0.4\baselineskip}\noindent\textbf{#1}\par\nopagebreak}
\newcommand{\bprule}{\par\medskip\noindent\hfil\rule{0.3\linewidth}{0.4pt}\hfil\par\medskip}
\newcommand{\bpboundary}[1]{\par\nopagebreak{\small\color{bpmuted}#1\par}\nopagebreak}
% A reference to something this export leaves out, and one that resolves nowhere.
\newcommand{\bpout}[1]{#1\textsuperscript{\hyperlink{bp-outside}{\ensuremath{\ast}}}}
\newcommand{\bpbroken}[1]{\textcolor{red!70!black}{[#1?]}}
\newcommand{\bpslug}[1]{\texttt{#1}}
% A character the export knows no way to set.
\newcommand{\bpglyph}[1]{\fbox{\scriptsize #1}}
% Images, at their own size unless they are wider than the line.
\newsavebox{\bpimagebox}
\newcommand{\bpimage}[1]{\sbox{\bpimagebox}{\includegraphics{#1}}%
  \ifdim\wd\bpimagebox>\linewidth\resizebox{\linewidth}{!}{\usebox{\bpimagebox}}\else\usebox{\bpimagebox}\fi}
\newcommand{\bpmissingimage}[1]{\fbox{\parbox{0.8\linewidth}{\centering\small\color{bpmuted}Image not included: #1}}}
\DefineVerbatimEnvironment{bpverbatim}{Verbatim}{fontsize=\small,xleftmargin=1em}
\renewcommand{\qedsymbol}{\ensuremath{\blacksquare}}`;

/**
 * Write the export of `request` as a complete LaTeX document.
 *
 * `options`:
 *   resolveAsset(object, src) -> {path} | {error}   where an image is, for
 *       the command line, which can read the project's files; left out (the
 *       browser) every image is a placeholder;
 *   snapshot: {label}   how the title block names the snapshot.
 *
 * Returns {tex, request, fileName, title, assets, diagnostics, stats}.
 * `assets` are what `resolveAsset` returned for the images the document
 * uses; `diagnostics` are {level, code, message, object} records, never
 * thrown: every one of them still leaves a document that compiles.
 */
export function exportLatex(model, request, options = {}) {
  const { request: req, outline, scopeEntry, plan, stats } = planExport(model, request);
  const diagnostics = [];
  let current = null; // the object whose prose is being written
  const warn = (code, message, level = 'warning') => {
    diagnostics.push({ level, code, message, object: current });
  };

  // Labels: one per object written out here, entries, proofs and steps alike.
  const labels = new Map();
  const labelOf = (id) => {
    if (!labels.has(id)) labels.set(id, 'bp' + (labels.size + 1));
    return labels.get(id);
  };
  const writtenHere = (id) => labels.has(id) || plan.written.has(id);
  // Every proof and step under an entry written here is written here too.
  const filedHere = new Set();
  const fileSteps = (id, seen = new Set()) => {
    for (const s of outline.steps.get(id) || []) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      filedHere.add(s.id);
      fileSteps(s.id, seen);
    }
  };
  for (const [id, node] of plan.written) {
    if (node.type === 'pointer') continue;
    for (const p of outline.proofs.get(id) || []) { filedHere.add(p.id); fileSteps(p.id); }
    fileSteps(id);
  }
  // Allocate labels in reading order, so they read bp1, bp2, … down the file.
  const allocate = (nodes) => {
    for (const n of nodes) {
      if (n.type === 'pointer') continue;
      labelOf(n.entry.id);
      if (n.children) allocate(n.children);
    }
  };
  allocate(plan.nodes);
  for (const id of filedHere) labelOf(id);

  const outside = new Map(); // id -> {ref, entry}

  /** How a reference to `id` reads here, linked when it is written out here. */
  const reference = (slug, before) => {
    const o = model.byId.get(slug);
    if (!o) {
      warn('unresolved-reference', `[${slug}] resolves to no object of this blueprint`);
      return `\\bpbroken{${escapeText(slug)}}`;
    }
    const ref = M.referenceOf(outline, slug);
    if (ref) {
      const text = escapeText(M.referenceLabel(model, ref, before));
      if (writtenHere(slug)) return `\\hyperref[${labelOf(slug)}]{${text}}`;
      outside.set(slug, { ref, entry: outline.byId.get(slug) });
      return `\\bpout{${text}}`;
    }
    // No number: a step or a proof (read as part of its statement), or an
    // object the document does not show.  The website keeps the slug.
    if (filedHere.has(slug) || plan.written.has(slug)) return `\\hyperref[${labelOf(slug)}]{\\bpslug{${escapeCode(slug)}}}`;
    return `\\bpslug{${escapeCode(slug)}}`;
  };

  /** An object named in a boundary or a step's head: its title and number. */
  const objectName = (id) => {
    const o = model.byId.get(id);
    if (!o) return `\\bpbroken{${escapeText(id)}}`;
    const ref = M.referenceOf(outline, id);
    // An object with no title is named by its id, as the website names it.
    const title = o.attrs && typeof o.attrs.title === 'string' && o.attrs.title
      ? titleTex(o.attrs.title) : `\\bpslug{${escapeCode(id)}}`;
    if (!ref) return filedHere.has(id) ? `\\hyperref[${labelOf(id)}]{${title}}` : title;
    const tag = escapeText(ref.word + ' ' + ref.number);
    if (writtenHere(id)) return `\\hyperref[${labelOf(id)}]{${title}} (${tag})`;
    outside.set(id, { ref, entry: outline.byId.get(id) });
    return `${title} (\\bpout{${tag}})`;
  };

  const math = (span) => {
    if (unsafeMath(span.body)) warn('unsafe-maths', `a formula uses a TeX command no formula on the website can (${UNSAFE_TEX.exec(span.body)[0]}); it is set as its source`);
    return mathToLatex(span);
  };
  const image = (src, alt, { block }) => {
    let res = null;
    if (typeof options.resolveAsset === 'function') res = options.resolveAsset(model.byId.get(current), src);
    if (!res) {
      warn('image-not-included', `the image ${src} is not included (no project files to take it from)`);
    } else if (res.error) {
      warn('image-not-included', res.error);
    }
    const ok = res && !res.error && res.path;
    if (ok) assets.push(res);
    const inner = ok ? `\\bpimage{${res.path}}` : `\\bpmissingimage{${escapeText(alt || src)}}`;
    if (!block) return inner;
    return `\\begin{center}\n${inner}` + (alt ? `\\par\\smallskip{\\small ${escapeText(alt)}}` : '') + '\n\\end{center}';
  };
  const assets = [];
  const ctx = { ref: reference, math, image, warn };
  const body = (o) => {
    current = o.id;
    const out = o.body && o.body.trim() ? markdownToLatex(o.body, ctx) : '';
    return out;
  };
  // Titles go into headings, the contents and the bookmarks: `$…$` there.
  const titleCtx = { ...ctx, math: (span) => mathToLatex(span, { title: true }) };
  const titleTex = (t) => titleToLatex(t, titleCtx);
  const plainTitle = (t) => titleToPlain(t).replace(/[\\{}]/g, '');

  const out = [];
  const comment = (s) => out.push('% ' + String(s).replace(/[\r\n]+/g, ' '));
  const top = req.scope === null ? 1 : 0;
  let tocLines = 0;

  const tocLine = (level, number, tex, plain) => {
    tocLines += 1;
    out.push(`\\addcontentsline{toc}{${HEADINGS[Math.min(level, 2)]}}{\\texorpdfstring{${number}\\quad ${tex}}{${escapePdf(number + ' ' + plain)}}}`);
  };

  const statementHead = (o, word, number) => {
    const t = o.attrs && typeof o.attrs.title === 'string' && o.attrs.title ? ` (${titleTex(o.attrs.title)})` : '';
    return { lead: `${escapeText(word)}~${escapeText(number)}`, rest: t };
  };

  const writeSteps = (id, seen) => {
    for (const s of outline.steps.get(id) || []) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      const tgt = M.boundaryEntry(s, 'tgt');
      comment(`step: ${s.id}`);
      current = s.id;
      const head = `\\textsc{${escapeText(s.kind.replace(/_/g, ' '))}}` + (tgt ? ` \\ensuremath{\\to} ${objectName(tgt)}` : '');
      out.push(`\\begin{bpstep}{${head}}\\phantomsection\\label{${labelOf(s.id)}}%`);
      if (s.attrs && s.attrs.title) out.push(`\\textit{${titleTex(s.attrs.title)}.}`);
      const b = body(s);
      if (b) out.push(b);
      writeSteps(s.id, seen);
      out.push('\\end{bpstep}');
    }
  };

  const writeProof = (p) => {
    comment(`proof: ${p.id}`);
    current = p.id;
    const rest = M.proofLeadRest(p).replace(/\.$/, '');
    out.push(`\\begin{proof}[{Proof${titleTex(rest)}}]\\phantomsection\\label{${labelOf(p.id)}}%`);
    const b = body(p);
    if (b) out.push(b);
    writeSteps(p.id, new Set());
    out.push('\\end{proof}');
  };

  const whereWritten = (node) => {
    const p = node.parent;
    if (!p) return 'at the top level of this export';
    const e = p.entry;
    return `under \\hyperref[${labelOf(e.id)}]{${escapeText(e.number)} ${titleTex(M.titleOf(e.object))}}`;
  };

  const writeNode = (node) => {
    const e = node.entry;
    const o = e.object;
    if (node.type === 'text') {
      comment(`text: ${o.id}`);
      out.push(`\\phantomsection\\label{${labelOf(o.id)}}%`);
      const b = body(o);
      if (b) out.push(b);
      writeSteps(o.id, new Set());
      out.push('');
      return;
    }
    if (node.type === 'pointer') {
      comment(`repeated: ${o.id}`);
      current = o.id;
      const word = M.kindWord(o.kind);
      out.push(`\\begin{bpnote}\\hyperref[${labelOf(o.id)}]{${escapeText(word + ' ' + e.number)}} (${titleTex(M.titleOf(o))}) ` +
        `belongs here too; it is written out ${whereWritten(node.target)}, on page~\\pageref{${labelOf(o.id)}}.\\end{bpnote}`);
      return;
    }

    const level = node.rel - top;
    const number = e.number;
    const isSection = M.isSectionKind(o.kind);
    const label = labelOf(o.id);
    comment(`object: ${o.id}` + (o.source && o.source.file ? ` (${o.source.file})` : ''));
    current = o.id;
    const title = entryTitle(model, outline, e);
    if (isSection) {
      const cmd = HEADINGS[Math.min(level, HEADINGS.length - 1)];
      out.push(`\\${cmd}*{\\texorpdfstring{${escapeText(number)}\\quad ${titleTex(title)}}{${escapePdf(number + ' ' + plainTitle(title))}}}`);
      out.push(`\\phantomsection\\label{${label}}%`);
      if (level < 3) tocLine(level, escapeText(number), titleTex(title), plainTitle(title));
    } else {
      out.push(`\\phantomsection\\label{${label}}%`);
      if (node.children.length && level < 3) tocLine(level, escapeText(number), titleTex(title), plainTitle(title));
    }

    if (node.displaced) {
      const first = e.parent;
      let where = 'at the top level';
      if (first) {
        const fp = `${escapeText(first.number)} ${titleTex(M.titleOf(first.object))}`;
        where = `under ${writtenHere(first.id) ? `\\hyperref[${labelOf(first.id)}]{${fp}}` : fp + ', outside this export'}`;
      }
      out.push(`\\begin{bpnote}Written out here; in the full blueprint it is read ${where}.\\end{bpnote}`);
    }

    const isProof = o.kind === 'proof';
    if (isProof) {
      const rest = M.proofLeadRest(o).replace(/\.$/, '');
      const of = M.attachedTo(o);
      out.push(`\\begin{proof}[{Proof ${escapeText(number)}${titleTex(rest)}}]`);
      if (of && model.byId.has(of) && rest === '') {
        out.push(`{\\small\\color{bpmuted}Of ${objectName(of)}.}\\par`);
      }
    } else if (!isSection) {
      const { lead, rest } = statementHead(o, M.kindWord(o.kind), number);
      const env = ITALIC_KINDS.has(o.kind) ? 'bpstatementit' : 'bpstatement';
      out.push(`\\begin{${env}}{${lead}}{${rest}}`);
      if (o.boundary.length) {
        out.push(`\\bpboundary{${o.boundary.map((b) => `\\textit{${escapeText(b.role)}} ${objectName(b.id)}`).join('; ')}}`);
      }
    } else if (o.boundary.length) {
      out.push(`\\bpboundary{${o.boundary.map((b) => `\\textit{${escapeText(b.role)}} ${objectName(b.id)}`).join('; ')}}`);
    }
    current = o.id;
    const b = body(o);
    if (b) out.push(b);
    if (!isProof && !isSection) out.push(`\\end{${ITALIC_KINDS.has(o.kind) ? 'bpstatementit' : 'bpstatement'}}`);

    for (const p of outline.proofs.get(o.id) || []) writeProof(p);
    writeSteps(o.id, new Set());
    for (const c of node.children) writeNode(c);
    if (node.omitted) {
      const n = node.omitted;
      out.push(`\\bpomitted{${n} ${n === 1 ? 'entry' : 'entries'} below ${escapeText(number)} ${n === 1 ? 'is' : 'are'} left out at this detail level.}`);
    }
    if (isProof) out.push('\\end{proof}');
    out.push('');
  };

  for (const n of plan.nodes) writeNode(n);
  current = null;

  // ------------------------------------------------------------ the frame
  const project = projectTitle(model);
  const described = describeRequest(model, req);
  const scopeTex = scopeEntry
    ? `${escapeText(M.kindWord(scopeEntry.object.kind))} ${escapeText(scopeEntry.number)}: ${titleTex(entryTitle(model, outline, scopeEntry))}`
    : 'The complete blueprint';
  const detailBits = [escapeText(described.detail.charAt(0).toUpperCase() + described.detail.slice(1))];
  detailBits.push(`read along the \\texttt{${escapeText(req.collapse)}} order`);
  if (described.appendices) detailBits.push(escapeText(described.appendices));
  const snapshotLabel = options.snapshot && options.snapshot.label ? options.snapshot.label : null;

  const back = [];
  if (outside.size) {
    back.push('\\bigskip\\phantomsection\\hypertarget{bp-outside}{}%');
    back.push('\\section*{Outside this export}');
    back.push('\\addcontentsline{toc}{section}{Outside this export}');
    back.push('References marked \\ensuremath{{}^\\ast} are to parts of the blueprint this document leaves out:');
    back.push('\\begin{description}');
    const sorted = [...outside.entries()].sort((a, b) => compareNumbers(a[1].ref.number, b[1].ref.number));
    for (const [id, { ref, entry }] of sorted) {
      const top = entry && topAncestor(entry);
      const where = top && top !== entry ? `, in ${escapeText(top.number)} ${titleTex(M.titleOf(top.object))}` : '';
      back.push(`\\item[${escapeText(ref.word + ' ' + ref.number)}] ${titleTex(M.titleOf(model.byId.get(id)))}${where} (\\bpslug{${escapeCode(id)}})`);
    }
    back.push('\\end{description}');
  }

  const macroLines = macroDefinitions(model.project.katexMacros, (code, message) => {
    diagnostics.push({ level: 'warning', code, message, object: null });
  });

  const title = titleTex(project);
  const pdfTitle = escapePdf(plainTitle(project) + (scopeEntry ? ' — ' + scopeEntry.number + ' ' + plainTitle(entryTitle(model, outline, scopeEntry)) : ''));
  const frontMatter = [
    '\\begin{document}',
    '\\pagestyle{plain}',
    '\\begin{center}',
    `{\\LARGE\\bfseries ${title}\\par}`,
    '\\vspace{0.7em}',
    `{\\large ${scopeTex}\\par}`,
    '\\vspace{0.5em}',
    `{\\small\\color{bpmuted}${detailBits.join(' \\textperiodcentered{} ')}\\par}`,
    snapshotLabel ? `{\\small\\color{bpmuted}${escapeText(snapshotLabel)}\\par}` : null,
    '\\end{center}',
    tocLines >= 2 ? '\\vspace{0.5em}\n{\\small\\tableofcontents}\n\\bigskip\\hrule\\bigskip' : '\\bigskip',
    '',
  ].filter((l) => l !== null);

  const bodyText = out.join('\n') + '\n' + back.join('\n');
  const { lines: unicodeLines, unknown } = unicodeDeclarations(frontMatter.join('\n') + bodyText + macroLines.join('\n'));
  for (const u of unknown) {
    diagnostics.push({ level: 'warning', code: 'unknown-character', message: `${u} has no LaTeX form here and is set as a placeholder`, object: null });
  }

  const tex = [
    '% Generated by the blueprint tool (' + GENERATOR + ') from a blueprint snapshot; edit the',
    '% Markdown sources, not this file.  Compile with `latexmk -pdf` or by running',
    '% `pdflatex` twice (the second run settles the contents and the page references).',
    '% Images, if any, are read from assets/ next to this file.',
    '\\documentclass[11pt]{article}',
    PREAMBLE,
    `\\hypersetup{pdftitle={${pdfTitle}},pdfsubject={${escapePdf(described.scope + '; ' + described.detail)}},pdfcreator={blueprint}}`,
    '% KaTeX commands the website knows',
    COMPAT,
    unicodeLines.length ? '% the characters beyond ASCII this document uses' : null,
    ...unicodeLines,
    macroLines.length ? '% the project\'s macros ([katex.macros] in blueprint.toml)' : null,
    ...macroLines,
    '',
    ...frontMatter,
    bodyText,
    '\\end{document}',
    '',
  ].filter((l) => l !== null).join('\n');

  // An unresolved reference is reported once per object and slug.
  const seen = new Set();
  const unique = diagnostics.filter((d) => {
    const k = d.code + ' ' + d.object + ' ' + d.message;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  return {
    tex,
    request: req,
    fileName: exportFileName(model, req),
    title: pdfTitle,
    description: described,
    assets,
    diagnostics: unique,
    stats: { ...stats, outside: outside.size, labels: labels.size },
  };
}

function topAncestor(entry) {
  let e = entry;
  while (e.parent) e = e.parent;
  return e;
}

function compareNumbers(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

/** Text for a PDF string (bookmarks, metadata): no TeX specials at all. */
function escapePdf(s) {
  return String(s).replace(/[\\{}$&%#_^~]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Environments the website accepts inside `$$…$$` that LaTeX wants on their
// own; set unnumbered, as KaTeX sets them.
const DISPLAY_ENVS = /^\s*\\begin\{(align|gather|multline|flalign|alignat|equation|eqnarray)(\*?)\}(\{\d+\})?([\s\S]*)\\end\{\1\2\}\s*$/;

// TeX primitives no formula on the website can use (KaTeX has none of them)
// and that would reach outside the formula in LaTeX: end the document, read
// or write files, change how TeX reads.  A formula with one is set as its
// source, and reported.
const UNSAFE_TEX = /\\(?:input|include|includeonly|endinput|openin|openout|read|write|immediate|special|catcode|documentclass|usepackage|RequirePackage|csname|shipout|end\s*\{document\}|begin\s*\{document\}|newwrite|newread|closeout|closein|jobname|pdfobj|pdfliteral)(?![A-Za-z])/;

/** Whether a formula would do something in LaTeX that it cannot on the website. */
export function unsafeMath(body) {
  return UNSAFE_TEX.test(String(body));
}

/** A maths span as LaTeX: its source between LaTeX's own delimiters. */
export function mathToLatex(span, { title = false } = {}) {
  if (unsafeMath(span.body)) return `\\texttt{${escapeText(span.source)}}`;
  let body = String(span.body)
    // A blank line ends a paragraph in TeX, and with it the formula.
    .replace(/\n[ \t]*(?:\n[ \t]*)+/g, '\n')
    // KaTeX ignores labels; LaTeX would complain about every duplicate.
    .replace(/\\label\s*\{[^{}]*\}/g, '');
  // A letter LaTeX knows only in text: `\mathrm{ét}`.
  let fixed = '';
  for (const ch of body) fixed += isTextLetter(ch.codePointAt(0)) ? `\\text{${ch}}` : ch;
  body = fixed;
  if (!span.display || title) return title ? `$${body}$` : `\\(${body}\\)`;
  const env = DISPLAY_ENVS.exec(body);
  if (env) {
    const name = env[1] === 'eqnarray' ? 'align' : env[1];
    if (name === 'equation') return `\\[${env[4]}\\]`;
    return `\\begin{${name}*}${env[3] || ''}${env[4]}\\end{${name}*}`;
  }
  return `\\[${body}\\]`;
}
