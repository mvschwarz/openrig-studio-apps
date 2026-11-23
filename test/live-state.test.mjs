// The live rig state companion: what it writes for the Studio's observe verb, from stand-in rig answers (nothing here runs the real
// rig command). Copyright 2026 mvschwarz. Licensed under the Apache License, Version 2.0.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildLiveState,
  writeLiveState,
  startLiveState,
} from "../providers/studio-host/live-state.mjs";
import { rigJson } from "../providers/lib/local-daemon.mjs";

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

// THE FLOOR IS ONE RIG'S FLOOR, resolved the same way the SDK's seat roster
// resolves it, so the sidebar and the floor never disagree on one screen.
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

test("the floor is scoped to ONE rig, not to every rig on the machine", async () => {
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

test("no identity and ONE rig on the machine needs no guess", async () => {
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

const SEATS = [
  {
    logicalId: "lab.writer",
    rigName: "lab",
    lifecycleState: "running",
    canonicalSessionName: "lab-writer@lab",
  },
  {
    logicalId: "lab.checker",
    rigName: "lab",
    lifecycleState: "running",
    canonicalSessionName: "lab-checker@lab",
  },
];

test("open work is this rig's and active only: another rig's pending item and a canceled one of ours never show", async () => {
  const OPEN = [
    {
      qitemId: "q-own-pending",
      state: "pending",
      summary: "ours",
      sourceSession: "lab-checker@lab",
      destinationSession: "lab-writer@lab",
      tsUpdated: "2026-10-23T07:10:00Z",
    },
    {
      qitemId: "q-foreign-pending",
      state: "pending",
      summary: "theirs",
      sourceSession: "x@other",
      destinationSession: "y@other",
      tsUpdated: "2026-10-23T07:09:00Z",
    },
    {
      qitemId: "q-own-canceled",
      state: "canceled",
      summary: "gone",
      sourceSession: "lab-checker@lab",
      destinationSession: "lab-writer@lab",
      tsUpdated: "2026-10-23T07:08:00Z",
    },
  ];
  const calls = [];
  const s = await buildLiveState({
    runRig: async (a) => {
      calls.push(a.join(" "));
      if (a[0] === "ps") return { ok: true, value: SEATS };
      if (a[0] === "whoami") return { ok: true, value: { identity: { rigName: "lab" } } };
      if (a[1] === "list") return { ok: true, value: OPEN };
      return { ok: true, value: [] };
    },
  });
  assert.deepEqual(
    s.queue.map((q) => q.id),
    ["q-own-pending"],
  );
  assert.ok(
    calls.includes("queue list -a --state pending,in-progress,blocked --full --json"),
    "open work is asked for by state",
  );
});

test("the answer is exactly the observe envelope's fields: rig, attachment, seats and open queue, nothing else", async () => {
  const s = await buildLiveState({
    runRig: async (a) =>
      a[0] === "ps"
        ? { ok: true, value: SEATS }
        : a[0] === "whoami"
          ? { ok: true, value: { identity: { rigName: "lab" } } }
          : { ok: true, value: [] },
  });
  assert.deepEqual(Object.keys(s).sort(), ["attached", "queue", "reason", "rig", "seats"]);
  assert.deepEqual(Object.keys(s.seats[0]).sort(), [
    "ageMinutes",
    "hasWork",
    "lifecycle",
    "member",
    "pendingWork",
    "pod",
    "seat",
    "state",
  ]);
});

// A refresh numbered when it starts: one that started earlier and finishes later is dropped, never written over a newer answer.
const openRow = (summary, ts) => ({
  qitemId: `q-${ts}`,
  state: "pending",
  summary,
  sourceSession: "lab-checker@lab",
  destinationSession: "lab-writer@lab",
  tsUpdated: ts,
});
const labCLI = (queue, hold) => async (a) => {
  if (a[0] === "ps") return { ok: true, value: SEATS };
  if (a[0] === "whoami") return { ok: true, value: { identity: { rigName: "lab" } } };
  if (a[0] === "queue") {
    if (hold) await hold();
    return { ok: true, value: queue };
  }
  return { ok: true, value: [] };
};
test("an older refresh that finishes last never writes over a newer one already written", async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "live-state-race-"));
  let entered, release;
  const inQueue = new Promise((r) => (entered = r)),
    held = new Promise((r) => (release = r));
  try {
    const older = writeLiveState(out, {
      runRig: labCLI([openRow("older", "2026-10-24T22:00:00.000Z")], async () => {
        entered();
        await held;
      }),
    });
    await inQueue;
    await writeLiveState(out, { runRig: labCLI([openRow("newer", "2026-10-24T22:02:00.000Z")]) });
    release();
    await older;
    const shown = JSON.parse(fs.readFileSync(path.join(out, "factory-state.json"), "utf8"))
      .queue[0];
    assert.equal(shown.title, "newer");
  } finally {
    release();
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test("the companion's scheduler runs one refresh at a time: the next is scheduled only after the current one finishes", async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "live-state-tick-"));
  const timers = [];
  let builds = 0,
    release;
  const held = new Promise((r) => (release = r));
  const log = { log() {}, error() {} };
  try {
    const run = startLiveState(
      out,
      {
        runRig: async (a) => {
          if (a[0] === "ps") {
            builds++;
            if (builds === 1) await held;
          }
          return labCLI([])(a);
        },
      },
      {
        interval: 10000,
        schedule: (fn, ms) => {
          timers.push({ fn, ms });
          return timers.length;
        },
        cancel() {},
        log,
      },
    );
    await new Promise((r) => setImmediate(r));
    assert.equal(timers.length, 0, "nothing is scheduled while the first refresh is still reading");
    assert.equal(builds, 1);
    release();
    await run.first;
    assert.deepEqual(
      timers.map((t) => t.ms),
      [10000],
      "the next refresh is scheduled once, after the first finished",
    );
    await timers[0].fn();
    assert.equal(builds, 2);
    assert.equal(timers.length, 2);
    run.stop();
    await timers[1].fn();
    assert.equal(timers.length, 2, "stopped: nothing more is scheduled");
    const once = startLiveState(
      out,
      { runRig: labCLI([]) },
      { interval: 0, schedule: () => assert.fail("interval 0 runs once"), log },
    );
    await once.first;
  } finally {
    release();
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test("only a changed answer is written: an unchanged one leaves the file (and the runtime's watcher) alone", async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "live-state-same-"));
  try {
    const f = path.join(out, "factory-state.json");
    await writeLiveState(out, { runRig: labCLI([]) });
    const first = fs.statSync(f).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));
    await writeLiveState(out, { runRig: labCLI([]) });
    assert.equal(fs.statSync(f).mtimeMs, first);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

// A seat that has never run has no session name. It is keyed by the queue's own address for it (pod-member@rig), so a row to or
// from it is this floor's.
test("a never-run seat is keyed in the queue's address form, so its open rows are this floor's", async () => {
  const nodes = [
    {
      logicalId: "team.lead",
      rigName: "acme-team",
      lifecycleState: "detached",
      canonicalSessionName: null,
    },
    {
      logicalId: "ops.caller",
      rigName: "acme-team",
      lifecycleState: "detached",
      canonicalSessionName: null,
    },
    { logicalId: "solo", rigName: "acme-team", lifecycleState: "detached" },
  ];
  const row = {
    qitemId: "q-open",
    state: "in-progress",
    summary: "Weekly summary",
    sourceSession: "ops-caller@acme-team",
    destinationSession: "team-lead@acme-team",
    tsUpdated: "2026-10-26T10:00:00.000Z",
  };
  const cli = async (args) =>
    args[0] === "whoami"
      ? { ok: false }
      : args[0] === "queue"
        ? { ok: true, value: [row] }
        : { ok: true, value: nodes };
  const s = await buildLiveState({ runRig: cli });
  assert.deepEqual(
    s.seats.map((x) => x.seat),
    ["team-lead@acme-team", "ops-caller@acme-team", "solo@acme-team"],
    "pod-member@rig; a logicalId with no pod stays as it is",
  );
  assert.deepEqual(
    s.queue.map((q) => q.id),
    ["q-open"],
  );
  const named = await buildLiveState({
    runRig: async (a) =>
      a[0] === "queue"
        ? { ok: true, value: [] }
        : a[0] === "whoami"
          ? { ok: false }
          : {
              ok: true,
              value: [
                {
                  logicalId: "team.lead",
                  rigName: "acme-team",
                  canonicalSessionName: "lead@acme-team",
                },
              ],
            },
  });
  assert.equal(named.seats[0].seat, "lead@acme-team", "a seat that HAS a session name keeps it");
});

test("the rig command helper: not installed, failed, timed out and non-JSON are each said as such; JSON comes back parsed", async () => {
  const fake =
    (err, stdout = "") =>
    (bin, args, opts, cb) => {
      assert.equal(bin, "rig");
      assert.ok(opts.timeout > 0 && opts.maxBuffer > 0);
      cb(err, stdout);
    };
  assert.deepEqual(
    await rigJson(["ps"], { run: fake(Object.assign(new Error("x"), { code: "ENOENT" })) }),
    { ok: false, reason: "no-rig-cli", detail: "the rig command isn't installed on this machine" },
  );
  assert.deepEqual(
    await rigJson(["ps"], { run: fake(Object.assign(new Error("x"), { code: 2 })) }),
    { ok: false, reason: "rig-error", detail: "rig ps failed with 2" },
  );
  assert.deepEqual(
    await rigJson(["ps"], { run: fake(Object.assign(new Error("x"), { killed: true })) }),
    { ok: false, reason: "rig-error", detail: "rig ps timed out" },
  );
  assert.deepEqual(await rigJson(["ps"], { run: fake(null, "not json") }), {
    ok: false,
    reason: "rig-error",
    detail: "rig ps returned invalid JSON",
  });
  assert.deepEqual(await rigJson(["ps"], { run: fake(null, '[{"a":1}]') }), {
    ok: true,
    value: [{ a: 1 }],
  });
});

// A DEPLOYMENT'S OWN FIELDS, through options.extend: the fields a hosted deployment adds (a mark on its customer's seat, the
// introductions taken out of the open queue, the recently done rows it reads with the same runRig) arrive in the state, and the
// public fields stay what they are.
test("extend adds a deployment's own fields from the same inputs, and can't change the public ones", async () => {
  const NODES = [
    { logicalId: "web.writer", rigName: "ours", lifecycleState: "running" },
    { logicalId: "docs.reader", rigName: "ours", lifecycleState: "running" },
  ];
  const rows = [
    {
      qitemId: "q1",
      state: "pending",
      destinationSession: "web-writer@ours",
      sourceSession: "x@ours",
      tags: [],
    },
    {
      qitemId: "q2",
      state: "pending",
      destinationSession: "web-writer@ours",
      sourceSession: "caller@ours",
      tags: ["introduction"],
    },
  ];
  const calls = [];
  const runRig = async (args) => {
    calls.push(args.join(" "));
    if (args[0] === "whoami") return { ok: true, value: { identity: { rigName: "ours" } } };
    if (args[0] === "queue" && args.includes("done"))
      return {
        ok: true,
        value: [{ qitemId: "d1", state: "done", destinationSession: "docs-reader@ours" }],
      };
    if (args[0] === "queue") return { ok: true, value: rows };
    return { ok: true, value: NODES };
  };
  const s = await buildLiveState({
    runRig,
    extend: async ({ state, queueRaw, ourSeats, runRig: rr }) => {
      assert.ok(ourSeats.has("web-writer@ours"));
      const intro = (q) => q.tags.includes("introduction");
      const done = await rr(["queue", "list", "-a", "--state", "done", "--json"]);
      return {
        seats: state.seats.map((x) =>
          x.seat === "docs-reader@ours" ? { ...x, customer: true } : x,
        ),
        queue: state.queue.filter((q) => !intro(rows.find((r) => r.qitemId === q.id))),
        introductions: queueRaw.filter(intro).map((q) => ({ id: q.qitemId })),
        done: { rows: done.value.map((q) => ({ id: q.qitemId })) },
        rig: "someone-else",
        attached: false,
      };
    },
  });
  assert.equal(s.rig, "ours", "a public field can't be changed");
  assert.equal(s.attached, true);
  assert.equal(s.seats.find((x) => x.seat === "docs-reader@ours").customer, true);
  assert.deepEqual(
    s.queue.map((q) => q.id),
    ["q1"],
  );
  assert.deepEqual(s.introductions, [{ id: "q2" }]);
  assert.deepEqual(s.done, { rows: [{ id: "d1" }] });
  assert.ok(
    calls.some((c) => c.includes("--state done")),
    "the hook's own read used the same runRig",
  );

  // A hook that hands back a non-list for seats or queue, or throws, leaves the public state as built.
  const bent = await buildLiveState({
    runRig,
    extend: () => ({ seats: "none", queue: null, note: 1 }),
  });
  assert.equal(bent.seats.length, 2);
  assert.equal(bent.queue.length, 2);
  assert.equal(bent.note, 1);
  const errors = [];
  const broke = await buildLiveState({
    runRig,
    log: { error: (m) => errors.push(m) },
    extend: () => {
      throw new Error("its source is down");
    },
  });
  assert.equal(broke.attached, true);
  assert.equal(broke.queue.length, 2);
  assert.match(errors[0], /extend failed — its source is down/);
});

// A hook that never settles (its own read hangs). The companion waits for each refresh before scheduling the next,
// so before the bound the floor stopped at its first write, with nothing logged.
test(
  "an extend hook that doesn't finish in time is logged and skipped, and the floor keeps refreshing",
  { timeout: 10000 },
  async () => {
    let n = 0;
    const runRig = async (args) => {
      if (args[0] === "ps")
        return {
          ok: true,
          value: [
            {
              rigName: "r",
              logicalId: "dev.impl",
              canonicalSessionName: "app-build@r",
              lifecycleState: "running",
            },
          ],
        };
      if (args[0] === "queue")
        return {
          ok: true,
          value: [
            {
              qitemId: `q${++n}`,
              state: "pending",
              destinationSession: "app-build@r",
              sourceSession: "x@r",
              summary: `work ${n}`,
            },
          ],
        };
      return { ok: false, reason: "x", detail: "x" };
    };
    const errors = [];
    const s = await buildLiveState({
      runRig,
      rig: "r",
      extendTimeoutMs: 100,
      log: { error: (m) => errors.push(m) },
      extend: () => new Promise(() => {}),
    });
    assert.equal(s.attached, true);
    assert.equal(s.queue.length, 1);
    assert.match(errors[0], /extend failed — it didn't finish in 0.1 s/);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-hang-"));
    let calls = 0;
    const live = startLiveState(
      dir,
      {
        runRig,
        rig: "r",
        extendTimeoutMs: 100,
        log: { error() {} },
        extend: () => (++calls === 1 ? { first: true } : new Promise(() => {})),
      },
      { interval: 20, log: { log() {}, error() {} } },
    );
    await live.first;
    const read = () => JSON.parse(fs.readFileSync(path.join(dir, "factory-state.json"), "utf8"));
    const first = read().queue[0].id;
    await new Promise((r) => setTimeout(r, 900));
    live.stop();
    assert.ok(calls >= 3, `the hook was asked again on later refreshes (${calls})`);
    assert.notEqual(
      read().queue[0].id,
      first,
      "the floor kept refreshing past the hook that never finished",
    );
    // The deployment's own fields from its last good run are kept, not dropped for the public reading.
    assert.equal(read().first, true, "the hook's last fields are kept while it doesn't answer");
    fs.rmSync(dir, { recursive: true, force: true });
  },
);

test("OpenRig's own stuck-sweep rows aren't the floor's work; a row that only mentions one is", async () => {
  const nodes = [
    {
      logicalId: "app.build",
      rigName: "lab",
      lifecycleState: "running",
      agentActivity: "idle",
      canonicalSessionName: "app-build@lab",
    },
  ];
  const sweep = {
    qitemId: "recovery-1",
    state: "pending",
    sourceSession: "app-check@lab",
    destinationSession: "app-build@lab",
    summary: "Checked on another item: its owner couldn't be woken (3 minutes)",
    tags: ["stuck-sweep-finding", "recovery-for:item-7"],
  };
  const work = {
    qitemId: "item-8",
    state: "pending",
    sourceSession: "app-check@lab",
    destinationSession: "app-build@lab",
    summary: "Look at the stuck-sweep-finding tag's docs",
    tags: ["docs"],
  };
  // Its other notices too: a wake that escalated, and a row recovering another.
  const escalation = { ...sweep, qitemId: "esc-1", tags: ["wake-escalation"] };
  const recovery = { ...sweep, qitemId: "rec-1", tags: ["recovery-for:item-9"] };
  const s = await buildLiveState({
    rig: "lab",
    runRig: async (a) =>
      a[0] === "queue"
        ? { ok: true, value: [sweep, escalation, recovery, work] }
        : { ok: true, value: nodes },
  });
  assert.deepEqual(
    s.queue.map((q) => q.id),
    ["item-8"],
  );
});
