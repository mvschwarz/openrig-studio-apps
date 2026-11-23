// The Files provider's own controls, run as part of the suite: the symlink boundary proof, the structural containment check,
// and the harness that proves both checkers can fail. Copyright 2026 mvschwarz. Licensed under the Apache License, Version 2.0.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const [script, ok] of [
  ["test-boundary.mjs", /OK {3}boundary holds/],
  ["verify-containment.mjs", /OK {3}containment holds/],
  ["verify-controls.mjs", /OK {3}every checker demonstrated able to fail/],
]) {
  test(`${script} passes`, () => {
    const r = spawnSync(process.execPath, [path.join(HERE, script)], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, ok);
  });
}
