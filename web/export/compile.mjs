// export/compile.mjs — LaTeX to PDF, in a directory of its own.
//
// One compilation is one fresh temporary directory holding the .tex and its
// images, and nothing else; TeX runs there with
//
//   * no shell escape (`-no-shell-escape`, and `shell_escape=f` for engines
//     that read it from the environment),
//   * `openin_any=p` and `openout_any=p`: no file may be read or written by
//     name outside that directory, so a body that says `\input{/etc/passwd}`
//     gets nothing,
//   * a wall-clock limit, after which the whole process group is killed,
//   * `-halt-on-error`, so an error stops it rather than producing a PDF with
//     a hole in it,
//
// and as many passes as the contents and the page references need: latexmk
// decides when it has them, and without latexmk pdflatex is run until the
// log stops asking for another pass.  Success means a PDF that starts with
// `%PDF-`, an exit status of 0 and a log with no undefined reference and no
// missing character; anything else is a failure with the log kept for the
// caller, never a PDF left over from an earlier run.  The directory is
// removed afterwards either way.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_TIMEOUT_MS = 120000;
const MAX_PDF_BYTES = 64 * 1024 * 1024;

/** The first executable called `name` on PATH, or null. */
export function which(name, env = process.env) {
  for (const dir of String(env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, name);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      if (fs.statSync(p).isFile()) return p;
    } catch (e) { /* not here */ }
  }
  return null;
}

/**
 * How TeX will be run here: latexmk driving pdflatex when both are installed,
 * pdflatex alone otherwise, or null.  `BLUEPRINT_LATEXMK` / `BLUEPRINT_PDFLATEX`
 * name other executables.
 */
export function findEngine(env = process.env) {
  const pdflatex = env.BLUEPRINT_PDFLATEX || which('pdflatex', env);
  if (!pdflatex) return null;
  const latexmk = env.BLUEPRINT_LATEXMK || which('latexmk', env);
  return { pdflatex, latexmk: latexmk || null };
}

function run(cmd, args, { cwd, env, deadline }) {
  return new Promise((resolve) => {
    let out = '';
    let killed = false;
    let child;
    try {
      child = spawn(cmd, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ code: -1, out: String(e), timedOut: false });
      return;
    }
    const keep = (d) => { if (out.length < 200000) out += d; };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const left = Math.max(1, deadline - Date.now());
    const timer = setTimeout(() => {
      killed = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { try { child.kill('SIGKILL'); } catch (e2) { /* gone */ } }
    }, left);
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out: out + String(e), timedOut: false }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: killed ? -1 : code, out, timedOut: killed }); });
  });
}

/** Which object of the .tex a line belongs to: the `% object: …` comment above it. */
function objectAt(texLines, line) {
  for (let i = Math.min(line, texLines.length) - 1; i >= 0; i -= 1) {
    const m = /^% (object|proof|step|text|repeated): (\S+)/.exec(texLines[i]);
    if (m) return m[2];
    if (texLines[i].startsWith('\\begin{document}')) return null;
  }
  return null;
}

/**
 * Read a TeX log: errors with the line and object they are in, and the
 * warnings that make a PDF wrong rather than merely ugly.
 */
export function readLog(log, tex, jobName) {
  const texLines = String(tex).split('\n');
  const lines = String(log).split('\n');
  const errors = [];
  const fileLine = new RegExp('^(?:\\./)?' + jobName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\.tex:(\\d+): (.*)$');
  for (let i = 0; i < lines.length; i += 1) {
    const m = fileLine.exec(lines[i]);
    if (m) {
      const line = Number(m[1]);
      const context = lines.slice(i + 1, i + 3).join(' ').replace(/\s+/g, ' ').trim();
      errors.push({ line, message: m[2].trim(), context, object: objectAt(texLines, line) });
    } else if (/^! /.test(lines[i]) && !errors.some((e) => e.message === lines[i].slice(2).trim())) {
      errors.push({ line: null, message: lines[i].slice(2).trim(), context: lines.slice(i + 1, i + 3).join(' ').trim(), object: null });
    }
  }
  const undefinedRefs = [...String(log).matchAll(/Reference `([^']+)' on page \d+ undefined/g)].map((m) => m[1]);
  const missingChars = [...String(log).matchAll(/Missing character: There is no (.+?) in font/g)].map((m) => m[1]);
  const overfull = [...String(log).matchAll(/Overfull \\hbox \((\d+(?:\.\d+)?)pt too wide\)[^\n]*lines? (\d+)/g)]
    .map((m) => ({ by: Number(m[1]), line: Number(m[2]), object: objectAt(texLines, Number(m[2])) }))
    .filter((o) => o.by > 6);
  const rerun = /Rerun to get|Label\(s\) may have changed|There were undefined references|No file .*\.toc/.test(log);
  const written = /Output written on .*? \((\d+) pages?, (\d+) bytes\)/.exec(log);
  return { errors, undefinedRefs: [...new Set(undefinedRefs)], missingChars: [...new Set(missingChars)], overfull, rerun,
    pages: written ? Number(written[1]) : null };
}

const SAFE_ASSET = /^assets\/[A-Za-z0-9._-]+$/;

/**
 * Compile `tex` to PDF.  `assets` are {path, from}: the file at `from` is
 * copied to `path` (which must be `assets/<name>`) next to the .tex.
 * Returns {ok, pdf (a Buffer, when ok), log, errors, warnings, engine,
 * passes, timedOut, message}.
 */
export async function compileLatex({ tex, assets = [], jobName = 'blueprint', timeoutMs = DEFAULT_TIMEOUT_MS,
  engine = findEngine(), keepWork = false, epoch = null } = {}) {
  if (!engine) {
    return { ok: false, environment: true, message: 'no TeX engine: neither pdflatex nor latexmk is on PATH', log: '', errors: [], warnings: [] };
  }
  if (!/^[A-Za-z0-9._-]+$/.test(jobName)) throw new Error(`bad job name ${jobName}`);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'blueprint-pdf-'));
  try {
    fs.writeFileSync(path.join(work, jobName + '.tex'), tex);
    for (const a of assets) {
      if (!SAFE_ASSET.test(a.path)) throw new Error(`bad asset path ${a.path}`);
      fs.mkdirSync(path.join(work, 'assets'), { recursive: true });
      fs.copyFileSync(a.from, path.join(work, a.path));
    }
    const env = {
      ...process.env,
      openin_any: 'p',
      openout_any: 'p',
      shell_escape: 'f',
      TEXMFOUTPUT: work,
      max_print_line: '10000',
      error_line: '254',
      half_error_line: '238',
    };
    // The same .tex makes the same PDF when a date is given (the committed
    // samples are made that way); otherwise the PDF carries today's.
    const when = epoch !== null ? epoch : process.env.SOURCE_DATE_EPOCH;
    if (when !== undefined && when !== null && /^\d+$/.test(String(when))) {
      env.SOURCE_DATE_EPOCH = String(when);
      env.FORCE_SOURCE_DATE = '1';
    }
    const deadline = Date.now() + timeoutMs;
    const texArgs = ['-no-shell-escape', '-interaction=nonstopmode', '-halt-on-error', '-file-line-error'];
    let result;
    let passes = 0;
    if (engine.latexmk) {
      result = await run(engine.latexmk, ['-pdf', '-norc', '-silent', ...texArgs,
        `-pdflatex="${engine.pdflatex}" ${texArgs.join(' ')} %O %S`, jobName + '.tex'], { cwd: work, env, deadline });
      passes = (result.out.match(/Run number \d+ of rule/g) || []).length || null;
    } else {
      for (passes = 1; passes <= 4; passes += 1) {
        result = await run(engine.pdflatex, [...texArgs, jobName + '.tex'], { cwd: work, env, deadline });
        if (result.code !== 0 || result.timedOut) break;
        const log = readFile(path.join(work, jobName + '.log'));
        if (passes >= 2 && !readLog(log, tex, jobName).rerun) break;
      }
    }
    const log = readFile(path.join(work, jobName + '.log'));
    const read = readLog(log, tex, jobName);
    const pdfPath = path.join(work, jobName + '.pdf');
    let pdf = null;
    if (fs.existsSync(pdfPath)) {
      const st = fs.statSync(pdfPath);
      if (st.size <= MAX_PDF_BYTES) pdf = fs.readFileSync(pdfPath);
    }
    const warnings = [];
    for (const r of read.undefinedRefs) warnings.push({ code: 'undefined-reference', message: `the reference ${r} is undefined` });
    for (const c of read.missingChars) warnings.push({ code: 'missing-character', message: `the font has no ${c}` });
    for (const o of read.overfull) warnings.push({ code: 'overfull', message: `a line is ${o.by}pt too wide`, object: o.object, line: o.line });
    const isPdf = !!pdf && pdf.subarray(0, 5).toString('latin1') === '%PDF-';
    let message = null;
    if (result.timedOut) message = `TeX did not finish within ${Math.round(timeoutMs / 1000)} s`;
    else if (result.code !== 0) {
      const e = read.errors[0];
      message = e ? `LaTeX error${e.object ? ` in ${e.object}` : ''}${e.line ? ` (line ${e.line})` : ''}: ${e.message}${e.context ? ' — ' + e.context : ''}`
        : `TeX exited with status ${result.code}` + (log ? '' : ': ' + result.out.trim().split('\n').slice(-3).join(' '));
    } else if (!isPdf) message = 'TeX produced no PDF';
    else if (read.undefinedRefs.length) message = `unresolved references in the PDF: ${read.undefinedRefs.join(', ')}`;
    else if (read.missingChars.length) message = `characters missing from the fonts: ${read.missingChars.join(', ')}`;
    const ok = message === null;
    return {
      ok,
      pdf: ok ? pdf : null,
      log,
      errors: read.errors,
      warnings,
      passes,
      pages: read.pages,
      timedOut: !!result.timedOut,
      engine: engine.latexmk ? 'latexmk' : 'pdflatex',
      message,
      work: keepWork ? work : null,
    };
  } finally {
    if (!keepWork) fs.rmSync(work, { recursive: true, force: true });
  }
}

function readFile(p) {
  try { return fs.readFileSync(p, 'latin1'); } catch (e) { return ''; }
}
