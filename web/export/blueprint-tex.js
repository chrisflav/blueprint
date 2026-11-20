// export/blueprint-tex.js — the whole blueprint as a leanblueprint LaTeX source.
//
// The PDF export (`latex.js`) writes the document as the website reads it,
// numbers and all, for printing.  This writes it the other way round: as the
// LaTeX a `leanblueprint` project is written in, which `blueprint
// import-latex` reads back — theorem-like environments with `\label`, `\lean`,
// `\leanok` and `\uses`, a `proof` right after its statement with its own
// `\uses`, `\chapter`/`\section` with their labels, the project's macros as
// `\newcommand`s.  The graph editor (edit.js) offers it as *Export TeX*, so
// that a blueprint reorganised in the browser comes out as an argument that can
// be read, compiled and imported again.
//
//   * Every label is the object's id, which `import-latex` keeps (an id is
//     already a slug), so a re-import gives the same ids and the same edges.
//   * Sections keep their nesting and order.  Within a section the statements
//     are put in dependency order: each after what it uses from the same
//     section, otherwise in the order the document reads them.  A statement
//     that refines another (a detail) is written in its section beside it,
//     since LaTeX has no nesting of statements.
//   * `[slug]` references become `\cref{slug}`, which the importer turns back
//     into `[slug]`; maths is copied through, as the PDF export copies it.
//
// Pure: no DOM, no node APIs.

import * as M from '../model.js';
import { markdownToLatex, titleToLatex } from './markdown-tex.js';
import { macroDefinitions, mathToLatex } from './latex.js';
import { unicodeDeclarations } from './unicode.js';

export const GENERATOR = 'blueprint-edit-tex/1';

const HEADINGS = ['chapter', 'section', 'subsection', 'subsubsection', 'paragraph'];

// The environments leanblueprint projects declare, with the style each is
// set in and its printed name.
const PLAIN = ['theorem', 'lemma', 'proposition', 'corollary', 'conjecture', 'claim', 'fact'];
const DEFINITION = ['definition', 'construction', 'notation', 'convention', 'example', 'problem', 'question', 'axiom', 'assumption'];
const ENV_RE = /^[a-z][a-z]*$/;

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** The environment an object is written in: the one it was imported from, else its kind. */
function envOf(o) {
  const tag = (o.attrs.tags || []).find((t) => typeof t === 'string' && t.startsWith('latex:'));
  const env = tag ? tag.slice(6) : o.kind;
  return ENV_RE.test(env) ? env : 'remark';
}

function texLabel(id) {
  return String(id).replace(/[{}\\%#\s]/g, '-');
}

/** A title as an environment's optional argument. */
function optTitle(title) {
  if (!title) return '';
  const t = titleToLatex(title, { math: (s) => `$${s.body}$` });
  return /[[\]]/.test(t) ? `[{${t}}]` : `[${t}]`;
}

/**
 * Stable topological order of `ids` by `deps` (id -> ids it needs), keeping
 * the given order wherever the dependencies allow; a cycle is left as it is.
 */
export function dependencyOrder(ids, deps) {
  const pos = new Map(ids.map((id, i) => [id, i]));
  const placed = new Set();
  const out = [];
  const visiting = new Set();
  const visit = (id) => {
    if (placed.has(id) || visiting.has(id)) return;
    visiting.add(id);
    const need = [...(deps.get(id) || [])].filter((d) => pos.has(d) && d !== id)
      .sort((a, b) => pos.get(a) - pos.get(b));
    for (const d of need) visit(d);
    visiting.delete(id);
    placed.add(id);
    out.push(id);
  };
  for (const id of ids) visit(id);
  return out;
}

/**
 * The blueprint as one LaTeX document.  Returns
 * { tex, fileName, diagnostics: [{code, message, object}], stats }.
 */
export function exportBlueprintTex(snapshot, { title = null } = {}) {
  const model = M.buildModel(snapshot);
  const kind = model.defaultCollapse;
  const diagnostics = [];
  const warn = (code, message, object = null) => diagnostics.push({ code, message, object });
  const stats = { headings: 0, statements: 0, proofs: 0, uses: 0, text: 0 };
  const isProof = (o) => o.kind === 'proof' && o.boundary.length === 1;
  const isEdge = (o) => o.boundary.length > 0;
  const isText = (o) => o.kind === M.TEXT_KIND;
  const isHeading = (o) => M.isSectionKind(o.kind);
  const isStatement = (o) => !isEdge(o) && !isText(o) && !isHeading(o) && !M.isReference(o);

  // What is written, and so may be named by `\uses` and `\cref`.
  const labelled = new Set(model.objects.filter((o) => !isEdge(o) && !isText(o) && !M.isReference(o)).map((o) => o.id));

  const usesKind = model.kinds.uses ? 'uses' : null;
  const statementOf = (id) => {
    const o = model.byId.get(id);
    return o && isProof(o) ? o.boundary[0].id : id;
  };
  const usesFrom = new Map(); // src id -> [tgt statement ids]
  for (const o of model.objects) {
    if (o.kind !== usesKind) continue;
    const s = M.boundaryEntry(o, 'src');
    const t = M.boundaryEntry(o, 'tgt');
    if (!s || !t) continue;
    if (!usesFrom.has(s)) usesFrom.set(s, []);
    usesFrom.get(s).push(statementOf(t));
  }
  const proofsOf = new Map();
  for (const o of model.objects) {
    if (!isProof(o)) continue;
    const of = o.boundary[0].id;
    if (!proofsOf.has(of)) proofsOf.set(of, []);
    proofsOf.get(of).push(o);
  }
  // A node's dependencies, statement and proof together: for the order.
  const depsOf = (id) => new Set([...(usesFrom.get(id) || []),
    ...(proofsOf.get(id) || []).flatMap((p) => usesFrom.get(p.id) || [])]);

  // ---- prose ----------------------------------------------------------------
  let current = null;
  const prose = (body) => {
    const maths = [];
    const ctx = {
      ref: (slug) => {
        const o = model.byId.get(slug);
        if (labelled.has(slug)) return `\\cref{${texLabel(slug)}}`;
        if (o && M.isReference(o)) return `\\cite{${texLabel(slug)}}`;
        if (o) return M.titleOf(o).replace(/[\\{}$&%#_^~]/g, ' ');
        // Most often a citation key the importer read from \cite: one again.
        warn('unresolved-ref', `[${slug}] names no object; written as \\cite{${slug}}`, current);
        return `\\cite{${texLabel(slug)}}`;
      },
      cite: () => null,
      math: (span) => { maths.push(mathToLatex(span)); return `\uE100${maths.length - 1}\uE101`; },
      image: (src) => {
        const f = String(src).replace(/[{}\\%#\s]/g, '');
        // A picture the document is not shipped with must not stop LaTeX.
        return `\\IfFileExists{${f}}{\\includegraphics[width=0.8\\linewidth]{${f}}}{\\fbox{\\texttt{${f.replace(/_/g, '\\_')}}}}`;
      },
      warn: (code, message) => warn(code, message, current),
    };
    let tex = markdownToLatex(body, ctx);
    // The PDF export's own commands, as plain LaTeX the importer reads too.
    tex = tex
      .replace(/\\bpbodyheading\{/g, '\\paragraph{')
      .replace(/\\bprule/g, '\\medskip\\hrule\\medskip')
      .replace(/\\bpstartat\{\d+\}/g, '')
      .replace(/\{bpverbatim\}/g, '{verbatim}')
      .replace(/\\allowbreak\{\}/g, '')
      .replace(/\\textless\{\}/g, '<').replace(/\\textgreater\{\}/g, '>')
      .replace(/\\textbar\{\}/g, '|').replace(/\\textquotedbl\{\}/g, '"');
    return tex.replace(/\uE100(\d+)\uE101/g, (_, k) => maths[Number(k)]);
  };

  // ---- the tree of the document ---------------------------------------------
  // `readingOrder` walks the collapse order from its roots, every object with
  // its children; a repeated object (several parents) is written once.
  const tree = { id: null, object: null, kids: [] };
  const stack = [{ depth: -1, node: tree }];
  for (const e of M.readingOrder(model, kind)) {
    if (!e.object || e.duplicate) continue;
    while (stack.length > 1 && stack[stack.length - 1].depth >= e.depth) stack.pop();
    const node = { id: e.id, object: e.object, kids: [] };
    stack[stack.length - 1].node.kids.push(node);
    stack.push({ depth: e.depth, node });
  }

  const written = new Set();
  const out = [];
  const envs = new Set();
  const leanOk = (id) => {
    const s = M.statusOf(model, id);
    return s === 'proved' || s === 'proved_with_axioms';
  };
  const usesLine = (src) => {
    const ts = [...new Set((usesFrom.get(src) || []).filter((t) => labelled.has(t) && t !== statementOf(src)))];
    stats.uses += ts.length;
    return ts.length ? `\\uses{${ts.map(texLabel).join(', ')}}\n` : '';
  };

  const writeStatement = (o) => {
    if (written.has(o.id)) return;
    written.add(o.id);
    current = o.id;
    stats.statements += 1;
    const env = envOf(o);
    envs.add(env);
    let s = `\\begin{${env}}${optTitle(o.attrs.title)}\n\\label{${texLabel(o.id)}}\n`;
    const lean = Array.isArray(o.attrs.lean) ? o.attrs.lean : [];
    if (lean.length) s += `\\lean{${lean.join(', ')}}\n`;
    if (lean.length && leanOk(o.id)) s += '\\leanok\n';
    s += usesLine(o.id);
    const body = prose(o.body);
    s += (body ? body + '\n' : '') + `\\end{${env}}\n`;
    const proofs = proofsOf.get(o.id) || [];
    proofs.forEach((p, i) => {
      current = p.id;
      stats.proofs += 1;
      if (i === 0) {
        s += '\n\\begin{proof}\n';
        if (lean.length && leanOk(o.id)) s += '\\leanok\n';
        s += usesLine(p.id);
        // A second proof cannot follow the first as an environment of its own
        // in leanblueprint; it is read on in the same one.
        const rest = proofs.slice(1);
        for (const q of rest) s += usesLine(q.id);
        const bodies = [prose(p.body), ...rest.map((q) => `\\paragraph{Another proof.} ${prose(q.body)}`)].filter(Boolean);
        s += (bodies.length ? bodies.join('\n\n') + '\n' : '') + '\\end{proof}\n';
        if (rest.length) warn('several-proofs', `${o.id} has ${proofs.length} proofs; written as one`, o.id);
      }
    });
    // A relation with prose of its own (a step) is read after its source.
    for (const step of model.objects) {
      if (!isEdge(step) || isProof(step) || !step.body || !step.body.trim()) continue;
      if (M.boundaryEntry(step, 'src') !== o.id) continue;
      current = step.id;
      s += `\n${prose(step.body)}\n`;
      warn('step-as-text', `the prose of ${step.id} is written as text after ${o.id}`, step.id);
    }
    out.push(s);
  };

  // The statements filed below a node that is not a heading (details of a
  // statement or of a proof, the contents of an edge), in reading order.
  const flatten = (node, acc) => {
    for (const k of node.kids) {
      const o = k.object;
      if (isHeading(o)) continue;
      if (isStatement(o) || isText(o)) acc.push(k);
      flatten(k, acc);
    }
    return acc;
  };

  const writeSection = (node, level) => {
    const items = flatten(node, []);
    // Dependency order among this section's statements; text keeps its place.
    const stmts = items.filter((k) => isStatement(k.object)).map((k) => k.id);
    const ordered = dependencyOrder(stmts, new Map(stmts.map((id) => [id, depsOf(id)])));
    let next = 0;
    for (const k of items) {
      if (isText(k.object)) {
        current = k.id;
        const t = prose(k.object.body);
        if (t) { out.push(t + '\n'); stats.text += 1; }
      } else {
        writeStatement(model.byId.get(ordered[next]));
        next += 1;
      }
    }
    for (const k of node.kids) {
      if (!isHeading(k.object)) continue;
      writeHeading(k, level);
    }
  };

  let inAppendix = false;
  const writeHeading = (node, level) => {
    const o = node.object;
    if (written.has(o.id)) return;
    written.add(o.id);
    current = o.id;
    stats.headings += 1;
    if (o.kind === 'appendix' && !inAppendix && level === 0) { out.push('\\appendix\n'); inAppendix = true; }
    const cmd = o.kind === M.PART_KIND ? 'part' : HEADINGS[Math.min(level, HEADINGS.length - 1)];
    if (level >= HEADINGS.length - 1) warn('deep-heading', `${o.id} is nested deeper than \\subsubsection`, o.id);
    const t = titleToLatex(M.titleOf(o), { math: (s) => `$${s.body}$` });
    let s = `\\${cmd}{${t}}\\label{${texLabel(o.id)}}\n`;
    const usesHere = (usesFrom.get(o.id) || []).filter((x) => labelled.has(x));
    if (usesHere.length) warn('heading-uses', `the uses of the heading ${o.id} are not written`, o.id);
    const body = prose(o.body);
    if (body) s += '\n' + body + '\n';
    out.push(s);
    writeSection(node, o.kind === M.PART_KIND ? level : level + 1);
  };

  // The top level: statements and text under no heading first, as the
  // importer reads what stands before the first chapter, then the headings.
  writeSection(tree, 0);

  // Anything the walk did not reach (a statement outside the collapse order).
  for (const o of model.objects) {
    if (isStatement(o) && !written.has(o.id)) {
      warn('unplaced', `${o.id} is in no section; written at the end`, o.id);
      writeStatement(o);
    }
  }

  // ---- the preamble -----------------------------------------------------------
  const macroWarn = (code, message) => warn(code, message);
  const macros = macroDefinitions(model.project.katexMacros || {}, macroWarn);
  const theoremLines = [];
  let style = 'plain';
  const declare = (want, names) => {
    const mine = names.filter((n) => envs.has(n) && n !== 'theorem');
    if (!mine.length) return;
    if (want !== style) theoremLines.push(`\\theoremstyle{${want}}`);
    style = want;
    for (const n of mine) theoremLines.push(`\\newtheorem{${n}}[theorem]{${cap(n)}}`);
  };
  const rest = [...envs].filter((e) => !PLAIN.includes(e) && !DEFINITION.includes(e)).sort();
  declare('plain', PLAIN);
  declare('definition', DEFINITION);
  declare('remark', rest);
  const docTitle = title || model.project.title || model.project.name || 'Blueprint';
  // The characters pdfLaTeX is not told about by itself, declared as the PDF
  // export declares them; one it has no form for is set in a box.
  const { lines: unicodeLines, unknown } = unicodeDeclarations(out.join('\n') + docTitle + macros.join('\n'));
  for (const u of unknown) warn('unknown-character', `${u} has no LaTeX form and is set as a placeholder`);
  const unicode = unicodeLines.map((l) => l.replace(/\\bpglyph\{([^}]*)\}/, '\\fbox{\\scriptsize $1}'));
  const tex = [
    `% ${docTitle}: the blueprint as reorganised in the graph editor.`,
    `% Written by ${GENERATOR}.  Read back with`,
    '%   blueprint import-latex <this file> --out blueprint --toml blueprint.toml',
    '\\documentclass{report}',
    '\\usepackage[T1]{fontenc}',
    '\\usepackage[utf8]{inputenc}',
    '\\usepackage{amsmath,amssymb,amsthm}',
    '\\usepackage{graphicx,array,booktabs,tabularx}',
    '\\usepackage[normalem]{ulem}',
    '\\usepackage{hyperref}',
    // \cref where cleveref is installed, a plain \ref where it is not; \let,
    // which the importer does not read as a macro of the project.
    '\\IfFileExists{cleveref.sty}{\\usepackage[capitalise,nameinlink]{cleveref}}{\\AtBeginDocument{\\let\\cref\\ref}}',
    '% The blueprint annotations, which leanblueprint reads and print ignores.',
    '\\providecommand{\\lean}[1]{}',
    '\\providecommand{\\leanok}{}',
    '\\providecommand{\\uses}[1]{}',
    '\\theoremstyle{plain}',
    '\\newtheorem{theorem}{Theorem}[chapter]',
    ...theoremLines,
    ...(unicode.length ? ['% Characters pdfLaTeX does not know by itself.', ...unicode] : []),
    ...(macros.length ? ['% The project\'s macros.', ...macros] : []),
    `\\title{${titleToLatex(docTitle, { math: (s) => `$${s.body}$` })}}`,
    // In the preamble, which the importer reads for declarations only: a
    // title page in the body would come back as a section of prose.
    '\\AtBeginDocument{\\maketitle\\tableofcontents}',
    '\\begin{document}',
    '',
    out.join('\n'),
    '\\end{document}',
    '',
  ].join('\n');
  const slug = String(model.project.name || docTitle).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'blueprint';
  return { tex, fileName: `${slug}-edited.tex`, diagnostics, stats };
}
