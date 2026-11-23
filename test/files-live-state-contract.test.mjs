// Live rig state must not die with whichever app happens to be installed: the companion that writes it belongs to the provider
// that ships it (studio-host's provider.json), and no app declares how to run that provider.
// Copyright 2026 mvschwarz. Licensed under the Apache License, Version 2.0.
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
  const liveState = companions.find((c) => c.entry === "live-state-run.mjs");

  assert.equal(
    provider.package,
    "@openrig/studio-host",
    "positive control: the expected provider declaration was not loaded",
  );
  assert.ok(liveState, "retiring any single consumer must not drop live rig state");
  assert.deepEqual(liveState.args, ["--out", "{{state}}", "--interval", "10000"]);
  assert.ok(
    fs.existsSync(path.join(REPO, "providers", "studio-host", liveState.entry)),
    "the declared live-state companion must ship with studio-host",
  );
});

test("no app declares how to run studio-host, so none can take it away", () => {
  // The other half, and the one that makes the first claim mean something. If an
  // app could carry a run spec for this provider, there would be two authorities
  // and the capability would depend on which app is installed.
  const app = JSON.parse(fs.readFileSync(APP, "utf8"));

  assert.equal(app.id, "files", "positive control: the expected app manifest was not loaded");
  assert.equal(app.provider?.package, "@openrig/studio-host");
  assert.equal(
    app.provider?.run,
    undefined,
    "an app must reference its provider, never declare how to run it",
  );
  assert.equal(app.verbs, undefined, "the provider answers verbs; the app declares what it calls");
  assert.ok(app.calls, "an app declares what it CALLS");
});
