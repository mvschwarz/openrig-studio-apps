#!/usr/bin/env node
// REAL rig state for the shell's observe surface, as a long-running companion.
//
// The SDK is fixture-backed BY DESIGN: it ships a factory-state describing a
// rig called "fixture-rig" with invented seats and invented queue items, and
// FLOOR renders it under a LIVE ACTIVITY header with a green live-signal dot.
// That is correct as an SDK example and actively misleading on a real box —
// it looks exactly like a rig you have. On a deployed studio it rendered
// invented seats as live box truth.
//
// So this generates the same contract from the ACTUAL rig and the studio
// points the runtime's fixtures at it. Same shape, real data.
//
// WHAT CHANGED IN THE MIGRATION, and it is the part that matters: the earlier
// version returned null when there was no rig and let the SDK's own fixture
// stand. On the machine it was written for there was always a rig, so that
// read as "nothing to do". On a box with no rig it means the fiction stays on
// screen. A studio is not required to be attached to a rig — it IS required to
// know whether it is and say so. So no-rig is now an explicit, written state
// with a reason, not an absence.
//
// Usage: node live-state.mjs --out <dir> [--rig <name>] [--interval <ms>] [--once]
//
// --rig pins which rig the floor is about. Without it the rig is resolved the
// same way the SDK's seat roster resolves it — whoami's identity, then the box's
// only rig — because the floor and the sidebar sit on one screen and must not
// answer that question differently.
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i > -1 && argv[i + 1] ? argv[i + 1] : d; };
const OUT = arg("--out", "");
const RIG = arg("--rig", "");
const INTERVAL = Number(arg("--interval", "10000"));
const ONCE = argv.includes("--once");

const run = (args) =>
  new Promise((resolve) => {
    execFile("rig", args, { timeout: 6000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err?.code === "ENOENT") {
        return resolve({ ok: false, reason: "no-rig-cli", detail: "the rig executable was not found on this box" });
      }
      if (err) {
        const outcome = err.killed ? "timed out" : `failed with ${err.code || "an unknown error"}`;
        return resolve({ ok: false, reason: "rig-error", detail: `rig ${args[0]} ${outcome}` });
      }
      try {
        resolve({ ok: true, value: JSON.parse(stdout) });
      } catch {
        resolve({ ok: false, reason: "rig-error", detail: `rig ${args[0]} returned invalid JSON` });
      }
    });
  });

const minutesSince = (ts) => {
  const t = Date.parse(ts || "");
  return Number.isFinite(t) ? Math.max(0, Math.round((Date.now() - t) / 60000)) : null;
};

// LIVENESS is lifecycleState's to report; agentActivity only says what a LIVE
// seat is doing. The order matters and it used to be the other way round: a
// known-but-stale activity could out-vote a lifecycle that had already gone
// unhealthy, so a dead seat could still be rendered as working. Activity must
// never be able to claim a seat is alive.
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
// emptiness). Collapsing them into one empty list is what made a dead tab look
// like a quiet one.
export async function buildLiveState(options = {}) {
  const runRig = options.runRig || run;
  const psResult = await runRig(["ps", "--nodes", "-A", "--json"]);
  if (!psResult.ok) {
    return { rig: null, attached: false, reason: psResult.reason, seats: [], queue: [],
      detail: psResult.detail };
  }
  const psRaw = psResult.value;
  const all = Array.isArray(psRaw) ? psRaw : psRaw.nodes || [];
  if (!all.length) {
    return { rig: null, attached: false, reason: "no-rig", seats: [], queue: [],
      detail: "this box has no rig running; one can be started here" };
  }

  // SCOPE TO ONE RIG. This used to emit every node on the box: measured here,
  // 92 seats across 12 rigs, under a header reading LIVE ACTIVITY and a green
  // dot. A floor is what THIS studio is attached to, and a fleet-wide union is
  // not a bigger version of that — it is a different claim, made silently.
  //
  // Same precedence, and for the same reason, as the SDK's own seat roster
  // (tools/seat-roster.mjs): an explicit setting, then whoami's identity, then
  // the box's only rig. The two derivations sit either side of one screen — the
  // sidebar and the floor — so a floor that resolved its rig differently would
  // put two disagreeing answers in front of the same person.
  //
  // The earlier attempt at this problem captioned the union with every rig name
  // joined by "·". That names the ambiguity without resolving it: the caption
  // gets longer and the seat list stays wrong.
  const rigsOnBox = [...new Set(all.map((n) => n.rigName).filter(Boolean))];
  let rig = options.rig || null;
  let ambiguity = null;
  if (!rig) {
    const who = await runRig(["whoami", "--json"]);
    rig = (who.ok ? who.value?.identity?.rigName : null) || null;
  }
  if (!rig) {
    if (rigsOnBox.length === 1) rig = rigsOnBox[0];
    else if (rigsOnBox.length > 1) {
      // Cannot tell which rig is ours. Narrowing to a guess would be worse than
      // the union — it would look right. Say so, and let the surface caption it.
      ambiguity = `${rigsOnBox.length} rigs on this box and no identity to choose between them: ${rigsOnBox.join(", ")}`;
      rig = rigsOnBox.join(" · ");
    }
  }
  // A named rig that no node belongs to is a stale name, not an empty floor;
  // fall back to the union rather than showing zero seats under a live dot.
  const scoped = rig && rigsOnBox.includes(rig) ? all.filter((n) => n.rigName === rig) : all;
  const nodes = scoped.length ? scoped : all;

  const seats = nodes.map((n) => {
    const [pod, member] = String(n.logicalId || "").split(".");
    return {
      seat: n.canonicalSessionName || `${n.logicalId}@${n.rigName}`,
      pod: pod || "",
      member: member || "",
      state: stateOf(n),
      ageMinutes: minutesSince(n.lastActivity),
      hasWork: Boolean(n.hasAssignedWork),
      pendingWork: n.pendingWorkCount ?? 0,
      lifecycle: n.lifecycleState || "unknown",
    };
  });

  // OPEN WORK, ONE RIG'S. Like the seats above, the queue is this floor's: an item with one of its seats at either end. It was the
  // whole box's, which a floor that finds work by id can't stand behind ("this rig's open work" that isn't). And open means the
  // CLI's active states (pending, in-progress, blocked): asked for, not every state but "done", which counted canceled, failed and
  // handed-off items as queued.
  const ourSeats = new Set(seats.map((s) => s.seat));
  const qResult = await runRig(["queue", "list", "-a", "--state", ACTIVE.join(","), "--full", "--json"]);
  const qRaw = qResult.ok ? qResult.value : [];
  const queue = (Array.isArray(qRaw) ? qRaw : [])
    .filter((q) => q && ACTIVE.includes(q.state) && (ourSeats.has(q.destinationSession) || ourSeats.has(q.sourceSession)))
    .slice(0, 20)
    .map((q) => ({
      id: q.qitemId,
      state: q.state,
      destination: q.destinationSession,
      source: q.sourceSession,
      tags: q.tags || [],
      updated: q.tsUpdated,
      // The summary is the human-readable line; fall back to the id rather
      // than to a truncated body, which reads like a title and is not one.
      title: q.summary ? String(q.summary).split(/(?<=\.)\s/)[0].slice(0, 120) : q.qitemId,
    }));

  const done = await recentDone(runRig, ourSeats, options.resultCache || RESULTS);

  // `reason` carries the ambiguity when there was one, so a floor showing a
  // union says WHY rather than presenting it as this studio's rig. Attached is
  // still true — there are real seats on screen; what is uncertain is which of
  // them are ours.
  return { rig: rig || "rig", attached: true, reason: ambiguity ? "ambiguous-rig" : null,
    seats, queue, done, ...(ambiguity ? { detail: ambiguity } : {}) };
}

// WORK THAT FINISHED stays findable. Work handed to a seat from outside (a chat assistant through the MCP queue tools, say) is
// answered by closing its row: the decision in closureReason/closureTarget, the answer in the CLOSING TRANSITION's note, the
// artifact in evidenceRef. The open list above drops done rows, so without this a person could watch work arrive and never see
// how it ended. Only this rig's rows (a seat of the floor at either end), the newest DONE_SHOWN of the newest DONE_LOOKED done
// rows on the box, each said as such in `done.coverage`. The note isn't in `queue list`, only in `queue show --full` on a closed
// row, so it is read once per row and cached by id AND tsUpdated: a row that changes again (a reopen, a later close) is read again.
// The note is taken only from the SAME version of the row the list showed (same id, still done, same tsUpdated): a row that moved
// between the two reads would pair a later answer with an earlier decision, so that reads as "couldn't be read" and is tried again
// on the next tick, never cached. Nothing here is invented: a field the row doesn't carry is null, and an answer that isn't the
// expected shape is unreadable, never "none" or "not recorded".
const ACTIVE = ["pending", "in-progress", "blocked"];
const DONE_LOOKED = 100, DONE_SHOWN = 10;
const RESULTS = new Map();
async function recentDone(runRig, ourSeats, cache) {
  const r = await runRig(["queue", "list", "-a", "--state", "done", "--full", "--json", "--limit", String(DONE_LOOKED)]);
  const unreadable = (why) => ({ rows: [], coverage: { looked: 0, shown: 0, unreadable: why } });
  if (!r.ok) return unreadable(r.detail || "the queue couldn't be read");
  if (!Array.isArray(r.value)) return unreadable("the queue's answer wasn't a list");
  const all = r.value;
  const ours = all.filter((q) => q && q.state === "done" && typeof q.qitemId === "string" && (ourSeats.has(q.destinationSession) || ourSeats.has(q.sourceSession)));
  const rows = [];
  for (const q of ours.slice(0, DONE_SHOWN)) {
    const key = `${q.qitemId}@${q.tsUpdated}`;
    let note = cache.get(key);
    if (note === undefined) {
      const s = await runRig(["queue", "show", q.qitemId, "--full", "--json"]);
      const v = s.ok ? s.value : null;
      const same = !!v && typeof v === "object" && v.qitemId === q.qitemId && v.state === "done" && v.tsUpdated === q.tsUpdated;
      note = same ? { read: true, text: typeof v.closingTransition?.transitionNote === "string" ? v.closingTransition.transitionNote : null } : { read: false };
      if (note.read) { for (const k of cache.keys()) if (k.startsWith(`${q.qitemId}@`)) cache.delete(k); cache.set(key, note); }
    }
    rows.push({
      id: q.qitemId, state: q.state,
      title: q.summary ? String(q.summary).split(/(?<=\.)\s/)[0].slice(0, 120) : q.qitemId,
      source: q.sourceSession, destination: q.destinationSession, closedAt: q.tsUpdated,
      decision: { reason: q.closureReason ?? null, target: q.closureTarget ?? null },
      result: note.read ? note.text : null, resultRead: note.read,
      resolution: q.resolution ?? null, artifact: q.evidenceRef ?? null,
      handedOffTo: q.handedOffTo ?? null, handedOffFrom: q.handedOffFrom ?? null,
    });
  }
  // Keep the cache to the rows on screen, so it never grows past DONE_SHOWN.
  const keep = new Set(rows.filter((x) => x.resultRead).map((x) => `${x.id}@${x.closedAt}`));
  for (const k of cache.keys()) if (!keep.has(k)) cache.delete(k);
  return { rows, coverage: { looked: all.length, ours: ours.length, shown: rows.length, limit: DONE_LOOKED } };
}

// Safe by construction rather than by validation: the directory comes from the
// studio's own configuration, never from a request, and the filename is fixed
// here. There is no caller-supplied path to sanitise because none is accepted.
//
// NEWER WINS. A refresh is many rig calls (up to ten closing-note reads, each
// allowed six seconds), so two refreshes of one output can be in flight at
// once, and the older one can finish last. Each refresh is numbered when it
// STARTS, per output file; one that started before a refresh already written
// there is dropped, never written over it, or the floor would step back to an
// older answer after a newer one was on screen.
const STARTED = new Map(), WRITTEN = new Map();
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
  try { if (fs.readFileSync(target, "utf8") === next) return state; } catch { /* first write */ }
  fs.writeFileSync(target, next);
  return state;
}

// ONE REFRESH AT A TIME. The next refresh is scheduled when the current one
// has finished, never on a fixed clock: a clock starts a new refresh while a
// slow one is still reading, which is how an older answer could land last.
// `interval` 0 runs once. `schedule`/`cancel` are the timer, swappable in tests.
export function startLiveState(outDir, options = {}, { interval = INTERVAL, schedule = setTimeout, cancel = clearTimeout, log = console } = {}) {
  let stopped = false, timer = null;
  const tick = async () => {
    try {
      const s = await writeLiveState(outDir, options);
      if (!s.attached) log.log(`live-state: ${s.reason} — ${s.detail}`);
      else if (s.reason === "ambiguous-rig") log.log(`live-state: ${s.detail} — pass --rig <name> to scope the floor`);
    } catch (e) {
      // Fail loudly and keep going: a state generator that dies silently
      // leaves the last-written state on screen looking current.
      log.error(`live-state: ${e.message}`);
    }
    if (!stopped && interval > 0) timer = schedule(tick, interval);
  };
  const first = tick();
  return { first, stop() { stopped = true; if (timer !== null) cancel(timer); } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const run = startLiveState(OUT, RIG ? { rig: RIG } : {}, { interval: ONCE ? 0 : INTERVAL });
  await run.first;
  if (!ONCE) console.log(`live-state: ${path.resolve(OUT)} refreshed ${INTERVAL}ms after each refresh finishes`);
}
