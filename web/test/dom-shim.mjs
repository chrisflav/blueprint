// web/test/dom-shim.mjs — a very small DOM, good enough to run the blueprint
// web app headlessly under node.  Used by `bench.mjs`, and by the parts of
// `model.test.mjs` that need `app.js` (the KaTeX options, for instance).
//
// It is deliberately shallow: `innerHTML` keeps the text and throws the markup
// away, layout is fake, and nothing paints.  What it does faithfully is the
// *shape* of the work the page modules do — how many elements they build, and
// how many bodies they hand to marked and KaTeX — which is what the
// performance work in this directory is about.
import fs from 'node:fs';
import path from 'node:path';

class ClassList {
  constructor(node) { this.node = node; }
  get _set() { return new Set((this.node.className || '').split(/\s+/).filter(Boolean)); }
  _write(s) { this.node.className = [...s].join(' '); }
  add(...c) { const s = this._set; c.forEach((x) => s.add(x)); this._write(s); }
  remove(...c) { const s = this._set; c.forEach((x) => s.delete(x)); this._write(s); }
  contains(c) { return this._set.has(c); }
  toggle(c, force) {
    const s = this._set;
    const on = force === undefined ? !s.has(c) : !!force;
    if (on) s.add(c); else s.delete(c);
    this._write(s);
    return on;
  }
}

let ELEMENT_NODE = 1, TEXT_NODE = 3, FRAGMENT_NODE = 11;

class Node2 {
  constructor(type) {
    this.nodeType = type;
    this.childNodes = [];
    this.parentNode = null;
  }
  get firstChild() { return this.childNodes[0] || null; }
  get children() { return this.childNodes.filter((c) => c.nodeType === ELEMENT_NODE); }
  appendChild(c) {
    if (!c) throw new Error('appendChild(null)');
    if (c.nodeType === FRAGMENT_NODE) {
      for (const x of c.childNodes.slice()) this.appendChild(x);
      return c;
    }
    if (c.parentNode) c.parentNode.removeChild(c);
    c.parentNode = this;
    this.childNodes.push(c);
    return c;
  }
  removeChild(c) {
    const i = this.childNodes.indexOf(c);
    if (i >= 0) this.childNodes.splice(i, 1);
    c.parentNode = null;
    return c;
  }
  replaceChild(nu, old) {
    const i = this.childNodes.indexOf(old);
    if (i < 0) throw new Error('replaceChild: not a child');
    if (nu.nodeType === FRAGMENT_NODE) {
      const kids = nu.childNodes.slice();
      this.childNodes.splice(i, 1, ...kids);
      for (const k of kids) k.parentNode = this;
    } else {
      this.childNodes.splice(i, 1, nu);
      nu.parentNode = this;
    }
    old.parentNode = null;
    return old;
  }
  contains(n) {
    for (let p = n; p; p = p.parentNode) if (p === this) return true;
    return false;
  }
  get isConnected() { return true; }
}

class Text2 extends Node2 {
  constructor(v) { super(TEXT_NODE); this.nodeValue = String(v); }
  get textContent() { return this.nodeValue; }
}

class Fragment extends Node2 {
  constructor() { super(FRAGMENT_NODE); }
}

class Element2 extends Node2 {
  constructor(tag, ns) {
    super(ELEMENT_NODE);
    this.tagName = String(tag).toUpperCase();
    this.localName = String(tag);
    this.namespaceURI = ns || null;
    this.attributes = new Map();
    this.className = '';
    this.id = '';
    this.style = {};
    this.dataset = {};
    this._listeners = new Map();
    this.classList = new ClassList(this);
    this.hidden = false;
  }
  setAttribute(k, v) {
    v = String(v);
    this.attributes.set(k, v);
    if (k === 'class') this.className = v;
    if (k === 'id') this.id = v;
    if (k.startsWith('data-')) {
      this.dataset[k.slice(5).replace(/-([a-z])/g, (m, c) => c.toUpperCase())] = v;
    }
  }
  getAttribute(k) {
    if (k === 'class') return this.className || null;
    if (k === 'id') return this.id || null;
    return this.attributes.has(k) ? this.attributes.get(k) : null;
  }
  hasAttribute(k) { return this.getAttribute(k) !== null; }
  removeAttribute(k) { this.attributes.delete(k); }
  addEventListener(t, fn) {
    if (!this._listeners.has(t)) this._listeners.set(t, []);
    this._listeners.get(t).push(fn);
  }
  removeEventListener() {}
  getBoundingClientRect() { return { x: 0, y: 0, left: 0, top: 0, width: 1200, height: 800, right: 1200, bottom: 800 }; }
  setPointerCapture() {}
  releasePointerCapture() {}
  scrollIntoView() {}
  focus() {}
  set textContent(v) { this.childNodes = []; if (v !== '') this.appendChild(new Text2(v)); }
  get textContent() { return this.childNodes.map((c) => c.textContent).join(''); }
  set innerHTML(v) {
    // Enough for the tests: strip tags, keep the text, note that HTML was set.
    this.childNodes = [];
    this._html = String(v);
    const text = String(v).replace(/<[^>]*>/g, '');
    if (text) this.appendChild(new Text2(text));
  }
  get innerHTML() { return this._html || this.textContent; }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) {
    const out = [];
    const parts = String(sel).trim().split(/\s+/);
    const match = (node, part) => {
      const m = part.match(/^([a-zA-Z0-9-]*)((?:[.#][^.#\[]+)*)((?:\[[^\]]*\])*)$/);
      if (!m) return false;
      if (m[1] && node.localName !== m[1]) return false;
      for (const c of m[2].match(/[.#][^.#\[]+/g) || []) {
        if (c[0] === '.' && !node.classList.contains(c.slice(1))) return false;
        if (c[0] === '#' && node.id !== c.slice(1)) return false;
      }
      for (const a of m[3].match(/\[[^\]]*\]/g) || []) {
        const inner = a.slice(1, -1);
        const eq = inner.indexOf('=');
        if (eq < 0) { if (!node.hasAttribute(inner)) return false; continue; }
        // Support the substring operators too: graph.js looks its ELK script
        // up with `script[src*="elk"]`.
        let k = inner.slice(0, eq);
        let op = '=';
        if (/[*^$~|]$/.test(k)) { op = k.slice(-1) + '='; k = k.slice(0, -1); }
        let v = inner.slice(eq + 1);
        if (/^["']/.test(v)) v = v.slice(1, -1).replace(/\\(.)/g, '$1');
        const actual = node.getAttribute(k);
        if (actual === null) return false;
        if (op === '=' && actual !== v) return false;
        if (op === '*=' && !actual.includes(v)) return false;
        if (op === '^=' && !actual.startsWith(v)) return false;
        if (op === '$=' && !actual.endsWith(v)) return false;
      }
      return true;
    };
    const walk = (node, depth) => {
      for (const c of node.children) {
        if (match(c, parts[depth])) {
          if (depth === parts.length - 1) out.push(c);
          else walk(c, depth + 1);
        }
        walk(c, depth);
      }
    };
    walk(this, 0);
    return [...new Set(out)];
  }
}

const NodeFilter = {
  SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3,
};

function createTreeWalker(root, what, filter) {
  const nodes = [];
  const walk = (n) => {
    for (const c of n.childNodes) {
      if (c.nodeType === TEXT_NODE) nodes.push(c);
      else walk(c);
    }
  };
  walk(root);
  let i = -1;
  return {
    nextNode() {
      while (++i < nodes.length) {
        const n = nodes[i];
        const v = filter && filter.acceptNode ? filter.acceptNode(n) : NodeFilter.FILTER_ACCEPT;
        if (v === NodeFilter.FILTER_ACCEPT) return n;
      }
      return null;
    },
  };
}

const registry = new Map();
const documentEl = new Element2('html');

const document2 = {
  createElement: (t) => new Element2(t, null),
  createElementNS: (ns, t) => new Element2(t, ns),
  createTextNode: (v) => new Text2(v),
  createDocumentFragment: () => new Fragment(),
  createTreeWalker,
  getElementById: (id) => registry.get(id) || documentEl.querySelector('#' + id) || null,
  querySelector: (s) => documentEl.querySelector(s),
  querySelectorAll: (s) => documentEl.querySelectorAll(s),
  addEventListener() {},
  title: '',
  documentElement: documentEl,
  body: documentEl,
};

export function setupDom({ ids = [], base = process.cwd(), snapshot = null } = {}) {
  registry.clear();
  documentEl.childNodes = [];
  for (const id of ids) {
    const e = new Element2('div');
    e.setAttribute('id', id);
    registry.set(id, e);
    documentEl.appendChild(e);
  }

  const events = new Map();
  global.document = document2;
  global.Node = Node2;
  global.NodeFilter = NodeFilter;
  global.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  global.requestIdleCallback = (fn) =>
    setTimeout(() => fn({ timeRemaining: () => 8, didTimeout: false }), 0);
  global.cancelIdleCallback = (h) => clearTimeout(h);
  global.history = {
    replaceState(_a, _b, url) { global.location.hash = String(url).replace(/^[^#]*/, ''); },
  };
  global.location = {
    hash: '', search: '', pathname: '/index.html',
    href: 'http://localhost/index.html',
  };

  // --- IntersectionObserver ------------------------------------------------
  // Nothing scrolls here, so the observer never fires by itself.  The harness
  // drives it: `observers.flush()` reports every observed element as visible,
  // which is what "the reader scrolled through the whole document" means.
  const observers = [];
  class IntersectionObserver2 {
    constructor(cb) { this.cb = cb; this.targets = new Set(); observers.push(this); }
    observe(node) { this.targets.add(node); }
    unobserve(node) { this.targets.delete(node); }
    disconnect() { this.targets.clear(); }
    _fire() {
      const list = [...this.targets];
      if (!list.length) return 0;
      this.cb(list.map((t) => ({ target: t, isIntersecting: true, intersectionRatio: 1 })), this);
      return list.length;
    }
  }
  observers.flush = () => {
    let n = 0;
    // Firing may unobserve, and may register more targets, so loop to a fixpoint.
    for (let round = 0; round < 40; round += 1) {
      let fired = 0;
      for (const o of observers.slice()) fired += o._fire();
      n += fired;
      if (!fired) break;
    }
    return n;
  };
  observers.pending = () => observers.reduce((a, o) => a + o.targets.size, 0);
  global.IntersectionObserver = IntersectionObserver2;

  // --- Blob / object URLs / workers ----------------------------------------
  // `workers.enabled = false` simulates an environment that refuses a Blob
  // worker (a page served with a restrictive `worker-src`, say), which is how
  // the main-thread fallback in graph.js gets exercised.
  const workers = { enabled: true, created: [], blobs: new Map(), seq: 0 };
  class Blob2 {
    constructor(parts) { this.parts = (parts || []).map(String); }
    get text() { return this.parts.join(''); }
  }
  const NodeURL = globalThis.URL;
  const URLShim = function URLShim(u, b) { return new NodeURL(u, b); };
  URLShim.createObjectURL = (b) => {
    const u = `blob:http://localhost/${(workers.seq += 1)}`;
    workers.blobs.set(u, b);
    return u;
  };
  URLShim.revokeObjectURL = (u) => { workers.blobs.delete(u); };
  class Worker2 {
    constructor(url) {
      if (!workers.enabled) throw new Error('worker blocked by policy');
      this.url = url;
      this.source = workers.blobs.has(url) ? workers.blobs.get(url).text : null;
      this.messages = [];
      workers.created.push(this);
    }
    postMessage(m) { this.messages.push(m); if (this.onHostMessage) this.onHostMessage(m); }
    terminate() { this.terminated = true; }
    addEventListener(t, fn) { this['on' + t] = fn; }
    removeEventListener() {}
    /** deliver a reply to the page */
    reply(data) { if (this.onmessage) this.onmessage({ data }); }
    fail(message) { if (this.onerror) this.onerror({ message }); }
  }
  global.Blob = Blob2;
  global.Worker = Worker2;
  // The page builds its worker with `URL.createObjectURL(new Blob([...]))`.
  // Node's own createObjectURL only accepts a real Blob and would not let us
  // read the source back, so the whole URL object is replaced for the run.
  Object.setPrototypeOf(URLShim, NodeURL);
  URLShim.prototype = NodeURL.prototype;
  global.URL = URLShim;

  const win = {
    addEventListener(t, fn) { if (!events.has(t)) events.set(t, []); events.get(t).push(fn); },
    removeEventListener() {},
    dispatch(t, ev) { for (const fn of events.get(t) || []) fn(ev); },
    marked: null,
    renderMathInElement: null,
    ELK: null,
    Worker: Worker2,
    Blob: Blob2,
    URL: URLShim,
    IntersectionObserver: IntersectionObserver2,
    document: document2,
    location: global.location,
    history: global.history,
    performance: globalThis.performance,
    Error, Math, JSON, Date, Array, Object, String, Number, Boolean, RegExp, Map, Set, Promise,
    setTimeout, clearTimeout, setInterval, clearInterval,
    requestAnimationFrame: global.requestAnimationFrame,
    navigator: { userAgent: 'node' },
  };
  global.window = win;
  global.self = win;

  global.fetch = async (url) => {
    const u = String(url).replace(/^https?:\/\/localhost/, '');
    // Only the page's own default data file is served from memory; anything
    // else (the bundled sample, a historical snapshot) still comes off disk.
    if (snapshot && (u === './blueprint.json' || u === '/blueprint.json')) {
      return { ok: true, status: 200, statusText: 'OK', json: async () => snapshot };
    }
    const p = path.resolve(base, u.replace(/^\//, '').replace(/^\.\//, ''));
    if (!fs.existsSync(p)) {
      return {
        ok: false, status: 404, statusText: 'Not Found',
        json: async () => { throw new Error('404'); },
      };
    }
    const txt = fs.readFileSync(p, 'utf8');
    return { ok: true, status: 200, statusText: 'OK', json: async () => JSON.parse(txt) };
  };

  return { document: document2, registry, Element2, observers, workers, window: win };
}

/**
 * A stand-in for marked: paragraphs and a little inline emphasis.  The shim
 * throws the markup away again, so this exists to make the cost of "parse this
 * body" visible rather than to be correct.
 */
export function fakeMarked() {
  return {
    parse(src) {
      return String(src)
        .split(/\n{2,}/)
        .map((p) => '<p>' + p.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>') + '</p>')
        .join('\n');
    },
  };
}

/** A stand-in for KaTeX auto-render that records the options it was handed. */
export function fakeKatex() {
  const calls = [];
  const fn = (root, options) => { calls.push({ root, options }); };
  fn.calls = calls;
  fn.reset = () => { calls.length = 0; };
  return fn;
}

export { Element2, document2 };
