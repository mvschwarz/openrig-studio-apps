// WATCHING THE PICTURE, the companion to listening to the track. Same contract:
// it turns what is IN the clip into keyframes and nothing else, so a curve
// derived from the edit travels the same single evaluation path as one somebody
// typed. See listen.mjs for why that matters.
//
// The interesting signal here is the CUT. A real broadcast chain does not switch
// sources cleanly — the receiver loses sync for a few frames, the colour
// subcarrier unlocks, the picture tears and then re-locks. Almost every
// video-degradation effect is stateless per frame and therefore cannot express
// that, because it has no idea an edit happened. We do.
import { spawnSync } from "node:child_process";

// ffmpeg's own scene score: how different this frame is from the last, 0..1.
// Using its detector rather than writing one, because "how different are two
// frames" is exactly the problem it has already solved well, and a hand-rolled
// difference would be another thing to be wrong about.
export function cuts(file, { threshold = 0.3, ffmpeg = "ffmpeg" } = {}) {
  const r = spawnSync(ffmpeg, [
    "-v", "info", "-i", file,
    "-filter:v", `select='gt(scene,${threshold})',showinfo`,
    "-f", "null", "-",
  ], { maxBuffer: 1 << 28, encoding: "utf8" });
  const err = r.stderr || "";
  const times = [];
  for (const m of err.matchAll(/pts_time:([0-9.]+)/g)) times.push(Number(m[1]));
  // A clip with no cuts is a NORMAL answer. A continuous shot is a legitimate
  // thing to point this at and should not read as a failure.
  return { ok: true, cuts: times.sort((a, b) => a - b), threshold };
}

// A cut becomes a LOSS OF LOCK, not a flash. The shape is the point: the fault
// arrives on the cut frame, is worst immediately, and recovers over a few tenths
// of a second — because that is what re-acquiring sync looks like. A symmetric
// blip would read as a strobe, which is the thing this is trying not to be.
export function lockLossTrack(times, { rest, peak, recover = 0.45 } = {}) {
  const pts = [{ t: 0, v: rest }];
  for (const t0 of times) {
    const t = +t0.toFixed(3);
    pts.push({ t: Math.max(0, +(t - 0.02).toFixed(3)), v: rest, ease: "snap" });
    pts.push({ t, v: peak, ease: "snap" });
    // Two-stage recovery: most of it comes back fast, the last of it lingers.
    // One linear ramp back reads mechanical; sync does not recover linearly.
    pts.push({ t: +(t + recover * 0.35).toFixed(3), v: rest + (peak - rest) * 0.28, ease: "smooth" });
    pts.push({ t: +(t + recover).toFixed(3), v: rest, ease: "smooth" });
  }
  return pts.sort((a, b) => a.t - b.t);
}
