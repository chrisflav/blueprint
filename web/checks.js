// checks.js — derived.checks, grouped by level and filterable by code.

import * as M from './model.js';

export function render(root, app) {
  const { el, clear } = app;
  const m = app.model;

  clear(root);
  const page = el('div.page');
  root.appendChild(page);

  page.appendChild(el('h1', 'Checks'));

  const all = m.checks;
  if (!all.length) {
    page.appendChild(el('p.muted', 'No checks in this snapshot: ',
      el('code', 'derived.checks'), ' is empty.'));
    return;
  }

  const wantLevel = app.route.params.get('level');
  const wantCode = app.route.params.get('code');
  const wantObject = app.route.params.get('object');

  const counts = new Map();
  for (const c of all) counts.set(c.code, (counts.get(c.code) || 0) + 1);
  const levelCounts = new Map();
  for (const c of all) levelCounts.set(c.level, (levelCounts.get(c.level) || 0) + 1);

  // ------------------------------------------------------------- filters
  const filters = el('div.filter-row');
  filters.appendChild(el('span.muted.small', 'level:'));
  filters.appendChild(chip(app, 'all', !wantLevel, () => app.setParams({ level: null })));
  for (const lv of M.CHECK_LEVELS) {
    if (!levelCounts.get(lv)) continue;
    filters.appendChild(chip(app, `${lv} (${levelCounts.get(lv)})`, wantLevel === lv,
      () => app.setParams({ level: lv }), 'level-' + lv));
  }
  page.appendChild(filters);

  const codeRow = el('div.filter-row');
  codeRow.appendChild(el('span.muted.small', 'code:'));
  codeRow.appendChild(chip(app, 'all', !wantCode, () => app.setParams({ code: null })));
  for (const code of [...counts.keys()].sort()) {
    codeRow.appendChild(chip(app, `${code} (${counts.get(code)})`, wantCode === code,
      () => app.setParams({ code })));
  }
  page.appendChild(codeRow);

  if (wantObject) {
    page.appendChild(el('p.muted.small', 'Filtered to checks mentioning ',
      app.objLink(m, wantObject), ' ',
      el('button', { onclick: () => app.setParams({ object: null }) }, 'clear')));
  }

  // ------------------------------------------------------------- the list
  const shown = all.filter((c) =>
    (!wantLevel || c.level === wantLevel) &&
    (!wantCode || c.code === wantCode) &&
    (!wantObject || (Array.isArray(c.objects) && c.objects.includes(wantObject))));

  if (!shown.length) {
    page.appendChild(el('p.muted', 'Nothing matches those filters.'));
    return;
  }

  const byLevel = new Map();
  for (const c of shown) {
    if (!byLevel.has(c.level)) byLevel.set(c.level, []);
    byLevel.get(c.level).push(c);
  }
  const levels = M.CHECK_LEVELS.filter((lv) => byLevel.has(lv))
    .concat([...byLevel.keys()].filter((lv) => !M.CHECK_LEVELS.includes(lv)));

  for (const lv of levels) {
    const list = byLevel.get(lv);
    page.appendChild(el('h2', `${lv} (${list.length})`));
    for (const c of list) page.appendChild(checkCard(app, c));
  }
}

function chip(app, label, active, onclick, extraClass) {
  return app.el('button', {
    class: (active ? 'active ' : '') + (extraClass || ''),
    onclick,
  }, label);
}

function checkCard(app, c) {
  const { el } = app;
  const m = app.model;
  return el('div', { class: 'check level-' + c.level },
    app.levelBadge(c.level),
    el('span.code', c.code),
    el('div.msg', c.message || ''),
    Array.isArray(c.objects) && c.objects.length
      ? el('div.objs', ...c.objects.map((id) =>
          m.byId.has(id)
            ? app.objLink(m, id)
            : el('span.chip', { title: 'unknown object' }, id)))
      : null);
}
