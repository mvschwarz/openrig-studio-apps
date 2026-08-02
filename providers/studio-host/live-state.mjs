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
// Usage: node live-state.mjs --out <dir> [--interval <ms>] [--once]
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i > -1 && argv[i + 1] ? argv[i + 1] : d; };
const OUT = arg("--out", "");
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

// agentActivity can be an object ({state:"unknown"}) when the daemon-ingest
// link is down for a runtime. Report what it says rather than defaulting to
// "idle", which would invent a fact about a live seat.
const stateOf = (n) => {
  const a = n.agentActivity;
  const s = typeof a === "string" ? a : a?.state;
  if (s && s !== "unknown") return s;
  return n.lifecycleState === "running" ? "unknown" : (n.lifecycleState || "unknown");
};

// The three no-rig cases are genuinely different and an app can act on the
// difference: the CLI is absent (nothing to install against), the CLI is there
// and reports no rigs (stand one up), or the CLI errored (say so, do not claim
// emptiness). Collapsing them into one empty list is what made a dead tab look
// like a quiet one.
export async function buildLiveState(options = {}) {
  const runRig = options.runRig || run;
  const psResult = await runRig(["ps", "--nodes", "--json"]);
  if (!psResult.ok) {
    return { rig: null, attached: false, reason: psResult.reason, seats: [], queue: [],
      detail: psResult.detail };
  }
  const psRaw = psResult.value;
  const nodes = Array.isArray(psRaw) ? psRaw : psRaw.nodes || [];
  if (!nodes.length) {
    return { rig: null, attached: false, reason: "no-rig", seats: [], queue: [],
      detail: "this box has no rig running; one can be started here" };
  }

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

  const qResult = await runRig(["queue", "list", "-a", "--full", "--json"]);
  const qRaw = qResult.ok ? qResult.value : [];
  const queue = (Array.isArray(qRaw) ? qRaw : [])
    .filter((q) => q.state !== "done")
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

  return { rig: nodes[0]?.rigName || "rig", attached: true, reason: null, seats, queue };
}

// Safe by construction rather than by validation: the directory comes from the
// studio's own configuration, never from a request, and the filename is fixed
// here. There is no caller-supplied path to sanitise because none is accepted.
export async function writeLiveState(outDir) {
  if (!outDir) throw new Error("live-state: --out <dir> is required");
  const dir = path.resolve(outDir);
  const state = await buildLiveState();
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, "factory-state.json");
  const next = JSON.stringify(state, null, 2) + "\n";
  // Only write on change: an unchanged rewrite fires the runtime's file watcher
  // and makes the floor look busier than the rig is.
  try { if (fs.readFileSync(target, "utf8") === next) return state; } catch { /* first write */ }
  fs.writeFileSync(target, next);
  return state;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const tick = async () => {
    try {
      const s = await writeLiveState(OUT);
      if (!s.attached) console.log(`live-state: ${s.reason} — ${s.detail}`);
    } catch (e) {
      // Fail loudly and keep going: a state generator that dies silently
      // leaves the last-written state on screen looking current.
      console.error(`live-state: ${e.message}`);
    }
  };
  await tick();
  if (!ONCE) {
    console.log(`live-state: ${path.resolve(OUT)} refreshed every ${INTERVAL}ms`);
    setInterval(tick, INTERVAL);
  }
}
