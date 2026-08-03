// Live rig state must not die with whichever app happens to be installed.
//
// AUTHORSHIP NOTE, since this file changed hands: studio-qa wrote this to pin
// the repair in a63a82e, which put the live-state companion on FILES after
// retiring the AGENTS app had taken it away — Matti's landing page served an
// invented rig with four invented seats under a green live signal on a box
// running eleven real ones.
//
// The property below is THEIRS and is unchanged. Only its location moved: the
// companion now belongs to the provider that ships live-state.mjs, so the
// original assertion (it is in apps/files/app.json) had to be re-expressed
// rather than deleted. The property is strictly STRONGER at the new layer —
// before, it held because one particular app declared it; now it holds no
// matter which app pulls the provider in, so retiring FILES the way AGENTS was
// retired can no longer lose it. That was the known limit of a63a82e, stated
// plainly by both of us at the time: it PINNED the bug rather than removing it.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP = path.join(REPO, "apps", "files", "app.json");
const PROVIDER = path.join(REPO, "providers", "studio-host", "provider.json");

test("live rig state travels with the provider, not with whoever uses it", () => {
  const provider = JSON.parse(fs.readFileSync(PROVIDER, "utf8"));
  const companions = provider.run?.companions ?? [];
  const liveState = companions.find((c) => c.entry === "live-state.mjs");

  assert.equal(provider.package, "@openrig/studio-host",
    "positive control: the expected provider declaration was not loaded");
  assert.ok(liveState, "retiring any single consumer must not drop live rig state");
  assert.deepEqual(liveState.args, ["--out", "{{state}}", "--interval", "10000"]);
  assert.ok(
    fs.existsSync(path.join(REPO, "providers", "studio-host", liveState.entry)),
    "the declared live-state companion must ship with studio-host",
  );
});

test("no app declares how to run studio-host, so none can take it away", () => {
  // The other half, and the one that makes the first claim mean something. If an
  // app could still carry a run spec for this provider, we would be back to two
  // authorities and the capability would again depend on which app survived.
  const app = JSON.parse(fs.readFileSync(APP, "utf8"));

  assert.equal(app.id, "files", "positive control: the expected app manifest was not loaded");
  assert.equal(app.provider?.package, "@openrig/studio-host");
  assert.equal(app.provider?.run, undefined,
    "an app must reference its provider, never declare how to run it");
  assert.equal(app.verbs, undefined,
    "verbs was app-authored routing doing double duty; the provider answers, the app calls");
  assert.ok(app.calls, "an app declares what it CALLS");
});
