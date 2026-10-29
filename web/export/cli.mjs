#!/usr/bin/env node
// export/cli.mjs — the PDF export from the command line.
//
//   node export/cli.mjs export  --snapshot blueprint.json [--scope ID] [--depth N|all] …
//   node export/cli.mjs list    --snapshot blueprint.json [--collapse K]
//   node export/cli.mjs site    --site _site [--assets-root ROOT] …
//   node export/cli.mjs prepare --site _site --snapshot-file F --scope ID …
//
// `blueprint export` and `blueprint site --pdf` run this; so does the local
// server behind `blueprint serve` for an export nobody prepared.  `--help`
// says it all; `docs/pdf-export.md` is the reference.
//
// Exit status: 0 done; 1 TeX failed (the .tex and the log are kept); 2 the
// request is wrong (no such part, a bad depth, not a snapshot, a snapshot that
// changed); 3 no TeX on this machine; 4 anything else.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ExportError, GENERATOR, exportLatex, exportScopes, resolveRequest } from './latex.js';
import { compileLatex, findEngine } from './compile.mjs';
import { zipFiles } from './zip.mjs';
import {
  allRequests, assetResolver, loadSnapshot, prepareExport, siteFile, siteSnapshots, snapshotLabel, writeAtomic,
} from './store.mjs';
import { exportDirName } from './sha256.js';

const EXIT = { ok: 0, compile: 1, invalid: 2, environment: 3, internal: 4 };

const USAGE = `usage: node export/cli.mjs <command> [options]

commands:
  export   write one export of a snapshot: <name>.tex, and <name>.pdf unless
           --tex-only; with images also assets/ and <name>-source.zip
             --snapshot FILE     the compiled blueprint.json ('-' reads stdin)
             --scope ID          the part to export (default: the whole blueprint)
             --depth N|all       levels below the part to write out (default all)
             --collapse K        the hierarchy to read along (default: the snapshot's)
             --no-appendices     leave out appendices inside the part
             --out DIR           where to write (default: the working directory)
             --name BASE         the file name, without extension
             --assets-root DIR   the project root, where images are read from
             --label TEXT        how the title block names the snapshot
             --tex-only          write the .tex, do not run TeX
             --timeout SECONDS   for TeX (default 120)
             --json              print the result as JSON
  list     the parts of a snapshot that can be exported, with their depths
             --snapshot FILE [--collapse K] [--json]
  site     prepare every export the website offers for a site's snapshots,
           under <site>/data/exports
             --site DIR          the assembled site (blueprint.json, data/)
             --assets-root DIR   the project root, for the current snapshot's images
             --history-limit N   also prepare the N newest history snapshots (default 10)
             --jobs N            compilations at once (default 2)
             --max-exports N     at most this many compilations (default 2000)
             --timeout SECONDS   per compilation (default 120)
             --tex-only          prepare the TeX only
  prepare  prepare one export of one of a site's snapshots, as the local server does
             --site DIR --snapshot-file FILE [--sha256 HASH]
             --scope ID|--whole --depth N|all [--collapse K] [--no-appendices]
             [--assets-root DIR] [--timeout SECONDS]

exit status: 0 done, 1 TeX failed, 2 a bad request, 3 no TeX installed, 4 other`;

function parseArgs(argv) {
  const flags = new Set(['--no-appendices', '--tex-only', '--json', '--whole', '--help', '-h', '--keep-work']);
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (flags.has(a)) out[a] = true;
    else if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) out[a.slice(0, eq)] = a.slice(eq + 1);
      else {
        if (i + 1 >= argv.length) throw new ExportError('invalid', `option ${a} needs a value`);
        out[a] = argv[i + 1];
        i += 1;
      }
    } else out._.push(a);
  }
  return out;
}

function fail(code, message) {
  const e = new Error(message);
  e.exit = code;
  return e;
}

function readSnapshotArg(args) {
  const f = args['--snapshot'];
  if (!f) throw fail(EXIT.invalid, '--snapshot <blueprint.json> is required');
  if (f === '-') {
    const bytes = fs.readFileSync(0);
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'blueprint-snap-')), 'blueprint.json');
    fs.writeFileSync(tmp, bytes);
    try { return loadSnapshot(tmp); } finally { fs.rmSync(path.dirname(tmp), { recursive: true, force: true }); }
  }
  if (!fs.existsSync(f)) throw fail(EXIT.invalid, `${f}: no such file`);
  try {
    return loadSnapshot(f);
  } catch (e) {
    throw fail(e.invalid ? EXIT.invalid : EXIT.internal, e.message);
  }
}

function seconds(args, dflt = 120) {
  const s = args['--timeout'];
  if (s === undefined) return dflt * 1000;
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0 || n > 3600) throw fail(EXIT.invalid, `--timeout must be a number of seconds up to 3600, not '${s}'`);
  return n * 1000;
}

function requestFromArgs(args) {
  return {
    collapse: args['--collapse'],
    scope: args['--whole'] ? null : args['--scope'] === undefined ? null : args['--scope'],
    depth: args['--depth'],
    appendices: !args['--no-appendices'],
  };
}

// ---------------------------------------------------------------------------

async function cmdExport(args) {
  const { model, hash } = readSnapshotArg(args);
  const req = resolveRequest(model, requestFromArgs(args));
  const resolveAsset = args['--assets-root'] ? assetResolver(args['--assets-root']) : null;
  const label = args['--label'] || `Snapshot ${hash.slice(0, 12)}`;
  const res = exportLatex(model, req, { resolveAsset, snapshot: { label } });
  const outDir = path.resolve(args['--out'] || '.');
  const name = args['--name'] || res.fileName;
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw fail(EXIT.invalid, `--name must be letters, digits, '.', '_' and '-', not '${name}'`);
  fs.mkdirSync(outDir, { recursive: true });
  const file = (ext) => path.join(outDir, name + ext);
  // Nothing from an earlier run may pass for this one's result.
  for (const ext of ['.pdf', '.log', '-source.zip']) fs.rmSync(file(ext), { force: true });
  writeAtomic(file('.tex'), res.tex);
  const assets = [...new Map(res.assets.map((a) => [a.path, a])).values()];
  const result = {
    ok: true, request: req, snapshot: { sha256: hash }, generator: GENERATOR, title: res.title,
    tex: file('.tex'), pdf: null, source: null, log: null, pages: null,
    diagnostics: res.diagnostics, stats: res.stats,
  };
  if (assets.length) {
    for (const a of assets) {
      fs.mkdirSync(path.join(outDir, 'assets'), { recursive: true });
      fs.copyFileSync(a.from, path.join(outDir, a.path));
    }
    writeAtomic(file('-source.zip'), zipFiles([
      { name: `${name}/${name}.tex`, data: Buffer.from(res.tex, 'utf8') },
      ...assets.map((a) => ({ name: `${name}/${a.path}`, data: fs.readFileSync(a.from) })),
    ]));
    result.source = file('-source.zip');
  }
  let code = EXIT.ok;
  if (!args['--tex-only']) {
    const engine = findEngine();
    if (!engine) {
      result.ok = false;
      result.error = 'no TeX engine: install TeX Live (pdflatex, and latexmk if you can), or pass --tex-only';
      code = EXIT.environment;
    } else {
      const out = await compileLatex({ tex: res.tex, assets, jobName: name, timeoutMs: seconds(args), engine, keepWork: !!args['--keep-work'] });
      result.engine = out.engine;
      result.diagnostics = result.diagnostics.concat(out.warnings.map((w) => ({ level: 'warning', ...w })));
      if (out.ok) {
        writeAtomic(file('.pdf'), out.pdf);
        result.pdf = file('.pdf');
        result.pages = out.pages;
      } else {
        writeAtomic(file('.log'), out.log || out.message);
        result.ok = false;
        result.error = out.message;
        result.errors = out.errors;
        result.log = file('.log');
        code = EXIT.compile;
      }
      if (out.work) result.work = out.work;
    }
  }
  if (args['--json']) {
    process.stdout.write(JSON.stringify(result, null, 1) + '\n');
  } else {
    for (const d of result.diagnostics) {
      process.stderr.write(`${d.level || 'warning'}: [${d.code}]${d.object ? ' ' + d.object + ':' : ''} ${d.message}\n`);
    }
    const what = `${res.description.scope}, ${res.description.detail}`;
    process.stdout.write(`tex: ${result.tex}\n`);
    if (result.source) process.stdout.write(`source: ${result.source}\n`);
    if (result.pdf) process.stdout.write(`pdf: ${result.pdf} (${result.pages} page(s); ${what}; ${res.stats.entries} entries)\n`);
    if (result.error) process.stderr.write(`export: ${result.error}\n` + (result.log ? `export: the TeX log is ${result.log}\n` : ''));
  }
  return code;
}

async function cmdList(args) {
  const { model } = readSnapshotArg(args);
  const kinds = args['--collapse'] ? [args['--collapse']] : model.collapseKinds;
  const rows = [];
  for (const collapse of kinds) {
    for (const s of exportScopes(model, collapse)) {
      const r = resolveRequest(model, { collapse, scope: s.id });
      rows.push({ collapse, scope: s.id, number: s.number, word: s.word, title: s.title, levels: r.height, appendices: r.hasAppendices });
    }
  }
  if (args['--json']) {
    process.stdout.write(JSON.stringify(rows, null, 1) + '\n');
  } else {
    for (const r of rows) {
      const name = r.scope === null ? '(whole blueprint)' : r.scope;
      process.stdout.write(`${r.collapse}\t${name}\t${r.number || ''}\t${r.title}\t${r.levels} level(s)${r.appendices ? '\twith appendices' : ''}\n`);
    }
  }
  return EXIT.ok;
}

/** A pool of `jobs` workers over `items`. */
async function pool(items, jobs, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, jobs) }, async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

async function cmdSite(args) {
  const site = args['--site'];
  if (!site) throw fail(EXIT.invalid, '--site <dir> is required');
  if (!fs.existsSync(path.join(site, 'blueprint.json'))) throw fail(EXIT.invalid, `${site}: no blueprint.json; assemble the site first`);
  const texOnly = !!args['--tex-only'];
  const engine = texOnly ? null : findEngine();
  if (!texOnly && !engine) {
    throw fail(EXIT.environment, 'no TeX engine: install TeX Live (pdflatex, latexmk) to prepare PDFs, or pass --tex-only');
  }
  const limit = args['--history-limit'] === undefined ? 10 : Number(args['--history-limit']);
  const jobs = args['--jobs'] === undefined ? 2 : Number(args['--jobs']);
  const budget = args['--max-exports'] === undefined ? 2000 : Number(args['--max-exports']);
  if (![limit, jobs, budget].every((n) => Number.isInteger(n) && n >= 0)) throw fail(EXIT.invalid, 'numbers must be whole and not negative');
  const timeoutMs = seconds(args);

  // The current snapshot and the newest history, grouped by their bytes.
  const all = siteSnapshots(site);
  const chosen = [all[0], ...all.slice(1, 1 + limit)];
  const groups = new Map();
  for (const s of chosen) {
    if (!fs.existsSync(s.path)) { process.stderr.write(`site: ${s.file}: listed in the index but not there; skipped\n`); continue; }
    let snap;
    try { snap = loadSnapshot(s.path); } catch (e) { process.stderr.write(`site: ${e.message}; skipped\n`); continue; }
    if (!groups.has(snap.hash)) groups.set(snap.hash, { ...snap, entries: [] });
    groups.get(snap.hash).entries.push(s);
  }
  const currentHash = loadSnapshot(all[0].path).hash;

  const compiled = new Map();
  let made = 0;
  let reused = 0;
  let failed = 0;
  let failedCurrent = 0;
  let skipped = 0;
  for (const [hash, g] of groups) {
    const isCurrent = hash === currentHash;
    const label = snapshotLabel(g.entries.find((e) => e.sha) || g.entries[0], hash);
    const wanted = allRequests(g.model);
    await pool(wanted, jobs, async (req) => {
      if (made + failed >= budget) { skipped += 1; return; }
      // Made again unless what is there was made from the same TeX.
      const entry = await prepareExport({
        model: g.model, hash, site, request: req, assetsRoot: isCurrent ? args['--assets-root'] || null : null,
        label, timeoutMs, engine, texOnly, compiled,
      });
      if (entry.reused) {
        reused += 1;
      } else if (entry.status === 'failed') {
        failed += 1;
        if (isCurrent) failedCurrent += 1;
        process.stderr.write(`site: ${exportDirName(hash)} ${entry.fileName}: ${entry.error}\n`);
      } else {
        made += 1;
      }
    });
    process.stdout.write(`exports: ${exportDirName(hash)} (${g.entries.map((e) => e.file).join(', ')}): ` +
      `${wanted.length} export(s)\n`);
  }

  // What no chosen snapshot needs any more goes, so the store stays bounded.
  const root = path.join(site, 'data', 'exports');
  const keep = new Set([...groups.keys()].map(exportDirName));
  let pruned = 0;
  if (fs.existsSync(root)) {
    for (const d of fs.readdirSync(root)) {
      if (keep.has(d)) continue;
      fs.rmSync(path.join(root, d), { recursive: true, force: true });
      pruned += 1;
    }
  }
  process.stdout.write(`exports: ${made} made, ${reused} already there, ${failed} failed` +
    (skipped ? `, ${skipped} not made (over --max-exports)` : '') + (pruned ? `, ${pruned} old snapshot(s) pruned` : '') + '\n');
  return failedCurrent ? EXIT.compile : EXIT.ok;
}

async function cmdPrepare(args) {
  const site = args['--site'];
  if (!site) throw fail(EXIT.invalid, '--site <dir> is required');
  const rel = args['--snapshot-file'] || 'blueprint.json';
  // Only what the site itself serves as a snapshot: its blueprint.json, or a
  // file its history index lists.
  const known = siteSnapshots(site);
  const snap = known.find((s) => s.file === rel);
  if (!snap || !siteFile(site, rel) || !fs.existsSync(snap.path)) throw fail(EXIT.invalid, `'${rel}' is not a snapshot this site serves`);
  let loaded;
  try { loaded = loadSnapshot(snap.path); } catch (e) { throw fail(EXIT.invalid, e.message); }
  const { model, hash } = loaded;
  if (args['--sha256'] && args['--sha256'] !== hash) {
    const e = fail(EXIT.invalid, `${rel} has changed since the page was loaded (it is now ${hash.slice(0, 12)}); reload the page`);
    e.stale = true;
    throw e;
  }
  const req = resolveRequest(model, requestFromArgs(args));
  const engine = findEngine();
  if (!engine) throw fail(EXIT.environment, 'no TeX engine on the server: install TeX Live (pdflatex, latexmk)');
  const current = loadSnapshot(path.join(site, 'blueprint.json')).hash === hash;
  // Reused when what is there was made from the same TeX, made otherwise.
  const entry = await prepareExport({
    model, hash, site, request: req, assetsRoot: current ? args['--assets-root'] || null : null,
    label: snapshotLabel(snap, hash), timeoutMs: seconds(args), engine,
  });
  const dir = 'data/exports/' + exportDirName(hash) + '/';
  process.stdout.write(JSON.stringify({ ok: entry.status === 'ok', cached: !!entry.reused, base: dir, sha256: hash, entry }) + '\n');
  return entry.status === 'ok' ? EXIT.ok : EXIT.compile;
}

// ---------------------------------------------------------------------------

export async function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`export: ${e.message}\n${USAGE}\n`);
    return EXIT.invalid;
  }
  const cmd = args._[0];
  if (args['--help'] || args['-h'] || !cmd) {
    process.stdout.write(USAGE + '\n');
    return cmd || args['--help'] || args['-h'] ? EXIT.ok : EXIT.invalid;
  }
  const run = { export: cmdExport, list: cmdList, site: cmdSite, prepare: cmdPrepare }[cmd];
  if (!run) {
    process.stderr.write(`export: unknown command '${cmd}'\n${USAGE}\n`);
    return EXIT.invalid;
  }
  try {
    return await run(args);
  } catch (e) {
    if (e instanceof ExportError) {
      if (args['--json'] || cmd === 'prepare') process.stdout.write(JSON.stringify({ ok: false, invalid: true, error: e.message }) + '\n');
      process.stderr.write(`export: ${e.message}\n`);
      return EXIT.invalid;
    }
    if (e.environment) {
      if (args['--json'] || cmd === 'prepare') process.stdout.write(JSON.stringify({ ok: false, environment: true, error: e.message }) + '\n');
      process.stderr.write(`export: ${e.message}\n`);
      return EXIT.environment;
    }
    if (e.exit !== undefined) {
      if (args['--json'] || cmd === 'prepare') {
        process.stdout.write(JSON.stringify({ ok: false, invalid: e.exit === EXIT.invalid, environment: e.exit === EXIT.environment, stale: !!e.stale, error: e.message }) + '\n');
      }
      process.stderr.write(`export: ${e.message}\n`);
      return e.exit;
    }
    process.stderr.write(`export: internal error: ${(e && e.stack) || e}\n`);
    return EXIT.internal;
  }
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (invoked) {
  // A reader that stops reading (`| head`) is not an error of the export.
  process.stdout.on('error', (e) => { if (e.code === 'EPIPE') process.exit(process.exitCode || 0); else throw e; });
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}

