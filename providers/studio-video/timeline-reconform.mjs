#!/usr/bin/env node
// Audio re-conform wizard : swap in a new audio master PACKAGE and
// emit the complete retime as ONE reviewable draft patch. Alignment is
// text-anchored word matching between the old and new words JSON; boundaries
// map through matched anchor words; slots whose words fail to align are
// REPORTED AND LEFT UNPATCHED - never guessed.
// 
import fs from "node:fs";
import path from "node:path";
import { materializeCards, readTimelineFile, roundSeconds } from "./timeline-export-core.mjs";
import { probeMedia, resolveSystemBin } from "./timeline-export-probe.mjs";

const BOUNDARY_TOLERANCE_S = 0.02; // ignore sub-frame drift
const FAILED_WINDOW_RATIO = 0.10;  // >10% unmatched words in a slot = failed alignment

// ---- words ----

export function loadWordsFile(wordsPath) {
  const payload = JSON.parse(fs.readFileSync(wordsPath, "utf8"));
  const raw = Array.isArray(payload) ? payload : payload.words;
  if (!Array.isArray(raw)) throw new Error(`${wordsPath}: no words[] found`);
  return raw
    .map((word, index) => ({
      text: String(word.text ?? ""),
      start: Number(word.masterStart ?? word.start),
      end: Number(word.masterEnd ?? word.end),
      index,
    }))
    .filter((word) => word.text && Number.isFinite(word.start) && Number.isFinite(word.end))
    .sort((a, b) => a.start - b.start || a.end - b.end);
}

function normToken(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

// Classic LCS over normalized tokens. ~1600x1600 fits comfortably in two
// Int32Array rows. Deferred: O(n*m) is fine at transcript scale; revisit only
// if scripts grow past ~10k words.
export function alignWords(oldWords, newWords) {
  const a = oldWords.map((word) => normToken(word.text));
  const b = newWords.map((word) => normToken(word.text));
  const n = a.length;
  const m = b.length;
  // DP table as rows to reconstruct the path we keep a compact full table of
  // Uint16 lengths (n+1)*(m+1); at 1617*1617 that is ~5.2MB - acceptable.
  const width = m + 1;
  const table = new Uint16Array((n + 1) * width);
  for (let i = 1; i <= n; i++) {
    const rowBase = i * width;
    const prevBase = rowBase - width;
    for (let j = 1; j <= m; j++) {
      table[rowBase + j] = a[i - 1] === b[j - 1]
        ? table[prevBase + j - 1] + 1
        : Math.max(table[prevBase + j], table[rowBase + j - 1]);
    }
  }
  const matches = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1] && table[i * width + j] === table[(i - 1) * width + (j - 1)] + 1) {
      matches.push({ oi: i - 1, ni: j - 1 });
      i--; j--;
    } else if (table[(i - 1) * width + j] >= table[i * width + (j - 1)]) {
      i--;
    } else {
      j--;
    }
  }
  matches.reverse();
  const matchedOld = new Set(matches.map((match) => match.oi));
  const matchedNew = new Set(matches.map((match) => match.ni));
  return {
    matches,
    oldUnmatched: oldWords.map((_, index) => index).filter((index) => !matchedOld.has(index)),
    newUnmatched: newWords.map((_, index) => index).filter((index) => !matchedNew.has(index)),
  };
}

// Map an OLD master-clock time to the NEW master clock: anchor on the first
// matched word at/after t and preserve the lead-in offset (silence before the
// first spoken word of a slot survives the swap). Past the last match,
// preserve the tail offset from the last matched word's end.
export function buildTimeMapper(oldWords, newWords, matches) {
  const anchors = matches.map(({ oi, ni }) => ({
    oldStart: oldWords[oi].start,
    newStart: newWords[ni].start,
    oldEnd: oldWords[oi].end,
    newEnd: newWords[ni].end,
  }));
  return function mapTime(t) {
    // binary search: first anchor with oldStart >= t
    let lo = 0;
    let hi = anchors.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (anchors[mid].oldStart >= t) hi = mid;
      else lo = mid + 1;
    }
    if (lo < anchors.length) {
      const anchor = anchors[lo];
      return roundSeconds(anchor.newStart - (anchor.oldStart - t));
    }
    const last = anchors[anchors.length - 1];
    if (!last) return t;
    return roundSeconds(last.newEnd + (t - last.oldEnd));
  };
}

// ---- audio package intake ----

export function readAudioPackage(input, { requireExists = true } = {}) {
  const resolved = path.resolve(input);
  const pending = [];
  let files = {};
  let packageStatus = null;
  if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
    // manifest.json (or package.json) may declare status "scratch"
    // (AI placeholder VO) vs "master" - threads through to audio_master_status
    for (const manifestName of ["manifest.json", "package.json"]) {
      const manifestPath = path.join(resolved, manifestName);
      if (!fs.existsSync(manifestPath)) continue;
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      if (manifest.status) packageStatus = String(manifest.status);
      for (const key of ["master", "words", "captions", "srt", "loudness"]) {
        if (manifest[key]) files[key] = path.resolve(resolved, manifest[key]);
      }
      break;
    }
    if (!files.master) {
      const names = fs.readdirSync(resolved);
      const pick = (test) => {
        const name = names.find(test);
        return name ? path.join(resolved, name) : undefined;
      };
      files.master = pick((name) => name.endsWith(".wav"))
        || pick((name) => name.endsWith(".mp3"));
      files.words = pick((name) => name.endsWith(".json") && /words/i.test(name));
      files.captions = pick((name) => name.endsWith(".vtt"));
      files.srt = pick((name) => name.endsWith(".srt"));
      files.loudness = pick((name) => /loudness/i.test(name));
    }
  } else {
    throw new Error(`audio package not found or not a directory: ${resolved}`);
  }
  for (const key of ["master", "words", "captions"]) {
    if (!files[key] || (requireExists && !fs.existsSync(files[key]))) {
      throw new Error(`audio package incomplete: missing required ${key} (${files[key] || "not found"})`);
    }
  }
  for (const key of ["srt", "loudness"]) {
    if (!files[key] || !fs.existsSync(files[key])) {
      pending.push(key);
      delete files[key];
    }
  }
  return { ...files, pending, root: resolved, status: packageStatus };
}

// ---- re-conform ----

function relativizeRef(filePath, sliceRoot) {
  const resolved = path.resolve(filePath);
  const root = path.resolve(sliceRoot) + path.sep;
  return resolved.startsWith(root) ? resolved.slice(root.length) : resolved;
}

export function reconformTimeline(timeline, {
  oldWords,
  newWords,
  newMasterDurationS,
  pkg,
  sliceRoot,
  actorNote = "",
}) {
  const { matches } = alignWords(oldWords, newWords);
  const mapTime = buildTimeMapper(oldWords, newWords, matches);
  const matchedOld = new Set(matches.map((match) => match.oi));

  const cards = materializeCards(timeline);
  const ops = [];
  const moves = [];
  const failed = [];

  for (const card of cards) {
    if (card.extension) continue; // post-spine cards keep durations; starts ride contiguity
    const oldStart = Number(card.audio_start_s ?? card.start_s);
    const oldEnd = Number(card.audio_end_s ?? oldStart + Number(card.duration_s));
    const windowWords = oldWords
      .map((word, index) => ({ word, index }))
      .filter(({ word }) => word.start >= oldStart - 0.001 && word.start < oldEnd);
    const unmatched = windowWords.filter(({ index }) => !matchedOld.has(index));
    if (windowWords.length > 0 && unmatched.length > Math.max(2, windowWords.length * FAILED_WINDOW_RATIO)) {
      failed.push({
        id: String(card.id),
        title: String(card.title || ""),
        unmatchedWords: unmatched.length,
        windowWords: windowWords.length,
        sample: unmatched.slice(0, 6).map(({ word }) => word.text).join(" "),
      });
      continue; // report-and-stop for this slot: keep its old duration
    }
    const newStart = mapTime(oldStart);
    const newEnd = mapTime(oldEnd);
    const newDuration = roundSeconds(newEnd - newStart);
    const oldDuration = Number(card.duration_s);
    if (!Number.isFinite(newDuration) || newDuration <= 0) {
      failed.push({ id: String(card.id), title: String(card.title || ""), reason: `mapped duration ${newDuration}` });
      continue;
    }
    if (Math.abs(newDuration - oldDuration) > BOUNDARY_TOLERANCE_S) {
      ops.push({ op: "set_duration", id: String(card.id), duration_s: newDuration, reason: `reconform: ${oldDuration}s -> ${newDuration}s` });
    }
    moves.push({
      id: String(card.id),
      oldStart, newStart,
      oldDuration, newDuration,
      startDelta: roundSeconds(newStart - oldStart),
      durationDelta: roundSeconds(newDuration - oldDuration),
    });
  }

  for (const bed of [...(timeline.audio_beds || []), ...(timeline.music_beds || [])]) {
    const oldStart = Number(bed.start_s);
    if (!Number.isFinite(oldStart)) continue;
    const newStart = mapTime(oldStart);
    if (Math.abs(newStart - oldStart) > BOUNDARY_TOLERANCE_S) {
      ops.push({ op: "set_bed_window", bed_id: String(bed.id), start_s: newStart, reason: `reconform: bed ${oldStart}s -> ${newStart}s` });
      moves.push({ id: String(bed.id), bed: true, oldStart, newStart, startDelta: roundSeconds(newStart - oldStart) });
    }
  }

  ops.push({
    op: "set_master",
    audio_master: relativizeRef(pkg.master, sliceRoot),
    words_json: relativizeRef(pkg.words, sliceRoot),
    captions_vtt: relativizeRef(pkg.captions, sliceRoot),
    ...(pkg.srt ? { srt: relativizeRef(pkg.srt, sliceRoot) } : {}),
    ...(pkg.loudness ? { loudness_report: relativizeRef(pkg.loudness, sliceRoot) } : {}),
    total_duration_s: roundSeconds(newMasterDurationS),
    status: pkg.status || "review-candidate",
    reason: actorNote || "reconform master install",
  });

  return { ops, moves, failed, matchCount: matches.length, oldWordCount: oldWords.length, newWordCount: newWords.length };
}

export function movementReport(result, { pkg, timelinePath }) {
  const shifted = result.moves.filter((move) => !move.bed && (Math.abs(move.startDelta) > BOUNDARY_TOLERANCE_S || Math.abs(move.durationDelta) > BOUNDARY_TOLERANCE_S));
  const beds = result.moves.filter((move) => move.bed);
  const lines = [
    `# Re-conform movement report`,
    ``,
    `- timeline: ${timelinePath}`,
    `- new master: ${pkg.master}`,
    `- words aligned: ${result.matchCount}/${result.oldWordCount} old, ${result.newWordCount} new`,
    `- package pending artifacts: ${pkg.pending?.length ? pkg.pending.join(", ") : "none"}`,
    ``,
    `## Cards (${shifted.length} moved, of ${result.moves.filter((m) => !m.bed).length} spine cards)`,
    ``,
    ...shifted.map((move) =>
      `- ${move.id}: start ${move.oldStart}s -> ${move.newStart}s (${move.startDelta >= 0 ? "+" : ""}${move.startDelta}s)` +
      (Math.abs(move.durationDelta) > BOUNDARY_TOLERANCE_S ? `; duration ${move.oldDuration}s -> ${move.newDuration}s` : "")),
    ``,
    `## Music beds`,
    ``,
    ...(beds.length ? beds.map((move) => `- ${move.id}: start ${move.oldStart}s -> ${move.newStart}s (${move.startDelta >= 0 ? "+" : ""}${move.startDelta}s)`) : ["- unchanged"]),
    ``,
    `## FAILED ALIGNMENT - left unpatched, needs a human`,
    ``,
    ...(result.failed.length
      ? result.failed.map((slot) => `- ${slot.id} "${slot.title}": ${slot.unmatchedWords ?? "?"}/${slot.windowWords ?? "?"} words unmatched${slot.sample ? ` (e.g. "${slot.sample}")` : ""}${slot.reason ? ` [${slot.reason}]` : ""}`)
      : ["- none"]),
    ``,
  ];
  return lines.join("\n");
}

// A/B listening block: the biggest boundary shifts, old vs new master, using
// media-fragment offsets so you can hear each seam side by side.
export function abListeningHtml(result, { oldMasterRef, newMasterRef }) {
  const top = result.moves
    .filter((move) => !move.bed && Math.abs(move.startDelta) > BOUNDARY_TOLERANCE_S)
    .sort((a, b) => Math.abs(b.startDelta) - Math.abs(a.startDelta))
    .slice(0, 5);
  const rows = top.map((move) => {
    const oldFrom = Math.max(0, move.oldStart - 3).toFixed(2);
    const newFrom = Math.max(0, move.newStart - 3).toFixed(2);
    return `<div class="seam"><h3>${move.id} (shift ${move.startDelta >= 0 ? "+" : ""}${move.startDelta}s)</h3>
      <label>OLD</label><audio controls preload="none" src="../../${oldMasterRef}#t=${oldFrom},${(Number(oldFrom) + 8).toFixed(2)}"></audio>
      <label>NEW</label><audio controls preload="none" src="../../${newMasterRef}#t=${newFrom},${(Number(newFrom) + 8).toFixed(2)}"></audio></div>`;
  });
  return `<!doctype html><html><head><meta charset="utf-8"><title>Re-conform A/B</title>
<style>body{background:#1b1a17;color:#d2cfc7;font:13px Menlo,monospace;padding:20px;max-width:760px}
.seam{border:1px solid #33302a;border-radius:4px;padding:10px 14px;margin-bottom:12px;background:#211f1c}
h3{color:#c9a35a;margin:0 0 6px}label{display:block;color:#756f61;font-size:10px;margin-top:6px}audio{width:100%}</style></head>
<body><h1>Re-conform A/B - biggest boundary shifts</h1>${rows.join("\n") || "<p>No boundary shifts above tolerance.</p>"}</body></html>`;
}

export function runReconform({ sliceRoot, timelinePath, packagePath, actorNote }) {
  const timeline = readTimelineFile(timelinePath);
  const pkg = readAudioPackage(packagePath);
  const oldWordsPath = path.resolve(sliceRoot, String(timeline.words_json || ""));
  if (!fs.existsSync(oldWordsPath)) throw new Error(`current timeline words_json not found: ${oldWordsPath}`);
  const oldWords = loadWordsFile(oldWordsPath);
  const newWords = loadWordsFile(pkg.words);
  const newMasterDurationS = probeMedia(resolveSystemBin("ffprobe"), pkg.master).duration_s;
  const result = reconformTimeline(timeline, { oldWords, newWords, newMasterDurationS, pkg, sliceRoot, actorNote });
  const report = movementReport(result, { pkg, timelinePath });
  const ab = abListeningHtml(result, {
    oldMasterRef: String(timeline.audio_master),
    newMasterRef: relativizeRef(pkg.master, sliceRoot),
  });
  return { ...result, report, ab, pkg, newMasterDurationS };
}

function main() {
  const argv = process.argv.slice(2);
  const options = {
    sliceRoot: path.resolve(new URL("../../", import.meta.url).pathname),
    packagePath: "",
    writePatch: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--slice-root") options.sliceRoot = path.resolve(argv[++i]);
    else if (arg === "--package") options.packagePath = argv[++i];
    else if (arg === "--write-patch") options.writePatch = true;
    else if (arg === "--json") options.json = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.packagePath) {
    console.log("Usage: node timeline-reconform.mjs --package <dir> [--slice-root dir] [--write-patch] [--json]");
    process.exit(1);
  }
  const timelinePath = path.join(options.sliceRoot, "timeline.json");
  const result = runReconform({ sliceRoot: options.sliceRoot, timelinePath, packagePath: options.packagePath });
  if (options.writePatch) {
    const patch = {
      patch_id: `patch_reconform_${Date.now().toString(36)}`,
      created_at: new Date().toISOString(),
      actor: "timeline-reconform-cli",
      reason: `reconform to ${path.basename(result.pkg.master)}`,
      base_timeline: "timeline.json",
      ops: result.ops,
    };
    fs.writeFileSync(path.join(options.sliceRoot, "timeline-edits.patch.json"), JSON.stringify(patch, null, 2));
  }
  console.log(options.json
    ? JSON.stringify({ ok: true, opCount: result.ops.length, failed: result.failed, matchCount: result.matchCount }, null, 2)
    : result.report);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main();
}
