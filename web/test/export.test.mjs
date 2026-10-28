// web/test/export.test.mjs
//
// The PDF export's reading of a snapshot (../export/latex.js) and its store
// (../export/store.mjs), without TeX: what is written out, in what order,
// under which numbers, with which references, and where it is filed.
//
//   nix-shell -p nodejs_22 --run "node web/test/export.test.mjs"
//
// The fixture is ../sample/paper/blueprint.json, the snapshot of
// examples/paper that `blueprint build` writes (./test.sh checks it is), and
// small snapshots written here for what the example does not have.  The
// compiled PDFs are export-compile.test.mjs's.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as M from '../model.js';
import {
  ExportError, exportLatex, exportScopes, planExport, resolveRequest, requestKey, mathToLatex, macroDefinitions,
} from '../export/latex.js';
import { markdownToLatex, escapeText, parseBlocks } from '../export/markdown-tex.js';
import { sha256Hex } from '../export/sha256.js';
import { allRequests, assetResolver, findEntry, prepareExport, sha256Bytes, siteFile } from '../export/store.mjs';
import { zipFiles, crc32 } from '../export/zip.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.join(here, '..');
const repo = path.join(webDir, '..');
const paperText = fs.readFileSync(path.join(webDir, 'sample', 'paper', 'blueprint.json'), 'utf8');
const paper = () => M.buildModel(JSON.parse(paperText));

let passed = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
  } catch (e) {
    failures.push({ name, message: (e && e.stack) || String(e) });
  }
}
function eq(actual, expected, what) {
  if (actual !== expected) throw new Error(`${what || 'value'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function ok(cond, what) {
  if (!cond) throw new Error(what || 'expected true');
}
function same(actual, expected, what) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what || 'value'}:\n    expected ${b}\n    got      ${a}`);
}
function throwsExport(fn, pattern, what) {
  try {
    fn();
  } catch (e) {
    ok(e instanceof ExportError, `${what}: an ExportError, not ${e && e.name}: ${e && e.message}`);
    ok(pattern.test(e.message), `${what}: message ${JSON.stringify(e.message)} does not match ${pattern}`);
    return;
  }
  throw new Error(`${what}: did not throw`);
}

/** The objects a .tex writes out, in order: its `% object:` comments. */
const written = (tex) => [...tex.matchAll(/^% object: (\S+)/gm)].map((m) => m[1]);
/** Everything the .tex says it sets, with what: object, proof, step, text, repeated. */
const marks = (tex) => [...tex.matchAll(/^% (object|proof|step|text|repeated): (\S+)/gm)].map((m) => m[1] + ' ' + m[2]);
const bodyOf = (tex) => tex.slice(tex.indexOf('\\begin{document}'));

// A tiny snapshot in the shape `blueprint build` writes.
function snapshot(objects, kinds = {}, project = {}) {
  const binary = { boundary: { src: { min: 1, max: 1 }, tgt: { min: 1, max: 1 } } };
  return {
    version: 1,
    project: { name: 'tiny', title: 'Tiny', ...project },
    schema: {
      defaultCollapse: 'refines',
      kinds: {
        section: { boundary: {} }, appendix: { boundary: {}, graph: 'optional' }, hidden: { boundary: {}, graph: 'never' },
        theorem: { boundary: {}, countable: true }, lemma: { boundary: {}, countable: true },
        definition: { boundary: {}, countable: true }, refines: { ...binary, collapse: true },
        uses: { ...binary, sugar: true }, proof: { boundary: { of: { min: 1, max: 1 } } }, ...kinds,
      },
    },
    objects,
    derived: { status: {} },
  };
}
const node = (id, kind, body = '', attrs = {}) => ({ id, kind, boundary: [], attrs, body, depth: 0, source: { file: 'blueprint/' + id + '.md' } });
const edge = (kind, src, tgt, body = '', attrs = {}, id = `${kind}/${src}/${tgt}`) => ({
  id, kind, attrs, body, depth: 1, boundary: [{ role: 'src', id: src }, { role: 'tgt', id: tgt }],
});

// ---------------------------------------------------------------------------
// 1. the whole blueprint, in the document's order
// ---------------------------------------------------------------------------

await check('the whole blueprint is the document, in its order and with its numbers', () => {
  const m = paper();
  const outline = M.documentOutline(m, 'refines');
  const res = exportLatex(m, {});
  eq(res.request.scope, null, 'the whole blueprint');
  eq(res.request.depth, 'all', 'all levels by default');
  // Every entry the website writes out, once, in the website's order.
  const expected = outline.entries.filter((e) => !e.duplicate && !e.text).map((e) => e.id);
  same(written(res.tex), expected, 'the objects, in reading order');
  // The numbers are the document's.
  for (const e of outline.entries) {
    if (e.duplicate || e.text || M.isSectionKind(e.object.kind) || e.object.kind === 'proof') continue;
    ok(res.tex.includes(`{${M.kindWord(e.object.kind)}~${e.number}}`), `${e.id} is ${M.kindWord(e.object.kind)} ${e.number}`);
  }
  ok(res.tex.includes('\\section*{\\texorpdfstring{1\\quad Introduction}'), 'sections are headings with their numbers');
  ok(res.tex.includes('\\subsection*{\\texorpdfstring{2.1\\quad Covers}'), 'subsections one level down');
  // The tube lemma has two parents: written out once, a pointer the second time.
  eq(written(res.tex).filter((id) => id === 'lem-tube').length, 1, 'one full occurrence');
  ok(marks(res.tex).includes('repeated lem-tube'), 'a pointer under its second parent');
  ok(/belongs here too; it is written out under \\hyperref\[bp\d+\]\{2\.2 Compact spaces\}/.test(res.tex), 'the pointer says where');
  eq(res.stats.outside, 0, 'nothing is outside the whole blueprint');
  ok(!res.tex.includes('Outside this export'), 'and so no list of what is outside');
  ok(res.tex.includes('The complete blueprint'), 'the title block says what this is');
  eq(res.fileName, 'paper-whole', 'its file name');
});

await check('a body is the Markdown and maths the website shows, set as LaTeX', () => {
  const tex = exportLatex(paper(), {}).tex;
  // Maths is copied through, delimiters aside; macros are the project's.
  ok(tex.includes('\\(\\Opens{X}\\)'), 'inline maths with a project macro');
  ok(tex.includes('\\[\n\\bigcup_{i \\in I} U_i = X .\n\\]'), 'display maths');
  ok(tex.includes('\\begin{aligned}\nF_{i_1} \\cap \\dots \\cap F_{i_n} &\\neq \\emptyset'), 'aligned, untouched');
  ok(tex.includes('\\providecommand{\\Opens}{}\\renewcommand{\\Opens}[1]{\\mathcal{O}(#1)}'), 'the macro, with its argument');
  ok(tex.includes('\\providecommand{\\Top}{}\\renewcommand{\\Top}{\\mathbf{Top}}'), 'a macro without arguments');
  // Markdown.
  ok(tex.includes('An \\emph{open cover} of'), 'emphasis');
  ok(/\\begin\{enumerate\}\n\\item The/.test(tex), 'an ordered list');
  ok(tex.includes('\\begin{tabular}{llr}'), 'a table, with its alignment');
  ok(tex.includes('\\texttt{TopologicalSpace.\\allowbreak{}IsCompact}'), 'a code span');
  ok(tex.includes('\\begin{bpverbatim}\nexample (X : Type*)'), 'a fenced code block, verbatim');
  ok(tex.includes('\\begin{quote}\nEvery result here is classical'), 'a block quote');
  // Non-ASCII text is declared for pdfLaTeX, not dropped.
  ok(tex.includes('Čech') && tex.includes('Erdős'), 'Latin letters stay as they are');
  ok(tex.includes('\\DeclareUnicodeCharacter{211D}{\\ensuremath{\\mathbb{R}}}'), 'ℝ is declared');
  ok(tex.includes('\\DeclareUnicodeCharacter{2264}{\\ensuremath{\\leq}}'), '≤ is declared');
  ok(tex.includes('\\DeclareUnicodeCharacter{03B1}{\\ensuremath{\\alpha}}'), 'α is declared');
});

// ---------------------------------------------------------------------------
// 2. a section, and a smaller part, with nothing else
// ---------------------------------------------------------------------------

await check('a section is that section and what is below it, nothing else', () => {
  const m = paper();
  const res = exportLatex(m, { scope: 'covers' });
  same(written(res.tex), ['covers', 'def-cover', 'def-fip'], 'only section 2.1');
  ok(marks(res.tex).includes('text covers-opening'), 'with the text that opens it');
  ok(res.tex.includes('Section 2.1: Covers'), 'the title block names it');
  eq(res.fileName, 'paper-2-1-covers', 'its file name');
});

await check('a shared lemma whose first place is elsewhere is written out in full', () => {
  const m = paper();
  const res = exportLatex(m, { scope: 'products' });
  same(written(res.tex), ['products', 'thm-product', 'rem-infinite', 'lem-tube'], 'section 3, with the tube lemma');
  ok(marks(res.tex).includes('proof proof/lem-tube'), 'and the tube lemma\'s proof with it');
  ok(!marks(res.tex).some((x) => x.startsWith('repeated')), 'not a pointer to a page that is not in the PDF');
  ok(res.tex.includes('Written out here; in the full blueprint it is read under 2.2 Compact spaces, outside this export.'),
    'the PDF says where it usually is');
  ok(res.tex.includes('{Lemma~2.2.3}'), 'with its own number, the one references use');
  // References to section 2 are references to outside the export.
  ok(/\\bpout\{Theorem 2\.2\.2\}/.test(res.tex), 'a reference outside is marked');
  ok(res.tex.includes('\\section*{Outside this export}'), 'and listed');
  ok(/\\item\[Theorem 2\.2\.2\] Compactness by closed sets, in 2 Covers and compact spaces/.test(res.tex), 'with what and where');
  ok(/\\hyperref\[bp\d+\]\{Lemma 2\.2\.3\}/.test(res.tex), 'a reference to the lemma written here links to it');
});

await check('a refined statement exports with its proof and the proof\'s details', () => {
  const m = paper();
  const res = exportLatex(m, { scope: 'thm-fip' });
  same(marks(res.tex), ['object thm-fip', 'object proof/thm-fip', 'step uses/proof~thm-fip/def-fip',
    'object lem-complements', 'object lem-finite-subfamily'], 'the statement, its proof, the step, the lemmas');
  const t = bodyOf(res.tex);
  const open = t.indexOf('\\begin{proof}[{Proof 2.2.2.1}]');
  const close = t.indexOf('\\end{proof}', t.indexOf('% object: lem-finite-subfamily'));
  ok(open > 0 && close > open, 'the lemmas are inside the proof');
  ok(t.indexOf('% object: lem-complements') > open && t.indexOf('% object: lem-complements') < close, 'Lemma 2.2.2.1.1 is in it');
  ok(t.includes('Of \\hyperref['), 'the proof says what it proves');
  ok(res.tex.includes('2.2.2.1\\quad Proof of Theorem 2.2.2'), 'and is named that in the contents');
  ok(/\\bpout\{Definition 2\.1\.2\}/.test(res.tex), 'the step\'s target is outside');
});

await check('a proof with details of its own is read right after its statement, on the website too', () => {
  const m = paper();
  const outline = M.documentOutline(m, 'refines');
  const proof = outline.byId.get('proof/thm-fip');
  ok(proof, 'the proof is an entry');
  eq(proof.parent && proof.parent.id, 'thm-fip', 'under its statement, not at the top of the document');
  eq(proof.number, '2.2.2.1', 'numbered among the statement\'s entries');
  eq(outline.roots.some((e) => e.id === 'proof/thm-fip'), false, 'not a root');
  eq(outline.byId.get('lem-complements').number, '2.2.2.1.1', 'its details below it');
  eq(M.documentPageOf(outline, 'lem-complements'), 'proof/thm-fip', 'read on its page');
});

await check('a proof inside a body is a proof, and so are proof objects', () => {
  const tex = exportLatex(paper(), { scope: 'products' }).tex;
  ok(/\\begin\{proof\}\[\{Proof\}\]\nLet \\\(\\fam\{W\}\\\) be an open cover/.test(tex), 'a "## Proof" section of a body');
  ok(tex.includes('less direct route.\n\\end{proof}'), 'ending where the body does, QED on the last line');
  ok(/\\begin\{proof\}\[\{Proof\}\]\\phantomsection\\label\{bp\d+\}%\nCover/.test(tex), 'a proof object');
});

// ---------------------------------------------------------------------------
// 3. detail levels
// ---------------------------------------------------------------------------

await check('the depth counts levels below the part, as the document\'s pages do', () => {
  const m = paper();
  const outline = M.documentOutline(m, 'refines');
  for (const [scope, depth] of [[null, 1], [null, 2], ['spaces', 1], ['spaces', 2], ['compact', 1]]) {
    const req = resolveRequest(m, { scope, depth });
    eq(req.depth, depth, `${scope} at ${depth} stays a depth`);
    // What the page shows, each object once, where the page first has it: a
    // repeated entry whose first place is cut is written out at the next.
    const want = [...new Set(M.documentPageEntries(outline, scope, depth).filter((e) => !e.text).map((e) => e.id))];
    same(written(exportLatex(m, req).tex), want, `${scope || 'the whole'} at depth ${depth} is what the page shows`);
  }
  const top = exportLatex(m, { depth: 1 }).tex;
  same(written(top), ['intro', 'spaces', 'products', 'conventions'], 'depth 1 of the whole: the sections');
  ok(top.includes('\\bpomitted{10 entries below 2 are left out at this detail level.}'), 'saying what it leaves out');
  ok(!top.includes('Definition~'), 'and no statement');
});

await check('a depth that cuts nothing is all, and a bad depth is refused', () => {
  const m = paper();
  const all = resolveRequest(m, { scope: 'compact' });
  eq(all.height, 3, 'section 2.2 has three levels: statements, the proof, its lemmas');
  eq(resolveRequest(m, { scope: 'compact', depth: 3 }).depth, 'all', 'depth 3 is all of it');
  eq(resolveRequest(m, { scope: 'compact', depth: 99 }).depth, 'all', 'and so is more');
  eq(resolveRequest(m, { scope: 'compact', depth: '2' }).depth, 2, 'a depth as text');
  eq(requestKey(resolveRequest(m, { scope: 'compact', depth: 3 })), requestKey(all), 'the same key');
  for (const bad of [0, -1, 1.5, 'two', '1e3']) {
    throwsExport(() => resolveRequest(m, { scope: 'compact', depth: bad }), /depth must be 'all' or a whole number/, `depth ${bad}`);
  }
});

await check('proofs and steps come with their statement at any depth', () => {
  const tex = exportLatex(paper(), { scope: 'compact', depth: 1 }).tex;
  same(written(tex), ['compact', 'def-compact', 'thm-fip', 'lem-tube'], 'the statements of 2.2');
  ok(marks(tex).includes('proof proof/lem-tube'), 'the tube lemma\'s proof is part of it');
  ok(tex.includes('\\bpomitted{3 entries below 2.2.2 are left out at this detail level.}'), 'the detailed proof is a level down');
});

// ---------------------------------------------------------------------------
// 4. text, appendices, hierarchies
// ---------------------------------------------------------------------------

await check('text that belongs to no statement is set in place, with no number', () => {
  const tex = exportLatex(paper(), { scope: 'compact' }).tex;
  const order = marks(tex);
  ok(order.indexOf('text compact-between') === order.indexOf('object def-compact') + 1, 'between the definition and the theorem');
  ok(tex.includes('Passing to complements turns open covers'), 'its prose');
  eq(resolveRequest(paper(), { scope: 'compact' }).scope, 'compact', 'sanity');
  throwsExport(() => resolveRequest(paper(), { scope: 'compact-between' }), /is text read in place inside 'compact'/, 'text is not a part');
});

await check('appendices are in by default and out when asked, and only where there are any', () => {
  const m = paper();
  const withA = resolveRequest(m, {});
  eq(withA.hasAppendices, true, 'the whole blueprint has an appendix');
  eq(withA.appendices, true, 'included by default');
  const without = exportLatex(m, { appendices: false });
  ok(!written(without.tex).includes('conventions') && !written(without.tex).includes('notation'), 'left out with its contents');
  ok(without.tex.includes('appendices left out'), 'the title block says so');
  eq(without.fileName, 'paper-whole-no-appendix', 'and the file name');
  ok(requestKey(without.request) !== requestKey(withA), 'a different key');
  const own = resolveRequest(m, { scope: 'conventions', appendices: false });
  eq(own.hasAppendices, false, 'an appendix exported on its own has no appendix inside it');
  eq(own.appendices, true, 'so the choice is moot, and canonical');
  ok(written(exportLatex(m, own).tex).includes('notation'), 'and it is all there');
});

await check('another hierarchy is another document, refused when unknown', () => {
  const m = paper();
  const res = exportLatex(m, { collapse: 'instance_of' });
  ok(res.tex.includes('read along the \\texttt{instance\\_of} order'), 'the title block says which order');
  eq(res.fileName, 'paper-whole-instance-of', 'not the default order: in the name');
  throwsExport(() => resolveRequest(m, { collapse: 'uses' }), /'uses' is not a collapse kind of this blueprint/, 'not a collapse kind');
});

// ---------------------------------------------------------------------------
// 5. invalid selections
// ---------------------------------------------------------------------------

await check('a part that does not exist, or is not a part, is refused with the reason', () => {
  const m = paper();
  throwsExport(() => resolveRequest(m, { scope: 'no-such-thing' }), /there is no object 'no-such-thing'/, 'unknown id');
  throwsExport(() => resolveRequest(m, { scope: 'proof/lem-tube' }), /is read as part of 'lem-tube'; export 'lem-tube' instead/, 'a proof');
  throwsExport(() => resolveRequest(m, { scope: 'uses/proof~thm-fip/def-fip' }), /read as part of 'proof\/thm-fip'/, 'a step');
  throwsExport(() => resolveRequest(m, { scope: 'refines/def-cover/covers' }), /is not in the document along 'refines'/, 'a structural edge');
  throwsExport(() => resolveRequest(m, { scope: 42 }), /scope must be an object id/, 'not a string');
});

await check('structural edges with nothing to say are not paragraphs', () => {
  const tex = exportLatex(paper(), {}).tex;
  ok(!/% (object|step): (refines|uses)\/(?!proof~thm-fip)/.test(tex), 'no sugar refines or uses edge is set');
});

// ---------------------------------------------------------------------------
// 6. references and maths
// ---------------------------------------------------------------------------

await check('references read as the website reads them, and unresolved ones are reported', () => {
  const m = M.buildModel(snapshot([
    node('sec', 'section', 'Opening.', { title: 'S', order: 1 }),
    node('lem', 'lemma', 'A lemma.', { order: 1 }),
    node('thm', 'theorem', 'By Lemma [lem], and by [lem], and [nowhere]. Thm [lem] too.', { order: 2 }),
    node('other', 'section', 'Elsewhere.', { title: 'Other', order: 2 }),
    node('far', 'definition', 'Far away.', { title: 'Far' }),
    edge('refines', 'lem', 'sec'), edge('refines', 'thm', 'sec'), edge('refines', 'far', 'other'),
    node('pointer', 'theorem', 'See [far].', { order: 3 }), edge('refines', 'pointer', 'sec'),
  ]));
  const res = exportLatex(m, { scope: 'sec' });
  ok(/By Lemma \\hyperref\[bp\d+\]\{1\.1\}/.test(res.tex), '"Lemma [lem]" keeps the word once');
  ok(/and by \\hyperref\[bp\d+\]\{Lemma 1\.1\}/.test(res.tex), 'a bare reference gets the word');
  ok(/Thm \\hyperref\[bp\d+\]\{1\.1\}/.test(res.tex), '"Thm [x]" names it already');
  ok(res.tex.includes('\\bpbroken{nowhere}'), 'an unresolved reference is visible');
  ok(res.diagnostics.some((d) => d.code === 'unresolved-reference' && d.object === 'thm' && /\[nowhere\]/.test(d.message)), 'and reported against its object');
  ok(res.tex.includes('\\bpout{Definition 2.1}'), 'a reference outside the part is marked');
  ok(res.tex.includes('\\item[Definition 2.1] Far, in 2 Other (\\bpslug{far})'), 'and listed with where it is');
});

await check('maths keeps its source and gets LaTeX\'s delimiters', () => {
  eq(mathToLatex({ display: false, body: 'x_1' }), '\\(x_1\\)', 'inline');
  eq(mathToLatex({ display: true, body: 'a\n\n b' }), '\\[a\nb\\]', 'a blank line in a display would end it');
  eq(mathToLatex({ display: true, body: '\\begin{align} a &= b \\\\ c &= d \\end{align}' }),
    '\\begin{align*} a &= b \\\\ c &= d \\end{align*}', 'an align is set as one, unnumbered as KaTeX sets it');
  eq(mathToLatex({ display: true, body: '\\begin{equation} e \\end{equation}' }), '\\[ e \\]', 'an equation is a display');
  eq(mathToLatex({ display: false, body: '\\mathrm{ét}' }), '\\(\\mathrm{\\text{é}t}\\)', 'a text letter in maths');
  eq(mathToLatex({ display: false, body: 'x \\label{eq:1}' }), '\\(x \\)', 'labels go, as KaTeX ignores them');
  const md = markdownToLatex('Cost $5 and $x_*$ and \\$ and `$y$`.', { ref: () => '', math: (s) => `[${s.body}]`, image: () => '', warn: () => {}, spans: [] });
  ok(md.includes('[x_*]') || md.includes('[5 and ]'), 'maths spans are found as the website finds them');
  ok(md.includes('\\texttt{\\$y\\$}'), 'maths in code is code');
});

await check('a formula with a TeX command that reaches outside it is set as its source', () => {
  for (const body of ['\\input{/etc/passwd}', 'x \\end{document}', '\\immediate\\write18{ls}', '\\catcode`\\$=12']) {
    const out = mathToLatex({ display: false, body, source: '$' + body + '$' });
    ok(out.startsWith('\\texttt{') && !out.includes('\\(') , `${body}: ${out}`);
  }
  eq(mathToLatex({ display: false, body: '\\def\\x{1}\\x', source: '' }), '\\(\\def\\x{1}\\x\\)', 'KaTeX has \\def, so it stays');
  eq(mathToLatex({ display: false, body: '\\inputs', source: '' }), '\\(\\inputs\\)', 'only the command itself');
  const m = M.buildModel(snapshot([node('s', 'section', 'Then $\\end{document}$ and more.', { title: 'S' })]));
  const res = exportLatex(m, {});
  ok(res.tex.includes('\\texttt{\\$\\textbackslash{}end\\{document\\}\\$}'), 'the document goes on');
  ok(res.diagnostics.some((d) => d.code === 'unsafe-maths' && d.object === 's'), 'and it is reported');
});

await check('macros become LaTeX definitions, except the ones that would break LaTeX', () => {
  const warns = [];
  const lines = macroDefinitions({ '\\Fq': '\\mathbf F_q', '\\poly': '#1[T]', '\\begin': 'x', '\\bad': '{', '\\a1': 'y' },
    (code, message) => warns.push(code + ': ' + message));
  same(lines, ['\\providecommand{\\Fq}{}\\renewcommand{\\Fq}{\\mathbf F_q}', '\\providecommand{\\poly}{}\\renewcommand{\\poly}[1]{#1[T]}'], 'definitions');
  eq(warns.length, 3, 'three left out, each said');
});

await check('text is escaped, and only text', () => {
  eq(escapeText('50% of #1 & $2_a {b} ~ ^ \\ -- \'\' <<'), '50\\% of \\#1 \\& \\$2\\_a \\{b\\} \\textasciitilde{} \\textasciicircum{} \\textbackslash{} -{}- \'{}\' \\textless{}\\textless{}', 'the specials');
  const ctx = { ref: (s) => `<${s}>`, math: (s) => `M(${s.body})`, image: (s) => `I(${s})`, warn: () => {}, spans: [] };
  eq(markdownToLatex('a_b_c snake_case *em*', ctx), 'a\\_b\\_c snake\\_case \\emph{em}', 'underscores inside words are not emphasis');
  eq(markdownToLatex('[x](https://e.org/a_b%20c#f)', ctx), '\\href{https://e.org/a_b\\%20c\\#f}{x}', 'a link');
  eq(markdownToLatex('[https://e.org](https://e.org)', ctx), '\\href{https://e.org}{https://e.org}', 'a link whose text is a URL is not linked twice');
  eq(markdownToLatex('see [lem-x] and [text](#/object/y)', ctx), 'see <lem-x> and text', 'a reference, and a link into the site');
  const blocks = parseBlocks(['- a', '  - b', '- c', '', '1. x', '2. y'].map(String));
  same(blocks.map((b) => [b.type, b.ordered, b.items.length]), [['list', false, 2], ['list', true, 2]], 'two lists');
});

await check('an image is included from the project, and never from outside it', () => {
  const m = paper();
  const res = exportLatex(m, { scope: 'conventions' }, { resolveAsset: assetResolver(path.join(repo, 'examples', 'paper')) });
  eq(res.assets.length, 1, 'one image');
  ok(/^assets\/[0-9a-f]{8}-cover\.png$/.test(res.assets[0].path), 'filed under assets/');
  ok(res.tex.includes(`\\bpimage{${res.assets[0].path}}`), 'and included');
  ok(res.tex.includes('Three open intervals covering a closed interval'), 'with its text');
  const bare = exportLatex(m, { scope: 'conventions' });
  ok(bare.tex.includes('\\bpmissingimage{Three open intervals'), 'without the project, a placeholder');
  ok(bare.diagnostics.some((d) => d.code === 'image-not-included' && d.object === 'figure-cover'), 'and a diagnostic');
  const resolve = assetResolver(path.join(repo, 'examples', 'paper'));
  const fig = m.byId.get('figure-cover');
  ok(/outside the project/.test(resolve(fig, '../../../../../etc/passwd.png').error), 'no way out of the project');
  ok(/on the web/.test(resolve(fig, 'https://example.org/x.png').error), 'nothing is fetched');
  ok(/\.svg file/.test(resolve(fig, 'cover.svg').error), 'only what pdfLaTeX takes');
  ok(/does not exist/.test(resolve(fig, 'missing.png').error), 'a missing image is said to be');
});

await check('a character with no LaTeX form is a visible placeholder and a diagnostic', () => {
  const m = M.buildModel(snapshot([node('s', 'section', 'Kanji 漢 here.', { title: 'S' })]));
  const res = exportLatex(m, {});
  ok(res.tex.includes('\\DeclareUnicodeCharacter{6F22}{\\bpglyph{U+6F22}}'), 'a placeholder');
  ok(res.diagnostics.some((d) => d.code === 'unknown-character' && /U\+6F22/.test(d.message)), 'said');
});

// ---------------------------------------------------------------------------
// 7. what the website offers, and where it is filed
// ---------------------------------------------------------------------------

await check('the parts on offer are the document\'s pages, named by their titles', () => {
  const m = paper();
  const scopes = exportScopes(m, 'refines');
  same(scopes.map((s) => s.id), [null, 'spaces', 'covers', 'compact', 'thm-fip', 'proof/thm-fip', 'products', 'conventions'], 'the parts');
  eq(scopes.find((s) => s.id === 'proof/thm-fip').title, 'Proof of Theorem 2.2.2', 'a detailed proof by what it proves');
  eq(scopes[0].title, 'Compactness through finite intersections', 'the whole blueprint by the project\'s title');
  const reqs = allRequests(m);
  eq(reqs.length, 25, 'every choice the dialog can make, once');
  ok(reqs.some((r) => r.scope === 'spaces' && r.depth === 3), 'depths short of all');
  ok(reqs.some((r) => r.scope === null && r.appendices === false), 'without the appendix');
  eq(new Set(reqs.map(requestKey)).size, reqs.length, 'no repeats');
});

await check('the page hashes the bytes as node does', () => {
  const bytes = new TextEncoder().encode(paperText);
  eq(sha256Hex(bytes), sha256Bytes(Buffer.from(paperText, 'utf8')), 'the same digest');
  eq(sha256Hex(new Uint8Array(0)), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'of nothing');
  eq(sha256Hex(new TextEncoder().encode('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', 'of abc');
});

await check('an export is filed under its snapshot\'s bytes and its request, and found only there', async () => {
  const site = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-export-test-'));
  try {
    const m = paper();
    const hash = sha256Bytes(Buffer.from(paperText, 'utf8'));
    const req = resolveRequest(m, { scope: 'products' });
    const entry = await prepareExport({ model: m, hash, site, request: req, texOnly: true });
    eq(entry.status, 'tex-only', 'the TeX, no PDF');
    ok(fs.existsSync(path.join(site, 'data', 'exports', hash.slice(0, 16), entry.tex)), 'filed under the snapshot');
    ok(findEntry(site, hash, req), 'found again by the same request');
    eq(findEntry(site, hash, resolveRequest(m, { scope: 'covers' })), null, 'not for another section');
    eq(findEntry(site, hash, resolveRequest(m, { scope: 'products', collapse: 'instance_of' })) , null, 'not for another hierarchy');
    // Another revision: one more byte.
    const other = sha256Bytes(Buffer.from(paperText + ' ', 'utf8'));
    eq(findEntry(site, other, req), null, 'not for another snapshot');
    // A manifest that claims another snapshot is not believed.
    const mf = path.join(site, 'data', 'exports', hash.slice(0, 16), 'manifest.json');
    const j = JSON.parse(fs.readFileSync(mf, 'utf8'));
    j.snapshot.sha256 = other;
    fs.writeFileSync(mf, JSON.stringify(j));
    eq(findEntry(site, hash, req), null, 'a manifest of other bytes is ignored');
  } finally {
    fs.rmSync(site, { recursive: true, force: true });
  }
});

await check('the site names its own snapshots, and nothing outside it', () => {
  const site = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-export-site-'));
  try {
    ok(siteFile(site, 'blueprint.json'), 'its snapshot');
    eq(siteFile(site, '../etc/passwd'), null, 'not a way out');
    eq(siteFile(site, '/etc/passwd'), null, 'not an absolute path');
    eq(siteFile(site, ''), null, 'not nothing');
  } finally {
    fs.rmSync(site, { recursive: true, force: true });
  }
});

await check('prepare refuses a snapshot the site does not serve, and one that changed', () => {
  const site = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-export-prepare-'));
  try {
    fs.writeFileSync(path.join(site, 'blueprint.json'), paperText);
    const cli = path.join(webDir, 'export', 'cli.mjs');
    const run = (...a) => spawnSync(process.execPath, [cli, 'prepare', '--site', site, ...a], { encoding: 'utf8', env: { ...process.env, PATH: '' } });
    let r = run('--snapshot-file=../outside.json', '--whole');
    eq(r.status, 2, 'a file outside the site');
    ok(/is not a snapshot this site serves/.test(r.stderr), r.stderr);
    r = run('--snapshot-file=data/never-listed.json', '--whole');
    eq(r.status, 2, 'a file the index does not list');
    r = run('--snapshot-file=blueprint.json', '--whole', '--sha256=' + '0'.repeat(64));
    eq(r.status, 2, 'the page saw other bytes');
    ok(JSON.parse(r.stdout.trim().split('\n').pop()).stale, 'said to be stale');
    r = run('--snapshot-file=blueprint.json', '--scope=no-such');
    eq(r.status, 2, 'no such part');
    r = run('--snapshot-file=blueprint.json', '--whole');
    eq(r.status, 3, 'with no TeX on PATH, an environment failure');
    ok(/no TeX engine/.test(r.stderr), r.stderr);
  } finally {
    fs.rmSync(site, { recursive: true, force: true });
  }
});

await check('the command line says what is wrong, with its exit status', () => {
  const cli = path.join(webDir, 'export', 'cli.mjs');
  const snap = path.join(webDir, 'sample', 'paper', 'blueprint.json');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-export-cli-'));
  try {
    const run = (...a) => spawnSync(process.execPath, [cli, ...a], { encoding: 'utf8', env: { ...process.env, PATH: '' } });
    let r = run('export', '--snapshot', snap, '--scope', 'nope', '--out', out);
    eq(r.status, 2, 'a bad part');
    ok(/there is no object 'nope'/.test(r.stderr), r.stderr);
    r = run('export', '--snapshot', path.join(out, 'none.json'));
    eq(r.status, 2, 'no snapshot');
    r = run('export', '--snapshot', snap, '--scope', 'products', '--out', out, '--tex-only');
    eq(r.status, 0, 'TeX only needs no TeX');
    ok(fs.existsSync(path.join(out, 'paper-3-products.tex')), 'the .tex is written');
    // A PDF left by an earlier run must not pass for this one.
    fs.writeFileSync(path.join(out, 'paper-3-products.pdf'), '%PDF-1.5 stale');
    r = run('export', '--snapshot', snap, '--scope', 'products', '--out', out);
    eq(r.status, 3, 'no TeX installed');
    eq(fs.existsSync(path.join(out, 'paper-3-products.pdf')), false, 'the stale PDF is gone');
    r = run('list', '--snapshot', snap, '--json');
    eq(r.status, 0, 'list');
    eq(JSON.parse(r.stdout).length, 9, 'eight parts along refines and the whole along instance_of');
    r = run('frobnicate');
    eq(r.status, 2, 'an unknown command');
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

await check('the source archive is a zip of the files', () => {
  const z = zipFiles([{ name: 'a/x.tex', data: Buffer.from('hello') }, { name: 'a/assets/y.png', data: Buffer.from([1, 2, 3]) }]);
  eq(z.readUInt32LE(0), 0x04034b50, 'a local header first');
  eq(z.readUInt32LE(z.length - 22), 0x06054b50, 'the end of the directory last');
  eq(z.readUInt16LE(z.length - 22 + 10), 2, 'two entries');
  eq(crc32(Buffer.from('123456789')), 0xcbf43926, 'the CRC of the check string');
  if (spawnSync('unzip', ['-v']).status === 0) {
    const f = path.join(os.tmpdir(), `bp-zip-${process.pid}.zip`);
    fs.writeFileSync(f, z);
    const r = spawnSync('unzip', ['-p', f, 'a/x.tex'], { encoding: 'utf8' });
    fs.rmSync(f, { force: true });
    eq(r.stdout, 'hello', 'unzip reads it back');
  }
});

// ---------------------------------------------------------------------------

if (failures.length) {
  console.error(`\n${failures.length} FAILED, ${passed} passed\n`);
  for (const f of failures) console.error(`  x ${f.name}\n      ${f.message}\n`);
  process.exit(1);
}
console.log(`ok - ${passed} checks passed`);
