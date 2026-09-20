// driver.mjs — the two real browsers, behind one small interface.
//
// Nothing here knows anything about the blueprint site: it is navigation,
// script evaluation, real pointer/keyboard/wheel input, screenshots, and the
// in-page error recorder that every check reads.
//
//   const d = await firefox({ width: 1400, height: 900 });
//   await d.open('http://127.0.0.1:8765/#/graph');
//   await d.js('return document.querySelectorAll(".gnode").length');
//
// Both drivers dispatch *real* input events (WebDriver actions in Firefox,
// Input.dispatch* in Chromium) rather than calling `el.click()`, because the
// bugs this suite exists for — pointer capture swallowing a click, a dblclick
// that never reaches a node — only appear with real input.

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// the recorder installed in the page
// ---------------------------------------------------------------------------

// Installed after every full page load.  A page load throws it away, so the
// suite navigates once and then drives the SPA through its hash router, which
// is also how a reader uses it.
// Written on one line to start with, because geckodriver's `execute/sync`
// takes the string as a function body: `return\n(function…` would be cut in
// two by automatic semicolon insertion and hand back `undefined`.
export const HOOK_SOURCE = `(function () {
  if (window.__bp) return 'already';
  var bp = { errors: [], warns: [], net: [] };
  window.__bp = bp;
  var fmt = function (a) {
    return Array.prototype.map.call(a, function (x) {
      if (x && x.stack) return String(x.message) + ' | ' + String(x.stack).split('\\n').slice(0, 3).join(' < ');
      if (x && typeof x === 'object') { try { return JSON.stringify(x); } catch (e) { return String(x); } }
      return String(x);
    }).join(' ');
  };
  var ce = console.error;
  console.error = function () { bp.errors.push('console.error: ' + fmt(arguments)); return ce.apply(console, arguments); };
  var cw = console.warn;
  console.warn = function () { bp.warns.push('console.warn: ' + fmt(arguments)); return cw.apply(console, arguments); };
  window.addEventListener('error', function (e) {
    if (e.target && e.target !== window && e.target.tagName) {
      bp.net.push('resource failed: ' + e.target.tagName + ' ' + (e.target.src || e.target.href || ''));
    } else {
      bp.errors.push('window.onerror: ' + ((e.error && e.error.stack) || e.message));
    }
  }, true);
  window.addEventListener('unhandledrejection', function (e) {
    bp.errors.push('unhandledrejection: ' + ((e.reason && e.reason.stack) || e.reason));
  });
  var f = window.fetch;
  window.fetch = function (input) {
    var url = typeof input === 'string' ? input : (input && input.url) || String(input);
    return f.apply(window, arguments).then(function (r) {
      if (!r.ok) bp.net.push('fetch ' + r.status + ' ' + r.url);
      return r;
    }, function (err) { bp.net.push('fetch failed ' + url + ': ' + err); throw err; });
  };
  return 'installed';
})()`;

const DRAIN_SOURCE = `(function () {
  var bp = window.__bp;
  if (!bp) return { errors: ['recorder missing'], warns: [], net: [] };
  var out = { errors: bp.errors.slice(), warns: bp.warns.slice(), net: bp.net.slice() };
  bp.errors.length = 0; bp.warns.length = 0; bp.net.length = 0;
  return out;
})()`;

// ---------------------------------------------------------------------------
// Firefox, through geckodriver's WebDriver HTTP API
// ---------------------------------------------------------------------------

export async function firefox({ width = 1400, height = 900, port = 4444, launch = true, log = '/tmp/shots/geckodriver.log' } = {}) {
  let child = null;
  if (launch) {
    child = spawn('geckodriver', ['--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    child.stdout.on('data', (c) => chunks.push(c));
    child.stderr.on('data', (c) => chunks.push(c));
    child.on('exit', () => { try { writeFileSync(log, Buffer.concat(chunks)); } catch (e) { /* best effort */ } });
    await waitForPort(`http://127.0.0.1:${port}/status`, 20000);
  }
  const base = `http://127.0.0.1:${port}`;
  const call = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    const v = json.value;
    if (v && typeof v === 'object' && v.error) {
      const e = new Error(`${v.error}: ${v.message}`);
      e.webdriver = v;
      throw e;
    }
    return v;
  };

  const session = await call('POST', '/session', {
    capabilities: {
      alwaysMatch: {
        'moz:firefoxOptions': {
          args: ['-headless', '-width', String(width), '-height', String(height)],
          // No caching: the sweep is usually run right after copying new
          // files into the site directory, and a cached style.css would test
          // the previous deploy.
          prefs: {
            'browser.cache.disk.enable': false,
            'browser.cache.memory.enable': false,
            'devtools.console.stdout.content': true,
          },
        },
        pageLoadStrategy: 'normal',
      },
    },
  });
  const sid = session.sessionId;
  const p = (path) => `/session/${sid}${path}`;

  const js = async (body, args = []) => call('POST', p('/execute/sync'), { script: body, args });

  // Two passes: the window rect is chrome-inclusive, so aim, measure the
  // viewport, and correct.  A deterministic viewport is what makes the legend
  // and node bounding boxes comparable between runs and between browsers.
  const sizeTo = async () => {
    for (let i = 0; i < 5; i += 1) {
      const inner = await js('return [window.innerWidth, window.innerHeight]');
      // Right after a navigation geckodriver occasionally answers a script
      // with a bare null; asking again a moment later works.
      if (!Array.isArray(inner)) { await sleep(300); continue; }
      if (inner[0] === width && inner[1] === height) return inner;
      const rect = await call('GET', p('/window/rect'));
      await call('POST', p('/window/rect'), {
        x: rect.x, y: rect.y,
        width: rect.width + (width - inner[0]),
        height: rect.height + (height - inner[1]),
      });
    }
    return js('return [window.innerWidth, window.innerHeight]');
  };

  const pointer = (actions) => call('POST', p('/actions'), {
    actions: [{ type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' }, actions }],
  });

  const d = {
    name: 'firefox',
    async open(url) {
      await call('POST', p('/url'), { url });
      await sizeTo();
    },
    // geckodriver insists on a JSON body even where the command takes no
    // parameters, so these all send `{}`.
    async reload() { await call('POST', p('/refresh'), {}); },
    async back() { await call('POST', p('/back'), {}); },
    async forward() { await call('POST', p('/forward'), {}); },
    js,
    async installHooks() { return js('return ' + HOOK_SOURCE); },
    async drain() { return js('return ' + DRAIN_SOURCE); },
    async move(x, y) {
      await pointer([{ type: 'pointerMove', x: Math.round(x), y: Math.round(y), origin: 'viewport' }]);
    },
    async click(x, y) {
      await pointer([
        { type: 'pointerMove', x: Math.round(x), y: Math.round(y), origin: 'viewport' },
        { type: 'pointerDown', button: 0 }, { type: 'pause', duration: 20 }, { type: 'pointerUp', button: 0 },
      ]);
    },
    async dblclick(x, y) {
      await pointer([
        { type: 'pointerMove', x: Math.round(x), y: Math.round(y), origin: 'viewport' },
        { type: 'pointerDown', button: 0 }, { type: 'pause', duration: 15 }, { type: 'pointerUp', button: 0 },
        { type: 'pause', duration: 40 },
        { type: 'pointerDown', button: 0 }, { type: 'pause', duration: 15 }, { type: 'pointerUp', button: 0 },
      ]);
    },
    async drag(x0, y0, x1, y1) {
      await pointer([
        { type: 'pointerMove', x: Math.round(x0), y: Math.round(y0), origin: 'viewport' },
        { type: 'pointerDown', button: 0 },
        { type: 'pointerMove', x: Math.round((x0 + x1) / 2), y: Math.round((y0 + y1) / 2), duration: 120, origin: 'viewport' },
        { type: 'pointerMove', x: Math.round(x1), y: Math.round(y1), duration: 120, origin: 'viewport' },
        { type: 'pause', duration: 40 },
        { type: 'pointerUp', button: 0 },
      ]);
    },
    async wheel(x, y, deltaY) {
      await call('POST', p('/actions'), {
        actions: [{
          type: 'wheel', id: 'wheel',
          actions: [{ type: 'scroll', x: Math.round(x), y: Math.round(y), deltaX: 0, deltaY: Math.round(deltaY), origin: 'viewport', duration: 60 }],
        }],
      });
    },
    async key(name) {
      const value = KEYS.firefox[name] || name;
      await call('POST', p('/actions'), {
        actions: [{
          type: 'key', id: 'kbd',
          actions: [{ type: 'keyDown', value }, { type: 'pause', duration: 20 }, { type: 'keyUp', value }],
        }],
      });
    },
    async type(text) {
      const actions = [];
      for (const ch of text) actions.push({ type: 'keyDown', value: ch }, { type: 'keyUp', value: ch });
      await call('POST', p('/actions'), { actions: [{ type: 'key', id: 'kbd', actions }] });
    },
    async shot(path) {
      const png = await call('GET', p('/screenshot'));
      writeFileSync(path, Buffer.from(png, 'base64'));
      return path;
    },
    async close() {
      try { await call('DELETE', p('')); } catch (e) { /* already gone */ }
      if (child) { child.kill(); await sleep(300); }
    },
  };
  return d;
}

// ---------------------------------------------------------------------------
// Chromium, over the DevTools protocol
// ---------------------------------------------------------------------------

export async function chromium({ width = 1400, height = 900, port = 9222, launch = true, binary = 'chromium' } = {}) {
  let child = null;
  if (launch) {
    child = spawn(binary, [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
      '--disable-extensions', '--hide-scrollbars',
      `--remote-debugging-port=${port}`,
      `--window-size=${width},${height}`,
      `--user-data-dir=/tmp/bp-sweep-chromium-${port}`,
      'about:blank',
    ], { stdio: 'ignore' });
    await waitForPort(`http://127.0.0.1:${port}/json/version`, 25000);
  }
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('chromium: no page target');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let seq = 0;
  const waiting = new Map();
  // Kept so a full page load's console output is not lost the way the in-page
  // recorder loses it: this half is armed before the first byte of the app.
  const cdpLog = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); return; }
    if (msg.method === 'Runtime.consoleAPICalled' && (msg.params.type === 'error' || msg.params.type === 'warning')) {
      cdpLog.push(`cdp console.${msg.params.type}: ` +
        msg.params.args.map((a) => a.value ?? a.description ?? a.unserializableValue ?? '').join(' '));
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d0 = msg.params.exceptionDetails;
      cdpLog.push(`cdp exception: ${d0.text} ${(d0.exception && d0.exception.description) || ''}`);
    }
    if (msg.method === 'Network.loadingFailed') {
      cdpLog.push(`cdp request failed: ${msg.params.errorText} ${msg.params.type}`);
    }
    if (msg.method === 'Network.responseReceived' && msg.params.response.status >= 400) {
      cdpLog.push(`cdp HTTP ${msg.params.response.status} ${msg.params.response.url}`);
    }
  };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const id = ++seq;
    waiting.set(id, (msg) => (msg.error ? rej(new Error(`${method}: ${msg.error.message}`)) : res(msg.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Network.enable');
  // The user data directory survives between runs, so without this a sweep run
  // straight after a deploy would measure the previous style.css.
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 1, mobile: false,
  });

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      throw new Error('evaluate: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    }
    return r.result.value;
  };

  const mouse = (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', {
    type, x: Math.round(x), y: Math.round(y), button: 'left', buttons: extra.buttons ?? 0, ...extra,
  });

  const d = {
    name: 'chromium',
    async open(url) {
      await send('Page.navigate', { url });
      // Page.loadEventFired is not worth a listener here: the suite polls for
      // the DOM it needs anyway, and the app boots asynchronously regardless.
      await sleep(400);
    },
    async reload() { await send('Page.reload', {}); await sleep(400); },
    async back() { await evaluate('history.back()'); await sleep(250); },
    async forward() { await evaluate('history.forward()'); await sleep(250); },
    async js(body) { return evaluate(`(function(){${body}})()`); },
    async installHooks() { return evaluate(HOOK_SOURCE); },
    async drain() {
      const out = await evaluate(DRAIN_SOURCE);
      const extra = cdpLog.splice(0);
      // The CDP half sees everything, the in-page half only what happened
      // after the hooks went in; union them and drop the duplicates.
      for (const line of extra) {
        const body = line.replace(/^cdp (console\.(error|warning)|exception): /, '');
        const dup = [...out.errors, ...out.warns, ...out.net].some((x) => x.includes(body.slice(0, 40)));
        if (dup) continue;
        if (/console\.warning/.test(line)) out.warns.push(line);
        else if (/request failed|HTTP \d/.test(line)) out.net.push(line);
        else out.errors.push(line);
      }
      return out;
    },
    async move(x, y) { await mouse('mouseMoved', x, y); },
    async click(x, y) {
      await mouse('mouseMoved', x, y);
      await mouse('mousePressed', x, y, { clickCount: 1, buttons: 1 });
      await mouse('mouseReleased', x, y, { clickCount: 1, buttons: 0 });
    },
    async dblclick(x, y) {
      await mouse('mouseMoved', x, y);
      await mouse('mousePressed', x, y, { clickCount: 1, buttons: 1 });
      await mouse('mouseReleased', x, y, { clickCount: 1, buttons: 0 });
      await mouse('mousePressed', x, y, { clickCount: 2, buttons: 1 });
      await mouse('mouseReleased', x, y, { clickCount: 2, buttons: 0 });
    },
    async drag(x0, y0, x1, y1) {
      await mouse('mouseMoved', x0, y0);
      await mouse('mousePressed', x0, y0, { clickCount: 1, buttons: 1 });
      const steps = 6;
      for (let i = 1; i <= steps; i += 1) {
        await mouse('mouseMoved', x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps, { buttons: 1 });
        await sleep(15);
      }
      await mouse('mouseReleased', x1, y1, { clickCount: 1, buttons: 0 });
    },
    async wheel(x, y, deltaY) {
      await mouse('mouseMoved', x, y);
      await send('Input.dispatchMouseEvent', {
        type: 'mouseWheel', x: Math.round(x), y: Math.round(y), deltaX: 0, deltaY: Math.round(deltaY),
      });
    },
    async key(name) {
      const k = KEYS.chromium[name] || { key: name, code: name, text: name, vk: name.charCodeAt(0) };
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k.key, code: k.code, text: k.text, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk });
    },
    async type(text) {
      for (const ch of text) {
        await send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch, unmodifiedText: ch });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
      }
    },
    async shot(path) {
      const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      writeFileSync(path, Buffer.from(data, 'base64'));
      return path;
    },
    async close() {
      try { ws.close(); } catch (e) { /* already closed */ }
      if (child) { child.kill(); await sleep(400); }
    },
  };
  return d;
}

const KEYS = {
  firefox: { Enter: '', Space: ' ', Escape: '', Tab: '' },
  chromium: {
    Enter: { key: 'Enter', code: 'Enter', text: '\r', vk: 13 },
    Space: { key: ' ', code: 'Space', text: ' ', vk: 32 },
    Escape: { key: 'Escape', code: 'Escape', text: '', vk: 27 },
    Tab: { key: 'Tab', code: 'Tab', text: '\t', vk: 9 },
  },
};

async function waitForPort(url, timeoutMs) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      const r = await fetch(url);
      if (r.ok) { await r.text(); return; }
    } catch (e) { /* not up yet */ }
    if (Date.now() > until) throw new Error('timed out waiting for ' + url);
    await sleep(200);
  }
}

export { sleep };
