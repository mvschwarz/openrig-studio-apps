// The one definition of "what the checkers must look at".
//
// WHY THIS EXISTS. Both checkers previously discovered files with a NON-RECURSIVE
// readdirSync filtered on .endsWith(".mjs"). A subdirectory entry does not end in
// ".mjs", so it was skipped and nothing descended into it — a served module at
// <provider>/<subdir>/foo.mjs was invisible to BOTH. Confirmed by planting one: a
// spawning module in a subdirectory produced a clean, green, exit-0 run.
//
// That is the worst shape a checker can have: A FILE NOBODY CHECKS PRODUCES THE SAME
// REPORT AS A FILE THAT PASSES. Coverage and absence are two different states and only
// one is a guarantee — the same distinction that put the front proxy INTO the BACKEND
// set rather than leaving it merely unmentioned.
//
// Two checkers discovering files two ways is also the divergence shape this codebase
// keeps producing (five containment sites, two branches of one check). One discovery
// function, used by both, cannot disagree with itself.

import fs from "node:fs";
import path from "node:path";

// Every .mjs under the given root, at any depth, as paths relative to `root`.
export function servedFiles(root) {
  const out = [];
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const rel = prefix ? path.join(prefix, entry.name) : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
      else if (entry.name.endsWith(".mjs")) out.push(rel);
    }
  };
  walk(root, "");
  return out.sort();
}
