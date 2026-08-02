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
