#!/usr/bin/env node
// Sandbox-boundary proof for the studio backend.
//
// The required proof (PM ruling): a symlink INSIDE an approved root pointing
// OUTSIDE it must be REJECTED for READ **and** for WRITE. Read-only testing
// would leave the write path unproven, and write is the one that escapes.
//
// Every case runs a POSITIVE CONTROL alongside the rejection, because a
// boundary that rejects everything and a boundary that rejects the right thing
// look identical from a list of PASSes.
//
// Usage: node scripts/test-boundary.mjs   (exits non-zero on any failure)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveInsideRoots, filesRead, filesWrite, filesTree } from "./host-backend.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "studio-boundary-"));
const ROOT = path.join(tmp, "approved-root");
const OUTSIDE = path.join(tmp, "outside");
fs.mkdirSync(ROOT, { recursive: true });
fs.mkdirSync(OUTSIDE, { recursive: true });

fs.writeFileSync(path.join(ROOT, "inside.txt"), "legitimate content\n");
fs.writeFileSync(path.join(OUTSIDE, "secret.txt"), "SECRET — must never be read or written\n");

// the attack: a symlink sitting INSIDE the approved root, pointing OUT
fs.symlinkSync(path.join(OUTSIDE, "secret.txt"), path.join(ROOT, "escape.txt"));
fs.symlinkSync(OUTSIDE, path.join(ROOT, "escape-dir"));

const roots = [ROOT];
let failures = 0;
const check = (label, actual, expected) => {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) console.log(`        expected ${expected}, got ${actual}`);
};

console.log("POSITIVE CONTROLS — the boundary must ALLOW legitimate access");
check("resolve a real file inside the root", resolveInsideRoots(path.join(ROOT, "inside.txt"), roots) !== null, true);
check("read a real file inside the root", filesRead(path.join(ROOT, "inside.txt"), roots)?.content.trim() === "legitimate content", true);
// filesTree's shape IS its contract with the surface, and it is now ONE shape:
// { path, dirs, files }, whether or not a dir was named. Assert it, because the
// earlier hand-rewrite that returned { dir, entries } passed every security
// check and rendered nothing.
//
// THIS ASSERTION USED TO DEMAND TWO SHAPES — no dir → { roots }. That was the
// tree verb doubling as the root list, and the root list has its own verb
// (/api/files/roots), which is what the surface reads. The second shape is
// gone; this case now pins the fallback that replaced it, so an empty `dir`
// answers the first bound root's contents rather than a different object.
check("list the root", ((filesTree(ROOT, roots)?.files?.length ?? 0) + (filesTree(ROOT, roots)?.dirs?.length ?? 0)) > 0, true);
check("no dir → the FIRST BOUND ROOT's contents, in the one shape", filesTree(null, roots)?.path, filesTree(ROOT, roots)?.path);
{
  const p = path.join(ROOT, "new-file.txt");
  let wrote = false;
  try { filesWrite(p, "written\n", null, roots); wrote = fs.readFileSync(p, "utf8") === "written\n"; } catch { wrote = false; }
  check("write a NEW file inside the root (must not require an existing realpath)", wrote, true);
}

console.log("\nTHE ATTACK — symlink inside the root pointing OUTSIDE");
check("resolveInsideRoots rejects the symlinked file", resolveInsideRoots(path.join(ROOT, "escape.txt"), roots), null);
check("READ through the symlink is rejected", filesRead(path.join(ROOT, "escape.txt"), roots), null);

let writeRejected = false;
try {
  filesWrite(path.join(ROOT, "escape.txt"), "PWNED\n", null, roots);
} catch (e) {
  writeRejected = /outside the pinned roots/.test(e.message);
}
check("WRITE through the symlink is rejected", writeRejected, true);
// NOTE — do NOT assert "the outside file is unchanged" here and call it an escape
// test. Measured against the broken boundary: a write to a FILE symlink does not
// write through it at all — renameSync REPLACES the symlink with a regular file,
// leaving the outside file untouched. So that assertion passes even when the
// boundary is broken, i.e. it passes for a reason unrelated to safety. The file
// symlink is a READ-leak vector; the directory symlink below is the WRITE escape.
check("the symlink is still a symlink (not silently replaced)",
  fs.lstatSync(path.join(ROOT, "escape.txt")).isSymbolicLink(), true);

console.log("\nTHE WRITE ESCAPE — directory symlink (this is the one that plants files outside)");
check("directory symlink escape is rejected", resolveInsideRoots(path.join(ROOT, "escape-dir", "secret.txt"), roots), null);
check("write THROUGH a directory symlink is rejected", (() => {
  try { filesWrite(path.join(ROOT, "escape-dir", "planted.txt"), "PWNED\n", null, roots); return false; } catch { return true; }
})(), true);
check("...and NO file was planted outside the root", fs.existsSync(path.join(OUTSIDE, "planted.txt")), false);

console.log("\nOTHER ESCAPES");
check("../ traversal is rejected", resolveInsideRoots(path.join(ROOT, "..", "outside", "secret.txt"), roots), null);
check("absolute path outside is rejected", resolveInsideRoots(path.join(OUTSIDE, "secret.txt"), roots), null);
check("sibling-prefix root is rejected (<root>-evil must not match <root>)", (() => {
  const evil = `${ROOT}-evil`;
  fs.mkdirSync(evil, { recursive: true });
  fs.writeFileSync(path.join(evil, "x.txt"), "x");
  return resolveInsideRoots(path.join(evil, "x.txt"), roots);
})(), null);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${failures === 0 ? "OK   boundary holds" : `FAIL ${failures} case(s)`}`);
process.exit(failures === 0 ? 0 : 1);
