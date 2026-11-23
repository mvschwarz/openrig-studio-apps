#!/usr/bin/env node
// Runs the whole suite (test/, providers/*/test/, apps/*/test/) with node --test, inside one temporary folder per run that is
// removed when the run ends, however it ends: everything the tests start inherits it as TMPDIR.
//
//   npm test                         the whole suite
//   npm test -- test/foo.test.mjs    just those files (any node --test arguments pass through)
//
// Copyright 2026 mvschwarz. Licensed under the Apache License, Version 2.0.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tests = (dir) => {
  try {
    return fs
      .readdirSync(path.join(root, dir))
      .filter((f) => f.endsWith(".test.mjs"))
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
};
const under = (dir) => {
  try {
    return fs
      .readdirSync(path.join(root, dir), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .flatMap((d) => tests(path.join(dir, d.name, "test")));
  } catch {
    return [];
  }
};
const args = process.argv.slice(2);
// Only arguments that name test files replace the default set (an option's value is not a file).
const files = args.some((a) => /\.(?:m?js|cjs)$/.test(a))
  ? []
  : [...tests("test"), ...under("providers"), ...under("apps")].sort();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "studio-apps-test-"));
let cleaned = false;
const clean = () => {
  if (cleaned) return;
  cleaned = true;
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
};
process.on("exit", clean);

const child = spawn(process.execPath, ["--test", ...args, ...files], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp },
});
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code, signal) => {
  clean();
  process.exit(code ?? (signal ? 1 : 0));
});
