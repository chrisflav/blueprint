// export/store.mjs — where prepared exports live, and how they are made.
//
// A site keeps its PDFs under `data/exports/<snapshot>/`, where <snapshot> is
// the first 16 hex digits of the SHA-256 of the snapshot file's bytes, next to
// the history it belongs to (`data/` is what CI keeps on the `gh-pages`
// branch).  Each such directory has a `manifest.json`:
//
//   { "version": 1, "generator": "blueprint-pdf/1",
//     "snapshot": { "sha256": "<all 64 digits>" },
//     "exports": [ { "collapse": "refines", "scope": null, "depth": "all",
//                    "appendices": true, "status": "ok",
//                    "pdf": "<stem>.pdf", "tex": "<stem>.tex",
//                    "source": "<stem>-source.zip",       // with images only
//                    "fileName": "paper-whole", "title": "…", "pages": 6,
//                    "input": "<SHA-256 of the TeX and its images>",
//                    "warnings": [ … ] },
//                  { …, "status": "failed", "error": "…", "log": "<stem>.log",
//                    "tex": "<stem>.tex" } ] }
//
// An entry is found by its canonical request (`resolveRequest`: hierarchy,
// scope, depth, appendices), and the directory by the snapshot's own bytes, so
// a PDF made from one revision is never offered for another, nor one section's
// for another section.  `<stem>` is a hash of the canonical request.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as M from '../model.js';
import { GENERATOR, exportLatex, exportScopes, resolveRequest, requestKey, slugify } from './latex.js';
import { exportDirName } from './sha256.js';
import { compileLatex } from './compile.mjs';
import { zipFiles } from './zip.mjs';

export const MANIFEST_VERSION = 1;

export function sha256Bytes(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function exportsDir(site, hash) {
  return path.join(site, 'data', 'exports', exportDirName(hash));
}

/** The stem of an export's files inside its snapshot's directory. */
export function artifactStem(req) {
  return sha256Bytes(Buffer.from(requestKey(req), 'utf8')).slice(0, 16);
}

/** Write a file so that no reader ever sees half of it. */
export function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.part';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

/** The manifest of a snapshot's exports, or null when there is none or it is not for this snapshot or generator. */
export function readManifest(site, hash) {
  const p = path.join(exportsDir(site, hash), 'manifest.json');
  let m;
  try { m = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
  if (!m || m.version !== MANIFEST_VERSION || !m.snapshot || m.snapshot.sha256 !== hash || !Array.isArray(m.exports)) return null;
  if (m.generator !== GENERATOR) return null;
  return m;
}

const sameRequest = (a, b) => a.collapse === b.collapse && (a.scope ?? null) === (b.scope ?? null) &&
  String(a.depth) === String(b.depth) && !!a.appendices === !!b.appendices;

/** The manifest entry for a canonical request, when its files are all there. */
export function findEntry(site, hash, req) {
  const m = readManifest(site, hash);
  if (!m) return null;
  const e = m.exports.find((x) => sameRequest(x, req));
  if (!e) return null;
  const dir = exportsDir(site, hash);
  for (const k of ['pdf', 'tex', 'source', 'log']) {
    if (e[k] && !fs.existsSync(path.join(dir, e[k]))) return null;
  }
  return e;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Run `fn` holding the lock of a snapshot's export directory. */
async function withLock(dir, fn) {
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, 'manifest.lock');
  const until = Date.now() + 60000;
  for (;;) {
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        // A lock left by a process that died is not held by anyone.
        if (Date.now() - fs.statSync(lock).mtimeMs > 10 * 60000) fs.rmSync(lock, { force: true });
      } catch (e2) { /* gone meanwhile */ }
      if (Date.now() > until) throw new Error(`${lock}: held for over a minute`);
      await sleep(50);
    }
  }
  try {
    return await fn();
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

/** Put an entry into the manifest, replacing the entry of the same request. */
export async function recordEntry(site, hash, entry) {
  const dir = exportsDir(site, hash);
  await withLock(dir, () => {
    const m = readManifest(site, hash) || { version: MANIFEST_VERSION, generator: GENERATOR, snapshot: { sha256: hash }, exports: [] };
    m.exports = m.exports.filter((x) => !sameRequest(x, entry));
    m.exports.push(entry);
    m.exports.sort((a, b) => (a.collapse + ' ' + (a.scope || '') + ' ' + a.depth + ' ' + a.appendices)
      .localeCompare(b.collapse + ' ' + (b.scope || '') + ' ' + b.depth + ' ' + b.appendices));
    writeAtomic(path.join(dir, 'manifest.json'), JSON.stringify(m, null, 1) + '\n');
  });
}

/**
 * Every request the website's export dialog can make of a snapshot: each
 * hierarchy, each part (`exportScopes`), each depth from 1 to the last one
 * that cuts something, and all; with and without appendices where the part
 * has any.  Canonical, and without repeats.
 */
export function allRequests(model) {
  const out = [];
  const seen = new Set();
  for (const collapse of model.collapseKinds) {
    for (const s of exportScopes(model, collapse)) {
      let base;
      try { base = resolveRequest(model, { collapse, scope: s.id, depth: 'all' }); } catch (e) { continue; }
      const depths = [];
      for (let d = 1; d < base.height; d += 1) depths.push(d);
      depths.push('all');
      for (const depth of depths) {
        for (const appendices of base.hasAppendices ? [true, false] : [true]) {
          const req = resolveRequest(model, { collapse, scope: s.id, depth, appendices });
          const k = requestKey(req);
          if (seen.has(k)) continue;
          seen.add(k);
          out.push(req);
        }
      }
    }
  }
  return out;
}

const IMAGE_TYPES = new Set(['png', 'jpg', 'jpeg', 'pdf']);
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/**
 * Where an image named in a body is: relative to the Markdown file the body
 * came from (`source.file`, itself relative to the project root), and inside
 * the project root, never outside it.  Only what pdfLaTeX can include.
 */
export function assetResolver(root) {
  const base = path.resolve(root);
  return (object, src) => {
    const raw = String(src || '').trim();
    if (!raw) return { error: 'an image with no address' };
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//')) {
      return { error: `the image ${raw} is on the web; the export does not fetch it` };
    }
    const file = object && object.source && object.source.file;
    if (!file) return { error: `the image ${raw} has no source file to be read relative to` };
    let rel = raw.split(/[?#]/)[0];
    try { rel = decodeURIComponent(rel); } catch (e) { /* as written */ }
    const abs = path.resolve(base, path.dirname(file), rel);
    const inside = path.relative(base, abs);
    if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) {
      return { error: `the image ${raw} is outside the project` };
    }
    const ext = path.extname(abs).slice(1).toLowerCase();
    if (!IMAGE_TYPES.has(ext)) return { error: `the image ${raw} is a .${ext || '?'} file; PDF exports take PNG, JPEG and PDF images` };
    let st;
    try { st = fs.statSync(abs); } catch (e) { return { error: `the image ${raw} does not exist (looked for ${inside})` }; }
    if (!st.isFile() || st.size > MAX_IMAGE_BYTES) return { error: `the image ${raw} is not a file of at most 20 MB` };
    const name = sha256Bytes(Buffer.from(inside)).slice(0, 8) + '-' + slugify(path.basename(abs, path.extname(abs)), 40) + '.' + ext;
    return { path: 'assets/' + name, from: abs, source: inside };
  };
}

const README = (name) => `This is the LaTeX source of a blueprint export.

    latexmk -pdf ${name}.tex

or run \`pdflatex ${name}.tex\` twice.  The images it includes are in assets/.
`;

/**
 * Make one export of a snapshot into a site's store and record it: the .tex
 * (and a .zip with the images, when there are any), then the PDF, or the log
 * when TeX failed.  Earlier files of the same request are removed first, so a
 * failure can never leave an older PDF in place of the new one.
 *
 * `compiled` is a cache of this run: TeX + images -> PDF, so that the same
 * document is not compiled twice.  Returns the manifest entry.
 */
export async function prepareExport({ model, hash, site, request, assetsRoot = null, label = null,
  timeoutMs, engine, texOnly = false, compiled = new Map() }) {
  const req = resolveRequest(model, request);
  const resolveAsset = assetsRoot ? assetResolver(assetsRoot) : null;
  const res = exportLatex(model, req, { resolveAsset, snapshot: { label } });
  const dir = exportsDir(site, hash);
  const stem = artifactStem(req);
  const assets = dedupeAssets(res.assets);
  // What the PDF is made of: the very TeX and images.  An export already
  // there for the same input is reused; anything else is made again, so a
  // change to the export itself never leaves a PDF of the old output behind.
  const input = sha256Bytes(Buffer.concat([Buffer.from(res.tex, 'utf8'), ...assets.map((a) => fs.readFileSync(a.from))]));
  const prev = findEntry(site, hash, req);
  if (prev && prev.input === input && (prev.status === 'ok' || (texOnly && prev.status === 'tex-only'))) {
    return { ...prev, reused: true };
  }
  for (const ext of ['.pdf', '.tex', '.log', '-source.zip']) fs.rmSync(path.join(dir, stem + ext), { force: true });
  writeAtomic(path.join(dir, stem + '.tex'), res.tex);
  let source = null;
  if (assets.length) {
    source = stem + '-source.zip';
    writeAtomic(path.join(dir, source), zipFiles([
      { name: res.fileName + '/' + res.fileName + '.tex', data: Buffer.from(res.tex, 'utf8') },
      { name: res.fileName + '/README.txt', data: Buffer.from(README(res.fileName), 'utf8') },
      ...assets.map((a) => ({ name: res.fileName + '/' + a.path, data: fs.readFileSync(a.from) })),
    ]));
  }
  const entry = {
    collapse: req.collapse, scope: req.scope, depth: req.depth, appendices: req.appendices,
    fileName: res.fileName, title: res.title, tex: stem + '.tex', input,
    ...(source ? { source } : {}),
    entries: res.stats.entries,
    warnings: res.diagnostics.map(({ code, message, object }) => ({ code, message, object })),
  };
  if (texOnly) {
    entry.status = 'tex-only';
  } else {
    let out = compiled.get(input);
    if (!out) {
      out = await compileLatex({ tex: res.tex, assets, jobName: res.fileName.replace(/[^A-Za-z0-9._-]/g, '-'), timeoutMs, engine });
      compiled.set(input, out);
    }
    if (out.environment) {
      const e = new Error(out.message);
      e.environment = true;
      throw e;
    }
    if (out.ok) {
      writeAtomic(path.join(dir, stem + '.pdf'), out.pdf);
      entry.status = 'ok';
      entry.pdf = stem + '.pdf';
      entry.pages = out.pages;
      entry.warnings.push(...out.warnings.map(({ code, message, object }) => ({ code, message, object: object || null })));
    } else {
      writeAtomic(path.join(dir, stem + '.log'), out.log || out.message);
      entry.status = 'failed';
      entry.error = out.message;
      entry.log = stem + '.log';
    }
  }
  await recordEntry(site, hash, entry);
  return entry;
}

function dedupeAssets(list) {
  const seen = new Map();
  for (const a of list) if (!seen.has(a.path)) seen.set(a.path, a);
  return [...seen.values()];
}

/** The model of a snapshot file, and its hash. */
export function loadSnapshot(file) {
  const bytes = fs.readFileSync(file);
  const hash = sha256Bytes(bytes);
  let snapshot;
  try {
    snapshot = JSON.parse(bytes.toString('utf8'));
  } catch (e) {
    const err = new Error(`${file}: not JSON (${e.message})`);
    err.invalid = true;
    throw err;
  }
  if (!snapshot || !Array.isArray(snapshot.objects)) {
    const err = new Error(`${file}: not a blueprint snapshot (no "objects" array)`);
    err.invalid = true;
    throw err;
  }
  return { model: M.buildModel(snapshot), hash, bytes };
}

/**
 * The snapshots a site serves, newest first: its `blueprint.json`, and the
 * files its `data/index.json` lists, each resolved inside the site.  Returns
 * [{file (as the site names it), path, sha, date, current}].
 */
export function siteSnapshots(site) {
  const out = [{ file: 'blueprint.json', path: path.join(site, 'blueprint.json'), sha: null, date: null, current: true }];
  let index = null;
  try { index = JSON.parse(fs.readFileSync(path.join(site, 'data', 'index.json'), 'utf8')); } catch (e) { /* no history */ }
  const entries = index && Array.isArray(index.snapshots) ? index.snapshots.slice() : [];
  entries.sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.sha).localeCompare(String(a.sha)));
  for (const e of entries) {
    if (!e || typeof e.file !== 'string') continue;
    if (e.file === 'blueprint.json') {
      out[0].sha = e.sha || null;
      out[0].date = e.date || null;
      continue;
    }
    const p = siteFile(site, e.file);
    if (!p) continue;
    out.push({ file: e.file, path: p, sha: e.sha || null, date: e.date || null, current: false });
  }
  return out;
}

/** A path the site names, inside the site, or null. */
export function siteFile(site, rel) {
  if (typeof rel !== 'string' || !rel || rel.includes('\0')) return null;
  const base = path.resolve(site);
  const abs = path.resolve(base, rel);
  const inside = path.relative(base, abs);
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) return null;
  return abs;
}

/** How the PDF's title block names a snapshot. */
export function snapshotLabel(entry, hash) {
  const bits = [];
  if (entry && entry.date) bits.push(entry.date);
  if (entry && entry.sha && entry.sha !== 'current') bits.push('revision ' + String(entry.sha).slice(0, 10));
  return 'Snapshot ' + (bits.length ? bits.join(', ') : hash.slice(0, 12));
}
