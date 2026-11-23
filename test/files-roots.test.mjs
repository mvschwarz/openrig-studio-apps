// Files: the folders an owner adds from the page. A folder where well-known tools keep keys or credentials, or one that
// contains such a folder, is refused in plain words; an ordinary folder in the home is added. A courtesy against exposing
// keys by accident, not a security gate. Copyright 2026 mvschwarz. Licensed under the Apache License, Version 2.0.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { rootAddable, CREDENTIAL_DIRS } from "../providers/studio-host/host-backend.mjs";

test("rootAddable refuses credential folders, what's inside them and what holds them; an ordinary folder is added", (t) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "files-roots-")));
  const before = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    process.env.HOME = before;
    fs.rmSync(home, { recursive: true, force: true });
  });
  assert.equal(os.homedir(), home, "positive control: the check reads this test's home");
  for (const rel of [".ssh", ".aws", ".gnupg", ".config/gcloud", ".kube", ".docker"])
    assert.ok(CREDENTIAL_DIRS.includes(rel), rel);

  for (const rel of CREDENTIAL_DIRS) {
    fs.mkdirSync(path.join(home, rel, "inside"), { recursive: true });
    for (const p of [rel, path.join(rel, "inside")]) {
      const r = rootAddable(path.join(home, p));
      assert.equal(r.ok, false, p);
      assert.match(r.error, /holds keys or credentials/, p);
    }
  }
  const config = rootAddable(path.join(home, ".config"));
  assert.equal(config.ok, false, "~/.config holds gcloud's credentials");
  assert.match(config.error, /Add a folder inside it instead/);

  // Reached through a symlink, a credential folder is still refused (the check is on the real path).
  fs.symlinkSync(path.join(home, ".aws"), path.join(home, "aws-link"));
  assert.equal(rootAddable(path.join(home, "aws-link")).ok, false, "a link to ~/.aws");

  fs.mkdirSync(path.join(home, "projects", "site"), { recursive: true });
  assert.deepEqual(rootAddable(path.join(home, "projects")), {
    ok: true,
    real: path.join(home, "projects"),
  });
  assert.equal(rootAddable(home).ok, false, "the whole home is too broad");
  assert.equal(rootAddable(path.join(home, "missing")).ok, false);
});
