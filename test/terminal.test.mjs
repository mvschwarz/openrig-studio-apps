// Terminal: what a read of the Studio's place means, the words for each state, the agents view's tile rules, and the page run in a
// stand-in browser. On a Studio that doesn't serve the agents view (every Studio reached only from this computer) the page is the
// shell alone; where the place advertises the agents, the page shows them as tiles. Copyright 2026 mvschwarz. Licensed under the
// Apache License, Version 2.0.
import test from "node:test";
import assert from "node:assert/strict";
import { T, all, runPage } from "./terminal-page.mjs";

const T1 = "term_65ec4de94ab672",
  T2 = "term_65ec4de94c37a4";
const AGENTS = { watch: "/agents/watch/", type: "/agents/type/" };

test("only a plain path on this Studio is a terminal: never another host, a query or a climb", () => {
  assert.equal(T.terminalOf({ terminal: "/terminal/" }), "/terminal/");
  for (const bad of [
    null,
    "",
    "https://example.invalid/terminal/",
    "//example.invalid/",
    "/terminal/?x=1",
    "/a/../b/",
    "/./x",
    7,
  ])
    assert.equal(T.terminalOf({ terminal: bad }), null, String(bad));
});

test("a read of the place: 200 with a terminal is open, 200 without one is not set up, anything else is unread (never 'off')", () => {
  assert.equal(T.stateOf({ status: 200, body: { terminal: "/terminal/" } }), "open");
  assert.equal(T.stateOf({ status: 200, body: { terminal: null } }), "notset");
  for (const status of [0, 403, 500])
    assert.equal(T.stateOf({ status, body: null }), "unread", String(status));
  assert.equal(T.stateOf({ status: 403, body: null, signInEnded: true }), "refused");
});

test("the words: open says what it is and that closing ends it; not set up gives the SDK's reason and the exact commands", () => {
  const open = T.stateHtml("open");
  assert.ok(open.includes(T.LINE) && open.includes(T.ENDS));
  assert.doesNotMatch(open, /data-act="mode"/, "one view: no switch");
  const notset = T.stateHtml("notset", {
    local: true,
    reason: T.reasonOf({
      terminals: { terminal: { reason: "Set STUDIO_TERMINAL_SOCKET to <the socket>." } },
    }),
  });
  assert.match(notset, /Terminal isn&#39;t set up yet\./);
  assert.match(
    notset,
    /Set STUDIO_TERMINAL_SOCKET to &lt;the socket&gt;\./,
    "the SDK's reason, escaped",
  );
  assert.match(notset, /node tools\/start-terminal\.mjs shell/);
  assert.match(notset, /data-act="retry"/);
  assert.match(T.stateHtml("unread"), /doesn't mean it's off/);
});

test("not set up: only a local Studio shows how to start the listener; anywhere else says who can set it up", () => {
  // A hosted Studio's person can't run the listener, so the card never shows commands there (don't show a step they can't take).
  for (const opts of [{}, { local: false }]) {
    const html = T.stateHtml("notset", opts);
    assert.match(html, /Terminal isn&#39;t set up yet\./);
    assert.match(html, /When it is, a terminal on your machine opens here\./);
    assert.ok(html.includes(T.HELP.replace(/'/g, "&#39;")), "who can set it up");
    assert.doesNotMatch(html, /start-terminal|STUDIO_TERMINAL_SOCKET/);
  }
  assert.match(T.stateHtml("notset", { local: true }), /node tools\/start-terminal\.mjs shell/);
});

test("the agents view is offered only when the place advertises it: a Studio without it is the shell alone", () => {
  // A loopback-only Studio answers agents { watch: null, type: null }.
  const local = { terminal: "/terminal/", team: null, agents: { watch: null, type: null } };
  assert.equal(T.agentsOf(local), null);
  assert.deepEqual(T.availOf(local), { shell: true, agents: false });
  assert.equal(T.modeFor("agents", T.availOf(local)), "shell", "#agents falls back to the shell");
  for (const bad of [
    { watch: "https://x.invalid/agents/" },
    { watch: "/a/../b/" },
    { watch: 7 },
    "x",
  ])
    assert.equal(T.agentsOf({ agents: bad }), null, JSON.stringify(bad));
  const hosted = { terminal: "/terminal/", agents: AGENTS };
  assert.deepEqual(T.agentsOf(hosted), AGENTS);
  assert.deepEqual(T.agentsOf({ agents: { watch: "/agents/watch/", type: null } }), {
    watch: "/agents/watch/",
    type: null,
  });
  assert.deepEqual(T.availOf(hosted), { shell: true, agents: true });
  assert.equal(T.modeFor("agents", T.availOf(hosted)), "agents");
  assert.match(T.stateHtml("open", { mode: "shell", both: true }), /data-act="mode"/);
  assert.deepEqual(T.availOf(hosted, "#agents&only=agents"), { shell: false, agents: true });
});

test("the team's terminal opens only when there is neither a terminal of your own nor the agents view", () => {
  assert.equal(T.teamOf({ terminal: null, team: "/team/", agents: null }), "/team/");
  assert.equal(T.teamOf({ terminal: "/terminal/", team: "/team/" }), null);
  assert.equal(T.teamOf({ team: "/team/", agents: AGENTS }), null);
  assert.equal(T.teamOf({ team: "/elsewhere/" }), null);
  assert.match(T.stateHtml("open", { team: true }), /data-view="team"/);
});

test("a tile's frame is the advertised watch or type path with the terminal id; nothing else is ever built", () => {
  assert.equal(
    T.tileUrl(AGENTS, T1),
    `/agents/watch/?arg=${T1}&disableReconnect=true&disableLeaveAlert=true`,
  );
  assert.equal(
    T.tileUrl(AGENTS, T1, "type"),
    `/agents/type/?arg=${T1}&arg=type&disableReconnect=true&disableLeaveAlert=true`,
  );
  assert.equal(
    T.tileUrl(AGENTS, T1, "watch", "qitem:fix-1"),
    `/agents/watch/?arg=qitem%3Afix-1&arg=${T1}&disableReconnect=true&disableLeaveAlert=true`,
  );
  assert.equal(T.tileUrl({ watch: "/agents/watch/", type: null }, T1, "type"), null);
  for (const bad of ["x", "term_xyz", "../term_1"]) assert.equal(T.tileUrl(AGENTS, bad), null, bad);
  assert.equal(T.tileUrl(AGENTS, T1, "sudo"), null);
  assert.equal(T.tileUrl(AGENTS, T1, "watch", "qitem:../x"), null);
});

test("the agents list: a read list makes tiles (members without a terminal kept), anything else is unread, never 'none'", () => {
  const r = T.terminalsOf({
    status: 200,
    body: {
      terminals: [
        { seat: "app.builder", session: "app-builder@rig1", terminal_id: T1, state: "working" },
        { seat: "app.checker", terminal_id: null, state: "idle" },
        { seat: "x.bad", terminal_id: "not-a-terminal" },
      ],
      ambiguous: ["ops.lead"],
    },
  });
  assert.equal(r.read, true);
  assert.deepEqual(
    r.terminals.map((t) => [t.key, t.name, !!t.unavailable]),
    [
      [T1, "app-builder@rig1", false],
      ["seat:app.checker", "app.checker", true],
      ["ambiguous:ops.lead", "ops.lead", true],
    ],
  );
  for (const bad of [
    { status: 503, body: { ok: false } },
    { status: 200, body: {} },
    { status: 0 },
  ])
    assert.equal(T.terminalsOf(bad).read, false);
  assert.equal(
    T.terminalsOf({ status: 503, body: { code: "task_views_unsupported" } }).unsupported,
    true,
  );
});

test("a tile that closed: typing goes back to Watch saying why; a changed terminal reads the list again", () => {
  assert.equal(T.closeReasonOf(["terminal is in use elsewhere"]), "inuse");
  assert.equal(T.afterClose("inuse", "type").next, "watch");
  assert.equal(T.afterClose("changed", "watch").next, "list");
  assert.equal(T.afterClose(null, "watch").next, "stay");
  assert.equal(T.capFor(1300, 900), 4);
  assert.equal(T.capFor(0, 900), null);
});

// ---- the page ----

const place = (o = {}) => ({
  status: 200,
  body: {
    profile: "local",
    terminal: "/terminal/",
    team: null,
    agents: { watch: null, type: null },
    ...o,
  },
});
const answers = (places, list = null) => {
  let i = 0;
  return (url) => {
    if (url === "/api/studio/place") return places[Math.min(i++, places.length - 1)];
    if (url.startsWith("/api/agents/terminals")) return list;
    throw new Error(`unexpected request ${url}`);
  };
};

test("page, no agents view advertised: the shell alone, and it never asks for the agents list (even with #agents)", async () => {
  for (const hash of ["", "#agents"]) {
    const p = await runPage(answers([place()]), { hash });
    assert.equal(p.nodes.screen.children.length, 1, hash);
    assert.equal(p.nodes.screen.children[0].tagName, "IFRAME");
    assert.equal(p.nodes.screen.children[0].src, "/terminal/");
    assert.match(p.nodes.status.innerHTML, /data-state="open" data-mode="shell"/);
    assert.doesNotMatch(p.nodes.status.innerHTML, /data-act="mode"|Agents/, "no switch");
    assert.deepEqual(p.fetched, ["/api/studio/place"], "only the place");
  }
});

test("page: a place that names /terminal/ opens it in a frame; when the place stops naming it, the frame goes and the page says so", async () => {
  const p = await runPage(
    answers([place(), { status: 500, body: null }, place({ terminal: null })]),
  );
  assert.equal(p.nodes.screen.children.length, 1);
  assert.equal(p.nodes.screen.children[0].src, "/terminal/");
  assert.match(p.nodes.status.innerHTML, /data-state="open"/);
  await p.tick();
  assert.equal(p.nodes.screen.children.length, 1, "a check that didn't answer leaves it open");
  await p.tick();
  assert.equal(p.nodes.screen.children.length, 0);
  assert.match(p.nodes.status.innerHTML, /data-state="notset"/);
});

test("page: not set up opens nothing and offers Check again; an unanswered check says so; a refused sign-in says so", async () => {
  const a = await runPage(
    answers([
      place({ terminal: null, terminals: { terminal: { reason: "Set STUDIO_TERMINAL_SOCKET." } } }),
    ]),
  );
  assert.equal(a.nodes.screen.children.length, 0);
  assert.match(a.nodes.status.innerHTML, /Set STUDIO_TERMINAL_SOCKET\./);
  const b = await runPage(answers([{ status: 0, body: null }]));
  assert.match(b.nodes.status.innerHTML, /data-state="unread"/);
  const c = await runPage(
    answers([
      place(),
      { status: 403, body: { ok: false }, headers: { "x-openrig-front-door": "closed" } },
    ]),
  );
  await c.tick();
  assert.equal(c.nodes.screen.children.length, 0);
  assert.match(c.nodes.status.innerHTML, /data-state="refused"/);
});

test("page, agents advertised: #agents shows a tile per agent from the list, each framing the advertised watch path", async () => {
  const list = {
    status: 200,
    body: {
      terminals: [
        { seat: "app.builder", session: "app-builder@rig1", terminal_id: T1, state: "working" },
        { seat: "app.checker", terminal_id: T2, state: "idle" },
        { seat: "app.planner", terminal_id: null, state: "idle" },
      ],
      ambiguous: [],
    },
  };
  const p = await runPage(answers([place({ profile: "hosted", agents: AGENTS })], list), {
    hash: "#agents",
  });
  assert.ok(p.fetched.includes("/api/agents/terminals"), "the list was read");
  assert.match(p.nodes.status.innerHTML, /data-state="open" data-mode="agents"/);
  assert.match(p.nodes.status.innerHTML, /data-act="mode"/, "both set up: the switch");
  const view = p.nodes.screen.children.find((c) => c.id === "agents");
  assert.ok(view, "the agents view");
  const frames = all(view).filter((e) => e.tagName === "IFRAME");
  assert.deepEqual(
    frames.map((f) => f.src),
    [T1, T2].map((id) => T.tileUrl(AGENTS, id)),
  );
  const heads = all(view)
    .filter((e) => /class="tile-head"/.test(e.markup ?? ""))
    .map((e) => e.markup);
  assert.equal(heads.length, 3, "two terminals and the member without one");
  assert.match(heads[0], /app-builder@rig1.*working.*You&#39;re watching/);
  assert.match(heads[0], /data-act="type"/, "a type path is advertised, so Type is offered");
  assert.match(heads.join(""), /app\.planner.*Not available in the terminal view yet\./);
  // Watch only where the place gives no type path.
  const q = await runPage(
    answers([place({ agents: { watch: "/agents/watch/", type: null } })], list),
    { hash: "#agents" },
  );
  const qh = all(q.nodes.screen)
    .filter((e) => /class="tile-head"/.test(e.markup ?? ""))
    .map((e) => e.markup);
  assert.doesNotMatch(qh.join(""), /data-act="type"/);
});

test("page, agents advertised but no terminal: the agents view opens without #agents; an unreadable list keeps saying so", async () => {
  const p = await runPage(
    answers([place({ terminal: null, agents: AGENTS })], {
      status: 503,
      body: { ok: false },
    }),
  );
  assert.match(p.nodes.status.innerHTML, /data-mode="agents"/);
  const grid = all(p.nodes.screen).find((e) => e.id === "tiles");
  assert.match(grid.innerHTML, /Couldn&#39;t read the agents&#39; terminals just now\./);
});
