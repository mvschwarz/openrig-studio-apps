// Terminal's behaviour as a person meets it: the words, the place rule, and the page script itself (run with an invented fetch, frames
// and timers): it opens only when the place names a terminal, says what closing does, removes the terminal when the sign-in ends, never
// says "open" on a refused check, and runs the agents view (tiles per agent terminal, Watch/Type/Take over, joins and leaves, task
// views). These are the scenarios the Terminal shipped with, run against this page. Copyright 2026 mvschwarz. Licensed under the Apache
// License, Version 2.0.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as T from "../apps/terminal/vendor/terminal/terminal.js";

const STATES = ["checking", "open", "notset", "refused", "unread"];

test("Terminal's words: the plain line and what closing does when open; each other state says why, never a guess", () => {
  const open = T.stateHtml("open");
  assert.match(
    open,
    /A full terminal on your machine, as your own user\. What you run here runs for real\./,
  );
  assert.match(
    open,
    /Closing this page ends this terminal and anything still running in it\. To keep something running, start it in tmux or screen\./,
  );
  assert.match(T.stateHtml("notset"), /Terminal isn(&#39;|')t set up yet\./);
  assert.match(
    T.stateHtml("refused"),
    /Studio didn(&#39;|')t accept your sign-in, so your terminal was closed\.[\s\S]*data-act="signin"/,
  );
  assert.doesNotMatch(
    T.stateHtml("refused"),
    /ended|expired/i,
    "a 403 can't say why the sign-in was refused",
  );
  for (const mode of ["shell", "agents"])
    assert.match(
      T.stateHtml("refused", { mode }),
      /If this keeps happening, contact the person who set up this machine using the channel you already use\./,
      mode,
    );
  assert.match(
    T.stateHtml("refused", { account: "https://cloud.example.invalid/account" }),
    /href="https:\/\/cloud\.example\.invalid\/account"[^>]*>Sign in again/,
  );
  assert.match(
    T.stateHtml("unread"),
    /Couldn(&#39;|')t check[\s\S]*This doesn(&#39;|')t mean it(&#39;|')s off: the check didn(&#39;|')t answer\. Try again in a moment\.[\s\S]*data-act="retry"/,
  );
  for (const s of STATES)
    assert.doesNotMatch(T.stateHtml(s), /\bbox\b/, `${s}: a Studio, never a box`);
});

test("the place decides: a front-door 403 is the sign-in refused; 200 opens only with a terminal path; anything else couldn't check", () => {
  assert.equal(T.stateOf({ status: 403, signInEnded: true }), "refused");
  assert.equal(T.stateOf({ status: 403, signInEnded: false }), "unread");
  assert.equal(T.stateOf({ status: 200, set: true }), "open");
  assert.equal(T.stateOf({ status: 200, set: false }), "notset");
  assert.equal(T.stateOf({ status: 0 }), "unread");
  assert.equal(T.terminalOf({ terminal: "/terminal/" }), "/terminal/");
  for (const bad of [
    null,
    "",
    "terminal/",
    "//evil.example/",
    "https://evil.example/",
    "/terminal/../x",
    "/terminal/?a=1",
    "/a b/",
    42,
  ])
    assert.equal(T.terminalOf({ terminal: bad }), null, JSON.stringify(bad));
});

// The page script itself, run with a small fake DOM: enough for the page's frames, its agents grid and their tiles.
const html = fs.readFileSync(
  new URL("../apps/terminal/app/terminal.html", import.meta.url),
  "utf8",
);
const body = html
  .match(/<script type="module">([\s\S]*?)<\/script>/)[1]
  .replace(/^import \* as T from .*$/m, "");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};
const answer = (status = 200, json = { terminal: "/terminal/" }, closed = false) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k) => (k === "x-openrig-front-door" && closed ? "closed" : null) },
  json: async () => json,
});

class El {
  static doc = null;
  static size = [1920, 1200];
  constructor(tag = "div") {
    this.tagName = tag;
    this.children = [];
    this.parent = null;
    this.dataset = {};
    this.hidden = false;
    this.className = "";
    this.id = "";
    this.title = "";
    this.src = "";
    this.listeners = {};
    this._html = "";
  }
  get isConnected() {
    return !!this.parent;
  }
  get parentNode() {
    return this.parent;
  }
  get clientWidth() {
    return El.size[0];
  }
  get clientHeight() {
    return El.size[1];
  }
  focus() {
    if (El.doc) El.doc.activeElement = this;
  }
  set innerHTML(h) {
    this._html = h;
    this.children = [];
  }
  get innerHTML() {
    return this._html;
  }
  get firstElementChild() {
    const e = new El();
    e.html = this._html;
    e.parent = this;
    return e;
  }
  append(...c) {
    for (const x of c) {
      x.parent = this;
      this.children.push(x);
    }
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((x) => x !== this);
    this.parent = null;
  }
  replaceWith(n) {
    const p = this.parent;
    if (!p) return;
    const i = p.children.indexOf(this);
    n.parent = p;
    p.children[i] = n;
    this.parent = null;
  }
  replaceChildren(...c) {
    this.children = [];
    this.append(...c);
  }
  insertAdjacentHTML(_, h) {
    const e = new El("p");
    e.html = h;
    e.parent = this;
    this.children.unshift(e);
  }
  querySelector(sel) {
    return sel === ":scope > p" ? (this.children.find((x) => x.tagName === "p") ?? null) : null;
  }
  addEventListener(ev, fn) {
    (this.listeners[ev] ||= []).push(fn);
  }
}
async function page(
  answers,
  {
    hash = "",
    terminals = null,
    size = [1920, 1200],
    ensure = null,
    box = null,
    hiddenAtStart = false,
  } = {},
) {
  let click = null;
  El.size = size;
  const status = {
      innerHTML: "",
      addEventListener(ev, fn) {
        if (ev === "click") click = fn;
      },
    },
    screen = new El("div");
  const document = {
    getElementById: (id) => (id === "status" ? status : screen),
    addEventListener() {},
    hidden: false,
    activeElement: null,
    createElement: (t) => new El(t.toUpperCase()),
  };
  El.doc = document;
  const intervals = [],
    urls = [],
    posts = [],
    win = {},
    location = { hash };
  const lists = Array.isArray(terminals) ? terminals : [terminals];
  const fetch = async (url, opts = {}) => {
    urls.push(url);
    if (opts.method === "POST") {
      posts.push({ url, body: JSON.parse(opts.body) });
      return ensure;
    }
    // A task view also reads the ordinary list for members with no viewer: separate from the task's own answers.
    if (url === "/api/agents/terminals" && hash.includes("view="))
      return box || answer(503, { ok: false, unreadable: "x" });
    if (url.startsWith("/api/agents/terminals")) return lists.length > 1 ? lists.shift() : lists[0];
    return answers.length > 1 ? answers.shift() : answers[0];
  };
  const window = { top: { location: { reload() {} } } };
  await new AsyncFunction(
    "T",
    "document",
    "window",
    "location",
    "fetch",
    "addEventListener",
    "console",
    "setTimeout",
    "clearTimeout",
    "setInterval",
    "clearInterval",
    body,
  )(
    T,
    document,
    window,
    location,
    fetch,
    (ev, fn) => {
      (win[ev] ||= []).push(fn);
    },
    { warn() {} },
    () => 0,
    () => {},
    (fn, ms) => {
      intervals.push({ fn, ms });
      return intervals.length;
    },
    () => {
      intervals.length = 0;
    },
  );
  // A deployment's local.js runs after the page's own script, before the first check answers.
  if (hiddenAtStart) window.studioTerminal.setHidden(true);
  await settle();
  const state = () => (status.innerHTML.match(/data-state="([a-z]+)"/) || [])[1] || "none";
  const tick = async () => {
    for (const t of intervals.slice()) if (t.ms === T.CHECK_MS) t.fn();
    await settle();
  };
  const switchTo = async (m) => {
    await click({ target: { closest: () => ({ dataset: { act: "mode", mode: m } }) } });
    await settle();
  };
  const agents = () => screen.children.find((x) => x.id === "agents");
  const grid = () => agents()?.children.find((x) => x.id === "tiles");
  const bar = () => agents()?.children.find((x) => x.id === "agentbar")?.innerHTML ?? "";
  const memberList = () => agents()?.children.find((x) => x.id === "members");
  const gridTiles = () => (grid()?.children ?? []).filter((x) => x.className === "tile"),
    memberTiles = () => (memberList()?.children ?? []).filter((x) => x.className === "tile");
  const tileEls = () => [...gridTiles(), ...memberTiles()];
  const tile = (id) => tileEls().find((x) => x.dataset.id === id);
  const press = async (act, id) => {
    for (const fn of screen.listeners.click ?? [])
      fn({ target: { closest: () => ({ dataset: { act, id } }) } });
    await settle();
  };
  // The address changes (a link to another task): the page's hashchange listeners run.
  const navigate = async (h) => {
    location.hash = h;
    for (const fn of win.hashchange ?? []) await fn();
    await settle();
  };
  return {
    state,
    screen,
    status,
    tick,
    intervals,
    urls,
    posts,
    switchTo,
    navigate,
    agents,
    grid,
    bar,
    tileEls,
    gridTiles,
    memberTiles,
    tile,
    press,
    document,
    setHidden: async (on) => {
      window.studioTerminal.setHidden(on);
      await settle();
    },
  };
}

test("page: opens the Studio's /terminal/ in a frame with the line above it, and checks the place every CHECK_MS while open", async () => {
  const p = await page([answer()]);
  assert.equal(p.state(), "open");
  assert.equal(p.screen.children.length, 1);
  assert.equal(p.screen.children[0].src, "/terminal/");
  assert.match(p.status.innerHTML, /A full terminal on your machine, as your own user\./);
  assert.ok(p.intervals.some((t) => t.ms === T.CHECK_MS));
});

test("page: the sign-in ends while open -> the terminal is removed and the page says so; not set up -> nothing is framed", async () => {
  const p = await page([answer(), answer(403, null, true)]);
  assert.equal(p.state(), "open");
  await p.tick();
  assert.equal(p.state(), "refused");
  assert.equal(p.screen.children.length, 0, "the frame is gone, which closes its connection");
  const n = await page([answer(200, { terminal: null })]);
  assert.deepEqual([n.state(), n.screen.children.length], ["notset", 0]);
  const u = await page([answer(500, null)]);
  assert.deepEqual([u.state(), u.screen.children.length], ["unread", 0]);
});

test("page: a check that doesn't answer leaves it open; hidden hides the same terminal (still connected), shown again it's the same", async () => {
  const p = await page([answer(), answer(0, null)]);
  await p.tick();
  assert.equal(p.state(), "open");
  const frame = p.screen.children[0];
  await p.setHidden(true);
  assert.deepEqual(
    [p.state(), p.screen.hidden, p.screen.children[0]],
    ["hidden", true, frame],
    "hidden, the same frame kept",
  );
  await p.setHidden(false);
  assert.deepEqual(
    [p.state(), p.screen.hidden, p.screen.children[0]],
    ["open", false, frame],
    "shown again, not reopened",
  );
  const q = await page([answer()], { hiddenAtStart: true });
  assert.deepEqual(
    [q.state(), q.screen.children.length],
    ["hidden", 0],
    "hidden from the start: none opened",
  );
  await q.setHidden(false);
  assert.deepEqual([q.state(), q.screen.children.length], ["open", 1], "shown: it opens then");
});

test("page: the sign-in ending while hidden still removes the terminal", async () => {
  const p = await page([answer(), answer(403, null, true)]);
  await p.setHidden(true);
  await p.tick();
  assert.deepEqual([p.state(), p.screen.children.length], ["refused", 0]);
});

test("page: overlapping checks: only the newest acts; a late older answer never removes the terminal; a newest refusal still does", async () => {
  const held = () => {
    let resolve;
    const promise = new Promise((r) => (resolve = r));
    return { promise, resolve };
  };
  for (const late of [answer(200, { terminal: null }), answer(403, null, true)]) {
    const q = [held(), held(), held()];
    const p = await page([answer()].concat(q.map((h) => h.promise)));
    const f = p.screen.children[0];
    await p.tick();
    await p.tick(); // two checks in flight: the older (q[0]) and the newer (q[1])
    q[1].resolve(answer());
    await new Promise((r) => setImmediate(r));
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    q[0].resolve(late);
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    assert.deepEqual(
      [p.state(), p.screen.children[0]],
      ["open", f],
      `a late older ${late.status} doesn't remove it`,
    );
    await p.tick();
    q[2].resolve(late);
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    assert.equal(p.screen.children.length, 0, `the newest ${late.status} does`);
  }
});

test("page CSS: only the open line's text loses its margin, so a state's button keeps its space", () => {
  assert.match(html, /#tstate\[data-state="open"\] \.meta \{ margin: 0; \}/);
  assert.doesNotMatch(html, /#status \.meta \{ margin: 0; \}/);
  assert.match(
    html,
    /#status \.next > :last-child \{ margin-bottom: 0; \}/,
    "a card ending in text has no empty space below it",
  );
});

const both = { terminal: "/terminal/", agents: { watch: "/agents/watch/", type: "/agents/type/" } };
const W = (id) => `/agents/watch/?arg=${id}&disableReconnect=true&disableLeaveAlert=true`,
  TY = (id, m) => `/agents/type/?arg=${id}&arg=${m}&disableReconnect=true&disableLeaveAlert=true`;
const list = (...ts) =>
  answer(200, {
    terminals: ts.map(([id, seat, state]) => ({ terminal_id: id, seat, state, inUse: null })),
  });
test("Agents words: the line, what closing does, the size warning; never the shell's 'closing ends it'", () => {
  const open = T.stateHtml("open", { mode: "agents" });
  assert.match(
    open,
    /Your team(&#39;|')s agents, live\. What you type goes to the agent whose tile you(&#39;|')re typing in\./,
  );
  assert.match(
    open,
    /Closing this page closes only your view\. The agents keep running\. Opening a tile can change the size of an agent(&#39;|')s terminal\./,
  );
  assert.doesNotMatch(open, /ends this terminal/);
  assert.match(
    T.stateHtml("notset", { mode: "agents" }),
    /The agents view isn(&#39;|')t set up yet\./,
  );
  assert.match(
    T.stateHtml("hidden", { mode: "agents" }),
    /Your agents(&#39;|') view is hidden for now\./,
  );
  assert.match(T.stateHtml("hidden"), /Your terminal is hidden for now\./);
  assert.match(
    T.stateHtml("refused", { mode: "agents" }),
    /Studio didn(&#39;|')t accept your sign-in, so your agents(&#39;|') view was closed\.[\s\S]*Your agents kept running\./,
  );
  assert.match(
    T.stateHtml("open", { mode: "agents", both: true }),
    /aria-pressed="false"[^>]*>Your terminal[\s\S]*aria-pressed="true"[^>]*>Agents/,
  );
  for (const s of [...STATES, "hidden"])
    assert.doesNotMatch(T.stateHtml(s, { mode: "agents" }), /\bbox\b/);
});

test("place, list and tile rules: watch/type paths; only valid terminal ids; type needs the type path; unreadable is never 'none'", () => {
  assert.deepEqual(T.agentsOf({ agents: { watch: "/agents/watch/", type: "/agents/type/" } }), {
    watch: "/agents/watch/",
    type: "/agents/type/",
  });
  assert.deepEqual(T.agentsOf({ agents: { watch: "/agents/watch/", type: null } }), {
    watch: "/agents/watch/",
    type: null,
  });
  for (const bad of [
    null,
    "/agents/",
    { watch: null, type: "/agents/type/" },
    { watch: "//evil.example/" },
    { watch: "/a/../b/" },
  ])
    assert.equal(T.agentsOf({ agents: bad }), null, JSON.stringify(bad));
  assert.equal(T.modeFor("agents", { shell: true, agents: true }), "agents");
  assert.equal(T.modeFor("shell", { shell: false, agents: true }), "agents");
  const p = { watch: "/agents/watch/", type: "/agents/type/" };
  assert.equal(
    T.tileUrl(p, "term_65ec4de94c37a4"),
    "/agents/watch/?arg=term_65ec4de94c37a4&disableReconnect=true&disableLeaveAlert=true",
  );
  assert.equal(
    T.tileUrl(p, "term_65ec4de94c37a4", "type"),
    "/agents/type/?arg=term_65ec4de94c37a4&arg=type&disableReconnect=true&disableLeaveAlert=true",
  );
  assert.equal(
    T.tileUrl(p, "term_65ec4de94c37a4", "takeover"),
    "/agents/type/?arg=term_65ec4de94c37a4&arg=takeover&disableReconnect=true&disableLeaveAlert=true",
  );
  for (const [id, m] of [
    ["term_x", "watch"],
    ["../etc", "watch"],
    ["term_ab&arg=takeover", "watch"],
    ["term_ab", "shell"],
  ])
    assert.equal(T.tileUrl(p, id, m), null, `${id} ${m}`);
  assert.equal(
    T.tileUrl({ watch: "/agents/watch/", type: null }, "term_ab", "type"),
    null,
    "no type path: no typing",
  );
  const read = (status, body) => ({ status, body });
  assert.deepEqual(
    T.terminalsOf(
      read(200, {
        terminals: [
          { terminal_id: "term_ab", seat: "dev.impl", state: "idle" },
          { terminal_id: "bad", seat: "x" },
        ],
      }),
    ),
    {
      read: true,
      terminals: [
        { id: "term_ab", key: "term_ab", seat: "dev.impl", name: "dev.impl", state: "idle" },
      ],
    },
  );
  assert.deepEqual(
    T.terminalsOf(read(200, { terminals: [] })),
    { read: true, terminals: [] },
    "an empty list read is none",
  );
  for (const r of [read(503, { ok: false, unreadable: "x" }), read(200, {}), read(0, null)])
    assert.equal(T.terminalsOf(r).read, false, "unreadable is never none");
  const head = T.tileHeadHtml(
    { id: "term_ab", seat: "dev.impl", state: "idle" },
    { mode: "watch", canType: true },
  );
  assert.match(
    head,
    /dev\.impl<\/span> <span class="st">idle[\s\S]*You(&#39;|')re watching[\s\S]*data-act="watch" aria-pressed="true"[^>]*>Watch[\s\S]*data-act="type"[\s\S]*>Type<[\s\S]*data-act="takeover"[\s\S]*>Take over<[\s\S]*>Pin</,
  );
  assert.doesNotMatch(
    T.tileHeadHtml({ id: "term_ab", seat: "dev.impl" }, { canType: false }),
    /data-act="type"|Take over/,
    "no type path: watch only",
  );
  assert.match(
    T.tileHeadHtml(
      { id: "term_ab", seat: "dev.impl" },
      { pinned: true, gone: true, canType: true },
    ),
    /no longer in this list[\s\S]*>Pinned</,
  );
});

test("page: #agents opens one WATCHING tile per terminal; Type and Take over are separate clicks; switching keeps the grid", async () => {
  const p = await page([answer(200, both)], {
    hash: "#agents",
    terminals: list(
      ["term_a1", "dev.impl", "idle"],
      ["term_b2", "team.lead", "working"],
      ["term_c3", "dev.qa", "idle"],
    ),
  });
  assert.equal(p.state(), "open");
  assert.equal(p.tileEls().length, 3);
  const frames = () => p.tileEls().map((t) => t.children[1].src);
  assert.deepEqual(frames(), [W("term_a1"), W("term_b2"), W("term_c3")], "watch by default");
  assert.ok(p.urls.includes("/api/agents/terminals"));
  await p.press("type", "term_b2");
  assert.equal(frames()[1], TY("term_b2", "type"), "Type attaches without taking over");
  await p.press("takeover", "term_b2");
  assert.equal(frames()[1], TY("term_b2", "takeover"), "Take over is its own click");
  await p.press("watch", "term_b2");
  assert.equal(frames()[1], W("term_b2"));
  await p.switchTo("shell");
  const shell = p.screen.children.find((x) => x.dataset.mode === "shell");
  assert.deepEqual(
    [shell.src, shell.hidden, p.agents().hidden, p.tileEls().length],
    ["/terminal/", false, true, 3],
    "the grid is kept, hidden",
  );
});

test("page: the tile set follows the list (3 -> 4 -> 3); a pinned tile that leaves stays, marked; the sign-in ending removes everything", async () => {
  const three = list(
    ["term_a1", "dev.impl", "idle"],
    ["term_b2", "team.lead", "idle"],
    ["term_c3", "dev.qa", "idle"],
  );
  const four = list(
    ["term_a1", "dev.impl", "idle"],
    ["term_b2", "team.lead", "idle"],
    ["term_c3", "dev.qa", "idle"],
    ["term_d4", "dev.docs", "working"],
  );
  const back = list(
    ["term_a1", "dev.impl", "idle"],
    ["term_b2", "team.lead", "idle"],
    ["term_c3", "dev.qa", "idle"],
  );
  const p = await page(
    [answer(200, both), answer(200, both), answer(200, both), answer(403, null, true)],
    { hash: "#agents", terminals: [three, four, back] },
  );
  const a1 = p.tileEls()[0];
  await p.tick();
  assert.deepEqual(
    p.tileEls().map((t) => t.dataset.id),
    ["term_a1", "term_b2", "term_c3", "term_d4"],
    "the 4th joins as a new watching tile",
  );
  assert.equal(p.tileEls()[0], a1, "existing tiles are the same tiles (their views not reopened)");
  await p.press("pin", "term_d4");
  await p.tick();
  const d4 = p.tileEls().find((t) => t.dataset.id === "term_d4");
  assert.ok(d4, "pinned: it stays after leaving the list");
  assert.match(d4.children[0].html, /no longer in this list/);
  assert.equal(p.tileEls().length, 4);
  await p.press("pin", "term_d4");
  assert.equal(p.tileEls().length, 3, "unpinned after it left: removed");
  await p.tick();
  assert.deepEqual([p.state(), p.screen.children.length], ["refused", 0]);
});

test("page: an unreadable list says so (never 'none'); an empty one says none; only a watch path means no Type", async () => {
  const u = await page([answer(200, both)], {
    hash: "#agents",
    terminals: answer(503, { ok: false, unreadable: "x" }),
  });
  assert.match(
    u.grid().children[0].html,
    /Couldn(&#39;|')t read the agents(&#39;|') terminals just now/,
  );
  const e = await page([answer(200, both)], {
    hash: "#agents",
    terminals: answer(200, { terminals: [] }),
  });
  assert.match(e.grid().children[0].html, /No agent terminals to show here yet/);
  const w = await page(
    [answer(200, { terminal: null, agents: { watch: "/agents/watch/", type: null } })],
    { terminals: list(["term_a1", "dev.impl", "idle"]) },
  );
  assert.equal(w.tileEls().length, 1);
  assert.doesNotMatch(w.tileEls()[0].children[0].html, /data-act="type"/);
});

test("a member without a terminal is shown, never hidden: 'Not available in the terminal view yet', then a real tile once it has one", async () => {
  const t = T.terminalsOf({
    status: 200,
    body: {
      terminals: [
        { terminal_id: "term_a1", seat: "dev.impl" },
        { terminal_id: null, seat: "dev.docs", status: "not-provisioned" },
        { seat: "dev.ops", status: "not-provisioned" },
        { terminal_id: "evil/../x", seat: "x" },
        { terminal_id: null },
      ],
    },
  });
  assert.deepEqual(
    t.terminals.map((x) => [x.key, !!x.unavailable]),
    [
      ["term_a1", false],
      ["seat:dev.docs", true],
      ["seat:dev.ops", true],
    ],
    "kept; a bad id and a seatless entry dropped",
  );
  assert.match(
    T.tileHeadHtml(t.terminals[1]),
    /dev\.docs[\s\S]*Not available in the terminal view yet\.[\s\S]*>Pin</,
  );
  assert.doesNotMatch(
    T.tileHeadHtml(t.terminals[1], { canType: true }),
    /data-act="(watch|type|takeover)"/,
    "nothing to watch or type into",
  );
  const missing = answer(200, {
    terminals: [
      { terminal_id: "term_a1", seat: "dev.impl", state: "idle" },
      { terminal_id: null, seat: "dev.docs", status: "not-provisioned" },
    ],
  });
  const ready = answer(200, {
    terminals: [
      { terminal_id: "term_a1", seat: "dev.impl", state: "idle" },
      { terminal_id: "term_d4", seat: "dev.docs", state: "idle" },
    ],
  });
  const p = await page([answer(200, both), answer(200, both)], {
    hash: "#agents",
    terminals: [missing, ready],
  });
  assert.deepEqual(
    p.tileEls().map((x) => [x.dataset.id, x.children.length]),
    [
      ["term_a1", 2],
      ["seat:dev.docs", 1],
    ],
    "shown, with no frame",
  );
  assert.match(p.tileEls()[1].children[0].html, /Not available in the terminal view yet/);
  await p.press("pin", "seat:dev.docs");
  await p.tick();
  const docs = p.tileEls().find((x) => x.dataset.id === "term_d4");
  assert.ok(docs && docs.children[1].src === W("term_d4"), "now a watching tile");
  assert.ok(
    !p.tileEls().some((x) => x.dataset.id === "seat:dev.docs"),
    "the placeholder is replaced",
  );
  assert.match(docs.children[0].html, />Pinned</, "its pin carried over");
});

test("a restart changes every terminal id: each tile is replaced by one for the new id ('This terminal changed; reloading'), pin kept", async () => {
  const before = list(["term_a1", "dev.impl", "idle"], ["term_b2", "team.lead", "idle"]);
  const after = list(["term_e5", "dev.impl", "idle"], ["term_f6", "team.lead", "idle"]);
  const p = await page([answer(200, both), answer(200, both)], {
    hash: "#agents",
    terminals: [before, after],
  });
  await p.press("pin", "term_a1");
  await p.tick();
  const ids = p.tileEls().map((x) => x.dataset.id);
  assert.deepEqual(ids, ["term_e5", "term_f6"], "the old ids are gone, never re-used");
  assert.deepEqual(
    p.tileEls().map((x) => x.children[1].src),
    [W("term_e5"), W("term_f6")],
    "frames use the new ids only",
  );
  assert.match(
    p.tileEls()[0].children[0].html,
    /This agent(&#39;|')s terminal restarted; reloading\.[\s\S]*>Pinned</,
    "said, and the pin carried",
  );
  assert.match(
    p.tileEls()[1].children[0].html,
    /This agent(&#39;|')s terminal restarted; reloading\./,
  );
  for (const fn of p.tileEls()[0].children[1].listeners.load) fn();
  assert.doesNotMatch(
    p.tileEls()[0].children[0].html,
    /This terminal changed/,
    "once its view loads, the note goes",
  );
});

test("labels aren't unique: when a seat's name now has two terminals, nothing is carried and each keeps its own tile", async () => {
  const before = list(["term_a1", "dev.impl", "idle"]);
  const after = list(["term_e5", "dev.impl", "idle"], ["term_e6", "dev.impl", "idle"]);
  const p = await page([answer(200, both), answer(200, both)], {
    hash: "#agents",
    terminals: [before, after],
  });
  await p.press("pin", "term_a1");
  await p.tick();
  const ids = p
    .tileEls()
    .map((x) => x.dataset.id)
    .sort();
  assert.deepEqual(
    ids,
    ["term_a1", "term_e5", "term_e6"],
    "the pinned old tile stays as a leaver; the two new ones are separate tiles",
  );
  const old = p.tileEls().find((x) => x.dataset.id === "term_a1");
  assert.match(old.children[0].html, /no longer in this list/);
  for (const id of ["term_e5", "term_e6"])
    assert.doesNotMatch(
      p.tileEls().find((x) => x.dataset.id === id).children[0].html,
      /This terminal changed|>Pinned</,
      `${id}: no carry`,
    );
});

test("an ambiguous name from the box is shown as its own tile, saying why, with nothing to watch or type into", async () => {
  const t = T.terminalsOf({
    status: 200,
    body: { terminals: [{ terminal_id: "term_a1", seat: "team.lead" }], ambiguous: ["dev.impl"] },
  });
  assert.deepEqual(
    t.terminals.map((x) => [x.key, !!x.ambiguous]),
    [
      ["term_a1", false],
      ["ambiguous:dev.impl", true],
    ],
  );
  const h = T.tileHeadHtml(t.terminals[1], { canType: true });
  assert.match(h, /dev\.impl[\s\S]*Two terminals have this name, so neither is shown\./);
  assert.doesNotMatch(h, /data-act="(watch|type|takeover)"/);
  assert.deepEqual(
    T.terminalsOf({ status: 200, body: { terminals: [], ambiguous: [] } }).terminals,
    [],
    "[] means none",
  );
  const p = await page([answer(200, both)], {
    hash: "#agents",
    terminals: answer(200, {
      terminals: [{ terminal_id: "term_a1", seat: "team.lead" }],
      ambiguous: ["dev.impl"],
    }),
  });
  assert.deepEqual(
    p.tileEls().map((x) => [x.dataset.id, x.children.length]),
    [
      ["term_a1", 2],
      ["ambiguous:dev.impl", 1],
    ],
  );
});

const ttydFrame = (frame, lines = [], { early = false } = {}) => {
  const element = { id: "term", children: [] },
    mos = [];
  class MO {
    constructor(fn) {
      this.fn = fn;
      this.on = false;
      mos.push(this);
    }
    observe() {
      this.on = true;
    }
    disconnect() {
      this.on = false;
    }
  }
  const row = (l) =>
    typeof l === "string" ? { text: l, wrapped: false } : (l ?? { text: "", wrapped: false });
  const term = {
    element,
    focus() {
      return "focused";
    },
    write(d, cb) {
      cb?.();
    },
    buffer: {
      active: {
        length: lines.length + 20,
        baseY: 0,
        cursorY: Math.max(0, lines.length - 1),
        getLine: (i) => ({
          translateToString: () => row(lines[i]).text,
          isWrapped: row(lines[i]).wrapped,
        }),
      },
    },
  }; // text at the top, empty rows below, as a fresh terminal
  frame.contentWindow = { MutationObserver: MO, document: { documentElement: {} } };
  if (early) {
    frame.contentWindow.term = term;
    element.children.push({ parentNode: element, textContent: "Press ⏎ to Reconnect" });
  }
  for (const fn of frame.listeners.load) fn();
  if (!early) frame.contentWindow.term = term;
  const overlay = { parentNode: element, textContent: "Connection Closed" };
  return {
    closes: () => {
      for (const m of mos) if (m.on) m.fn([{ target: element, addedNodes: [overlay] }]);
    },
    term: frame.contentWindow.term,
    mos,
  };
};
test("(a) a Type or Take over tile never reconnects into typing: ttyd's reconnect is off for it, and a closed connection goes back to Watch", async () => {
  assert.match(
    T.tileUrl({ watch: "/w/", type: "/t/" }, "term_ab", "type"),
    /&disableReconnect=true/,
  );
  assert.match(
    T.tileUrl({ watch: "/w/", type: "/t/" }, "term_ab", "takeover"),
    /&disableReconnect=true/,
  );
  assert.match(
    T.tileUrl({ watch: "/w/", type: "/t/" }, "term_ab"),
    /&disableReconnect=true/,
    "watching doesn't reconnect by itself either: the page decides",
  );
  const p = await page([answer(200, both)], {
    hash: "#agents",
    terminals: list(["term_a1", "dev.impl", "idle"], ["term_b2", "team.lead", "idle"]),
  });
  await p.press("takeover", "term_a1");
  const f = p.tile("term_a1").children[1];
  assert.equal(f.src, TY("term_a1", "takeover"));
  ttydFrame(f).closes();
  await settle();
  assert.equal(f.src, W("term_a1"), "back to watching, never a second take over");
  assert.match(
    p.tile("term_a1").children[0].html,
    /The connection closed, so this tile is back to watching\./,
  );
  await p.press("type", "term_b2");
  const g = p.tile("term_b2").children[1];
  ttydFrame(g, [
    "$ ",
    "terminal term_b2 already has an attached client; retry with --takeover",
    "",
  ]).closes();
  await settle();
  assert.equal(g.src, W("term_b2"));
  assert.match(
    p.tile("term_b2").children[0].html,
    /In use elsewhere, so this tile is back to watching\. Take over to type here\./,
  );
  await p.press("type", "term_b2");
  assert.doesNotMatch(
    p.tile("term_b2").children[0].html,
    /In use elsewhere/,
    "the note goes at the owner's next click",
  );
  const h = ttydFrame(g);
  await p.press("watch", "term_b2");
  h.closes();
  await settle();
  assert.equal(g.src, W("term_b2"));
});

test("tile mode changes replace child history so Back cannot reopen an old Type connection", async () => {
  const p = await page([answer(200, both)], {
    hash: "#agents",
    terminals: list(["term_a1", "dev.impl", "idle"]),
  });
  const f = p.tile("term_a1").children[1],
    history = [f.src],
    replaced = [];
  let current = f.src;
  Object.defineProperty(f, "src", {
    get: () => current,
    set: (url) => {
      current = url;
      history.push(url);
    },
  });
  const location = {
    replace(url) {
      current = url;
      history[history.length - 1] = url;
      replaced.push(url);
    },
  };
  f.contentWindow = { location };
  await p.press("type", "term_a1");
  const type = ttydFrame(f);
  f.contentWindow.location = location;
  type.closes();
  await settle();
  assert.deepEqual(replaced, [TY("term_a1", "type"), W("term_a1")]);
  assert.deepEqual(history, [W("term_a1")]);
});

test("(a) at a phone's width: a refusal that closed before the tile finished loading, its words wrapped across rows, goes back to Watch saying in use", async () => {
  const p = await page([answer(200, both)], {
    hash: "#agents",
    terminals: list(["term_a1", "dev.impl", "idle"], ["term_b2", "team.lead", "idle"]),
  });
  await p.press("type", "term_b2");
  const g = p.tile("term_b2").children[1];
  assert.equal(g.src, TY("term_b2", "type"));
  ttydFrame(
    g,
    [
      '{"type":"terminal.closed","reason":"termin',
      { text: "al attach failed: terminal term_b2 already", wrapped: true },
      { text: " has an attached client; retry with --take", wrapped: true },
      { text: 'over"}', wrapped: true },
    ],
    { early: true },
  );
  await settle();
  assert.equal(
    g.src,
    W("term_b2"),
    "back to watching, though the close came before the page looked",
  );
  assert.match(
    p.tile("term_b2").children[0].html,
    /In use elsewhere, so this tile is back to watching\. Take over to type here\./,
    "the wrapped words read as one line",
  );
  await p.press("type", "term_a1");
  const f = p.tile("term_a1").children[1];
  ttydFrame(f, ["$ echo already", "has an attached client", ""], { early: true });
  await settle();
  assert.match(
    p.tile("term_a1").children[0].html,
    /The connection closed, so this tile is back to watching\./,
  );
});

test("(b) a departing tile stays while typed in, focused or pinned, saying why; joins and leaves are said; no tile takes the keyboard", async () => {
  const three = list(
    ["term_a1", "dev.impl", "idle"],
    ["term_b2", "team.lead", "idle"],
    ["term_c3", "dev.qa", "idle"],
  );
  const four = list(
    ["term_a1", "dev.impl", "idle"],
    ["term_b2", "team.lead", "idle"],
    ["term_c3", "dev.qa", "idle"],
    ["term_d4", "dev.docs", "working"],
  );
  const one = list(["term_a1", "dev.impl", "idle"]);
  const p = await page(Array(8).fill(answer(200, both)), {
    hash: "#agents",
    terminals: [three, four, one, one, one],
  });
  assert.equal(p.bar(), "", "nothing said on the first read");
  const a1 = p.tile("term_a1").children[1];
  p.document.activeElement = a1;
  await p.tick();
  assert.match(p.bar(), /dev\.docs joined\./);
  const d4 = p.tile("term_d4").children[1];
  p.document.activeElement = d4;
  const { term } = ttydFrame(d4);
  assert.equal(p.document.activeElement, a1, "the keyboard goes back to the tile the owner was in");
  assert.equal(term.focus(), undefined, "a watching tile's own focus call is switched off");
  await p.press("type", "term_b2");
  await p.press("pin", "term_c3");
  p.document.activeElement = d4;
  await p.tick(); // only dev.impl is left in the list
  assert.match(
    p.tile("term_b2").children[0].html,
    /no longer in this list\. Kept while you(&#39;|')re typing in it\./,
  );
  assert.match(
    p.tile("term_c3").children[0].html,
    /no longer in this list\. Kept because you pinned it\./,
  );
  assert.match(
    p.tile("term_d4").children[0].html,
    /no longer in this list\. Kept for 12 seconds while you(&#39;|')re using it\./,
  );
  assert.equal(p.tileEls().length, 4, "none closed under the owner's hands");
  await p.press("watch", "term_b2");
  p.document.activeElement = null;
  await p.tick();
  assert.deepEqual(
    p.tileEls().map((x) => x.dataset.id),
    ["term_a1", "term_c3"],
    "no longer typed in or focused: closed; pinned: kept",
  );
  assert.match(
    p.bar(),
    /team\.lead left this list, so its tile was closed\. The agent keeps running\.[\s\S]*dev\.docs left this list/,
  );
});

test("(c) as many tiles as fit at a readable size, the rest named ('+1 more'); Show them / Show fewer; never past 8; (d) blocked still shown", async () => {
  assert.equal(T.capFor(1264, 744), 2);
  assert.equal(T.capFor(374, 600), 1, "a phone: one");
  assert.equal(T.capFor(1904, 1000), 6);
  assert.equal(T.capFor(5000, 3000), T.CEILING);
  assert.equal(T.capFor(0, 0), null, "hidden: no size, no answer");
  const three = list(
    ["term_a1", "dev.impl", "blocked"],
    ["term_b2", "team.lead", "idle"],
    ["term_c3", "dev.qa", "idle"],
  );
  const p = await page([answer(200, both)], {
    hash: "#agents",
    terminals: three,
    size: [1280, 760],
  });
  assert.deepEqual(
    p.tileEls().map((x) => x.dataset.id),
    ["term_a1", "term_b2"],
  );
  assert.match(
    p.tile("term_a1").children[0].html,
    /dev\.impl<\/span> <span class="st">waiting/,
    "(d) blocked is shown, as waiting",
  );
  assert.match(p.bar(), /\+1 more: dev\.qa\.[\s\S]*data-act="more"[^>]*>Show them</);
  await p.press("more");
  assert.equal(p.tileEls().length, 3);
  assert.match(p.bar(), /data-act="fewer"[^>]*>Show fewer</);
  await p.press("type", "term_c3");
  await p.press("fewer");
  assert.deepEqual(
    p.tileEls().map((x) => x.dataset.id),
    ["term_a1", "term_c3"],
    "fewer: a watching one closes, never the one being typed in",
  );
  assert.match(p.bar(), /\+1 more: team\.lead\./);
  const many = list(
    ...Array.from({ length: 20 }, (_, i) => [`term_${(i + 16).toString(16)}`, `seat.${i}`, "idle"]),
  );
  const q = await page([answer(200, both)], {
    hash: "#agents",
    terminals: many,
    size: [5000, 3000],
  });
  assert.equal(q.tileEls().length, 8);
  assert.match(q.bar(), /\+12 more: seat\.8, [\s\S]*seat\.19\./);
  await q.press("more");
  assert.equal(q.tileEls().length, 8, "never past 8");
  assert.match(q.bar(), /\+12 more[\s\S]*At most 8 at once\./);
  const r = await page([answer(200, both)], {
    hash: "#agents",
    terminals: three,
    size: [390, 700],
  });
  assert.equal(r.tileEls().length, 1);
  assert.match(r.bar(), /\+2 more: team\.lead, dev\.qa\./);
});

test("(e) a following view and a saved layout are said differently; an unknown kind is not shown", async () => {
  const body = (viewDescriptor) => ({
    terminals: [{ terminal_id: "term_a1", seat: "dev.impl" }],
    viewDescriptor,
  });
  assert.deepEqual(
    T.terminalsOf({ status: 200, body: body({ kind: "following", name: "task 42" }) }).view,
    { kind: "following", name: "task 42" },
  );
  assert.equal(
    T.terminalsOf({ status: 200, body: body({ kind: "magic", name: "x" }) }).view,
    undefined,
  );
  assert.equal(
    T.terminalsOf({ status: 200, body: { terminals: [], view: { kind: "following", name: "x" } } })
      .view,
    undefined,
    "only Core's viewDescriptor, never another name",
  );
  const f = await page([answer(200, both)], {
    hash: "#agents",
    terminals: answer(200, body({ kind: "following", name: "task 42" })),
  });
  assert.match(
    f.bar(),
    /Following “task 42”: agents join and leave this view as the work changes\./,
  );
  const s = await page([answer(200, both)], {
    hash: "#agents",
    terminals: answer(200, body({ kind: "fixed", name: "review desk" })),
  });
  assert.match(s.bar(), /Saved layout “review desk”: the same agents until someone changes it\./);
  assert.doesNotMatch(s.bar(), /Following/);
});

test("why a tile closed comes from what the terminal said (Herdr's in-band reasons, the box's lines), and decides what the tile does", () => {
  const herdr = (reason) => `{"type":"terminal.closed","reason":"${reason}"}`;
  assert.equal(
    T.closeReasonOf([
      herdr(
        "terminal attach failed: terminal term_ab already has an attached client; retry with --takeover",
      ),
    ]),
    "inuse",
  );
  assert.equal(
    T.closeReasonOf([
      "In use elsewhere: this agent's terminal is open in another window. Watch it, or Take over.",
    ]),
    "inuse",
  );
  assert.equal(T.closeReasonOf([herdr("terminal attach taken over")]), "takenover");
  assert.equal(
    T.closeReasonOf([herdr("terminal session observe failed: terminal target term_ab not found")]),
    "changed",
  );
  assert.equal(
    T.closeReasonOf(["This agent's terminal isn't open in this workspace now."]),
    "changed",
  );
  assert.equal(T.closeReasonOf([herdr("process exited")]), "ended");
  assert.equal(T.closeReasonOf(["$ ls", ""]), null, "nothing said: the connection dropped");
  assert.deepEqual(T.afterClose("inuse", "type"), { note: T.IN_USE_BACK, next: "watch" });
  assert.deepEqual(T.afterClose("takenover", "takeover"), { note: T.TAKEN_BACK, next: "watch" });
  assert.deepEqual(T.afterClose(null, "type"), { note: T.CLOSED_BACK, next: "watch" });
  assert.deepEqual(
    T.afterClose("changed", "type"),
    { note: T.CHANGED, next: "list" },
    "a changed terminal is looked up again, never re-attached by its old id",
  );
  assert.deepEqual(T.afterClose("ended", "watch"), { note: T.ENDED, next: "stay" });
  assert.deepEqual(
    T.afterClose(null, "watch"),
    { note: T.CLOSED_WATCH, next: "stay" },
    "a watching tile doesn't reconnect by itself either",
  );
});

test("page: a tile taken over elsewhere goes back to Watch saying so; a stale id reads the list again; an ended terminal stays, said", async () => {
  const p = await page(Array(4).fill(answer(200, both)), {
    hash: "#agents",
    terminals: list(["term_a1", "dev.impl", "idle"], ["term_b2", "team.lead", "idle"]),
  });
  await p.press("type", "term_a1");
  const f = p.tile("term_a1").children[1];
  ttydFrame(f, ['{"type":"terminal.closed","reason":"terminal attach taken over"}']).closes();
  await settle();
  assert.equal(f.src, W("term_a1"));
  assert.match(
    p.tile("term_a1").children[0].html,
    /Taken over in another window, so this tile is back to watching\./,
  );
  const reads = p.urls.filter((u) => u === "/api/agents/terminals").length;
  const g = p.tile("term_b2").children[1];
  ttydFrame(g, [
    '{"type":"terminal.closed","reason":"terminal session observe failed: terminal target term_b2 not found"}',
  ]).closes();
  await settle();
  assert.match(
    p.tile("term_b2").children[0].html,
    /This agent(&#39;|')s terminal restarted; reloading\./,
  );
  assert.ok(
    p.urls.filter((u) => u === "/api/agents/terminals").length > reads,
    "the list is read again (a changed id is replaced from it)",
  );
  const h = p.tile("term_a1").children[1];
  ttydFrame(h, ['{"type":"terminal.closed","reason":"process exited"}']).closes();
  await settle();
  assert.match(p.tile("term_a1").children[0].html, /This agent(&#39;|')s terminal ended\./);
  assert.equal(h.src, W("term_a1"), "an ended terminal isn't reopened");
});

test("a focused departing tile stays 12 s, then the keyboard moves to a remaining tile and it closes; pinned and typed-in stay", async () => {
  assert.equal(T.FOCUS_HOLD_S, 12);
  const two = list(["term_a1", "dev.impl", "idle"], ["term_b2", "team.lead", "idle"]),
    one = list(["term_a1", "dev.impl", "idle"]);
  const real = Date.now;
  let t = real();
  Date.now = () => t;
  try {
    const p = await page(Array(6).fill(answer(200, both)), {
      hash: "#agents",
      terminals: [two, one, one, one],
    });
    const b2 = p.tile("term_b2").children[1],
      a1 = p.tile("term_a1").children[1];
    p.document.activeElement = b2;
    await p.tick();
    assert.match(
      p.tile("term_b2").children[0].html,
      /Kept for 12 seconds while you(&#39;|')re using it\./,
    );
    t += 11000;
    await p.tick();
    assert.ok(p.tile("term_b2"), "still there at 11 s");
    t += 2000;
    await p.tick();
    assert.equal(p.tile("term_b2"), undefined, "closed after the hold");
    assert.equal(
      p.document.activeElement,
      a1,
      "the keyboard moved to a tile still in the list first",
    );
    assert.match(p.bar(), /team\.lead left this list, so its tile was closed\./);
  } finally {
    Date.now = real;
  }
});

test("a failed read keeps the tiles and says so; a read empty list is 'none', waiting for agents", async () => {
  const one = list(["term_a1", "dev.impl", "idle"]),
    bad = answer(503, { ok: false, unreadable: "x" }),
    empty = answer(200, { terminals: [], ambiguous: [] });
  const p = await page(Array(6).fill(answer(200, both)), {
    hash: "#agents",
    terminals: [one, bad, one, empty],
  });
  await p.tick();
  assert.ok(p.tile("term_a1"), "a failed read removes nothing");
  assert.match(
    p.bar(),
    /Couldn(&#39;|')t reach your agents just now, so these may be out of date\./,
  );
  await p.tick();
  assert.doesNotMatch(p.bar(), /reach your agents/, "a good read clears it");
  await p.tick();
  assert.equal(p.tileEls().length, 0, "a confirmed empty list closes the tiles");
  assert.match(p.grid().children[0].html, /No agent terminals to show here yet/);
});

test("names are seat@rig when the box gives the session; each bar line stands alone; the tile says what YOU are doing", async () => {
  const t = T.terminalsOf({
    status: 200,
    body: {
      terminals: [
        { terminal_id: "term_a1", seat: "dev.impl", session: "app-builder@acme-team" },
        { terminal_id: "term_b2", seat: "dev.qa", session: "not a session" },
      ],
    },
  }).terminals;
  assert.deepEqual(
    t.map((x) => [x.seat, x.name]),
    [
      ["dev.impl", "app-builder@acme-team"],
      ["dev.qa", "dev.qa"],
    ],
    "matching stays by seat; the shown name is the session",
  );
  assert.match(
    T.tileHeadHtml(t[0], { canType: true }),
    /class="nm">app-builder@acme-team<[\s\S]*You(&#39;|')re watching/,
  );
  assert.match(T.tileHeadHtml(t[0], { mode: "type", canType: true }), /You(&#39;|')re typing/);
  assert.match(T.tileHeadHtml(t[0], { mode: "takeover", canType: true }), /You took over/);
  const bar = T.barHtml({
    view: { kind: "following", name: "Fix the login page" },
    notes: ["dev-docs@acme-team joined."],
    hidden: ["app-checker@acme-team"],
  });
  const rows = [
    ...bar.matchAll(
      /<span class="bar-line ([a-z]+)">([\s\S]*?)<\/span>(?=<span class="bar-line|$)/g,
    ),
  ].map((m) => [m[1], m[2]]);
  assert.deepEqual(
    rows.map((r) => r[0]),
    ["view", "notes", "more"],
    "one line each",
  );
  assert.match(
    rows[2][1],
    /\+1 more: app-checker@acme-team\.[\s\S]*data-act="more"/,
    "the button sits with the count it controls",
  );
  assert.doesNotMatch(rows[1][1], /data-act/, "no button on the change line");
  const p = await page([answer(200, both)], {
    hash: "#agents",
    terminals: answer(200, {
      terminals: [
        { terminal_id: "term_a1", seat: "dev.impl", session: "app-builder@acme-team" },
        { terminal_id: "term_b2", seat: "dev.qa", session: "app-checker@acme-team" },
      ],
    }),
    size: [700, 760],
  });
  assert.match(p.bar(), /\+1 more: app-checker@acme-team\./, "hidden ones by the same name");
  assert.equal(p.tile("term_a1").children[1].title, "app-builder@acme-team");
});

test("the list is read slowly: on the timer only while the page is visible, never for a view loading", async () => {
  assert.ok(T.CHECK_MS >= 10000 && T.LIST_MIN_MS >= 10000, "10 s or slower");
  const p = await page(Array(6).fill(answer(200, both)), {
    hash: "#agents",
    terminals: list(["term_a1", "dev.impl", "idle"], ["term_b2", "team.lead", "idle"]),
  });
  const reads = () => p.urls.filter((u) => u === "/api/agents/terminals").length,
    places = () => p.urls.filter((u) => u === "/api/studio/place").length;
  assert.equal(reads(), 1, "one read to open");
  const pl = places();
  for (const t of p.tileEls()) for (const fn of t.children[1].listeners.load) fn();
  await settle();
  assert.equal(reads(), 1, "views loading don't read the list");
  assert.ok(places() > pl, "they check the sign-in (the place)");
  p.document.hidden = true;
  await p.tick();
  assert.equal(reads(), 1, "hidden: the timer reads nothing");
  p.document.hidden = false;
  await p.tick();
  assert.equal(reads(), 2, "visible: the timer reads it");
});

test("the followed name is quoted; expanded, 'Showing all N.' sits with Show fewer on its own line", () => {
  assert.match(
    T.barHtml({ view: { kind: "fixed", name: "Review desk" } }),
    /Saved layout “Review desk”: the same agents/,
  );
  const b = T.barHtml({
    notes: ["dev-docs@acme-team left this list, so its tile was closed. The agent keeps running."],
    override: true,
    shown: 3,
  });
  assert.match(
    b,
    /<span class="bar-line more"><span>Showing all 3\.<\/span><button[^>]*data-act="fewer"/,
  );
  assert.doesNotMatch(b.match(/<span class="bar-line notes">[\s\S]*?<\/span>/)[0], /data-act/);
});

const VIEW = "qitem:task-a1";
const member = (seat, o = {}) => ({
  seat,
  session: seat,
  key: { hostId: "host-1", nodeId: `node-${seat.split("@")[0]}` },
  availability: "available",
  viewerStatus: "not-provisioned",
  ...o,
});
const taskBody = (members, o = {}) => ({
  task: {
    qitemId: "task-a1",
    name: "Fix the login page",
    complete: true,
    issues: [],
  },
  viewDescriptor: { kind: "following", name: "Fix the login page" },
  plan: "plan-1",
  ensure: true,
  members,
  ...o,
});
const taskList = (members, o = {}) => answer(200, taskBody(members, o)); // what the page's fetch gets
const taskRead = (members, o = {}) => ({ status: 200, body: taskBody(members, o) }); // what terminalsOf gets (the page's read)

test("task view: the address names the task; only a qitem view of an id's shape counts", () => {
  assert.equal(T.viewOf("#agents&view=qitem%3Atask-a1"), VIEW);
  assert.equal(T.viewOf("#agents"), null);
  assert.equal(T.viewOf("#shell&view=qitem%3Ax"), null);
  for (const bad of ["rig%3Aacme", "qitem%3A..%2Fx", "qitem%3A", "%E0%A4%A"])
    assert.equal(T.viewOf(`#agents&view=${bad}`), null, bad);
  assert.ok(T.asksAgents("#agents&view=qitem%3Ax"));
  assert.ok(T.asksAgents("#agents"));
  assert.ok(!T.asksAgents("#agentsx"));
  const paths = { watch: "/agents/watch/", type: "/agents/type/" };
  assert.equal(
    T.tileUrl(paths, "term_ab", "watch", VIEW),
    "/agents/watch/?arg=qitem%3Atask-a1&arg=term_ab&disableReconnect=true&disableLeaveAlert=true",
  );
  assert.equal(
    T.tileUrl(paths, "term_ab", "takeover", VIEW),
    "/agents/type/?arg=qitem%3Atask-a1&arg=term_ab&arg=takeover&disableReconnect=true&disableLeaveAlert=true",
  );
  assert.equal(T.tileUrl(paths, "term_ab", "watch", "rig:acme"), null);
  assert.equal(
    T.tileUrl(paths, "term_ab", "watch"),
    "/agents/watch/?arg=term_ab&disableReconnect=true&disableLeaveAlert=true",
    "the box's view: as before",
  );
});

test("task view: a member's terminal is a tile only when Core VERIFIED it; every other member is shown, saying why; Add view only where Core can add one", () => {
  const r = T.terminalsOf(
    taskRead([
      member("app-builder@acme", { viewerStatus: "verified", terminal_id: "term_a1" }),
      member("app-checker@acme", {
        viewerStatus: "verified",
        terminal_id: "term_b2",
        readOnly: true,
      }),
      member("team-lead@acme"),
      member("dev-docs@acme", { viewerStatus: "unconfirmed" }),
      member("ops@acme", { availability: "stopped", reason: "Seat is stopped." }),
      member("pm@acme", { availability: "hosted" }),
      member("old@acme", { availability: "missing" }),
      member("far@other", { availability: "unresolved", key: { hostId: null, nodeId: null } }),
      member("fake@acme", { viewerStatus: "unconfirmed", terminal_id: "term_c3" }), // a terminal id Core didn't verify: never a tile
    ]),
  );
  assert.equal(r.read, true);
  assert.equal(r.plan, "plan-1");
  assert.equal(r.ensure, true);
  assert.deepEqual(r.task, { name: "Fix the login page", complete: true, issues: [] });
  assert.deepEqual(r.view, { kind: "following", name: "Fix the login page" });
  const by = Object.fromEntries(r.terminals.map((t) => [t.seat, t]));
  assert.deepEqual(
    [by["app-builder@acme"].id, by["app-builder@acme"].readOnly, by["app-builder@acme"].member],
    ["term_a1", false, { hostId: "host-1", nodeId: "node-app-builder" }],
  );
  assert.equal(by["app-checker@acme"].readOnly, true);
  assert.deepEqual(
    ["team-lead@acme", "dev-docs@acme", "fake@acme"].map((s) => [
      by[s].id,
      by[s].why,
      by[s].ensure,
    ]),
    [
      [null, "not-provisioned", true],
      [null, "unconfirmed", true],
      [null, "unconfirmed", true],
    ],
  );
  assert.deepEqual(
    ["ops@acme", "pm@acme", "old@acme", "far@other"].map((s) => [by[s].why, by[s].ensure]),
    [
      ["stopped", false],
      ["hosted", false],
      ["missing", false],
      ["unresolved", false],
    ],
  );
  const inc = T.terminalsOf(
    taskRead([member("team-lead@acme")], {
      task: { name: "T", complete: false, issues: ["lineage read limit"] },
    }),
  );
  assert.equal(inc.terminals[0].ensure, false);
  assert.deepEqual(inc.task.issues, ["lineage read limit"]);
  assert.equal(
    T.terminalsOf(taskRead([member("team-lead@acme")], { ensure: false })).terminals[0].ensure,
    false,
  );
  assert.deepEqual(
    T.terminalsOf({ status: 503, body: { error: "x", code: "task_views_unsupported" } }),
    { read: false, terminals: [], unsupported: true },
  );
  assert.deepEqual(T.terminalsOf({ status: 503, body: { error: "x" } }), {
    read: false,
    terminals: [],
  });
  assert.deepEqual(
    T.terminalsOf({
      status: 404,
      body: { ok: false, code: "view_not_found", error: "this task isn't known to this workspace" },
    }),
    { read: false, terminals: [], notFound: true },
  );
  assert.deepEqual(
    T.terminalsOf({ status: 404, body: { error: "x" } }),
    { read: false, terminals: [] },
    "any other 404 stays unread",
  );
});

test("task view: the tile head says each member's state, offers Add view, Watch only on a read-only view, and a leaver is 'no longer in this task'", () => {
  const words = (t, o) => T.tileHeadHtml(t, { canType: true, inTask: true, ...o });
  for (const [why, w] of Object.entries(T.MEMBER_WORDS))
    assert.ok(
      words({ id: null, key: "seat:x", seat: "x", name: "x", unavailable: true, why }).includes(
        w.replace(/'/g, "&#39;"),
      ),
      why,
    );
  assert.match(
    words({
      id: null,
      key: "seat:x",
      seat: "x",
      name: "x",
      unavailable: true,
      why: "not-provisioned",
      ensure: true,
    }),
    /data-act="ensure"[^>]*>Add view</,
  );
  assert.match(
    words(
      {
        id: null,
        key: "seat:x",
        seat: "x",
        name: "x",
        unavailable: true,
        why: "not-provisioned",
        ensure: true,
      },
      { adding: true },
    ),
    /disabled>Adding view…</,
  );
  assert.doesNotMatch(
    words({
      id: null,
      key: "seat:x",
      seat: "x",
      name: "x",
      unavailable: true,
      why: "stopped",
      ensure: false,
    }),
    /Add view/,
  );
  const ro = words({ id: "term_b2", key: "term_b2", seat: "q", name: "q", readOnly: true });
  assert.doesNotMatch(ro, /data-act="type"|data-act="takeover"/);
  assert.match(ro, /You&#39;re watching\. You can&#39;t type here\./);
  assert.match(
    words({ id: "term_a1", key: "term_a1", seat: "i", name: "i" }),
    /data-act="type"[\s\S]*data-act="takeover"/,
    "a verified writable viewer: Type and Take over, each a click",
  );
  assert.match(
    words({ id: "term_a1", key: "term_a1", seat: "i", name: "i" }, { gone: true, kept: "pinned" }),
    /no longer in this task\. Kept because you pinned it\./,
  );
  assert.equal(
    T.leftNote("x@acme", true),
    "x@acme left this task, so its tile was closed. The agent keeps running.",
  );
  const inc1 = T.barHtml({ task: { complete: false, issues: ["lineage read limit"] } });
  assert.match(
    inc1,
    /<span class="bar-line warn" data-issues="lineage read limit">Some agents on this task may be missing from this list, because the whole task couldn(&#39;|')t be read\.<\/span>/,
  );
  assert.doesNotMatch(inc1.replace(/data-issues="[^"]*"/, ""), /lineage/);
  const held = T.terminalsOf(
    taskRead([member("team-lead@acme")], { task: { name: "T", complete: false, issues: [] } }),
  ).terminals[0];
  assert.deepEqual([held.ensure, held.held], [false, true]);
  assert.match(
    words(held),
    /<span class="meta">Not available in the terminal view yet\. You can add a view once the full list can be read\.<\/span>/,
    "one line, one space",
  );
  assert.doesNotMatch(words(held), /data-act="ensure"/);
  assert.equal(
    T.terminalsOf(
      taskRead([member("team-lead@acme")], {
        task: { name: "T", complete: false, issues: [] },
        ensure: false,
      }),
    ).terminals[0].held,
    false,
    "no Add view on this OpenRig: nothing held",
  );
  assert.equal(T.barHtml({ task: { complete: true, issues: [] } }), "");
});

test("Add view's answer: added or found -> read again; changed, unconfirmed, unavailable said; unknown never said as done", () => {
  const R = (status, body) => T.ensureResult({ status, body });
  assert.deepEqual(R(200, { ok: true, created: true, viewer: {} }), {
    note: "View added.",
    next: "list",
  });
  assert.deepEqual(R(200, { ok: true, created: false, viewer: {} }), {
    note: "View found.",
    next: "list",
  });
  assert.equal(
    R(409, { ok: false, code: "preview_changed" }).note,
    "This task changed. Try again.",
  );
  assert.equal(
    R(200, { ok: false, code: "viewer_unconfirmed" }).note,
    "OpenRig couldn't confirm this agent's view.",
  );
  assert.equal(
    R(200, { ok: false, code: "viewer_unavailable" }).note,
    "This agent has no terminal to show here right now.",
  );
  assert.equal(R(404, { ok: false, code: "view_not_found" }).next, "stay");
  assert.equal(
    R(200, { ok: false, code: "viewer_unsupported" }).note,
    "This machine's OpenRig can't add a view here yet.",
  );
  for (const r of [R(0, null), R(502, null), R(200, { ok: "yes" })])
    assert.deepEqual(r, {
      note: "Couldn't confirm whether the view was added. Checking again.",
      next: "list",
    });
});

test("page, task view: the list is read for the task; members become tiles; Add view posts the member and plan, then reads the task again", async () => {
  const before = taskList([
    member("app-builder@acme", { viewerStatus: "verified", terminal_id: "term_a1" }),
    member("app-checker@acme"),
  ]);
  const after = taskList(
    [
      member("app-builder@acme", { viewerStatus: "verified", terminal_id: "term_a1" }),
      member("app-checker@acme", { viewerStatus: "verified", terminal_id: "term_b2" }),
    ],
    { plan: "plan-2" },
  );
  const p = await page([answer(200, both)], {
    hash: "#agents&view=qitem%3Atask-a1",
    terminals: [before, after],
    ensure: answer(200, { ok: true, created: true, viewer: { terminalId: "term_b2" } }),
  });
  assert.equal(p.state(), "open");
  assert.ok(
    p.urls.includes("/api/agents/terminals?view=qitem%3Atask-a1"),
    "the task's list, not the box's",
  );
  assert.ok(
    p
      .tile("term_a1")
      ?.children.find((c) => c.tagName === "IFRAME")
      ?.src.startsWith("/agents/watch/?arg=qitem%3Atask-a1&arg=term_a1"),
    "the tile watches with the task first",
  );
  assert.ok(p.tile("seat:app-checker@acme"), "a member with no view yet is a tile with no frame");
  await p.press("ensure", "seat:app-checker@acme");
  assert.deepEqual(p.posts, [
    {
      url: "/api/agents/ensure",
      body: {
        view: VIEW,
        member: { hostId: "host-1", nodeId: "node-app-checker" },
        expectedPlan: "plan-1",
      },
    },
  ]);
  assert.ok(p.tile("term_b2"), "read again: the new view replaces the member's tile");
  assert.ok(!p.tile("seat:app-checker@acme"));
  assert.equal(p.urls.filter((u) => u === "/api/terminal/open").length, 0, "never OpenRig's open");
});

test("the limit is for terminals: a member with nothing to show is always a tile and never hides a terminal; a view the owner added stays", async () => {
  const ms = [
    member("app-builder@acme", { viewerStatus: "verified", terminal_id: "term_a1" }),
    member("team-lead@acme", { viewerStatus: "verified", terminal_id: "term_b2" }),
    member("app-checker@acme"),
    member("ops@acme", { availability: "stopped" }),
    member("far@other", { availability: "unresolved", key: { hostId: null, nodeId: null } }),
    member("dev-docs@acme", { viewerStatus: "verified", terminal_id: "term_d4" }),
  ];
  const after = ms.map((m) =>
    m.seat === "app-checker@acme" ? { ...m, viewerStatus: "verified", terminal_id: "term_c3" } : m,
  );
  const p = await page([answer(200, both)], {
    hash: "#agents&view=qitem%3Atask-a1",
    size: [1280, 760],
    terminals: [taskList(ms), taskList(after, { plan: "plan-2" })],
    ensure: answer(200, { ok: true, created: true, viewer: { terminalId: "term_c3" } }),
  });
  assert.deepEqual(
    p.gridTiles().map((x) => x.dataset.id),
    ["term_a1", "term_b2"],
    "two terminals fit, in the grid",
  );
  assert.deepEqual(
    p.memberTiles().map((x) => x.dataset.id),
    ["seat:app-checker@acme", "seat:ops@acme", "seat:far@other"],
    "every member without one, in the list after it",
  );
  assert.match(
    p.tile("seat:app-checker@acme").children[0].html,
    /data-act="ensure"[^>]*>Add view</,
  );
  assert.match(
    p.bar(),
    /\+1 more: dev-docs@acme\./,
    "only a terminal is ever left out, and it's named",
  );
  await p.press("ensure", "seat:app-checker@acme");
  assert.ok(
    p.tile("term_c3"),
    "the view the owner asked for is shown, past the limit, in its member's place",
  );
  assert.deepEqual(
    p.gridTiles().map((x) => x.dataset.id),
    ["term_a1", "term_b2", "term_c3"],
    "moved up into the grid",
  );
  assert.deepEqual(
    p.memberTiles().map((x) => x.dataset.id),
    ["seat:ops@acme", "seat:far@other"],
  );
  const b = await page([answer(200, both)], {
    hash: "#agents",
    size: [1280, 760],
    terminals: answer(200, {
      terminals: [
        { terminal_id: "term_a1", seat: "dev.impl" },
        { terminal_id: null, seat: "dev.docs", status: "not-provisioned" },
        { terminal_id: "term_b2", seat: "team.lead" },
        { terminal_id: "term_c3", seat: "dev.qa" },
      ],
    }),
  });
  assert.deepEqual(
    b.gridTiles().map((x) => x.dataset.id),
    ["term_a1", "term_b2"],
  );
  assert.deepEqual(
    b.memberTiles().map((x) => x.dataset.id),
    ["seat:dev.docs"],
  );
  assert.match(b.bar(), /\+1 more: dev\.qa\./);
});

test("page, task view on an OpenRig without task views: said, with the way back to all agents; nothing is posted", async () => {
  const p = await page([answer(200, both)], {
    hash: "#agents&view=qitem%3Atask-a1",
    terminals: answer(503, { error: "x", code: "task_views_unsupported" }),
  });
  const g = p.grid();
  assert.match(
    g.children.map((c) => c.html || "").join(""),
    /<p class="meta">Task views aren&#39;t available on this machine yet\. All your agents are in the agents view\. <a href="#agents">Show all agents/,
  );
  assert.match(
    p.status.innerHTML,
    /Your team&#39;s agents, live\./,
    "the general line, not the task's, when no task is shown",
  );
  assert.equal(p.posts.length, 0);
});

test("page, task view of a task this workspace doesn't know: said plainly, never 'just now', with the way back; nothing is posted", async () => {
  const p = await page([answer(200, both)], {
    hash: "#agents&view=qitem%3Aqitem-gone-1",
    terminals: answer(404, {
      ok: false,
      code: "view_not_found",
      error: "this task isn't known to this workspace",
    }),
  });
  const html = p
    .grid()
    .children.map((c) => c.html || "")
    .join("");
  assert.match(
    html,
    /<p class="meta">This task isn&#39;t known to this workspace, so there are no agents to show for it\. <a href="#agents">Show all agents/,
  );
  assert.doesNotMatch(html, /just now/);
  assert.equal(p.posts.length, 0);
});

test("a state is shown only when known: none on a task view's members, amber 'state not known' only where the box's list gave none", () => {
  const m = { id: null, key: "seat:x", seat: "x", name: "x", unavailable: true, why: "stopped" };
  assert.doesNotMatch(
    T.tileHeadHtml(m, { inTask: true }),
    /state not known|class="st"/,
    "a task member: no chip",
  );
  assert.match(
    T.tileHeadHtml({ ...m, state: "working" }, { inTask: true }),
    /<span class="st">working<\/span>/,
    "a real state is shown",
  );
  assert.match(
    T.tileHeadHtml({ id: "term_a1", key: "term_a1", seat: "i", name: "i", state: null }),
    /<span class="st warn">state not known<\/span>/,
    "the box's view: a missing state is said",
  );
  assert.match(
    T.tileHeadHtml({ id: "term_a1", key: "term_a1", seat: "i", name: "i", state: "blocked" }),
    /<span class="st">waiting<\/span>/,
  );
  assert.match(
    T.stateHtml("open", { mode: "agents", inTask: true }),
    /Agents on this task, live\./,
    "a task view's line: they may not all be your team",
  );
  assert.match(T.stateHtml("open", { mode: "agents" }), /Your team&#39;s agents, live\./);
});

const TV = (id, m = "watch") =>
  m === "watch"
    ? `/agents/watch/?arg=qitem%3Atask-a1&arg=${id}&disableReconnect=true&disableLeaveAlert=true`
    : `/agents/type/?arg=qitem%3Atask-a1&arg=${id}&arg=${m}&disableReconnect=true&disableLeaveAlert=true`;
test("a view that becomes read only while the owner types in it goes back to Watch, saying why; Type stays off", async () => {
  const writable = taskList([
    member("app-builder@acme", { viewerStatus: "verified", terminal_id: "term_a1" }),
  ]);
  const readOnly = taskList([
    member("app-builder@acme", {
      viewerStatus: "verified",
      terminal_id: "term_a1",
      readOnly: true,
    }),
  ]);
  const p = await page([answer(200, both)], {
    hash: "#agents&view=qitem%3Atask-a1",
    terminals: [writable, readOnly],
  });
  await p.press("type", "term_a1");
  const f = p.tile("term_a1").children[1];
  assert.equal(f.src, TV("term_a1", "type"));
  await p.tick();
  assert.equal(f.src, TV("term_a1"), "the typing connection is replaced by watching");
  assert.match(
    p.tile("term_a1").children[0].html,
    /This view is now watch only, so this tile is back to watching\./,
  );
  assert.doesNotMatch(p.tile("term_a1").children[0].html, /data-act="type"|data-act="takeover"/);
  await p.press("type", "term_a1");
  await p.press("takeover", "term_a1");
  assert.equal(
    f.src,
    TV("term_a1"),
    "a stale Type or Take over click on a read-only view does nothing",
  );
});

test("another task in the address replaces only the agents' view; an open workspace shell stays", async () => {
  const a = taskList([
    member("app-builder@acme", { viewerStatus: "verified", terminal_id: "term_a1" }),
  ]);
  const b = taskList(
    [member("app-checker@acme", { viewerStatus: "verified", terminal_id: "term_b2" })],
    {
      task: { qitemId: "task-b2", name: "Another task", complete: true, issues: [] },
    },
  );
  const p = await page([answer(200, both)], {
    hash: "#agents&view=qitem%3Atask-a1",
    terminals: [a, b],
  });
  await p.switchTo("shell");
  await p.switchTo("agents");
  const shell = p.screen.children.find((x) => x.dataset?.mode === "shell");
  assert.ok(shell, "the workspace shell is open");
  await p.navigate("#agents&view=qitem%3Atask-b2");
  assert.ok(p.screen.children.includes(shell), "the same shell frame, still there");
  assert.ok(
    p.urls.includes("/api/agents/terminals?view=qitem%3Atask-b2"),
    "the new task's list is read",
  );
  assert.ok(p.tile("term_b2") && !p.tile("term_a1"), "the agents' view is the new task's");
  assert.equal(p.state(), "open");
  const q = await page([answer(200, both)], {
    hash: "#agents&view=qitem%3Atask-a1",
    terminals: [a, b],
  });
  await q.navigate("#agents&view=qitem%3Atask-b2");
  assert.ok(q.tile("term_b2") && !q.tile("term_a1"));
});

test("a member that can't be read makes the task not read in full (said, and no Add view); an empty member list is a task with no agents", () => {
  const r = T.terminalsOf(
    taskRead([null, member("team-lead@acme"), { key: { hostId: "h", nodeId: "n" } }]),
  );
  assert.equal(r.read, true);
  assert.equal(r.task.complete, false);
  assert.ok(r.task.issues.includes(T.MEMBERS_UNREAD));
  assert.equal(r.terminals.length, 1);
  assert.equal(r.terminals[0].ensure, false, "Core refuses Add view on an incomplete task");
  assert.match(
    T.barHtml({ task: r.task }),
    /data-issues="some of its agents couldn&#39;t be read">Some agents on this task may be missing from this list/,
  );
  const none = T.terminalsOf(taskRead([]));
  assert.deepEqual(
    [none.read, none.task.complete, none.terminals.length],
    [true, true, 0],
    "[] is read, and empty",
  );
});

test("the line under a banner's button follows the button directly", () => {
  assert.match(
    T.stateHtml("refused"),
    /data-act="signin">Sign in again<\/button><p class="meta">If this keeps happening/,
    "the line is the button's next sibling",
  );
});

test("a task member with no viewer of its own is watched through the workspace's ordinary terminal", () => {
  const box = T.terminalsOf({
    status: 200,
    body: {
      terminals: [
        { terminal_id: "term_a1", seat: "team.lead", session: "team-lead@workshop", state: "idle" },
      ],
    },
  });
  const member = (session, availability, viewerStatus) => ({
    seat: session,
    session,
    key: { hostId: "h", nodeId: session },
    availability,
    viewerStatus,
  });
  const task = T.terminalsOf({
    status: 200,
    body: {
      task: { qitemId: "q", name: "Fix", complete: true, issues: [] },
      ensure: true,
      plan: "p",
      members: [
        member("team-lead@workshop", "available", "unconfirmed"),
        member("dev-gone@workshop", "stopped", "unconfirmed"),
        member("dev-new@workshop", "available", "not-provisioned"),
      ],
    },
  });
  const out = T.withBoxTerminals(task, box),
    [lead, gone, fresh] = out.terminals;
  assert.equal(lead.id, "term_a1");
  assert.equal(lead.fromBox, true);
  assert.equal(lead.unavailable, undefined);
  assert.equal(gone.id, null, "a stopped agent isn't dressed up as watchable");
  assert.equal(gone.why, "stopped");
  assert.equal(fresh.id, null, "not in the ordinary list: it keeps Add view");
  assert.equal(fresh.ensure, true);
  assert.deepEqual(
    T.withBoxTerminals(task, { read: false, terminals: [] }),
    task,
    "an unread list changes nothing",
  );
  assert.match(
    T.tileUrl({ watch: "/w" }, lead.id, "watch", null),
    /^\/w\?arg=term_a1&/,
    "the ordinary route, with no task in it",
  );
});

test("page, task view: a member with no viewer gets a live frame by the ordinary route, and a real task viewer keeps its task route", async () => {
  const task = taskList([
    member("app-builder@acme", { viewerStatus: "verified", terminal_id: "term_a1" }),
    member("team-lead@acme", { viewerStatus: "unconfirmed" }),
  ]);
  const box = answer(200, {
    terminals: [
      { terminal_id: "term_c9", seat: "team.lead", session: "team-lead@acme", state: "idle" },
    ],
  });
  const p = await page([answer(200, both)], {
    hash: "#agents&view=qitem%3Atask-a1",
    terminals: task,
    box,
  });
  assert.ok(
    p
      .tile("term_a1")
      ?.children.find((c) => c.tagName === "IFRAME")
      ?.src.startsWith("/agents/watch/?arg=qitem%3Atask-a1&arg=term_a1"),
  );
  const frame = p.tile("term_c9")?.children.find((c) => c.tagName === "IFRAME");
  assert.ok(
    frame?.src.startsWith("/agents/watch/?arg=term_c9"),
    "no task in its route: " + frame?.src,
  );
  assert.equal(p.tile("seat:team-lead@acme"), undefined, "not also shown as a tile with no frame");
});

const fakeTerm = (lines, rows, viewportY = lines.length - rows) => {
  const t = {
    rows,
    moved: [],
    buffer: {
      active: {
        baseY: lines.length - rows,
        viewportY,
        getLine: (r) => ({ translateToString: () => lines[r] ?? "" }),
      },
    },
    scrollToLine(n) {
      t.buffer.active.viewportY = n;
      t.moved.push(n);
    },
    scrollToBottom() {
      t.buffer.active.viewportY = t.buffer.active.baseY;
      t.moved.push("bottom");
    },
  };
  return t;
};
test("a Watch tile shows the text when the rows at the bottom are blank, and goes back to following", async () => {
  const { keepTextInView } = await import("../apps/terminal/vendor/terminal/terminal.js");
  const lines = ["", "---", "> go on", "---", ...Array(37).fill("")],
    t = fakeTerm(lines, 12);
  let st = keepTextInView(t);
  assert.deepEqual(t.moved, [0], "the text comes into view");
  assert.equal(st.moved, true);
  st = keepTextInView(t, st);
  assert.deepEqual(t.moved, [0], "it doesn't keep moving");
  lines[40] = "new output";
  st = keepTextInView(t, st);
  assert.deepEqual(t.moved, [0, "bottom"], "new text at the bottom is followed again");
  assert.equal(st.moved, false);
});

test("a Watch tile never moves a view that has text, or that the person scrolled", async () => {
  const { keepTextInView } = await import("../apps/terminal/vendor/terminal/terminal.js");
  const full = fakeTerm(["a", "b", "c", "d"], 2);
  keepTextInView(full);
  assert.deepEqual(full.moved, []);
  const scrolled = fakeTerm(["a", "", "", "", "", ""], 2, 1);
  keepTextInView(scrolled);
  assert.deepEqual(scrolled.moved, [], "scrolled up by hand: left alone");
  const empty = fakeTerm(["", "", ""], 2);
  keepTextInView(empty);
  assert.deepEqual(empty.moved, [], "nothing anywhere: nothing to show");
  assert.deepEqual(keepTextInView(undefined), {}, "no terminal yet");
});

test("a Watch tile doesn't pull the person back after they've scrolled from where it put them", async () => {
  const { keepTextInView } = await import("../apps/terminal/vendor/terminal/terminal.js");
  const lines = ["", "---", "> go on", "---", ...Array(37).fill("")],
    t = fakeTerm(lines, 12);
  const st = keepTextInView(t);
  t.buffer.active.viewportY = 5; // the person scrolls
  lines[40] = "new output";
  keepTextInView(t, st);
  assert.equal(t.buffer.active.viewportY, 5, "their view stays");
  assert.deepEqual(t.moved, [0]);
  assert.equal(st.moved, false);
});

test("with only a team terminal, Terminal opens it and says what it is, and a workspace's own views stay first", async () => {
  const open = T.stateHtml("open", { team: true });
  assert.match(open, /data-view="team"/);
  assert.match(open, /shared with anyone else who has it open/);
  assert.match(open, /Closing this page leaves them running/);
  assert.doesNotMatch(open, /ends this terminal/, "closing it doesn't end anything");
  assert.doesNotMatch(T.stateHtml("open"), /data-view="team"/);
  assert.equal(T.teamOf({ team: "/team/" }), "/team/");
  assert.equal(
    T.teamOf({ team: "/team/", terminal: "/term/" }),
    null,
    "its own terminal comes first",
  );
  assert.equal(
    T.teamOf({ team: "/team/", agents: { watch: "/a/" } }),
    null,
    "so does its agents view",
  );
  for (const team of [
    null,
    undefined,
    "https://elsewhere.invalid/team/",
    "//elsewhere.invalid/team/",
    "/team/<x>",
  ])
    assert.equal(T.teamOf({ team }), null, String(team));
  const p = await page([answer(200, { team: "/team/" })]);
  assert.equal(p.screen.children.find((x) => x.tagName === "IFRAME")?.title, "All terminals");
});

test("agents grid: empty and unreadable reads have distinct words and a safe team escape", async () => {
  const place = answer(200, {
    terminal: "/terminal/",
    agents: { watch: "/agents/watch/", type: "/agents/type/" },
    team: "/team/",
  });
  const p = await page([place], {
    hash: "#agents",
    terminals: [answer(200, { terminals: [] }), answer(503, {})],
  });
  const notice = () => p.grid().querySelector(":scope > p")?.html || "";
  assert.match(notice(), /No agent terminals to show here yet/);
  assert.match(
    notice(),
    /href="\/team\/" target="_blank" rel="noopener">All terminals <or-icon name="external"><\/or-icon>/,
  );
  assert.equal(
    p.screen.children.some((x) => x.tagName === "IFRAME"),
    false,
    "#agents never picks the available workspace shell",
  );
  await p.tick();
  assert.match(notice(), /Couldn&#39;t read the agents&#39; terminals just now/);
  assert.doesNotMatch(notice(), /No agent terminals/);
  assert.match(notice(), /All terminals <or-icon name="external"><\/or-icon>/);
  assert.equal(p.posts.length, 0);
});

test("agents grid retained: a failed refresh keeps its terminal and uses only the status bar warning", async () => {
  const p = await page([answer(200, { agents: { watch: "/agents/watch/" }, team: "/team/" })], {
    hash: "#agents",
    terminals: [
      answer(200, {
        terminals: [{ terminal_id: "term_a", seat: "lead", session: "lead@example" }],
      }),
      answer(503, {}),
    ],
  });
  const frame = p.tile("term_a").children.find((x) => x.tagName === "IFRAME");
  assert.ok(frame);
  await p.tick();
  assert.equal(
    p.tile("term_a").children.find((x) => x.tagName === "IFRAME"),
    frame,
  );
  assert.equal(
    p.grid().querySelector(":scope > p"),
    null,
    "no extra full grid row above the live terminal",
  );
  assert.match(p.bar(), /Couldn(&#39;|')t reach your agents just now/);
  assert.equal(p.posts.length, 0);
});

test("grid fallback never invents or follows an external team route", () => {
  assert.equal(T.MODE_NAMES.shell, "Your terminal");
  for (const team of [
    null,
    "https://example.invalid/team/",
    "//example.invalid/team/",
    "/team/../secret",
    "/team/?token=x",
  ]) {
    assert.doesNotMatch(T.gridStateHtml("empty", { team }), /<a /);
  }
});

test("page: hidden while a mode switch's read is out, or a fallback to the other view while hidden, never shows a terminal", async () => {
  let release;
  const held = new Promise((r) => {
    release = r;
  });
  const terminals = answer(200, { terminals: [{ seat: "dev.qa", terminal_id: "term_ab" }] });
  const p = await page([answer(200, both), held], { terminals });
  assert.equal(p.state(), "open");
  const switching = p.switchTo("agents");
  await p.setHidden(true);
  assert.deepEqual([p.state(), p.screen.hidden], ["hidden", true]);
  release(answer(200, both));
  await switching;
  await settle();
  assert.deepEqual(
    [p.state(), p.screen.hidden],
    ["hidden", true],
    "the late answer makes the agents view, hidden",
  );
  assert.ok(p.agents(), "made (and connected), only not shown");
  await p.setHidden(false);
  assert.deepEqual(
    [p.state(), p.screen.hidden, p.agents().hidden],
    ["open", false, false],
    "shown again: the agents view shows",
  );
  // Both views kept; hidden; a check finds the agents mode gone, so it falls back to the shell: still hidden.
  const q = await page(
    [answer(200, both), answer(200, both), answer(200, { terminal: "/terminal/", agents: null })],
    { hash: "#agents", terminals },
  );
  await q.switchTo("shell");
  await q.switchTo("agents");
  assert.equal(q.screen.children.length, 2);
  await q.setHidden(true);
  await q.tick();
  assert.deepEqual(
    [q.state(), q.screen.hidden, q.screen.children.length],
    ["hidden", true, 1],
    "fell back to the shell, hidden",
  );
});

test("page: while hidden, another task in the address keeps the hidden shell; shown again, it's the new task's agents", async () => {
  const a = taskList([
    member("app-builder@acme", { viewerStatus: "verified", terminal_id: "term_a1" }),
  ]);
  const b = taskList(
    [member("app-checker@acme", { viewerStatus: "verified", terminal_id: "term_b2" })],
    {
      task: { qitemId: "task-b2", name: "Another task", complete: true, issues: [] },
    },
  );
  const p = await page([answer(200, both)], {
    hash: "#agents&view=qitem%3Atask-a1",
    terminals: [a, b],
  });
  await p.switchTo("shell");
  await p.switchTo("agents");
  const shell = p.screen.children.find((x) => x.dataset?.mode === "shell");
  await p.setHidden(true);
  assert.equal(p.state(), "hidden");
  await p.navigate("#agents&view=qitem%3Atask-b2");
  assert.ok(p.screen.children.includes(shell), "the hidden shell is kept");
  assert.deepEqual([p.state(), p.screen.hidden], ["hidden", true], "still hidden");
  await p.setHidden(false);
  assert.equal(p.state(), "open");
  assert.ok(p.tile("term_b2") && !p.tile("term_a1"), "the new task's agents");
  assert.ok(p.screen.children.includes(shell));
});

test("a deployment's own controls attach through vendor/terminal/local.js, loaded after the page; public ships it empty", () => {
  const local = fs.readFileSync(
    new URL("../apps/terminal/vendor/terminal/local.js", import.meta.url),
    "utf8",
  );
  assert.equal(local.replace(/\/\/.*$/gm, "").trim(), "", "comments only");
  const page = html.indexOf('<script type="module">'),
    extra = html.search(
      /<script type="module" src="\/vendor\/terminal\/local\.js\?v=[0-9a-f]{64}"><\/script>/,
    );
  assert.ok(
    extra > page,
    "a separate module after the page's own, so its absence or a throw changes nothing there",
  );
});

// A files-only guest's place has workspace "files" and no terminals. It was told "Terminal isn't set up yet …
// contact the person who set up this machine", which isn't true: it is set up, just not for them.
test("page: a files-only guest is told Terminal isn't part of their access, never that it isn't set up", async () => {
  const g = await page([
    answer(200, {
      workspace: "files",
      access: "owner",
      terminal: null,
      team: null,
      agents: { watch: null, type: null },
      terminals: null,
    }),
  ]);
  assert.deepEqual([g.state(), g.screen.children.length], ["notset", 0]);
  assert.match(g.status.innerHTML, /files only, so Terminal isn(&#39;|')t open to you/);
  assert.doesNotMatch(g.status.innerHTML, /set up yet/);
  const o = await page([answer(200, { workspace: "full", terminal: null })]);
  assert.match(
    o.status.innerHTML,
    /Terminal isn(&#39;|')t set up yet\./,
    "a full workspace without a terminal still says it isn't set up",
  );
});
