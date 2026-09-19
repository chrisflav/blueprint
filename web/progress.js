// progress.js — the dashboard: counts by status, a table per top-level section,
// and a time slider driven by data/index.json.

import * as M from './model.js';

export function render(root, app) {
  const { el, clear } = app;
  const m = app.model;
  const kind = pickKind(app);

  clear(root);
  const page = el('div.page.wide');
  root.appendChild(page);

  page.appendChild(el('h1', 'Progress'));

  // ------------------------------------------------------------- overall
  const { counts, total } = M.statusCounts(m);
  page.appendChild(el('p.muted',
    `${total} countable objects (kinds with `, el('code', 'countable = true'), ').'));

  page.appendChild(el('div.stat-row',
    ...M.STATUSES.map((s) => el('div', { class: 'stat s-' + s },
      el('div.n', String(counts[s] || 0)),
      el('div.l', M.STATUS_LABEL[s])))));

  page.appendChild(stackBar(app, counts, total));

  // -------------------------------------------------------- time slider
  const hist = app.history;
  if (hist && hist.snapshots && hist.snapshots.length > 1) {
    page.appendChild(historyPanel(app, hist));
  } else if (hist && hist.snapshots && hist.snapshots.length === 1) {
    page.appendChild(el('p.muted.small', 'Only one snapshot in ', el('code', 'data/index.json'), '.'));
  }

  // ------------------------------------------------------------- by section
  page.appendChild(el('h2', 'By ' + kind + ' root'));
  if (m.collapseKinds.length > 1) {
    page.appendChild(el('p.muted.small', 'Collapse kind: ',
      el('select', { onchange: (e) => app.setParams({ collapse: e.target.value }) },
        ...m.collapseKinds.map((k) => el('option', { value: k, selected: k === kind }, k)))));
  }
  page.appendChild(sectionTable(app, kind));

  // ------------------------------------------------------- everything else
  page.appendChild(el('h2', 'All countable objects'));
  page.appendChild(objectTable(app, kind));
}

// ---------------------------------------------------------------------------

function pickKind(app) {
  const m = app.model;
  const wanted = app.route.params.get('collapse');
  if (wanted && m.kinds[wanted] && m.kinds[wanted].collapse) return wanted;
  return m.defaultCollapse || m.collapseKinds[0] || null;
}

function stackBar(app, counts, total) {
  const { el } = app;
  if (!total) return el('p.muted', 'Nothing to count.');
  const bar = el('div.stackbar', { style: { margin: '0 0 1.5rem' } });
  for (const s of ['proved', 'proved_with_axioms', 'stated', 'missing', 'absent']) {
    const n = counts[s] || 0;
    if (!n) continue;
    bar.appendChild(el('span', {
      style: { width: (100 * n) / total + '%', background: `var(--st-${s})` },
      title: `${M.STATUS_LABEL[s]}: ${n}`,
    }));
  }
  return bar;
}

function sectionTable(app, kind) {
  const { el } = app;
  const m = app.model;
  const order = M.collapseOrder(m, kind);
  const roots = M.topLevel(m, kind).filter((o) => M.childrenOf(order, o.id).length > 0);
  if (!roots.length) return el('p.muted', 'No object has children in this order.');

  const rows = roots.map((o) => {
    const p = M.progressOf(m, kind, o.id);
    const leaves = [o.id, ...M.descendantsOf(order, o.id)];
    const counts = tally(m, leaves);
    return el('tr',
      el('td', app.objLink(m, o.id), ' ', app.kindBadge(o.kind)),
      el('td', { style: { minWidth: '11rem' } }, p ? app.progressBar(p) : el('span.muted', '—')),
      el('td.nowrap', String(leaves.length - 1)),
      el('td', miniStack(app, counts)));
  });

  return el('div.table-wrap', el('table.grid',
    el('thead', el('tr',
      el('th', 'Object'), el('th', 'Progress'), el('th', 'Below'), el('th', 'Status mix'))),
    el('tbody', ...rows)));
}

function tally(m, ids) {
  const counts = Object.create(null);
  let total = 0;
  for (const id of ids) {
    const o = m.byId.get(id);
    const k = o && m.kinds[o.kind];
    if (!k || !k.countable) continue;
    const s = M.statusOf(m, id) || 'absent';
    counts[s] = (counts[s] || 0) + 1;
    total += 1;
  }
  counts.__total = total;
  return counts;
}

function miniStack(app, counts) {
  const { el } = app;
  const total = counts.__total || 0;
  if (!total) return el('span.muted', '—');
  const bar = el('div.stackbar', { style: { width: '9rem', height: '10px' } });
  for (const s of ['proved', 'proved_with_axioms', 'stated', 'missing', 'absent']) {
    const n = counts[s] || 0;
    if (!n) continue;
    bar.appendChild(el('span', {
      style: { width: (100 * n) / total + '%', background: `var(--st-${s})` },
      title: `${M.STATUS_LABEL[s]}: ${n}`,
    }));
  }
  return bar;
}

// A few thousand rows of badges and progress bars is a slow page and an
// unreadable one; the rest is one click away.
const FIRST_ROWS = 300;

function objectTable(app, kind) {
  const { el } = app;
  const m = app.model;
  const objects = m.objects
    .filter((o) => m.kinds[o.kind] && m.kinds[o.kind].countable)
    .sort((a, b) => (M.titleOf(a) < M.titleOf(b) ? -1 : 1));

  const order = M.collapseOrder(m, kind);
  const row = (o) => {
    const s = M.statusOf(m, o.id);
    const p = M.progressOf(m, kind, o.id);
    const chains = M.ancestorChains(order, o.id);
    const where = chains.length && chains[0].length ? chains[0][chains[0].length - 1] : null;
    return el('tr',
      el('td', app.objLink(m, o.id)),
      el('td', app.kindBadge(o.kind)),
      el('td', s === null ? el('span.muted', '—') : app.statusBadge(s)),
      el('td', where ? app.objLink(m, where) : el('span.muted', '—')),
      el('td', p ? app.progressBar(p) : el('span.muted', '—')));
  };

  const shown = objects.slice(0, FIRST_ROWS);
  const rest = objects.slice(FIRST_ROWS);
  const tbody = el('tbody', ...shown.map(row));
  const table = el('div.table-wrap', el('table.grid',
    el('thead', el('tr',
      el('th', 'Object'), el('th', 'Kind'), el('th', 'Status'), el('th', 'Under'), el('th', 'Progress'))),
    tbody));
  if (!rest.length) return table;

  const more = el('p.muted.small',
    `Showing the first ${FIRST_ROWS} of ${objects.length} objects. `,
    el('button', {
      onclick: () => {
        for (const o of rest) tbody.appendChild(row(o));
        more.textContent = `All ${objects.length} objects.`;
      },
    }, `Show all ${objects.length}`));
  return el('div', table, more);
}

// ---------------------------------------------------------------------------
// history: chart + slider
// ---------------------------------------------------------------------------

function historyPanel(app, hist) {
  const { el } = app;
  const snaps = hist.snapshots;
  const currentIdx = app.viewingSha
    ? snaps.findIndex((s) => s.sha === app.viewingSha)
    : snaps.length - 1;

  const panel = el('div.panel');
  panel.appendChild(el('h2', { style: { marginTop: 0 } }, 'Over time'));
  panel.appendChild(el('p.muted.small',
    `${snaps.length} snapshots from `, el('code', 'data/index.json'), '.'));

  const chartHost = el('div');
  panel.appendChild(chartHost);

  const label = el('span.small.mono');
  const slider = el('input', {
    type: 'range', min: 0, max: snaps.length - 1, step: 1,
    value: currentIdx < 0 ? snaps.length - 1 : currentIdx,
    oninput: (e) => { setLabel(Number(e.target.value)); },
    onchange: (e) => pick(Number(e.target.value)),
  });

  function setLabel(i) {
    const s = snaps[i];
    const sum = s.summary || {};
    label.textContent = `${String(s.sha).slice(0, 8)} · ${s.date || ''} · ` +
      `${sum.proved ?? '?'}/${sum.total ?? '?'} proved`;
  }

  function pick(i) {
    const s = snaps[i];
    if (i === snaps.length - 1) app.showSnapshot(null);
    else app.showSnapshot(s);
  }

  panel.appendChild(el('div.slider-row', slider, label));
  panel.appendChild(el('div.row',
    el('button', { onclick: () => app.showSnapshot(null) }, 'Latest'),
    el('span.muted.small', 'Moving the slider loads that snapshot and switches the whole site to it.')));

  chartHost.appendChild(lineChart(app, snaps, currentIdx, pick));
  setLabel(currentIdx < 0 ? snaps.length - 1 : currentIdx);
  return panel;
}

/** A hand-drawn SVG line chart of proved/total over time. */
function lineChart(app, snaps, selIdx, onPick) {
  const { svgEl } = app;
  const W = 720;
  const H = 200;
  const pad = { l: 42, r: 14, t: 14, b: 26 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;

  const totals = snaps.map((s) => (s.summary && s.summary.total) || 0);
  const proved = snaps.map((s) => (s.summary && s.summary.proved) || 0);
  const ymax = Math.max(1, ...totals, ...proved);
  const n = snaps.length;
  const x = (i) => pad.l + (n === 1 ? iw / 2 : (iw * i) / (n - 1));
  const y = (v) => pad.t + ih - (ih * v) / ymax;

  const svg = svgEl('svg', {
    class: 'chart', viewBox: `0 0 ${W} ${H}`,
    preserveAspectRatio: 'xMidYMid meet', role: 'img',
    'aria-label': 'proved and total objects over time',
  });

  // grid + y ticks
  const steps = 4;
  for (let i = 0; i <= steps; i += 1) {
    const v = Math.round((ymax * i) / steps);
    svg.appendChild(svgEl('line', { class: 'grid-line', x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v) }));
    svg.appendChild(svgEl('text', { class: 'tick', x: pad.l - 6, y: y(v) + 3, 'text-anchor': 'end' }, String(v)));
  }
  svg.appendChild(svgEl('line', { class: 'axis', x1: pad.l, x2: pad.l, y1: pad.t, y2: pad.t + ih }));
  svg.appendChild(svgEl('line', { class: 'axis', x1: pad.l, x2: W - pad.r, y1: pad.t + ih, y2: pad.t + ih }));

  // x ticks: first, middle, last
  for (const i of uniq([0, Math.floor((n - 1) / 2), n - 1])) {
    const d = String(snaps[i].date || '').slice(0, 10);
    svg.appendChild(svgEl('text', {
      class: 'tick', x: x(i), y: H - 8,
      'text-anchor': i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle',
    }, d));
  }

  const line = (vals) => vals.map((v, i) => `${i ? 'L' : 'M'} ${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');

  svg.appendChild(svgEl('path', {
    class: 'area-proved',
    d: line(proved) + ` L ${x(n - 1).toFixed(1)} ${y(0).toFixed(1)} L ${x(0).toFixed(1)} ${y(0).toFixed(1)} Z`,
  }));
  svg.appendChild(svgEl('path', { class: 'line-total', d: line(totals) }));
  svg.appendChild(svgEl('path', { class: 'line-proved', d: line(proved) }));

  for (let i = 0; i < n; i += 1) {
    const dot = svgEl('circle', {
      class: 'pt' + (i === selIdx ? ' sel' : ''),
      cx: x(i), cy: y(proved[i]), r: 4,
      stroke: 'var(--st-proved)',
    }, svgEl('title', `${String(snaps[i].sha).slice(0, 8)} · ${snaps[i].date || ''}\n` +
      `${proved[i]} of ${totals[i]} proved`));
    dot.addEventListener('click', () => onPick(i));
    svg.appendChild(dot);
  }

  // legend
  svg.appendChild(svgEl('text', { class: 'tick', x: W - pad.r, y: pad.t + 4, 'text-anchor': 'end', fill: 'var(--st-proved)' }, 'proved'));
  svg.appendChild(svgEl('text', { class: 'tick', x: W - pad.r, y: pad.t + 17, 'text-anchor': 'end' }, 'total'));
  return svg;
}

function uniq(xs) {
  return [...new Set(xs)].filter((i) => i >= 0);
}
