// LISTENING TO THE MATERIAL. Everything else in this engine turns an AUTHOR's
// intent into keyframes. This turns the CLIP's own content into them.
//
// It emits KEYFRAMES and nothing else, which is the whole reason it can exist at
// all: the curve engine already interpolates, clamps, reports and animates them,
// so an audio-driven curve is the same data as a hand-written one and travels
// down the same single evaluation path. A "reactive mode" that watched the clock
// at render time would be a second evaluator, and a second evaluator is the
// duplicated-shader defect in another costume.
//
// It also means the result is INSPECTABLE and EDITABLE. An agent can generate a
// curve from a track, a person can look at the keyframes, and either can nudge
// one before rendering. Reactivity that only exists inside the renderer is
// reactivity you cannot argue with.
import { spawnSync } from "node:child_process";

// One mono pass at a low rate. Loudness envelopes do not need fidelity — they
// need enough resolution to catch a transient, and 8kHz gives 8 samples per
// millisecond of attack, which is far more than any parameter can act on.
const RATE = 8000;

export function pcm(file, ffmpeg = "ffmpeg") {
  const r = spawnSync(ffmpeg, [
    "-v", "error", "-i", file, "-vn", "-ac", "1", "-ar", String(RATE),
    "-f", "s16le", "-",
  ], { maxBuffer: 1 << 28, encoding: "buffer" });
  if (r.status !== 0 || !r.stdout || !r.stdout.length) {
    // A CLIP WITH NO SOUND IS A NORMAL ANSWER, not a broken tool. Raw ffmpeg
    // stderr here sends the reader off debugging a codec when the truth is
    // simply that this video has no audio track, so the plain sentence wins and
    // the raw text is kept alongside for the case where it IS a real failure.
    const raw = r.stderr?.toString().trim() || "";
    const silent = /does not contain any stream|Output file is empty|Stream map .* matches no streams/i.test(raw);
    return {
      ok: false,
      error: silent ? "this source has no audio track, so there is nothing to listen to" : (raw || "could not read audio"),
      detail: raw || null,
    };
  }
  const buf = r.stdout;
  const n = Math.floor(buf.length / 2);
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++) s[i] = buf.readInt16LE(i * 2) / 32768;
  return { ok: true, samples: s, rate: RATE, seconds: n / RATE };
}

// RMS per window. Root-mean-square rather than peak because peak follows single
// clicks and RMS follows perceived loudness, and a parameter driven by peaks
// twitches on things nobody hears.
export function envelope(samples, rate, hz = 30) {
  const win = Math.max(1, Math.round(rate / hz));
  const out = [];
  for (let i = 0; i + win <= samples.length; i += win) {
    let sum = 0;
    for (let k = 0; k < win; k++) { const v = samples[i + k]; sum += v * v; }
    out.push({ t: i / rate, v: Math.sqrt(sum / win) });
  }
  return out;
}

// Onsets: a rise in loudness that stands out from the recent past. Compared
// against a LOCAL median rather than a global threshold, because a global one
// finds everything in a loud passage and nothing in a quiet one — which is the
// same failure as absolute L* on a low-key frame that this tier already fixed
// once in the tile family.
export function onsets(env, { sensitivity = 1.6, minGap = 0.12 } = {}) {
  const hits = [];
  const look = 12;
  let last = -Infinity;
  for (let i = 1; i < env.length; i++) {
    const from = Math.max(0, i - look);
    const past = env.slice(from, i).map((e) => e.v).sort((a, b) => a - b);
    if (!past.length) continue;
    const med = past[Math.floor(past.length / 2)];
    const rise = env[i].v - env[i - 1].v;
    if (env[i].v > med * sensitivity && rise > 0 && env[i].t - last >= minGap) {
      hits.push({ t: env[i].t, strength: med > 0 ? env[i].v / med : 1 });
      last = env[i].t;
    }
  }
  return hits;
}

// Normalise an envelope into a parameter's range, by PERCENTILE rather than by
// min/max. One loud transient would otherwise define the top of the range and
// flatten everything else into the bottom — the identical mistake absolute
// levelling made on real footage, and the reason autoLevels exists.
export function envelopeTrack(env, { min, max, lowPct = 5, highPct = 95, gamma = 1 } = {}) {
  const vals = env.map((e) => e.v).sort((a, b) => a - b);
  if (!vals.length) return [];
  const at = (p) => vals[Math.min(vals.length - 1, Math.max(0, Math.round((p / 100) * (vals.length - 1))))];
  const lo = at(lowPct), hi = at(highPct);
  const span = hi - lo;
  return env.map((e) => {
    let u = span > 1e-9 ? (e.v - lo) / span : 0;
    u = Math.min(1, Math.max(0, u));
    if (gamma !== 1) u = Math.pow(u, gamma);
    return { t: +e.t.toFixed(3), v: +(min + (max - min) * u).toFixed(4) };
  });
}

// An onset becomes a HIT: jump to the top, fall back. Three keyframes each, so
// the shape is legible in the data rather than hidden in an evaluator.
export function onsetTrack(hits, { min, max, decay = 0.22 } = {}) {
  const pts = [{ t: 0, v: min }];
  for (const h of hits) {
    const t = +h.t.toFixed(3);
    pts.push({ t: Math.max(0, +(t - 0.012).toFixed(3)), v: min, ease: "snap" });
    pts.push({ t, v: max, ease: "snap" });
    pts.push({ t: +(t + decay).toFixed(3), v: min, ease: "smooth" });
  }
  return pts.sort((a, b) => a.t - b.t);
}
