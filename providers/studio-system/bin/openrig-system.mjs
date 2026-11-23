#!/usr/bin/env node
// openrig-system: this machine's storage, memory and CPU, with the same states and words as the Machine app. Read only.
//   openrig-system            plain words
//   openrig-system --json     the same reading as JSON (for scripts and agents)
//   openrig-system --big      also list what's taking space in your home (bounded, ~10 s at most)
//   openrig-system --studio <dir>   the Studio's folder (else $OPENRIG_STUDIO_DIR), to read the same numbers the app shows
// Read only: it writes nothing. Cleanups aren't run from here: open the Machine app, or run the tool's own command with the person's OK.
// Copyright 2026 mvschwarz. Licensed under the Apache License, Version 2.0.
import { status } from "../system-route.mjs";
import { bigFolders } from "../lib/fixes.mjs";

const argv = process.argv.slice(2),
  si = argv.indexOf("--studio");
const env = {
  ...process.env,
  ...(si > -1 && argv[si + 1] ? { OPENRIG_STUDIO_DIR: argv[si + 1] } : {}),
};
const args = new Set(argv.filter((a, n) => !(si > -1 && (n === si || n === si + 1))));
if ([...args].some((a) => !["--json", "--big"].includes(a))) {
  console.error("usage: openrig-system [--json] [--big] [--studio <dir>]");
  process.exit(2);
}
const s = await status(env, { readOnly: true });
if (args.has("--big")) s.bigFolders = await bigFolders({ env });
if (args.has("--json")) {
  console.log(JSON.stringify(s, null, 2));
  process.exit(0);
}

const gb = (b) =>
  b == null ? "?" : b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`;
const pct = (f) => (f == null ? "" : ` (${Math.round(f * 100)}%)`);
const st = s.storage,
  m = s.memory,
  c = s.cpu;
console.log(
  `Storage: ${s.words.storage}${pct(st.fraction)}  ${st.usedBytes != null ? `${gb(st.usedBytes)} of ${gb(st.totalBytes)} used · ${gb(st.freeBytes)} free${st.lowFree ? ` (only ${gb(st.freeBytes)} left)` : ""}` : st.why || ""}`,
);
if (st.tighter === "inodes")
  console.log(
    `  ${Math.round(st.inodes.fraction * 100)}% of the space for files is used (many small files).`,
  );
console.log(
  `Memory:  ${s.words.memory}${pct(m.fraction)}  ${m.usedBytes != null ? `${gb(m.usedBytes)} of ${m.scope === "workspace" ? `this machine's ${gb(m.limitBytes)}` : gb(m.totalBytes)} used · ${gb(m.scope === "workspace" ? m.limitBytes - m.usedBytes : m.availableBytes)} available` : ""}${m.why ? `  (${m.why})` : ""}`,
);
console.log(
  `CPU:     ${s.words.cpu}${pct(c.fraction)}  ${c.usedCores != null ? `Using ${c.usedCores.toFixed(1)} of ${+(c.limitCores || c.cores).toFixed(1)} cores` : c.load ? `load ${c.load.map((x) => x.toFixed(2)).join(" ")} on ${c.cores} cores` : c.why || ""}`,
);
const up = s.uptimeSeconds,
  ud = Math.floor(up / 86400),
  uh = Math.floor(up / 3600),
  um = Math.max(1, Math.floor(up / 60));
console.log(
  `Running for ${ud ? `${ud} day${ud === 1 ? "" : "s"}` : uh ? `${uh} hour${uh === 1 ? "" : "s"}` : `${um} minute${um === 1 ? "" : "s"}`}`,
);
for (const f of s.findings)
  console.log(
    `! ${f.title}${f.at ? ` at ${f.at.slice(0, 10)} ${f.at.slice(11, 16)} UTC` : ""}${f.text ? ` ${f.text}` : "."}`,
  );
if (s.oom?.kills > 0 && !s.findings.some((f) => f.at))
  console.log(
    `Programs were stopped for using too much memory ${s.oom.kills} time${s.oom.kills === 1 ? "" : "s"} since this machine started${s.oom.seenAt ? " (none in the last day)" : ""}.`,
  );
if (!s.findings.length) console.log("Nothing slowing it down right now.");
if (s.platformNote) console.log(s.platformNote);
else for (const n of s.notes || []) console.log(n);
for (const fx of s.fixes)
  console.log(
    `Safe to clear: ${fx.label.replace(/^(Clear|Remove) /, "")}: ${fx.frees == null ? "size not known" : fx.frees < 1e6 ? "nothing to clear" : `frees about ${gb(fx.frees)}`}`,
  );
if (s.bigFolders) {
  console.log(
    `What's taking space in ~${s.bigFolders.partial ? " (partial list: stopped looking after 10 seconds)" : ""}:`,
  );
  for (const f of s.bigFolders.folders)
    console.log(
      `  ${gb(f.bytes).padStart(8)}  ~/${f.path}${f.inProject ? (s.steps?.lead ? "  (part of your project: ask your lead what can go)" : "  (part of your project, so it isn't cleared from here)") : ""}`,
    );
  for (const f of s.bigFolders.notCounted || [])
    console.log(`  ${"?".padStart(8)}  ~/${f}  (too big to count in time)`);
  for (const f of s.bigFolders.notTried || [])
    console.log(`  ${"?".padStart(8)}  ~/${f}  (not looked at in time)`);
  if (s.bigFolders.skipped?.length)
    console.log(`  (~/${s.bigFolders.skipped.join(", ~/")} isn't looked at on a Mac)`);
}
