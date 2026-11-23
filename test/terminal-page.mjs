// Runs the Terminal page's own script in a stand-in browser (node:vm and a small document), for the terminal tests. Not a test file:
// test/terminal.test.mjs and test/terminal-agents.test.mjs use it. Copyright 2026 mvschwarz. Licensed under the Apache License,
// Version 2.0.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
export const MOD = path.join(ROOT, "apps/terminal/vendor/terminal/terminal.js");
export const HTML = fs.readFileSync(path.join(ROOT, "apps/terminal/app/terminal.html"), "utf8");
export const T = await import(pathToFileURL(MOD));

// Just enough of an element for the page: a tree of children, markup kept as text (outerHTML), and its listeners.
class El {
  constructor(tag, markup = null) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.dataset = {};
    this.style = {};
    this.hidden = false;
    this.listeners = {};
    this.markup = markup;
    this.html = "";
    this.id = "";
    this.className = "";
    this.title = "";
    this.src = "";
    this.clientWidth = 1300;
    this.clientHeight = 900;
  }
  append(...cs) {
    for (const c of cs) {
      c.remove();
      c.parentNode = this;
      this.children.push(c);
    }
  }
  replaceChildren(...cs) {
    for (const c of this.children) c.parentNode = null;
    this.children = [];
    this.append(...cs);
  }
  remove() {
    if (!this.parentNode) return;
    this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1);
    this.parentNode = null;
  }
  replaceWith(n) {
    const p = this.parentNode;
    if (!p) return;
    n.remove();
    p.children[p.children.indexOf(this)] = n;
    n.parentNode = p;
    this.parentNode = null;
  }
  get isConnected() {
    let e = this;
    while (e.parentNode) e = e.parentNode;
    return !!e.root;
  }
  set innerHTML(h) {
    this.html = h;
    this.children = [];
  }
  get innerHTML() {
    return this.html + this.children.map((c) => c.outerHTML).join("");
  }
  get outerHTML() {
    return (
      this.markup ??
      `<${this.tagName.toLowerCase()}>${this.innerHTML}</${this.tagName.toLowerCase()}>`
    );
  }
  get firstElementChild() {
    return this.html ? new El("div", this.html) : (this.children[0] ?? null);
  }
  insertAdjacentHTML(where, h) {
    const n = new El(/^<p\b/.test(h) ? "p" : "div", h);
    n.parentNode = this;
    this.children.unshift(n);
  }
  querySelector(sel) {
    return sel === ":scope > p"
      ? (this.children.find((c) => c.tagName === "P" && c.markup) ?? null)
      : null;
  }
  contains() {
    return false;
  }
  addEventListener(ev, fn) {
    this.listeners[ev] = fn;
  }
}

/** Every element under el, depth first. */
export const all = (el) => el.children.flatMap((c) => [c, ...all(c)]);

/**
 * Runs the page. fetchFor(url, init) answers each request: { status, body, headers } (a stand-in) or a real fetch's Response.
 * hash: the page's address fragment. Returns the page's nodes, its timers and listeners, every URL it fetched, and tick() for the
 * place re-check timer.
 */
export async function runPage(fetchFor, { hash = "" } = {}) {
  const status = new El("div"),
    screen = new El("div");
  status.root = screen.root = true;
  const nodes = { status, screen };
  const intervals = [],
    listeners = {},
    fetched = [];
  const ctx = vm.createContext({
    document: {
      getElementById: (id) => nodes[id],
      hidden: false,
      activeElement: null,
      createElement: (tag) => new El(tag),
      addEventListener: (ev, fn) => (listeners[`document:${ev}`] = fn),
    },
    location: { hash },
    fetch: async (url, init) => {
      fetched.push(url);
      const r = await fetchFor(url, init);
      if (typeof r.json === "function") return r;
      return {
        status: r.status,
        ok: r.status >= 200 && r.status < 300,
        headers: { get: (k) => r.headers?.[k.toLowerCase()] ?? null },
        json: async () => r.body,
      };
    },
    AbortSignal,
    setInterval: (fn, ms) => (intervals.push({ fn, ms }), intervals.length),
    clearInterval() {},
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 50)),
    addEventListener: (ev, fn) => (listeners[ev] = fn),
    innerHeight: 900,
    Date,
    Map,
    Set,
    JSON,
    Promise,
    encodeURIComponent,
  });
  ctx.window = ctx;
  ctx.T = T;
  const src = HTML.match(/<script type="module">([\s\S]*?)<\/script>/)[1].replace(
    /^import \* as T from .*$/m,
    "",
  );
  await vm.runInContext(`(async () => { ${src} })()`, ctx);
  const settle = async () => {
    for (let k = 0; k < 20; k++) await new Promise((r) => setImmediate(r));
  };
  await settle();
  return {
    nodes,
    listeners,
    fetched,
    settle,
    // The place re-check timer (CHECK_MS), as the page registers it.
    tick: async () => {
      await intervals.find((i) => i.ms === T.CHECK_MS).fn();
      await settle();
    },
  };
}
