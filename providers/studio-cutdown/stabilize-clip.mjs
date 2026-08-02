#!/usr/bin/env node
// vid.stab two-pass stabilization for a cut clip. Deterministic lane.
// Produces <cut>-stab.mp4 beside the original cut. Tuned for handheld
// footage with no gyro stabilization.
// Usage: node stabilize-clip.mjs <cut.mp4>
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { FFMPEG, FFPROBE } from "./bin.mjs";

const src = process.argv[2];
if (!src || !fs.existsSync(src)) { console.error("no such clip"); process.exit(1); }
const argIdx = process.argv.indexOf("--smoothing");
const SMOOTHING = argIdx > -1 ? Number(process.argv[argIdx + 1]) : 12;
const TRIPOD = process.argv.includes("--tripod");
const lvlIdx = process.argv.indexOf("--level");
const LEVEL = lvlIdx > -1 ? process.argv[lvlIdx + 1]
  : (TRIPOD ? "locked" : SMOOTHING <= 8 ? "light" : SMOOTHING <= 16 ? "medium" : "strong");
const out = src.replace(/\.mp4$/, `-stab-${LEVEL}.mp4`);
if (fs.existsSync(out)) { console.log("exists:", path.basename(out)); process.exit(0); }
const trf = path.join(os.tmpdir(), path.basename(src) + ".trf");
const progFile = src.replace(/\.mp4$/, `.stabprogress-${LEVEL}`);
const durS = Number(execFileSync(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", src]).toString().trim());


import { spawn } from "node:child_process";
function runPass(args, frac0, frac1) {
  return new Promise((resolve, reject) => {
    const progPipe = path.join(os.tmpdir(), path.basename(src) + ".prog");
    fs.rmSync(progPipe, { force: true });
    const child = spawn(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", "-progress", progPipe, ...args], { stdio: "ignore" });
    const timer = setInterval(() => {
      try {
        const txt = fs.readFileSync(progPipe, "utf8");
        const m = [...txt.matchAll(/out_time_us=(\d+)/g)].pop();
        if (m && durS > 0) {
          const frac = Math.min(1, Number(m[1]) / 1e6 / durS);
          fs.writeFileSync(progFile, String(Math.round((frac0 + frac * (frac1 - frac0)) * 100)));
        }
      } catch {}
    }, 3000);
    child.on("exit", (code) => { clearInterval(timer); code === 0 ? resolve() : reject(new Error("ffmpeg exit " + code)); });
  });
}
const tp = TRIPOD ? ":tripod=1" : "";
await runPass(["-i", src, "-vf", `vidstabdetect=shakiness=6:accuracy=15${tp}:result=${trf}`, "-f", "null", "-"], 0, 0.5);
await runPass(["-i", src, "-vf", `vidstabtransform=input=${trf}:smoothing=${SMOOTHING}${tp}:optzoom=1:interpol=bicubic,unsharp=5:5:0.5:3:3:0.3`,
  "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-c:a", "copy", "-movflags", "+faststart", out], 0.5, 1);
fs.writeFileSync(out.replace(/\.mp4$/, ".json"),
  JSON.stringify({ level: LEVEL, smoothing: SMOOTHING, tripod: TRIPOD, engine: "local", at: new Date().toISOString() }));
fs.rmSync(trf, { force: true });
const prevDir = path.join(path.dirname(out), "previews");
fs.mkdirSync(prevDir, { recursive: true });
execFileSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", "-i", out,
  "-vf", "scale=960:-2", "-c:v", "libx264", "-preset", "veryfast", "-crf", "28",
  "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart",
  path.join(prevDir, path.basename(out))], { stdio: "inherit" });
fs.rmSync(progFile, { force: true });
console.log("stabilized:", path.basename(out));
