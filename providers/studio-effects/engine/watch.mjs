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

// ONE DECODE PASS, TWO SIGNALS. Brightness and motion are both functions of the
// same pixels, so decoding twice would be paying twice to learn one thing.
//
// 32x18 greyscale, deliberately tiny. Neither signal needs detail: brightness is
// a mean and motion is how much that mean's PARTS moved, and at this size a whole
// 30-second clip is a few hundred kilobytes instead of gigabytes. Downscaling
// also does the low-pass for free, so film grain and compression noise stop
// registering as motion — which is the main way a naive frame-difference lies.
export function frames(file, { fps = 15, w = 32, h = 18, ffmpeg = "ffmpeg" } = {}) {
  const r = spawnSync(ffmpeg, [
    "-v", "error", "-i", file,
    "-vf", `fps=${fps},scale=${w}:${h},format=gray`,
    "-f", "rawvideo", "-",
  ], { maxBuffer: 1 << 28, encoding: "buffer" });
  if (r.status !== 0 || !r.stdout?.length) {
    return { ok: false, error: r.stderr?.toString().trim() || "could not read frames" };
  }
  const size = w * h;
  const n = Math.floor(r.stdout.length / size);
  const out = [];
  let prev = null;
  for (let i = 0; i < n; i++) {
    const f = r.stdout.subarray(i * size, (i + 1) * size);
    let sum = 0, diff = 0;
    for (let k = 0; k < size; k++) {
      sum += f[k];
      if (prev) diff += Math.abs(f[k] - prev[k]);
    }
    out.push({
      t: i / fps,
      brightness: sum / size / 255,
      // The first frame has nothing to compare against. Reporting 0 there would
      // put a false "still" at the start of every clip, so it inherits the next
      // frame's value once that exists.
      motion: prev ? diff / size / 255 : null,
    });
    prev = Buffer.from(f);
  }
  if (out.length > 1 && out[0].motion === null) out[0].motion = out[1].motion;
  return { ok: true, fps, frames: out };
}

// Rolling mean. Raw frame difference is spiky — a single compressed frame or a
// flash reads as a burst of movement — and a parameter driven by spikes twitches
// on things nobody perceives as motion.
export function smooth(series, key, window = 5) {
  const half = Math.floor(window / 2);
  return series.map((p, i) => {
    let sum = 0, n = 0;
    for (let k = Math.max(0, i - half); k <= Math.min(series.length - 1, i + half); k++) {
      const v = series[k][key];
      if (typeof v === "number") { sum += v; n++; }
    }
    return { t: p.t, v: n ? sum / n : 0 };
  });
}

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
