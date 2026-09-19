// web/test/gen-large.mjs — a synthetic snapshot of the size the real blueprint
// this site will serve has, for the performance harness (`bench.mjs`).
//
//   nix-shell -p nodejs_22 --run "node web/test/gen-large.mjs [out.json]"
//
// Shape (docs/snapshot-format.md, version 1), deterministic for a fixed seed:
//
//   * a three-level chapter / section / subsection hierarchy of `section`
//     objects, nested with `refines`;
//   * ~1,100 definitions, ~800 lemmas and ~1,210 theorems (750 theorems plus
//     460 propositions, which the real project folds into the `theorem` kind),
//     each refining a section — ~3,300 node objects in total;
//   * one `refines` edge object per non-chapter node, plus a few extra parents
//     so multi-parent objects are exercised — ~3,300 of them;
//   * ~1,500 `uses` edge objects, mostly local to a section, some crossing
//     chapters, and some declared coarsely between sections so the quotient's
//     declared / derived / both table has something to say;
//   * `derived.status`, `derived.progress` for `refines`, and a few checks.
//
// Everything is generated from a seeded PRNG, so two runs produce byte-identical
// output and benchmark numbers are comparable.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// --- deterministic PRNG (mulberry32) ---------------------------------------

function rng(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- vocabulary -------------------------------------------------------------

const AREAS = [
  'perfectoid', 'adic', 'prismatic', 'crystalline', 'etale', 'motivic',
  'rigid', 'syntomic', 'condensed', 'derived', 'formal', 'logarithmic',
  'arithmetic', 'spectral', 'analytic',
];
const NOUNS = [
  'space', 'site', 'sheaf', 'topos', 'complex', 'filtration', 'cohomology',
  'descent', 'comparison', 'tilting', 'valuation', 'completion', 'period',
  'lattice', 'module', 'functor', 'stack', 'gerbe', 'cover', 'fibration',
];
const VERBS = [
  'is exact', 'commutes with limits', 'is fully faithful', 'is an equivalence',
  'is quasi-compact', 'has finite cohomological dimension', 'is flat',
  'is universally closed', 'descends along the cover', 'is independent of the choice',
];

const MATHS = [
  'Let $X$ be a \\Fbar-scheme and let $\\Ocal_X$ be its structure sheaf.',
  'Write $\\Fbar$ for the algebraic closure and $\\Ocal_X$ for the structure sheaf.',
  'Then $H^i(X, \\Ocal_X) = 0$ for $i > \\dim X$.',
  'We have \\( \\mathrm{R}\\Gamma(X, \\Ocal_X) \\simeq \\mathrm{R}\\Gamma(Y, \\Ocal_Y) \\).',
  'Consider the exact triangle \\[ \\Ocal_X \\to \\mathcal{F} \\to \\mathcal{G} \\to \\Ocal_X[1]. \\]',
  'In particular $\\dim_{\\Fbar} H^1 < \\infty$.',
];

const STATUS_WEIGHTS = [
  ['proved', 0.42],
  ['stated', 0.28],
  ['absent', 0.18],
  ['missing', 0.07],
  ['proved_with_axioms', 0.05],
];

// ---------------------------------------------------------------------------

export function generate({
  seed = 20260919,
  chapters = 14,
  sectionsPerChapter = 4,
  subsectionsPerSection = 2,
  definitions = 1100,
  lemmas = 800,
  theorems = 750,
  propositions = 460, // folded into the `theorem` kind, as the real project does
  usesEdges = 1500,
  extraParents = 20,
} = {}) {
  const rand = rng(seed);
  const pick = (xs) => xs[Math.floor(rand() * xs.length)];
  const int = (n) => Math.floor(rand() * n);

  const objects = [];
  const push = (o) => { objects.push(o); return o; };

  // --- the section hierarchy -----------------------------------------------

  const chapterIds = [];
  const sectionIds = [];     // level 2
  const subsectionIds = [];  // level 3
  const parentOf = new Map();
  const containerIds = [];   // every section-ish id, for attaching content

  for (let c = 0; c < chapters; c += 1) {
    const cid = `ch-${pad(c + 1)}`;
    chapterIds.push(cid);
    containerIds.push(cid);
    push(section(cid, `${cap(pick(AREAS))} ${pick(NOUNS)}s`, c + 1, 'chapter'));
    for (let s = 0; s < sectionsPerChapter; s += 1) {
      const sid = `${cid}-s${pad(s + 1)}`;
      sectionIds.push(sid);
      containerIds.push(sid);
      parentOf.set(sid, cid);
      push(section(sid, `${cap(pick(AREAS))} ${pick(NOUNS)}`, s + 1, 'section'));
      for (let u = 0; u < subsectionsPerSection; u += 1) {
        const uid = `${sid}-u${pad(u + 1)}`;
        subsectionIds.push(uid);
        containerIds.push(uid);
        parentOf.set(uid, sid);
        push(section(uid, `${cap(pick(NOUNS))} of ${pick(AREAS)} type`, u + 1, 'subsection'));
      }
    }
  }

  function section(id, title, order, level) {
    return {
      id,
      kind: 'section',
      boundary: [],
      attrs: { title, order, tags: [level] },
      body: `Overview of ${title.toLowerCase()}. ${pick(MATHS)}`,
      source: { file: `blueprint/${id.replace(/-/g, '/')}/_section.md`, anonymous: false },
      depth: 0,
    };
  }

  // --- content nodes --------------------------------------------------------
  //
  // Most content sits in the deepest containers; a fifth hangs directly off a
  // section and a twentieth directly off a chapter, as real blueprints do.

  const contentIds = [];
  const kindPlan = [
    ['definition', definitions, 'def'],
    ['lemma', lemmas, 'lem'],
    ['theorem', theorems, 'thm'],
    ['theorem', propositions, 'prop'], // propositions carry the `theorem` kind
  ];

  let n = 0;
  for (const [kind, count, prefix] of kindPlan) {
    for (let i = 0; i < count; i += 1) {
      const id = `${prefix}-${pad(i + 1, 4)}`;
      const r = rand();
      const container =
        r < 0.05 ? pick(chapterIds) : r < 0.25 ? pick(sectionIds) : pick(subsectionIds);
      parentOf.set(id, container);
      contentIds.push(id);
      const title = `${cap(pick(AREAS))} ${pick(NOUNS)} ${prefix === 'def' ? '' : pick(VERBS)}`.trim();
      push({
        id,
        kind,
        boundary: [],
        attrs: {
          title,
          lean: [`Project.${camel(id)}`],
          order: (n % 97) + 1,
          tags: [prefix],
        },
        body: bodyFor(prefix, title, pick, rand),
        source: { file: `blueprint/${container.replace(/-/g, '/')}/${id}.md`, anonymous: false },
        depth: 0,
      });
      n += 1;
    }
  }

  // --- refines edges --------------------------------------------------------

  const refines = (src, tgt) =>
    push({
      id: `refines/${src}/${tgt}`,
      kind: 'refines',
      boundary: [{ role: 'src', id: src }, { role: 'tgt', id: tgt }],
      attrs: {},
      body: '',
      source: { file: `blueprint/${src.replace(/-/g, '/')}.md`, anonymous: true },
      depth: 1,
    });

  for (const [child, parent] of parentOf) refines(child, parent);

  // A handful of genuinely multi-parent objects.
  const extraSeen = new Set();
  for (let i = 0; i < extraParents; i += 1) {
    const child = contentIds[int(contentIds.length)];
    const parent = containerIds[int(containerIds.length)];
    const key = `${child} ${parent}`;
    if (parent === parentOf.get(child) || extraSeen.has(key)) continue;
    extraSeen.add(key);
    refines(child, parent);
  }

  // --- uses edges -----------------------------------------------------------
  //
  // Locality: two thirds of the dependencies stay inside the same container,
  // a quarter point at something earlier in the same chapter, the rest go
  // anywhere.  Plus a few coarse section-to-section declarations.

  const byContainer = new Map();
  for (const id of contentIds) {
    const c = parentOf.get(id);
    if (!byContainer.has(c)) byContainer.set(c, []);
    byContainer.get(c).push(id);
  }
  const chapterOf = (id) => {
    let cur = id;
    for (let i = 0; i < 4 && parentOf.has(cur); i += 1) cur = parentOf.get(cur);
    return cur;
  };
  const byChapter = new Map();
  for (const id of contentIds) {
    const c = chapterOf(id);
    if (!byChapter.has(c)) byChapter.set(c, []);
    byChapter.get(c).push(id);
  }

  const seenUses = new Set();
  const addUses = (src, tgt) => {
    if (!src || !tgt || src === tgt) return false;
    const key = `${src} ${tgt}`;
    if (seenUses.has(key)) return false;
    seenUses.add(key);
    push({
      id: `uses/${src}/${tgt}`,
      kind: 'uses',
      boundary: [{ role: 'src', id: src }, { role: 'tgt', id: tgt }],
      attrs: {},
      body: '',
      source: { file: `blueprint/${src.replace(/-/g, '/')}.md`, anonymous: true },
      depth: 1,
    });
    return true;
  };

  const coarse = Math.round(usesEdges * 0.06);
  let made = 0;
  let guard = 0;
  while (made < usesEdges - coarse && guard < usesEdges * 40) {
    guard += 1;
    const src = contentIds[int(contentIds.length)];
    const r = rand();
    let pool;
    if (r < 0.66) pool = byContainer.get(parentOf.get(src)) || contentIds;
    else if (r < 0.9) pool = byChapter.get(chapterOf(src)) || contentIds;
    else pool = contentIds;
    if (addUses(src, pool[int(pool.length)])) made += 1;
  }
  for (let i = 0; i < coarse; i += 1) {
    const a = containerIds[int(containerIds.length)];
    const b = containerIds[int(containerIds.length)];
    if (addUses(a, b)) made += 1;
  }

  // --- derived --------------------------------------------------------------

  const byId = new Map(objects.map((o) => [o.id, o]));
  const kindsWithLean = new Set(['definition', 'theorem', 'lemma']);

  const status = {};
  for (const o of objects) {
    if (!kindsWithLean.has(o.kind)) continue;
    status[o.id] = weighted(rand(), STATUS_WEIGHTS);
  }

  // progress along `refines`: countable leaves below each object
  const children = new Map();
  for (const o of objects) {
    if (o.kind !== 'refines') continue;
    const src = o.boundary[0].id;
    const tgt = o.boundary[1].id;
    if (!children.has(tgt)) children.set(tgt, []);
    children.get(tgt).push(src);
  }
  const memo = new Map();
  const tally = (id, seen) => {
    if (memo.has(id)) return memo.get(id);
    if (seen.has(id)) return { proved: 0, total: 0 };
    seen.add(id);
    const kids = children.get(id) || [];
    let out;
    if (!kids.length) {
      const o = byId.get(id);
      const countable = o && kindsWithLean.has(o.kind);
      out = { proved: countable && status[id] === 'proved' ? 1 : 0, total: countable ? 1 : 0 };
    } else {
      out = { proved: 0, total: 0 };
      for (const c of kids) {
        const t = tally(c, seen);
        out.proved += t.proved;
        out.total += t.total;
      }
    }
    memo.set(id, out);
    return out;
  };
  const progress = {};
  for (const id of children.keys()) {
    const t = tally(id, new Set());
    if (t.total) progress[id] = t;
  }

  const checks = [];
  for (const key of [...extraSeen].slice(0, 8)) {
    const [child] = key.split(' ');
    checks.push({
      level: 'warning',
      code: 'multi-parent',
      message: `'${child}' refines more than one object`,
      objects: [child],
    });
  }
  for (const id of contentIds.slice(0, 5)) {
    checks.push({
      level: 'info',
      code: 'undeclared-edge',
      message: `the coarse view shows a relation out of '${id}' that nothing declares`,
      objects: [id],
    });
  }
  checks.push({
    level: 'error',
    code: 'missing-lean',
    message: `'${contentIds[7]}' names a Lean declaration that does not exist`,
    objects: [contentIds[7]],
  });

  return {
    version: 1,
    generated: '2026-09-19T12:00:00Z',
    project: {
      name: 'LargeProject',
      title: 'A large synthetic blueprint',
      katexMacros: {
        '\\Fbar': '\\overline{\\mathbf F}_q',
        '\\Ocal': '\\mathcal{O}',
      },
    },
    schema: SCHEMA,
    objects,
    facts: null,
    derived: { status, progress, checks },
  };
}

// ---------------------------------------------------------------------------

const SCHEMA = {
  defaultCollapse: 'refines',
  kinds: {
    section: {
      boundary: {}, kinds: {}, attrs: ['title', 'order', 'tags', 'aliases'],
      constraints: [], collapse: false, countable: false, sugar: false, color: '#7a8aa0',
    },
    definition: {
      boundary: {}, kinds: {}, attrs: ['title', 'lean', 'review', 'tags', 'order', 'aliases'],
      constraints: [], collapse: false, countable: true, sugar: false, color: '#5b8def',
    },
    theorem: {
      boundary: {}, kinds: {}, attrs: ['title', 'lean', 'review', 'tags', 'order', 'aliases'],
      constraints: [], collapse: false, countable: true, sugar: false, color: '#4a7',
    },
    lemma: {
      boundary: {}, kinds: {}, attrs: ['title', 'lean', 'review', 'tags', 'order', 'aliases'],
      constraints: [], collapse: false, countable: true, sugar: false, color: '#59a',
    },
    uses: {
      boundary: { src: { min: 1, max: 1 }, tgt: { min: 1, max: 1 } },
      kinds: { src: [], tgt: [] }, attrs: ['title'],
      constraints: [], collapse: false, countable: false, sugar: true,
    },
    refines: {
      boundary: { src: { min: 1, max: 1 }, tgt: { min: 1, max: 1 } },
      kinds: {}, attrs: ['title'],
      constraints: ['acyclic'], collapse: true, countable: false, sugar: true,
    },
  },
};

function pad(n, w = 2) { return String(n).padStart(w, '0'); }
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
function camel(id) {
  return id.replace(/[^a-zA-Z0-9]+(.)/g, (m, c) => c.toUpperCase());
}

function weighted(r, table) {
  let acc = 0;
  for (const [value, w] of table) {
    acc += w;
    if (r < acc) return value;
  }
  return table[table.length - 1][0];
}

function bodyFor(prefix, title, pick, rand) {
  const lead = prefix === 'def'
    ? `We say that a ${pick(NOUNS)} is **${title.toLowerCase()}** when the following holds.`
    : `**${title}.** ${pick(MATHS)}`;
  const mid = `${pick(MATHS)} ${pick(MATHS)}`;
  const tail = rand() < 0.5
    ? `\n\nThe proof reduces to the ${pick(AREAS)} case; compare ${pick(NOUNS)}s.`
    : '';
  return `${lead}\n\n${mid}${tail}`;
}

// --- CLI --------------------------------------------------------------------

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const out = process.argv[2] || path.join(process.cwd(), 'large-blueprint.json');
  const snap = generate();
  fs.writeFileSync(out, JSON.stringify(snap));
  const count = (k) => snap.objects.filter((o) => o.kind === k).length;
  process.stdout.write(
    `wrote ${out}\n` +
    `  ${snap.objects.length} objects total ` +
    `(${(fs.statSync(out).size / 1e6).toFixed(1)} MB)\n` +
    `  nodes:   ${count('section')} section, ${count('definition')} definition, ` +
    `${count('lemma')} lemma, ${count('theorem')} theorem` +
    ` = ${count('section') + count('definition') + count('lemma') + count('theorem')}\n` +
    `  edges:   ${count('refines')} refines, ${count('uses')} uses\n`,
  );
}
