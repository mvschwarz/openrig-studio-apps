#!/usr/bin/env node
// CONTROL HARNESS — proves, on every run, that the checkers CAN fail.
//
// WHY THIS EXISTS. A checker you have only ever seen pass is an untested checker, and in a
// security context a checker that cannot fail is counted as protection. The controls for
// verify-containment and test-boundary were originally run by planting a violation by
// hand, observing the failure, and reverting. That made "these checkers can fail"
// TRUE-AS-OF-WHEN-OBSERVED — a status line, which goes stale silently and on the happy
// path. It also meant nobody else could re-establish it without re-deriving the planting
// steps.
//
// So the controls are committed and self-re-establishing. Same shape as the checked BOOT
// exemption: the control that proves itself beats the control that was proven once.
//
// Each control copies this provider to a temp dir, plants ONE violation there, and asserts
// the checker exits NON-ZERO. The original tree is never modified. A BASELINE case asserts
// the unmodified copy PASSES — without it, a checker that always failed would score a
// perfect run here.
//
// Usage: npm run verify:controls   (exits non-zero if any control fails to fire)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const CONTROLS = [
  {
    name: "BASELINE — unmodified tree PASSES all checkers",
    checker: null, // all of them
    plant: () => {},
    expect: "pass",
  },
  {
    name: "verify:containment (a) catches a SECOND containment implementation",
    checker: "verify-containment.mjs",
    plant: (dir) => append(dir, "host-server.mjs",
      "\nexport function sneaky(p, rootDir) { return p.startsWith(rootDir); }\n"),
    expect: "fail",
  },
  {
    name: "verify:containment (b) catches a module write to an unresolved caller path",
    checker: "verify-containment.mjs",
    plant: (dir) => append(dir, "host-backend.mjs",
      "\nexport function unsafeWrite(callerPath, data) { fs.writeFileSync(callerPath, data); }\n"),
    expect: "fail",
  },
  {
    name: "verify:containment REVOKES the BOOT exemption when a boot file reads request input",
    checker: "verify-containment.mjs",
    plant: (dir) => append(dir, "live-state.mjs", "\n// touches req.searchParams\n"),
    expect: "fail",
  },
  {
    name: "test:boundary catches a resolve-only (symlink-blind) containment",
    checker: "test-boundary.mjs",
    plant: (dir) => {
      const p = path.join(dir, "host-backend.mjs");
      const src = fs.readFileSync(p, "utf8");
      // Reproduce the original asymmetry: resolve, never realpath.
      const broken = src.replace(
        /export function resolveInsideRoots\(p, roots\) \{[\s\S]*?\n\}/,
        `export function resolveInsideRoots(p, roots) {
  if (typeof p !== "string" || !p) return null;
  const real = path.resolve(p);
  for (const root of roots) {
    const realRoot = path.resolve(root);
    if (real === realRoot || real.startsWith(realRoot + path.sep)) return real;
  }
  return null;
}`,
      );
      if (broken === src) throw new Error("could not plant the resolve-only variant — anchor missed");
      fs.writeFileSync(p, broken);
    },
    expect: "fail",
  },
];

function append(dir, file, text) {
  fs.appendFileSync(path.join(dir, file), text);
}

function freshCopy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-host-controls-"));
  // cpSync so the copy includes any subdirectories — otherwise the harness itself
  // would reproduce the flat-scan blindness it now tests for.
  fs.cpSync(HERE, dir, { recursive: true });
  return dir;
}

const run = (dir, checker) =>
  spawnSync(process.execPath, [path.join(dir, checker)], { encoding: "utf8" }).status;

const ALL = ["verify-containment.mjs", "test-boundary.mjs"];
let failures = 0;

for (const c of CONTROLS) {
  const dir = freshCopy();
  let ok, detail = "";
  try {
    c.plant(dir);
    const checkers = c.checker ? [c.checker] : ALL;
    const codes = checkers.map((k) => ({ k, code: run(dir, k) }));
    if (c.expect === "pass") {
      ok = codes.every((r) => r.code === 0);
      detail = ok ? "" : `expected all to pass, got ${codes.filter((r) => r.code !== 0).map((r) => r.k).join(", ")} failing`;
    } else {
      ok = codes.every((r) => r.code !== 0);
      detail = ok ? "" : `checker did NOT fire — ${c.checker} exited 0 with the violation planted`;
    }
  } catch (e) {
    ok = false;
    detail = `control could not be planted: ${e.message}`;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (!ok) failures++;
  console.log(`  ${ok ? "OK  " : "FAIL"}  ${c.name}${detail ? ` — ${detail}` : ""}`);
}

console.log(
  `\n${failures === 0
    ? "OK   every checker demonstrated able to fail, and the clean tree passes"
    : `FAIL ${failures} control(s) did not behave as required`}`,
);
process.exit(failures === 0 ? 0 : 1);
