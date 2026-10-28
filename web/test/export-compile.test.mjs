// web/test/export-compile.test.mjs
//
// The PDF export with TeX: that what export.test.mjs checks as LaTeX also
// compiles, into PDFs that say what the blueprint says in the order it says
// it, and that every way TeX can fail ends in a failure that says why, never
// in a PDF from an earlier run.
//
//   nix-shell -p nodejs_22 texliveMedium poppler-utils --run "node web/test/export-compile.test.mjs"
//
// Without pdflatex on PATH it says so and passes: the TeX itself is
// export.test.mjs's.  With pdftotext (poppler) it also reads the PDFs back.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compileLatex, findEngine } from '../export/compile.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.join(here, '..');
const repo = path.join(webDir, '..');
const cli = path.join(webDir, 'export', 'cli.mjs');
const paper = path.join(webDir, 'sample', 'paper', 'blueprint.json');

if (!findEngine()) {
  console.log('ok - skipped: no pdflatex on PATH (nix-shell -p texliveMedium runs these)');
  process.exit(0);
}
const pdftotext = spawnSync('pdftotext', ['-v']).error ? null : 'pdftotext';

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

const out = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-compile-test-'));
const run = (...a) => {
  const r = spawnSync(process.execPath, [cli, 'export', '--json', '--out', out, ...a], { encoding: 'utf8' });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch (e) { /* not JSON */ }
  return { status: r.status, json, stderr: r.stderr };
};
// The text of a PDF, its spacing (columns, the gap after a heading's number) one space.
const text = (pdf) => spawnSync(pdftotext, [pdf, '-'], { encoding: 'utf8' }).stdout.replace(/\s+/g, ' ');
const inOrder = (hay, needles) => {
  let at = -1;
  for (const n of needles) {
    const i = hay.indexOf(n, at + 1);
    if (i < 0) return `"${n}" missing after position ${at}`;
    at = i;
  }
  return null;
};

function tinySnapshot(body, extra = {}) {
  return JSON.stringify({
    version: 1,
    project: { name: 'tiny', title: 'Tiny', ...extra },
    schema: { defaultCollapse: 'refines', kinds: {
      section: { boundary: {} }, theorem: { boundary: {}, countable: true },
      refines: { boundary: { src: { min: 1, max: 1 }, tgt: { min: 1, max: 1 } }, collapse: true },
    } },
    objects: [
      { id: 'sec', kind: 'section', boundary: [], attrs: { title: 'A section' }, body: 'Opening.', depth: 0 },
      { id: 'thm', kind: 'theorem', boundary: [], attrs: { title: 'The theorem' }, body, depth: 0 },
      { id: 'refines/thm/sec', kind: 'refines', boundary: [{ role: 'src', id: 'thm' }, { role: 'tgt', id: 'sec' }], attrs: {}, body: '', depth: 1 },
    ],
    derived: { status: {} },
  });
}

try {
  await check('the whole blueprint compiles, with its image, contents and order', () => {
    const r = run('--snapshot', paper, '--assets-root', path.join(repo, 'examples', 'paper'));
    eq(r.status, 0, 'exit status: ' + r.stderr);
    ok(r.json && r.json.ok, 'ok');
    const pdf = fs.readFileSync(r.json.pdf);
    eq(pdf.subarray(0, 5).toString(), '%PDF-', 'a PDF');
    ok(r.json.pages >= 3, `${r.json.pages} pages`);
    ok(fs.existsSync(path.join(out, 'assets')) && r.json.source, 'the image is packaged with the source');
    if (!pdftotext) return;
    const t = text(r.json.pdf);
    const problem = inOrder(t, ['Compactness through finite intersections', 'The complete blueprint', 'Contents',
      '1 Introduction', '2 Covers and compact spaces', '2.1 Covers', 'Definition 2.1.1 (Open cover)',
      'Definition 2.1.2', 'Definition 2.2.1', 'Theorem 2.2.2', 'Proof 2.2.2.1', 'Lemma 2.2.2.1.1',
      'Lemma 2.2.2.1.2', 'Lemma 2.2.3 (Tube lemma)', '3 Products', 'Theorem 3.1', 'Remark 3.2',
      'belongs here too', '4 Conventions', 'Remark 4.1 (Symbols)', 'Remark 4.2']);
    eq(problem, null, 'reading order in the PDF');
    ok(!/\?\?/.test(t), 'no unresolved reference marks');
    ok(t.includes('Čech') && t.includes('Erdős'), 'accented names survive');
    ok(t.includes('α ∈ A') || t.includes('α∈A'), 'Greek in text');
  });

  await check('a section compiles, with the shared lemma written out and the outside listed', () => {
    const r = run('--snapshot', paper, '--scope', 'products');
    eq(r.status, 0, 'exit status: ' + r.stderr);
    if (!pdftotext) return;
    const t = text(r.json.pdf);
    eq(inOrder(t, ['Section 3: Products', '3 Products', 'Theorem 3.1', 'Proof.', 'Remark 3.2',
      'Written out here', 'Lemma 2.2.3 (Tube lemma)', 'Outside this export', 'Theorem 2.2.2']), null, 'order');
    ok(!t.includes('Definition 2.1.1 (Open cover)'), 'nothing of section 2 but the shared lemma');
  });

  await check('a smaller part compiles at a chosen depth', () => {
    const r = run('--snapshot', paper, '--scope', 'thm-fip', '--depth', '1');
    eq(r.status, 0, 'exit status: ' + r.stderr);
    eq(r.json.request.depth, 1, 'depth 1');
    if (!pdftotext) return;
    const t = text(r.json.pdf);
    ok(t.includes('Theorem 2.2.2: Compactness by closed sets') && t.includes('1 level below Theorem 2.2.2'), 'the title block');
    ok(t.includes('left out at this detail level'), 'it says what it leaves out');
    ok(!t.includes('Lemma 2.2.2.1.1 (Complements)'), 'the lemmas are one level too far');
    ok(t.includes('Lemma 2.2.2.1.1∗') || t.includes('Lemma 2.2.2.1.1 ∗') || t.includes('Outside this export'), 'a reference to one is to outside the export');
  });

  await check('a TeX error fails the export, says where, and leaves no PDF behind', () => {
    const snap = path.join(out, 'bad.json');
    fs.writeFileSync(snap, tinySnapshot('Then $\\nosuchmacro{x}$ holds.'));
    fs.writeFileSync(path.join(out, 'tiny-whole.pdf'), '%PDF-1.5 from an earlier run');
    const r = run('--snapshot', snap);
    eq(r.status, 1, 'exit status 1');
    ok(r.json && !r.json.ok, 'not ok');
    ok(/Undefined control sequence/.test(r.json.error) && /in thm/.test(r.json.error), 'the error names the object: ' + r.json.error);
    eq(fs.existsSync(path.join(out, 'tiny-whole.pdf')), false, 'the earlier PDF is gone');
    ok(fs.existsSync(path.join(out, 'tiny-whole.log')) && fs.existsSync(path.join(out, 'tiny-whole.tex')), 'the log and the TeX are kept');
  });

  await check('a formula that would read a file is set as its source, not run', () => {
    const snap = path.join(out, 'read.json');
    fs.writeFileSync(snap, tinySnapshot('Leak $\\input{/etc/hostname}$ here.'));
    const r = run('--snapshot', snap, '--name', 'leak');
    eq(r.status, 0, 'compiles: ' + (r.json && r.json.error));
    ok(r.json.diagnostics.some((d) => d.code === 'unsafe-maths' && d.object === 'thm'), 'and says so');
    if (pdftotext) ok(text(r.json.pdf).includes('$\\input{/etc/hostname}$'), 'the PDF shows the source');
  });

  await check('TeX itself may not read files outside its directory', async () => {
    // Below the export's own guard: the sandbox, with raw TeX that tries.
    const tex = '\\documentclass{article}\\begin{document}Leak: \\input{/etc/hostname} done.\\end{document}\n';
    const res = await compileLatex({ tex, jobName: 'leak', timeoutMs: 60000 });
    eq(res.ok, false, 'refused');
    ok(/openin_any|not found|Emergency stop/i.test(res.log + ' ' + res.message), 'the log says why: ' + res.message);
    eq(res.pdf, null, 'and there is no PDF');
  });

  await check('TeX that never ends is stopped at the time limit', () => {
    const snap = path.join(out, 'loop.json');
    fs.writeFileSync(snap, tinySnapshot('Forever $\\def\\x{\\x}\\x$.'));
    const t0 = Date.now();
    const r = run('--snapshot', snap, '--name', 'loop', '--timeout', '4');
    eq(r.status, 1, 'a failure');
    ok(/did not finish within 4 s/.test(r.json.error), r.json.error);
    ok(Date.now() - t0 < 30000, 'promptly');
  });
} finally {
  fs.rmSync(out, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`\n${failures.length} FAILED, ${passed} passed\n`);
  for (const f of failures) console.error(`  x ${f.name}\n      ${f.message}\n`);
  process.exit(1);
}
console.log(`ok - ${passed} checks passed${pdftotext ? '' : ' (no pdftotext: the PDFs were not read back)'}`);
