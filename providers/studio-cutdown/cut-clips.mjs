#!/usr/bin/env node
// The cut lane: consumes markers.jsonl, cuts each marked range FROM THE
// ORIGINALS at full quality (frame-accurate re-encode CRF 18), lands clips
// in the project bundle's media/renders as take material, and reindexes.
// Idempotent + self-healing: safe to run every watcher sweep.
//   - each marker is isolated: one ffmpeg failure never blocks the rest
//   - encodes are atomic: temp name -> rename, so partial files never count
//     as done and a delete during encode can't corrupt the lane
//   - a cut deleted via the UI (cut-deletions.jsonl) RETIRES its marker:
//     the lane will not resurrect it (re-punching the range works — only
//     deletions newer than the marker retire it)
//   - persistent failures leave a .cutfail.json sidecar (max 3 attempts)
//     that the server surfaces as FAILED instead of eternal CUTTING
// Usage: node cut-clips.mjs [--footage dir] [--bundle dir]
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { FFMPEG, FFPROBE } from "./bin.mjs";

const arg = (k, d) => { const i = process.argv.indexOf("--" + k); return i > -1 ? process.argv[i + 1] : d; };
// DE-BESPOKED (rig-studio port): --footage is the input folder, any project.
const FOOTAGE = arg("footage", path.join(os.homedir(), "openrig-videos", "footage"));
// was: a single hardcoded project. Clips land beside their footage by default.
const BUNDLE = arg("bundle", FOOTAGE);
const OUT = path.join(BUNDLE, "media", "renders");
const MAX_ATTEMPTS = 3;
fs.mkdirSync(OUT, { recursive: true });

const readJsonl = (p) => fs.existsSync(p)
  ? fs.readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
  : [];

const markersPath = path.join(FOOTAGE, "markers.jsonl");
if (!fs.existsSync(markersPath)) { console.log("no markers yet"); process.exit(0); }
const all = readJsonl(markersPath);
const deleted = new Set(all.filter((m) => m.deleted).map((m) => m.ref));
const marks = all.filter((m) => !m.deleted && !deleted.has(m.id) && m.out_s != null);
// note_edit records overlay the referenced marker's note
const noteEdits = {};
for (const m of all) if (m.note_edit && m.ref) noteEdits[m.ref] = m.note;

// UI cut-deletions retire markers older than the deletion (see header)
const cutDeletions = readJsonl(path.join(FOOTAGE, "cut-deletions.jsonl"));
const latestDeletion = {};
for (const d of cutDeletions) {
  if (!latestDeletion[d.clip] || d.ts > latestDeletion[d.clip]) latestDeletion[d.clip] = d.ts;
}

const tagOf = (m) => {
  const base = m.clip.replace(/\.(mp4|MP4)$/, "");
  return `${base}-${Number(m.in_s).toFixed(1)}-${Number(m.out_s).toFixed(1)}`.replace(/\./g, "_");
};

let made = 0, skipped = 0, retired = 0, failed = 0;
for (const m of marks) {
  const base = m.clip.replace(/\.(mp4|MP4)$/, "");
  const tag = tagOf(m);
  const outName = `cut-${tag}.mp4`;
  const out = path.join(OUT, outName);
  const failSide = path.join(OUT, `cut-${tag}.cutfail.json`);

  if (fs.existsSync(out)) { skipped++; continue; }
  const delTs = latestDeletion[outName];
  if (delTs && delTs > (m.ts || "")) { retired++; continue; }

  let prevFail = null;
  try { prevFail = JSON.parse(fs.readFileSync(failSide, "utf8")); } catch {}
  if (prevFail && prevFail.attempts >= MAX_ATTEMPTS) { failed++; continue; }

  // DE-BESPOKED: this looked ONLY in <footage>/originals, which assumed the
  // proxies/originals split the original project used. Still preferred when it
  // exists — cutting from the full-res original rather than a review proxy is
  // the point — but a plain folder of video now works, which is what "point it
  // at a folder and cut it down" means.
  // Case may differ between proxy and original (CLIP01.MP4 vs clip01.mp4).
  const exts = [".MP4", ".mp4", ".MOV", ".mov", ".webm"];
  const cand = [
    ...exts.map((e) => path.join(FOOTAGE, "originals", base + e)),
    ...exts.map((e) => path.join(FOOTAGE, base + e)),
    path.join(FOOTAGE, m.clip),
  ];
  const src = cand.find((p) => fs.existsSync(p));
  if (!src) { console.log(`SKIP ${m.id}: source for ${m.clip} not found`); continue; }

  const tmp = path.join(OUT, `.tmp-${outName}`);
  try {
    execFileSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y",
      "-ss", String(m.in_s), "-to", String(m.out_s), "-i", src,
      "-c:v", "libx264", "-crf", "18", "-preset", "medium",
      "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", tmp],
      { stdio: ["ignore", "inherit", "pipe"] });
    fs.renameSync(tmp, out);
    fs.rmSync(failSide, { force: true });
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    const attempts = (prevFail?.attempts || 0) + 1;
    fs.writeFileSync(failSide, JSON.stringify({
      marker: m.id, clip: m.clip, in_s: m.in_s, out_s: m.out_s, by: m.by,
      attempts, last_error: String(e.stderr || e.message || e).slice(0, 500),
      ts: new Date().toISOString(),
    }, null, 1));
    failed++;
    console.log(`FAIL ${outName} (attempt ${attempts}/${MAX_ATTEMPTS}): ${String(e.message || e).slice(0, 200)}`);
    continue;
  }

  // preview proxy for browser playback (full file stays for the NLE);
  // preview failure is non-fatal — /cutprev/ falls back to the full file
  try {
    const prevDir = path.join(OUT, "previews");
    fs.mkdirSync(prevDir, { recursive: true });
    const ptmp = path.join(prevDir, `.tmp-${outName}`);
    execFileSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", "-i", out,
      "-vf", "scale=960:-2", "-c:v", "libx264", "-preset", "veryfast", "-crf", "28",
      "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", ptmp], { stdio: "inherit" });
    fs.renameSync(ptmp, path.join(prevDir, outName));
  } catch (e) {
    console.log(`preview failed for ${outName} (non-fatal): ${String(e.message || e).slice(0, 120)}`);
  }

  fs.writeFileSync(out.replace(/\.mp4$/, ".marker.json"),
    JSON.stringify({ marker: m.id, by: m.by, note: noteEdits[m.id] != null ? noteEdits[m.id] : m.note, src: path.basename(src), in_s: m.in_s, out_s: m.out_s, cut_at: new Date().toISOString() }, null, 1));
  made++;
  console.log(`cut ${outName}  (${m.by}${m.note ? " — " + m.note : ""})`);
}
console.log(`done: ${made} cut, ${skipped} already existed, ${retired} retired by deletion, ${failed} failed, ${marks.length} markers total`);
