#!/usr/bin/env node
// CLASS-1 STRUCTURAL CHECK — the two claims a reviewer verifies without trusting the author.
//
//   (a) NO INDEPENDENT CONTAINMENT LOGIC anywhere in this provider.
//       Everything routes the ONE canonical resolver. Five sites in the original source
//       diverged (insideRoots-vs-rootAddable, library/route's destination, /api/media's
//       bypass branch, canvasSrcAllowed's two branches, safeStaticPath) because there
//       WERE multiple containment code paths. A systemic asymmetry is fixed by removing
//       the ability to be asymmetric, so a second containment implementation is a FAILURE
//       even if it happens to be written correctly.
//
//   (b) NO MODULE FS-WRITE TRUSTS A CALLER-SUPPLIED PATH UN-RESOLVED.
//       This one would have slipped past (a): a module that never validated anything has
//       nothing for a containment grep to find — THE ABSENCE IS THE DEFECT. Found in the
//       source as applyPatch(target) -> path.resolve(target) -> writeFileSync, safe only
//       because its single caller constrained it. Any second caller re-opens it.
//
// WHY IT LIVES HERE. It used to sit in the studio repo's scripts/, guarding a copy of
// this backend that the studio carried before the app/provider split. That copy is gone;
// the code it guarded is these files. A control left behind in the repo the code moved
// OUT of keeps passing forever and guards nothing, which is worse than not having it —
// it reads as coverage. The control goes where the code went.
//
// Both are grep-shaped on purpose: a reviewer runs them, not the author.
//
// Usage: npm run verify:containment   (exits non-zero if either claim is broken)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { servedFiles } from "./served-files.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// The single approved containment implementation. Everything else must call it.
const RESOLVER_FILE = "host-backend.mjs";
const RESOLVER_NAME = "resolveInsideRoots";

// Files that are allowed to contain the resolver's own internals.
const RESOLVER_OWNERS = new Set([RESOLVER_FILE]);
// Test/verifier files legitimately mention these patterns while proving them.
const NON_BACKEND = new Set(["test-boundary.mjs", "verify-containment.mjs", "verify-controls.mjs", "served-files.mjs"]);

// BOOT set — runs before the server exists and receives NO request input, so claim (b)
// ("no CALLER-supplied path") cannot apply: there is no caller. This is an exemption, so
// it is itself CHECKED below rather than taken on trust — a bare allowlist here would be
// exactly the loophole this file exists to prevent. A boot file that ever reads request
// input stops qualifying and the check fails.
const BOOT = new Set(["live-state.mjs"]);
const REQUEST_INPUT = /\breq\b|searchParams|readBody|request\./;

let failures = 0;
const check = (ok, label, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "OK  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

// RECURSIVE via the shared discovery — one definition of what must be looked at, so
// the two checkers cannot disagree about their own reach.
const backendFiles = servedFiles(HERE)
  .filter((f) => !NON_BACKEND.has(path.basename(f)))
  .map((f) => ({ name: f, src: fs.readFileSync(path.join(HERE, f), "utf8") }));

// ---- (a) one containment implementation ------------------------------------
// A containment check is a root comparison: `startsWith(root...)` or a realpath used to
// decide whether a path is inside somewhere. Outside the resolver, neither may appear.
const CONTAINMENT = /\.startsWith\(\s*[A-Za-z_$][\w$]*(?:Root|root|dir|Dir|base|Base)/;
const REALPATH = /realpathSync\s*\(/;

console.log("(a) ONE canonical containment implementation");
const resolverPresent = backendFiles.some(
  (f) => RESOLVER_OWNERS.has(f.name) && f.src.includes(`export function ${RESOLVER_NAME}`),
);
check(resolverPresent, `${RESOLVER_NAME} is defined in ${RESOLVER_FILE}`);

for (const f of backendFiles) {
  if (RESOLVER_OWNERS.has(f.name)) continue;
  const ownContainment = CONTAINMENT.test(f.src) || REALPATH.test(f.src);
  check(!ownContainment, `${f.name} performs no containment of its own`,
    ownContainment ? "found a root-comparison or realpath outside the resolver" : "");
}

// ---- (b) no module fs-write trusts a caller path ---------------------------
// Every write must be to a path that came out of the resolver. Flag a write whose
// argument is a bare identifier we cannot see being resolved in the same file.
const WRITES = /fs\.(writeFileSync|appendFileSync|copyFileSync|renameSync|rmSync|mkdirSync)\s*\(\s*([A-Za-z_$][\w$.]*)/g;

console.log("\n(b) no module fs-write trusts a caller-supplied path un-resolved");
// The BOOT exemption is verified, not asserted: a boot file must genuinely take no
// request input. If one ever does, it loses the exemption and is checked like the rest.
for (const f of backendFiles) {
  if (!BOOT.has(f.name)) continue;
  const takesRequestInput = REQUEST_INPUT.test(f.src);
  check(!takesRequestInput, `${f.name} qualifies for the BOOT exemption (no request input)`,
    takesRequestInput ? "reads request input — exemption REVOKED, must resolve its write targets" : "");
}
for (const f of backendFiles) {
  if (BOOT.has(f.name) && !REQUEST_INPUT.test(f.src)) continue; // exempt and verified so
  const resolvedNames = new Set();
  // names bound from the resolver's return value
  for (const m of f.src.matchAll(new RegExp(`(?:const|let)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${RESOLVER_NAME}\\s*\\(`, "g"))) {
    resolvedNames.add(m[1]);
  }
  const offenders = [];
  for (const m of f.src.matchAll(WRITES)) {
    let arg = m[2];
    // `path.dirname(x)` / `path.join(x, …)` are derivations OF their argument, so the
    // question is whether THAT argument is resolver-derived. Look through one wrapper
    // rather than treating the helper name as the path's origin.
    const wrapped = new RegExp(`fs\\.\\w+\\(\\s*path\\.(?:dirname|join|resolve)\\(\\s*([A-Za-z_$][\\w$]*)`).exec(m[0] + f.src.slice(m.index + m[0].length, m.index + m[0].length + 40));
    if (arg.startsWith("path.") && wrapped) arg = wrapped[1];
    const rootOfArg = arg.split(".")[0];
    // Allowed: a resolver output, or a path built locally from one (tmp/backup names).
    const derived = new RegExp(`(?:const|let)\\s+${rootOfArg}\\s*=[^\\n]*(?:${[...resolvedNames].join("|") || "\\u0000"})`).test(f.src);
    if (!resolvedNames.has(rootOfArg) && !derived) offenders.push(`${m[1]}(${arg})`);
  }
  check(offenders.length === 0, `${f.name} writes only to resolver-derived paths`,
    offenders.length ? `unresolved: ${[...new Set(offenders)].join(", ")}` : "");
}

console.log(`\n${failures === 0 ? "OK   Class-1 holds: one resolver, no un-resolved module writes" : `FAIL ${failures} problem(s)`}`);
process.exit(failures === 0 ? 0 : 1);
