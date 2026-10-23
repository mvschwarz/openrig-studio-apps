import test from "node:test";
import assert from "node:assert/strict";
import { buildLiveState } from "../providers/studio-host/live-state.mjs";

test("live state distinguishes a missing rig CLI from a rig command failure", async () => {
  const missing = await buildLiveState({
    runRig: async () => ({ ok: false, reason: "no-rig-cli", detail: "rig executable not found" }),
  });
  assert.equal(missing.attached, false);
  assert.equal(missing.reason, "no-rig-cli");

  const failed = await buildLiveState({
    runRig: async () => ({ ok: false, reason: "rig-error", detail: "daemon unavailable" }),
  });
  assert.equal(failed.attached, false);
  assert.equal(failed.reason, "rig-error");
  assert.match(failed.detail, /daemon unavailable/);
});

test("an answering CLI with no nodes is the only no-rig result", async () => {
  const empty = await buildLiveState({
    runRig: async () => ({ ok: true, value: [] }),
  });
  assert.equal(empty.attached, false);
  assert.equal(empty.reason, "no-rig");
});

// THE FLOOR IS ONE RIG'S FLOOR.
//
// This emitted every node on the box — measured on this machine as 92 seats
// across 12 rigs, under a header reading LIVE ACTIVITY beside a green dot. The
// sidebar next to it showed 10, because the SDK's own seat roster had already
// been fixed; two derivations of one fact disagreed on one screen.
//
// Each case feeds in the SAME fleet and changes only the identity, so the count
// is a delta rather than an absolute: a scoping that had quietly stopped
// working would report the fleet size, not a plausible smaller number.
const FLEET = [
  { logicalId: "a.impl", rigName: "ours", lifecycleState: "running" },
  { logicalId: "b.qa", rigName: "ours", lifecycleState: "running" },
  { logicalId: "c.lead", rigName: "theirs", lifecycleState: "running" },
  { logicalId: "d.lead", rigName: "third", lifecycleState: "running" },
];
const fleetCLI = (whoami) => async (args) => {
  if (args[0] === "whoami") return whoami;
  if (args[0] === "queue") return { ok: true, value: [] };
  return { ok: true, value: FLEET };
};
const rigsIn = (s) => [...new Set(s.seats.map((x) => x.seat.split("@")[1]))];

test("the floor is scoped to ONE rig, not to every rig on the box", async () => {
  const s = await buildLiveState({
    runRig: fleetCLI({ ok: true, value: { identity: { rigName: "ours" } } }),
  });
  assert.equal(s.rig, "ours");
  assert.equal(s.reason, null);
  assert.deepEqual(rigsIn(s), ["ours"]);
  assert.equal(s.seats.length, 2, `two of the ${FLEET.length} fleet nodes are ours`);
});

test("an explicit rig wins over whoami", async () => {
  const s = await buildLiveState({
    rig: "theirs",
    runRig: fleetCLI({ ok: true, value: { identity: { rigName: "ours" } } }),
  });
  assert.equal(s.rig, "theirs");
  assert.deepEqual(rigsIn(s), ["theirs"]);
});

test("no identity and several rigs is AMBIGUOUS, and says so rather than guessing", async () => {
  const s = await buildLiveState({ runRig: fleetCLI({ ok: false, reason: "rig-error" }) });
  // The union is still shown — a blank floor would be a worse answer than an
  // unscoped one — but it is LABELLED, so nothing reads it as this rig's floor.
  assert.equal(s.attached, true);
  assert.equal(s.reason, "ambiguous-rig");
  assert.equal(s.seats.length, FLEET.length);
  assert.match(s.detail, /3 rigs/);
});

test("no identity and ONE rig on the box needs no guess", async () => {
  const oneRig = FLEET.filter((n) => n.rigName === "ours");
  const s = await buildLiveState({
    runRig: async (args) => {
      if (args[0] === "whoami") return { ok: false, reason: "rig-error" };
      if (args[0] === "queue") return { ok: true, value: [] };
      return { ok: true, value: oneRig };
    },
  });
  assert.equal(s.rig, "ours");
  assert.equal(s.reason, null);
  assert.equal(s.seats.length, 2);
});

// WORK THAT FINISHED stays findable: a row handed to a seat
// from outside and closed with an answer must still show, with its decision, result (the closing note) and artifact. Invented rows.
const SEATS = [{ logicalId: "lab.impl", rigName: "lab", lifecycleState: "running", canonicalSessionName: "lab-impl@lab" },
  { logicalId: "lab.qa", rigName: "lab", lifecycleState: "running", canonicalSessionName: "lab-qa@lab" }];
const DONE = [
  { qitemId: "qitem-20261023070000-aaaa", state: "done", summary: "Fix the README typo. Then report.", sourceSession: "assistant@lab", destinationSession: "lab-impl@lab",
    tsUpdated: "2026-10-23T07:00:00.000Z", closureReason: "no-follow-on", closureTarget: null, evidenceRef: "docs/README.md@1a2b3c4", resolution: null },
  { qitemId: "qitem-20261023065900-bbbb", state: "done", summary: "Answer a question", sourceSession: "lab-qa@lab", destinationSession: "lab-impl@lab",
    tsUpdated: "2026-10-23T06:59:00.000Z", closureReason: "handed_off_to", closureTarget: "qitem-20261023065901-cccc" },
  { qitemId: "qitem-20261023065800-dddd", state: "done", summary: "Another rig's work", sourceSession: "x@other", destinationSession: "y@other", tsUpdated: "2026-10-23T06:58:00.000Z" },
];
function labCLI({ done = DONE, notes = { "qitem-20261023070000-aaaa": "Fixed: 'recieve' -> 'receive' in README line 12." }, showFails = false } = {}) {
  const calls = [];
  const cli = async (args) => {
    calls.push(args.join(" "));
    if (args[0] === "whoami") return { ok: true, value: { identity: { rigName: "lab" } } };
    if (args[0] === "ps") return { ok: true, value: SEATS };
    if (args[0] === "queue" && args[1] === "list") return { ok: true, value: args.includes("done") ? done : [] };
    if (args[0] === "queue" && args[1] === "show") {
      if (showFails) return { ok: false, reason: "rig-error", detail: "rig queue timed out" };
      const id = args[2], row = done.find((q) => q.qitemId === id);
      return { ok: true, value: { ...row, closingTransition: notes[id] === undefined ? null : { transitionNote: notes[id] } } };
    }
    return { ok: true, value: [] };
  };
  return { cli, calls };
}

test("done work stays findable: this rig's done rows with decision, result (the closing note) and artifact; another rig's are not shown", async () => {
  const { cli } = labCLI(), s = await buildLiveState({ runRig: cli, resultCache: new Map() });
  assert.deepEqual(s.done.rows.map((r) => r.id), ["qitem-20261023070000-aaaa", "qitem-20261023065900-bbbb"]);
  const [a, b] = s.done.rows;
  assert.deepEqual(a.decision, { reason: "no-follow-on", target: null });
  assert.equal(a.result, "Fixed: 'recieve' -> 'receive' in README line 12."); assert.equal(a.resultRead, true);
  assert.equal(a.artifact, "docs/README.md@1a2b3c4"); assert.equal(a.title, "Fix the README typo."); assert.equal(a.closedAt, "2026-10-23T07:00:00.000Z");
  assert.equal(b.result, null, "no closing note: null, never invented"); assert.equal(b.resultRead, true); assert.equal(b.artifact, null);
  assert.deepEqual(b.decision, { reason: "handed_off_to", target: "qitem-20261023065901-cccc" });
  assert.deepEqual(s.done.coverage, { looked: 3, ours: 2, shown: 2, limit: 100 });
  assert.equal(s.queue.length, 0, "the open list is unchanged: done rows never join it");
});

test("the result is read once per row and read again when the row changes (keyed by tsUpdated); a failed read says so and is retried", async () => {
  const cache = new Map(), one = labCLI();
  await buildLiveState({ runRig: one.cli, resultCache: cache });
  await buildLiveState({ runRig: one.cli, resultCache: cache });
  assert.equal(one.calls.filter((c) => c.startsWith("queue show")).length, 2, "two rows, each shown once across two ticks");
  const changed = DONE.map((q) => (q.qitemId === "qitem-20261023070000-aaaa" ? { ...q, tsUpdated: "2026-10-23T07:30:00.000Z" } : q));
  const two = labCLI({ done: changed, notes: { "qitem-20261023070000-aaaa": "Reopened, then fixed again." } });
  const s = await buildLiveState({ runRig: two.cli, resultCache: cache });
  assert.deepEqual(two.calls.filter((c) => c.startsWith("queue show")), ["queue show qitem-20261023070000-aaaa --full --json"], "only the changed row is read again");
  assert.equal(s.done.rows[0].result, "Reopened, then fixed again.");
  assert.ok(cache.size <= 2, "the cache holds only rows on screen");
  const bad = labCLI({ showFails: true }), c2 = new Map(), f = await buildLiveState({ runRig: bad.cli, resultCache: c2 });
  assert.equal(f.done.rows[0].resultRead, false); assert.equal(f.done.rows[0].result, null); assert.equal(c2.size, 0, "a failed read isn't cached");
});

test("bounded: at most 10 done rows shown from the newest 100 looked at; a queue that can't be read says so", async () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ qitemId: `qitem-2026102307${String(i).padStart(4, "0")}-ee${i}`, state: "done", summary: `w${i}`,
    sourceSession: "lab-qa@lab", destinationSession: "lab-impl@lab", tsUpdated: new Date(Date.parse("2026-10-23T07:00:00Z") - i * 60000).toISOString() }));
  const { cli, calls } = labCLI({ done: many, notes: {} }), s = await buildLiveState({ runRig: cli, resultCache: new Map() });
  assert.equal(s.done.rows.length, 10); assert.equal(s.done.rows[0].summary, undefined); assert.equal(s.done.rows[0].title, "w0");
  assert.deepEqual(s.done.coverage, { looked: 30, ours: 30, shown: 10, limit: 100 });
  assert.ok(calls.includes("queue list -a --state done --full --json --limit 100"));
  const down = await buildLiveState({ resultCache: new Map(), runRig: async (args) => (args[0] === "ps" ? { ok: true, value: SEATS } : args[0] === "whoami" ? { ok: true, value: { identity: { rigName: "lab" } } }
    : args.includes("done") ? { ok: false, reason: "rig-error", detail: "rig queue timed out" } : { ok: true, value: [] }) });
  assert.deepEqual(down.done, { rows: [], coverage: { looked: 0, shown: 0, unreadable: "rig queue timed out" } });
});

// Review fixes on the first candidate. Each fails on it.
test("open work is this rig's and active only: another rig's pending item and a canceled one of ours never show", async () => {
  const OPEN = [
    { qitemId: "qitem-own-pending", state: "pending", summary: "ours", sourceSession: "lab-qa@lab", destinationSession: "lab-impl@lab", tsUpdated: "2026-10-23T07:10:00Z" },
    { qitemId: "qitem-foreign-pending", state: "pending", summary: "theirs", sourceSession: "x@other", destinationSession: "y@other", tsUpdated: "2026-10-23T07:09:00Z" },
    { qitemId: "qitem-own-canceled", state: "canceled", summary: "gone", sourceSession: "lab-qa@lab", destinationSession: "lab-impl@lab", tsUpdated: "2026-10-23T07:08:00Z" },
  ];
  const calls = [];
  const s = await buildLiveState({ resultCache: new Map(), runRig: async (a) => { calls.push(a.join(" "));
    if (a[0] === "ps") return { ok: true, value: SEATS }; if (a[0] === "whoami") return { ok: true, value: { identity: { rigName: "lab" } } };
    if (a[1] === "list") return { ok: true, value: a.includes("done") ? [] : OPEN }; return { ok: true, value: [] }; } });
  assert.deepEqual(s.queue.map((q) => q.id), ["qitem-own-pending"]);
  assert.ok(calls.includes("queue list -a --state pending,in-progress,blocked --full --json"), "open work is asked for by state");
});

test("a note is taken only from the same version of the row: a later close, a reopen, or an unrelated answer reads as unreadable and isn't cached", async () => {
  const row = DONE[0];
  for (const [why, shown] of [["closed again later", { ...row, tsUpdated: "2026-10-23T07:45:00.000Z", closingTransition: { transitionNote: "a LATER answer" } }],
    ["reopened", { ...row, state: "pending", tsUpdated: row.tsUpdated, closingTransition: { transitionNote: "old answer" } }],
    ["another row", { qitemId: "qitem-something-else", state: "done", tsUpdated: row.tsUpdated, closingTransition: { transitionNote: "x" } }],
    ["not an object", "garbage"]]) {
    const cache = new Map();
    const s = await buildLiveState({ resultCache: cache, runRig: async (a) => {
      if (a[0] === "ps") return { ok: true, value: SEATS }; if (a[0] === "whoami") return { ok: true, value: { identity: { rigName: "lab" } } };
      if (a[1] === "list") return { ok: true, value: a.includes("done") ? [row] : [] }; if (a[1] === "show") return { ok: true, value: shown }; return { ok: true, value: [] }; } });
    assert.equal(s.done.rows[0].resultRead, false, why); assert.equal(s.done.rows[0].result, null, why); assert.equal(cache.size, 0, `${why}: not cached`);
    assert.equal(s.done.rows[0].closedAt, row.tsUpdated, "the row's own decision and time are kept");
  }
});

test("a done-list answer that isn't a list is unreadable, not 'no finished work'", async () => {
  for (const value of [{}, { items: [] }, null, "x"]) {
    const s = await buildLiveState({ resultCache: new Map(), runRig: async (a) => {
      if (a[0] === "ps") return { ok: true, value: SEATS }; if (a[0] === "whoami") return { ok: true, value: { identity: { rigName: "lab" } } };
      if (a[1] === "list") return { ok: true, value: a.includes("done") ? value : [] }; return { ok: true, value: [] }; } });
    assert.deepEqual(s.done, { rows: [], coverage: { looked: 0, shown: 0, unreadable: "the queue's answer wasn't a list" } }, JSON.stringify(value));
  }
});
