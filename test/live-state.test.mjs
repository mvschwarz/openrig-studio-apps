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
