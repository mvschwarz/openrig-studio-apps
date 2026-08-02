#!/usr/bin/env node
// The cut-lane watcher — the process cutdown's write verbs enqueue for.
//
// REWRITTEN FROM watch-markers.sh rather than ported. The original was a bash
// loop with the bespoke era baked in: a hardcoded app dir, a single-project
// default, logs into $HOME, an optional Modal GPU offload keyed on files in the
// machine-local files — and `stat -c %Y`, which is GNU syntax. On macOS
// that returns nothing, the guard falls through to "none", and THE CUT LANE
// NEVER RUNS AT ALL. It was Linux-only by accident, not by choice.
//
// Same lane, same idempotence, paths from arguments, runs anywhere Node does.
//
// The lane sweeps every cycle because it is cheap when there is nothing to do,
// so a crashed run or a deleted-then-repunched cut self-heals within one sweep.
// The heavier index rebuild only runs when the lane actually did work or the
// markers file changed.

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > -1 ? process.argv[i + 1] : d; };
const FOOTAGE = path.resolve(arg("footage", ""));
const BUNDLE = path.resolve(arg("bundle", FOOTAGE));
const INTERVAL = Number(arg("interval", 10000));
const HERE = path.dirname(new URL(import.meta.url).pathname);
const EXPORT_TOOLS = path.resolve(HERE, "..", "studio-video");
const LOG = path.join(FOOTAGE, "cutlane.log");

if (!FOOTAGE || !fs.existsSync(FOOTAGE)) {
  console.error(`watch-markers: --footage must be an existing directory (got ${FOOTAGE || "nothing"})`);
  process.exit(1);
}

const log = (m) => {
  const line = `${new Date().toISOString()} ${m}\n`;
  try { fs.appendFileSync(LOG, line); } catch { /* logging must never take the lane down */ }
};

const node = (file, args, cwd) =>
  new Promise((resolve) => {
    execFile(process.execPath, [file, ...args], { cwd, timeout: 15 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ err, out: String(stdout || ""), errOut: String(stderr || "") }));
  });

const mtime = (p) => { try { return fs.statSync(p).mtimeMs; } catch { return null; } };

async function rebuildIndexes() {
  for (const [tool, args] of [
    ["project-assets.mjs", ["generate", "--slice-root", "."]],
    ["timeline-history.mjs", ["rebuild", "--slice-root", "."]],
  ]) {
    const r = await node(path.join(EXPORT_TOOLS, tool), args, BUNDLE);
    if (r.err) log(`index rebuild failed (${tool}): ${r.err.message}`);
  }
}

// Latest job per clip+level wins. Entries without a level are legacy and are
// already satisfied by the bare -stab output, so they are skipped.
function pendingStabJobs() {
  const p = path.join(FOOTAGE, "stab-jobs.jsonl");
  if (!fs.existsSync(p)) return [];
  const latest = new Map();
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const j = JSON.parse(line);
      if (!j.level) continue;
      latest.set(`${j.clip}|${j.level}`, j);
    } catch { /* a malformed line is skipped, not fatal */ }
  }
  return [...latest.values()];
}

let lastMarkers = null;

async function sweep() {
  const markers = path.join(FOOTAGE, "markers.jsonl");
  const cur = mtime(markers);

  if (cur !== null) {
    const lane = await node(path.join(HERE, "cut-clips.mjs"), ["--footage", FOOTAGE, "--bundle", BUNDLE]);
    const didWork = (lane.out.match(/^cut /gm) || []).length;
    if (didWork) log(`lane cut ${didWork} clip(s)`);
    if (lane.err && !lane.out) log(`lane error: ${lane.err.message}`);
    if (cur !== lastMarkers || didWork > 0) {
      lastMarkers = cur;
      await rebuildIndexes();
    }
  }

  for (const job of pendingStabJobs()) {
    const src = path.join(BUNDLE, "media", "renders", job.clip);
    const out = src.replace(/\.mp4$/, `-stab-${job.level}.mp4`);
    if (!fs.existsSync(src) || fs.existsSync(out)) continue;
    log(`stabilizing ${job.clip} (${job.level})`);
    const args = [src, "--level", job.level, "--smoothing", String(job.smoothing ?? 12)];
    if (job.tripod) args.push("--tripod");
    // The original had a Modal GPU fast lane gated on machine-local files
    // home directory, falling back to this local pass. Dropped: it is host
    // setup, not product, and the local lane is what actually shipped.
    const r = await node(path.join(HERE, "stabilize-clip.mjs"), args);
    if (r.err) log(`stabilize failed for ${job.clip}: ${r.err.message}`);
    else await rebuildIndexes();
  }
}

console.log(`watch-markers: ${FOOTAGE}/markers.jsonl -> ${BUNDLE} (every ${INTERVAL}ms)`);
const tick = async () => {
  try { await sweep(); } catch (e) { log(`sweep threw: ${e.message}`); }
  setTimeout(tick, INTERVAL);
};
tick();
