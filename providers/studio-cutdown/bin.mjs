// WHERE THIS PROVIDER'S BINARIES COME FROM.
//
// cut-clips and stabilize-clip called execFileSync("ffmpeg", …) with a BARE
// NAME, which resolves against whatever PATH happens to hold. On a box without
// ffmpeg that is an ENOENT at the moment a user punches a cut — invisible at
// install, fatal in use. a fresh Linux VPS typically has node and git and NO ffmpeg.
//
// ffmpeg/ffprobe now ship WITH this provider (ffmpeg-static / ffprobe-static),
// so `npm ci` is sufficient on any of the three platforms they build for.
// PATH stays as the fallback: a box with a real ffmpeg — extra codecs, hardware
// encoders — should be able to use it, and an operator override stays possible.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const packaged = (name) => {
  try {
    return name === "ffmpeg" ? require("ffmpeg-static") : require("ffprobe-static").path;
  } catch { return null; }
};

export const FFMPEG = packaged("ffmpeg") || "ffmpeg";
export const FFPROBE = packaged("ffprobe") || "ffprobe";
