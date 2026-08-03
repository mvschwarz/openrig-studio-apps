import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = path.join(REPO, "apps", "files", "app.json");

test("FILES keeps real rig state attached to the shared studio-host provider", () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  const companions = manifest.provider?.run?.companions ?? [];
  const liveState = companions.find((companion) => companion.entry === "live-state.mjs");

  assert.equal(manifest.id, "files", "positive control: the expected app manifest was not loaded");
  assert.equal(manifest.provider?.package, "@openrig/studio-host");
  assert.ok(liveState, "removing another studio-host consumer must not drop live rig state");
  assert.deepEqual(liveState.args, ["--out", "{{state}}", "--interval", "10000"]);
  assert.ok(
    fs.existsSync(path.join(REPO, "providers", "studio-host", liveState.entry)),
    "the declared live-state companion must ship with studio-host",
  );
});
