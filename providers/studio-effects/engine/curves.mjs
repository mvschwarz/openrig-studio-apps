// CURVES — a parameter as a function of time, which is the difference between a
// filter and a motion-graphics tier.
//
// A still filter applied to every frame is a photo effect. The same effect with a
// curve on one knob is motion graphics, and the cost of the distinction is this
// file rather than anything in the renderers.
//
// THE REPRESENTATION IS KEYFRAMES AND NOTHING ELSE. Every generator below emits
// keyframes rather than evaluating itself at render time, so there is exactly ONE
// evaluation path — which means a curve an agent wrote by hand, a curve built
// from an audio envelope, and a curve produced by a preset are all the same data
// and all reproduce identically in preview and in export. A second evaluator that
// only export uses is the same class of defect as a second copy of the shader.
//
// A CURVE IS DATA, and that is the whole point: it can be keyframed by a person,
// stored on a timeline card, derived from a beat track, or written by an agent
// that has never seen this code.

// WHAT CAN BE INTERPOLATED AND WHAT CANNOT — the one real design constraint.
//
// Numbers move continuously. A palette does not: there is no colour halfway
// between "gameboy" and "cga", and a tile set is not a quantity. Interpolating
// them would either produce nonsense or silently pick one, so those types HOLD
// their value until the next keyframe instead. Saying so is better than a
// surprise.
const INTERPOLATABLE = new Set(["float", "int"]);

const EASINGS = {
  // Named for what they look like, not for their formula.
  linear: (u) => u,
  smooth: (u) => u * u * (3 - 2 * u),
  // "hold" is a step: the value does not move until the next keyframe lands. It
  // is what an enum gets whether it asks for it or not.
  hold: () => 0,
  // Fast departure, slow arrival, and the reverse. These read as "snap" and
  // "settle" to anyone watching.
  snap: (u) => 1 - (1 - u) * (1 - u),
  settle: (u) => u * u,
};

export const EASING_NAMES = Object.keys(EASINGS);

// Normalise a track to sorted keyframes. Written defensively because the most
// likely author of a track is an agent composing JSON, and an out-of-order
// keyframe is a plausible mistake rather than a broken caller.
function normaliseTrack(points) {
  if (!Array.isArray(points)) return [];
  return points
    .filter((p) => p && Number.isFinite(Number(p.t)))
    .map((p) => ({ t: Number(p.t), v: p.v, ease: EASINGS[p.ease] ? p.ease : "linear" }))
    .sort((a, b) => a.t - b.t);
}

// Evaluate one track at a time. Outside the keyframe range the value HOLDS at
// the nearest end rather than extrapolating — extrapolating a curve past its
// last keyframe invents motion the author never asked for, and on a looping clip
// it would keep going forever.
function evalTrack(points, t, interpolatable) {
  if (!points.length) return undefined;
  if (t <= points[0].t) return points[0].v;
  if (t >= points[points.length - 1].t) return points[points.length - 1].v;

  let i = 0;
  while (i < points.length - 1 && points[i + 1].t <= t) i++;
  const a = points[i], b = points[i + 1];

  if (!interpolatable) return a.v;           // enums, colours and booleans step
  const span = b.t - a.t;
  const u = span <= 0 ? 1 : (t - a.t) / span;
  const eased = EASINGS[b.ease] ? EASINGS[b.ease](u) : u;
  return Number(a.v) + (Number(b.v) - Number(a.v)) * eased;
}

// THE TIME BASE IS DECLARED, NOT ASSUMED. A curve written against a 14-second
// clip and replayed on a 40-second one should either stretch or hold its
// absolute timings, and only the author knows which — so the spec says.
//
//   fraction : t runs 0..1 across whatever the clip is (portable between clips)
//   seconds  : t is absolute (a cut at 2.5s stays at 2.5s)
export function curveTime(spec, timeSeconds, durationSeconds) {
  if ((spec?.unit || "fraction") === "seconds") return timeSeconds;
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 0;
  return Math.max(0, Math.min(1, timeSeconds / durationSeconds));
}

// Evaluate a whole spec into a parameter patch. Returns ONLY the parameters the
// curves actually drive, so it layers cleanly on top of a preset or hand-set
// values rather than replacing them.
//
// `family` is the schema entry, used to decide what may be interpolated and to
// keep the result inside the declared range. A curve that overshoots is the
// normal case when something else is driving — an agent reaching for an extreme,
// a track written against an older range — so it is clamped and REPORTED, the
// same contract coerce() already offers.
export function evalCurves(spec, family, timeSeconds, durationSeconds) {
  const notes = [];
  const patch = {};
  const tracks = spec?.tracks || {};
  const t = curveTime(spec, timeSeconds, durationSeconds);

  for (const [key, raw] of Object.entries(tracks)) {
    const p = family?.params?.[key];
    if (!p) { notes.push(`no such parameter: ${key}`); continue; }
    const points = normaliseTrack(raw);
    if (!points.length) { notes.push(`${key}: track has no usable keyframes`); continue; }

    const interpolatable = INTERPOLATABLE.has(p.type);
    let v = evalTrack(points, t, interpolatable);
    if (v === undefined) continue;

    if (interpolatable) {
      const n = Number(v);
      if (!Number.isFinite(n)) { notes.push(`${key}: ${v} is not a number`); continue; }
      const c = Math.min(p.max ?? Infinity, Math.max(p.min ?? -Infinity, n));
      if (c !== n) notes.push(`${key}: ${+n.toFixed(3)} clamped to ${c}`);
      v = p.type === "int" ? Math.round(c) : c;
    } else if (p.type === "enum" && !p.values.includes(v)) {
      notes.push(`${key}: ${v} is not one of ${p.values.join("/")}`);
      continue;
    } else if (p.type === "bool") {
      v = Boolean(v);
    }
    patch[key] = v;
  }
  return { t, patch, notes };
}

// ---- GENERATORS -----------------------------------------------------------
// Each one EMITS KEYFRAMES. None of them is a second kind of curve.

// A ONE-FRAME SPIKE AT EACH CUT is the oldest trick in analog video and it costs
// three keyframes. Given the times of the edits, this is the whole feature.
export function pulses(times, { from = 0, to = 1, width = 0.06, ease = "snap" } = {}) {
  const pts = [{ t: 0, v: from, ease: "linear" }];
  for (const at of [...times].sort((a, b) => a - b)) {
    const lead = Math.max(0, at - width * 0.15);
    if (lead > pts[pts.length - 1].t) pts.push({ t: lead, v: from, ease: "linear" });
    pts.push({ t: at, v: to, ease });
    pts.push({ t: at + width, v: from, ease: "settle" });
  }
  return pts;
}

// BIND A KNOB TO A BEAT ENVELOPE. The music work already produces beat times, so
// this is the shortest path from "effects exist" to "effects are part of how we
// make things".
export function fromBeats(beatTimes, opts = {}) {
  return pulses(beatTimes, opts);
}

// A slow sweep across the clip — the plain case, written out so nobody hand-rolls
// a two-keyframe array and gets the easing argument in the wrong place.
export function ramp(from, to, { ease = "smooth", start = 0, end = 1 } = {}) {
  return [{ t: start, v: from, ease: "linear" }, { t: end, v: to, ease }];
}
