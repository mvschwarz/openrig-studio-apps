// The one definition of "what the checkers must look at": every .mjs under the provider, at any depth.
// Copyright 2026 mvschwarz. Licensed under the Apache License, Version 2.0.
//
// A non-recursive scan would skip a served module in a subfolder, and a file nobody checks produces the same report as a file
// that passes. One discovery function, used by both checkers, cannot disagree with itself.

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
