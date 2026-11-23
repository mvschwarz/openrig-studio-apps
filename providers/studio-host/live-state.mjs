#!/usr/bin/env node
// Real rig state for the Studio's observe verb (/api/factory/state), as a long-running companion of this provider.
// Copyright 2026 mvschwarz. Licensed under the Apache License, Version 2.0.
//
// The SDK runtime answers /api/factory/state from a state folder. A provider that declares {{state}} (provider.json) points the
// runtime at the folder this writes, so FLOOR, Workspace and anything else reading that verb show the actual rig on this
// machine: its seats and its open queue. A Studio need not be attached to a rig, but it must say whether it is, so "no rig"
// is written as its own state with a reason, never left blank for the page to guess at.
//
// Run by live-state-run.mjs: node live-state-run.mjs --out <dir> [--rig <name>] [--interval <ms>] [--once]. A deployment that adds
// its own fields replaces that runner with one that passes options.extend (below); this module stays as it is.
//
// --rig pins which rig the floor is about. Without it the rig is resolved the same way the SDK's seat roster resolves it
// (whoami's identity, then the machine's only rig), because the floor and the sidebar sit on one screen and must not answer
// that question differently.
import fs from "node:fs";
import path from "node:path";
import { rigJson } from "../lib/local-daemon.mjs";

const DEFAULT_INTERVAL = 10000;

const minutesSince = (ts) => {
  const t = Date.parse(ts || "");
  return Number.isFinite(t) ? Math.max(0, Math.round((Date.now() - t) / 60000)) : null;
};

// LIVENESS is lifecycleState's to report; agentActivity only says what a LIVE
// seat is doing. The order matters: a known-but-stale activity must never
// out-vote a lifecycle that has gone unhealthy, so a dead seat is never shown
// as working.
//
// agentActivity can also be an object ({state:"unknown"}) when the daemon
// ingest link is down for a runtime. Report unknown rather than defaulting to
// "idle", which would invent a fact about a live seat.
const stateOf = (n) => {
  const life = n.lifecycleState || "unknown";
  if (life !== "running") return life;
  const a = n.agentActivity;
  const s = typeof a === "string" ? a : a?.state;
  return s && s !== "unknown" ? s : "unknown";
};

// The three no-rig cases are genuinely different and an app can act on the
// difference: the CLI is absent (nothing to install against), the CLI is there
// and reports no rigs (stand one up), or the CLI errored (say so, do not claim
// emptiness). Collapsing them into one empty list would make a dead tab look
// like a quiet one.
export async function buildLiveState(options = {}) {
  const runRig = options.runRig || ((args) => rigJson(args));
  const psResult = await runRig(["ps", "--nodes", "-A", "--json"]);
  if (!psResult.ok) {
    return {
      rig: null,
      attached: false,
      reason: psResult.reason,
      seats: [],
      queue: [],
      detail: psResult.detail,
    };
  }
  const psRaw = psResult.value;
  const all = Array.isArray(psRaw) ? psRaw : psRaw.nodes || [];
  if (!all.length) {
    return {
      rig: null,
      attached: false,
      reason: "no-rig",
      seats: [],
      queue: [],
      detail: "this machine has no rig running; one can be started here",
    };
  }

  // SCOPE TO ONE RIG. A floor is what THIS Studio is attached to; a union of every
  // rig on the machine is a different claim. Same precedence, and for the same
  // reason, as the SDK's own seat roster (tools/seat-roster.mjs): an explicit
  // setting, then whoami's identity, then the machine's only rig.
  const rigsHere = [...new Set(all.map((n) => n.rigName).filter(Boolean))];
  let rig = options.rig || null;
  let ambiguity = null;
  if (!rig) {
    const who = await runRig(["whoami", "--json"]);
    rig = (who.ok ? who.value?.identity?.rigName : null) || null;
  }
  if (!rig) {
    if (rigsHere.length === 1) rig = rigsHere[0];
    else if (rigsHere.length > 1) {
      // Cannot tell which rig is ours. Narrowing to a guess would be worse than
      // the union — it would look right. Say so, and let the surface caption it.
      ambiguity = `${rigsHere.length} rigs on this machine and no identity to choose between them: ${rigsHere.join(", ")}`;
      rig = rigsHere.join(" · ");
    }
  }
  // A named rig that no node belongs to is a stale name, not an empty floor;
  // fall back to the union rather than showing zero seats under a live dot.
  const scoped = rig && rigsHere.includes(rig) ? all.filter((n) => n.rigName === rig) : all;
  const nodes = scoped.length ? scoped : all;

  const seats = nodes.map((n) => {
    const [pod, member] = String(n.logicalId || "").split(".");
    return {
      // A seat that has never run has no session name; it is keyed by the queue's own address for it (pod-member@rig).
      seat:
        n.canonicalSessionName ||
        (pod && member ? `${pod}-${member}@${n.rigName}` : `${n.logicalId}@${n.rigName}`),
      pod: pod || "",
      member: member || "",
      state: stateOf(n),
      ageMinutes: minutesSince(n.lastActivity),
      hasWork: Boolean(n.hasAssignedWork),
      pendingWork: n.pendingWorkCount ?? 0,
      lifecycle: n.lifecycleState || "unknown",
    };
  });

  // OPEN WORK, THIS RIG'S: an item with one of its seats at either end, in the CLI's
  // active states (pending, in-progress, blocked).
  const ourSeats = new Set(seats.map((s) => s.seat));
  const qResult = await runRig([
    "queue",
    "list",
    "-a",
    "--state",
    ACTIVE.join(","),
    "--full",
    "--json",
  ]);
  const qRaw = qResult.ok ? qResult.value : [];
  const queue = (Array.isArray(qRaw) ? qRaw : [])
    .filter(
      (q) =>
        q &&
        ACTIVE.includes(q.state) &&
        !housekeeping(q) &&
        (ourSeats.has(q.destinationSession) || ourSeats.has(q.sourceSession)),
    )
    .slice(0, 20)
    .map(projectOpen);

  // `reason` carries the ambiguity when there was one, so a floor showing a
  // union says WHY rather than presenting it as this studio's rig. Attached is
  // still true — there are real seats on screen; what is uncertain is which of
  // them are ours.
  const state = {
    rig: rig || "rig",
    attached: true,
    reason: ambiguity ? "ambiguous-rig" : null,
    seats,
    queue,
    ...(ambiguity ? { detail: ambiguity } : {}),
  };
  return options.extend
    ? extended(state, options, {
        nodes,
        queueRaw: Array.isArray(qRaw) ? qRaw : [],
        ourSeats,
        runRig,
      })
    : state;
}

// A DEPLOYMENT'S OWN FIELDS. options.extend({ state, nodes, queueRaw, ourSeats, runRig }) may return fields to add to an attached
// floor's state (a deployment's own marks on seats, its own lists): it gets the state built above and the raw inputs it came from,
// and the same runRig, so any further read goes to the same daemon. What it returns is merged over the state, but the public fields
// stay what they are: rig, attached, reason and detail can't change, and seats and queue can be replaced only by arrays. A hook that
// throws, or doesn't finish within options.extendTimeoutMs (EXTEND_MS by default), is logged and the state is written with the fields
// it last returned (none before its first success), so the floor never waits on it. Each refresh waits for the one before, so one hook that never settled used to stop every
// refresh after it. A hook that finishes late is ignored: its refresh was already written.
const FIXED = ["rig", "attached", "reason", "detail"];
const LISTS = ["seats", "queue"];
const EXTEND_MS = 30_000;
// The last fields each hook returned. When a later run throws or times out, those are applied instead of none, so the deployment's
// own marks (a customer seat, its introductions) don't fall back to the public reading for a refresh (they may be a refresh old).
const LAST_GOOD = new WeakMap();
const merge = (state, extra) => {
  const out = { ...state };
  for (const [k, v] of Object.entries(extra)) {
    if (FIXED.includes(k)) continue;
    if (LISTS.includes(k) && !Array.isArray(v)) continue;
    out[k] = v;
  }
  return out;
};
async function extended(state, options, inputs) {
  const ms =
    Number.isFinite(options.extendTimeoutMs) && options.extendTimeoutMs > 0
      ? options.extendTimeoutMs
      : EXTEND_MS;
  let extra, timer;
  try {
    extra = await Promise.race([
      Promise.resolve().then(() => options.extend({ state: structuredClone(state), ...inputs })),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`it didn't finish in ${ms / 1000} s`)), ms);
      }),
    ]);
  } catch (e) {
    const last = LAST_GOOD.get(options.extend);
    (options.log || console).error(
      `live-state: extend failed — ${e?.message || e}${last ? "; its last fields are kept" : ""}`,
    );
    return last ? merge(state, last) : state;
  } finally {
    clearTimeout(timer);
  }
  if (!extra || typeof extra !== "object" || Array.isArray(extra)) return state;
  LAST_GOOD.set(options.extend, extra);
  return merge(state, extra);
}

const ACTIVE = ["pending", "in-progress", "blocked"];
// OpenRig's own housekeeping: when an owner can't be woken, the queue's stuck sweep writes a row about it (tagged
// stuck-sweep-finding), a wake that doesn't land escalates (wake-escalation), and a row recovering another is tagged
// recovery-for:<id>. That's OpenRig talking to itself, not work anyone asked for, so the floor's work leaves it out, open or
// finished. Exported so a deployment's own fields (finished work) use the same rule.
export const housekeeping = (q) =>
  Array.isArray(q?.tags) &&
  q.tags.some(
    (t) =>
      t === "stuck-sweep-finding" ||
      t === "wake-escalation" ||
      (typeof t === "string" && t.startsWith("recovery-for:")),
  );
const projectOpen = (q) => ({
  id: q.qitemId,
  state: q.state,
  destination: q.destinationSession,
  source: q.sourceSession,
  tags: q.tags || [],
  updated: q.tsUpdated,
  title: q.summary
    ? String(q.summary)
        .split(/(?<=\.)\s/)[0]
        .slice(0, 120)
    : q.qitemId,
});

// Safe by construction rather than by validation: the directory comes from the
// studio's own configuration, never from a request, and the filename is fixed
// here. There is no caller-supplied path to sanitise because none is accepted.
//
// NEWER WINS. A refresh is several rig calls, each allowed six seconds, so two refreshes of one output can be in flight at
// once, and the older one can finish last. Each refresh is numbered when it
// STARTS, per output file; one that started before a refresh already written
// there is dropped, never written over it, or the floor would step back to an
// older answer after a newer one was on screen.
const STARTED = new Map(),
  WRITTEN = new Map();
export async function writeLiveState(outDir, options = {}) {
  if (!outDir) throw new Error("live-state: --out <dir> is required");
  const dir = path.resolve(outDir);
  const target = path.join(dir, "factory-state.json");
  const gen = (STARTED.get(target) || 0) + 1;
  STARTED.set(target, gen);
  const state = await buildLiveState(options);
  if ((WRITTEN.get(target) || 0) > gen) return state;
  WRITTEN.set(target, gen);
  fs.mkdirSync(dir, { recursive: true });
  const next = JSON.stringify(state, null, 2) + "\n";
  // Only write on change: an unchanged rewrite fires the runtime's file watcher
  // and makes the floor look busier than the rig is.
  try {
    if (fs.readFileSync(target, "utf8") === next) return state;
  } catch {
    /* first write */
  }
  fs.writeFileSync(target, next);
  return state;
}

// ONE REFRESH AT A TIME. The next refresh is scheduled when the current one
// has finished, never on a fixed clock: a clock starts a new refresh while a
// slow one is still reading, which is how an older answer could land last.
// `interval` 0 runs once. `schedule`/`cancel` are the timer, swappable in tests.
export function startLiveState(
  outDir,
  options = {},
  { interval = DEFAULT_INTERVAL, schedule = setTimeout, cancel = clearTimeout, log = console } = {},
) {
  let stopped = false,
    timer = null;
  const tick = async () => {
    try {
      const s = await writeLiveState(outDir, options);
      if (!s.attached) log.log(`live-state: ${s.reason} — ${s.detail}`);
      else if (s.reason === "ambiguous-rig")
        log.log(`live-state: ${s.detail} — pass --rig <name> to scope the floor`);
    } catch (e) {
      // Fail loudly and keep going: a state generator that dies silently
      // leaves the last-written state on screen looking current.
      log.error(`live-state: ${e.message}`);
    }
    if (!stopped && interval > 0) timer = schedule(tick, interval);
  };
  const first = tick();
  return {
    first,
    stop() {
      stopped = true;
      if (timer !== null) cancel(timer);
    },
  };
}
