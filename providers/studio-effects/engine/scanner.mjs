// SCANNER — a tape head for images and video.
//
// The tool this comes from contains no image processing at all: five drawImage
// calls, zero getImageData. Source rect equals destination rect, so the copy
// does no warping. THE DISTORTION IS TIME. A head advances a few pixels per
// frame across a canvas somebody is dragging, and each output column is the
// picture at a different instant under a different transform, accumulated into
// a buffer that is never cleared.
//
// That decides the architecture: this is not a filter with a time parameter. It
// is a RECORDER, and its output is state rather than a function of its inputs.
//
// THREE TRANSPORTS, THREE RATES. The bed moves, the head sweeps, and the source
// plays -- each at its own rate against one master clock. All rates at 1.0 is
// the locked case where the picture comes back; every interesting result is a
// disagreement. Rate differences are the instrument, not a hazard, and DECLARING
// every clock is what removes the real hazard: with no implicit clock left there
// is nothing to read by accident. The render loop's own frame rate never enters
// any calculation here.

export const SCANNER_VERTEX = `#version 300 es
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// ONE STRIP PER STEP. The draw is scissored to the write column, so the cost is
// O(strip) rather than O(frame) -- which is what the original does and why it
// can run an accumulation buffer at all.
//
// There is no ping-pong here and that is deliberate: the write pass never READS
// the recording, so the output texture can be its own target. Persistence below
// 1.0 is the one thing that would need the previous contents, and it is a
// separate fade pass rather than a reason to double the buffer.
export const SCANNER_WRITE_FRAGMENT = `#version 300 es
precision highp float;
out vec4 fragColor;

uniform sampler2D uSrc;      // the source frame, at scanTime
uniform sampler2D uPrev;     // the source one step earlier, for motion
uniform vec2  uOut;          // output buffer size
uniform vec2  uSrcSize;
uniform float uAxis;         // 0 = head lies vertical, travels sideways, writes columns
                             // 1 = head lies horizontal, travels upward, writes rows
uniform float uWriteAt;      // where in the output this strip lands, 0..1
uniform float uHeadAt;       // where on the bed the head is reading, 0..1
uniform float uHeadWidth;
uniform float uHeadAngle;    // degrees off-axis
uniform float uSoftness;    // feather, as a fraction of the strip width
uniform float uStripAt;     // where this strip starts, in output pixels
uniform float uStripW;      // its core width

// The bed transform -- the thing being scanned, and how it is being moved.
uniform vec2  uBedPos;
uniform float uBedRot;
uniform float uBedScale;

// Numbering IS the order of the enums below, and the surface derives the index
// from that list rather than carrying its own copy.
uniform float uRead;         // 0 passthrough 1 luma 2 motion 3 chroma 4 edge 5 difference
uniform float uWriteMode;    // 0 direct 1 intensity 2 palette 3 matte 4 displace
uniform float uGain;
uniform float uBias;
uniform float uThreshold;
uniform float uInvert;
uniform vec3  uTarget;       // the colour chroma looks for
uniform float uPalette;      // 0 ember 1 cold 2 mono 3 paper
uniform float uDisplace;     // how far the response bends the strip, in px

float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

// Four ramps, generated rather than sampled from a table -- a palette is a
// function of one number here, so there is nothing to keep in step.
vec3 ramp(float v) {
  v = clamp(v, 0.0, 1.0);
  if (uPalette < 0.5)      return vec3(pow(v,0.7), pow(v,1.9)*0.75, pow(v,3.4)*0.45);          // ember
  else if (uPalette < 1.5) return vec3(pow(v,3.0)*0.5, pow(v,1.6)*0.8, pow(v,0.75));           // cold
  else if (uPalette < 2.5) return vec3(v);                                                      // mono
  return mix(vec3(0.93,0.91,0.85), vec3(0.12,0.11,0.10), 1.0 - v);                              // paper
}

// The response, as one number, for whatever the head is set to read.
float respond(vec2 uv, vec2 texel, vec3 cur, out vec3 rgb) {
  rgb = cur;
  if (uRead < 0.5) return luma(cur);
  if (uRead < 1.5) { rgb = vec3(luma(cur)); return luma(cur); }
  if (uRead < 2.5) {
    // Temporal magnitude -- how much this point CHANGED, sign discarded.
    float d = abs(luma(cur) - luma(texture(uPrev, uv).rgb)) * 4.0;
    rgb = vec3(d); return d;
  }
  if (uRead < 3.5) {
    // Nearness to a colour, so the head can scan FOR something. Distance is
    // inverted because a response should be large where the thing IS.
    float d = 1.0 - clamp(length(cur - uTarget) / 1.732, 0.0, 1.0);
    rgb = vec3(d); return d;
  }
  if (uRead < 4.5) {
    // Gradient magnitude: structure kept, tone discarded.
    float l  = luma(cur);
    float lx = luma(texture(uSrc, uv + vec2(texel.x, 0.0)).rgb);
    float ly = luma(texture(uSrc, uv + vec2(0.0, texel.y)).rgb);
    float e  = length(vec2(l - lx, l - ly)) * 6.0;
    rgb = vec3(e); return e;
  }
  // SIGNED difference, centred on a half. Distinct from motion on purpose:
  // motion says how much changed, this says which WAY -- brighter above the
  // middle, darker below -- and the two look nothing alike on real footage.
  float s = (luma(cur) - luma(texture(uPrev, uv).rgb)) * 3.0 + 0.5;
  rgb = vec3(s); return s;
}

// Bed space -> source space. Inverted, because we are asking "what is under this
// point of the glass", not "where did this pixel go".
vec2 offGlass(vec2 p) {
  vec2 c = vec2(0.5);
  vec2 q = p - c - uBedPos / uSrcSize;
  float s = sin(-uBedRot), co = cos(-uBedRot);
  q = vec2(q.x * co - q.y * s, q.x * s + q.y * co);
  q /= max(0.0001, uBedScale);
  return q + c;
}

void main() {
  vec2 px = gl_FragCoord.xy;

  // WHERE ON THE BED THIS FRAGMENT READS. Along the head we run the full length
  // of the strip; across it we sit at the head's position, nudged by the angle
  // so a tilted head samples a diagonal.
  float along  = (uAxis < 0.5 ? px.y / uOut.y : px.x / uOut.x);
  float across = uHeadAt + tan(radians(uHeadAngle)) * (along - 0.5);
  vec2  bedUV  = uAxis < 0.5 ? vec2(across, along) : vec2(along, across);

  vec2 uv = offGlass(bedUV);
  // Off the glass reads as blank paper rather than as a repeat of the edge --
  // dragging the source out from under the head is a real gesture and it should
  // record as nothing being there.
  float on = (uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0) ? 1.0 : 0.0;
  uv = clamp(uv, 0.0, 1.0);

  vec2 texel = 1.0 / uSrcSize;
  vec3 cur = texture(uSrc, uv).rgb;
  vec3 rgb;
  float value = respond(uv, texel, cur, rgb);

  value = clamp((value + uBias) * uGain, 0.0, 1.0);
  if (value < uThreshold) value = 0.0;
  if (uInvert > 0.5) value = 1.0 - value;

  // DISPLACE — the response BENDS the strip rather than colouring it. The read
  // position is pushed along the head by the response, so a bright or fast
  // region physically drags the recording out of shape. This is the one write
  // mode that changes WHERE we sampled, so it re-reads rather than re-tinting.
  if (uWriteMode > 3.5) {
    vec2 push = (uAxis < 0.5) ? vec2(0.0, (value - 0.5) * uDisplace * texel.y * uSrcSize.y)
                              : vec2((value - 0.5) * uDisplace * texel.x * uSrcSize.x, 0.0);
    vec2 uv2 = clamp(uv + push * texel, 0.0, 1.0);
    fragColor = vec4(texture(uSrc, uv2).rgb * on, 1.0);
    return;
  }

  vec3 outc;
  if (uWriteMode < 0.5)      outc = rgb;                    // direct
  else if (uWriteMode < 1.5) outc = vec3(value);            // intensity
  else if (uWriteMode < 2.5) outc = ramp(value);            // palette
  else                       outc = cur * step(uThreshold + 0.001, value); // matte

  // FEATHER THE STRIP EDGES so neighbouring slices CROSSFADE rather than butt up
  // against each other. Without this every column boundary is a hard cut, and a
  // recording made of slices screams that it is made of slices. With it the
  // seams dissolve and it reads as one picture that happens to have vertical
  // themes.
  //
  // Alpha rather than a blur: the strips are written with blending on and
  // overlap by the feather amount, so the fade is a genuine crossfade with what
  // was already on the tape, not a smear applied afterwards.
  float a = 1.0;
  if (uSoftness > 0.001) {
    float pos = (uAxis < 0.5 ? gl_FragCoord.x : gl_FragCoord.y) - uStripAt;
    float f = max(1.0, uSoftness * uStripW);
    a = clamp(min(pos, uStripW - pos) / f, 0.0, 1.0);
    a = a * a * (3.0 - 2.0 * a);
  }
  fragColor = vec4(outc * on, a);
}`;

// A separate pass, only when persistence is below 1. Kept apart so the common
// case -- a tape that retains, which is what a tape does -- costs nothing.
export const SCANNER_FADE_FRAGMENT = `#version 300 es
precision highp float;
out vec4 fragColor;
uniform sampler2D uTape;
uniform vec2 uOut;
uniform float uPersistence;
void main() {
  vec3 c = texture(uTape, gl_FragCoord.xy / uOut).rgb;
  fragColor = vec4(c * uPersistence, 1.0);
}`;

export const READS  = ["passthrough", "luma", "motion", "chroma", "edge", "difference"];
export const WRITES = ["direct", "intensity", "palette", "matte", "displace"];
export const PALETTES = ["ember", "cold", "mono", "paper"];

// The knob surface, published so an agent drives from this rather than from our
// source. Grouped by transport, because the grouping IS the concept: bed, head,
// output. Same contract as the effect families -- name things for what a person
// perceives, never for the mechanism.
export const SCANNER_PARAMS = {
  bedX:        { type: "float", min: -2000, max: 2000, default: 0, group: "bed",
                 says: "slide the picture sideways on the glass; dragging it while the head sweeps is where the classic scanner shatter comes from" },
  bedY:        { type: "float", min: -2000, max: 2000, default: 0, group: "bed",
                 says: "slide the picture up and down on the glass" },
  bedRotate:   { type: "float", min: -180, max: 180, default: 0, group: "bed",
                 says: "turn the picture on the glass, in degrees" },
  bedScale:    { type: "float", min: 0.1, max: 4, default: 1, group: "bed",
                 says: "how large the picture sits on the glass" },
  bedRate:     { type: "float", min: -4, max: 4, default: 1, group: "bed",
                 says: "this transport's speed against the master clock; differs from headRate and the two beat against each other" },

  axis:        { type: "enum", values: ["vertical", "horizontal"], default: "vertical", group: "head",
                 says: "how the head LIES, which is perpendicular to how it TRAVELS — a vertical head stands upright and sweeps sideways, writing columns; a horizontal head lies flat and sweeps up the frame, writing rows. Watch a run and you see the travel, so the name will feel like the opposite of what you observe" },
  headPosition:{ type: "float", min: 0, max: 1, default: 0, group: "head",
                 says: "where the head is reading, across the bed; hold it still and you get slit-scan" },
  headWidth:   { type: "float", min: 1, max: 128, default: 6, group: "head",
                 says: "how thick a strip the head takes, in pixels" },
  headAngle:   { type: "float", min: -60, max: 60, default: 0, group: "head",
                 says: "tilt the head off-axis so it samples a diagonal" },
  headSoftness:{ type: "float", min: 0, max: 1, default: 0, group: "head",
                 says: "feather the strip's edges; 0 is a hard slit" },
  headRate:    { type: "float", min: -4, max: 4, default: 1, group: "head",
                 says: "the head transport's speed against the master clock" },

  read:        { type: "enum", values: READS, default: "passthrough", group: "response",
                 says: "what the head responds to — the picture itself, its brightness, or where it changed" },
  gain:        { type: "float", min: 0, max: 8, default: 1, group: "response",
                 says: "how hard the response is driven before it is written" },
  bias:        { type: "float", min: -1, max: 1, default: 0, group: "response",
                 says: "shift the response up or down before gain" },
  threshold:   { type: "float", min: 0, max: 1, default: 0, group: "response",
                 says: "responses below this are written as nothing" },
  invert:      { type: "bool", default: false, group: "response",
                 says: "flip the response" },
  targetColor: { type: "color", default: "#c84a2a", group: "response",
                 says: "the colour `chroma` looks for; the response is large where the picture is near it" },

  writeMode:   { type: "enum", values: WRITES, default: "direct", group: "output",
                 says: "what lands on the tape — the strip as read, the response as greyscale or through a colour ramp, the source only where the response clears the threshold, or the response BENDING the strip" },
  palette:     { type: "enum", values: PALETTES, default: "ember", group: "output",
                 says: "the ramp `palette` writes through" },
  displace:    { type: "float", min: 0, max: 200, default: 40, group: "output",
                 says: "how far the response bends the strip when writeMode is displace, in pixels" },
  advance:     { type: "float", min: -4, max: 4, default: 0, group: "output",
                 says: "output columns per head step. 0 FITS the recording to the scan duration, which is what you want unless you are deliberately mismatching; 1 is one column per step, and every other value is a deliberate disagreement with the sweep" },
  frames:      { type: "int", min: 1, max: 48, default: 1, group: "output",
                 says: "how many instants each column holds. 1 is a still — every column is a single moment. Above 1 the column becomes a WINDOW, and the stack plays back with every column advancing through its own window at once, so one continuous movement in the source becomes a row of bands each animating a different fragment of it" },
  fps:         { type: "int", min: 4, max: 30, default: 12, group: "output", pairsWith: ["frames"],
                 says: "playback rate of the frame stack; only means anything when frames is above 1" },
  persistence: { type: "float", min: 0.9, max: 1, default: 1, group: "output",
                 says: "1 means the tape retains, which is what a tape does; below 1 the recording fades as it is laid down" },
  sourceRate:  { type: "float", min: -4, max: 4, default: 1, group: "output",
                 says: "clip time per unit of master clock; 0 freezes the frame and 1 is normal playback" },
};

// PRESETS ARE CHAIN SPECS NOW, not flat parameter sets — because the thing
// worth naming is a whole signal path, and a preset that could not express a
// second stage would be a preset for a tool we no longer have.
export const SCANNER_PRESETS = {
  "flatbed": {
    scan: { duration: "12s" },
    stages: [{ id: "a", source: { rate: 0 },
      head: { axis: "vertical", position: { ramp: [0, 1] }, width: 6 },
      response: { read: "passthrough" }, write: { mode: "direct", advance: 0 } }],
  },
  "slit-scan": {
    scan: { duration: "14s" },
    stages: [{ id: "a", source: { rate: 1 },
      head: { axis: "vertical", position: 0.5, width: 4 },
      response: { read: "passthrough" }, write: { mode: "direct", advance: 0 } }],
  },
  "motion tape": {
    scan: { duration: "14s" },
    stages: [{ id: "a", source: { rate: 1 },
      head: { axis: "vertical", position: { ramp: [0, 1] }, width: 5 },
      response: { read: "motion", gain: 2.2 },
      write: { mode: "displace", displace: 110, advance: 0 } }],
  },
  // The one the chain exists for: stage a turns X into time, stage b turns Y
  // into time as well, so the final picture has no spatial axis left.
  "both axes are time": {
    scan: { duration: "18s" },
    stages: [
      { id: "a", source: { rate: 1 },
        head: { axis: "vertical", position: { ramp: [0, 1] }, width: 4 },
        response: { read: "passthrough" }, write: { mode: "direct", advance: 0 } },
      { id: "b", source: { from: "a" },
        head: { axis: "horizontal", position: { ramp: [0, 1] }, width: 4 },
        response: { read: "passthrough" }, write: { mode: "direct", advance: 0 } },
    ],
  },
  // Dubbing: the same axis scanned twice, so each pass compounds the last one's
  // warp. Tape to tape, generation loss.
  "second generation": {
    scan: { duration: "18s" },
    clocks: { drift: { rate: 1.11 } },
    stages: [
      { id: "a", source: { rate: 1 }, bed: { clock: "drift" },
        head: { axis: "vertical", position: { ramp: [0, 1] }, width: 5 },
        response: { read: "passthrough" }, write: { mode: "direct", advance: 0 } },
      { id: "b", source: { from: "a" }, bed: { clock: "drift" },
        head: { axis: "vertical", position: { ramp: [0, 1] }, width: 5 },
        response: { read: "passthrough" }, write: { mode: "direct", advance: 0 } },
    ],
  },
  // Time itself speeds up with the music: the clock's RATE is a lane, so the
  // bed does not move to the beat -- its clock accelerates on it.
  "time runs on the beat": {
    scan: { duration: "16s" },
    clocks: { pulse: { rate: { "from-audio": { mode: "envelope", range: [0.25, 2.6] } } } },
    stages: [
      { id: "a", source: { rate: 1 }, bed: { clock: "pulse", x: { ramp: [0, -320] } },
        head: { axis: "vertical", position: { ramp: [0, 1] }, width: 4 },
        response: { read: "passthrough" }, write: { mode: "direct", advance: 0 } },
      { id: "b", source: { from: "a" },
        head: { axis: "horizontal", position: { ramp: [0, 1] }, width: 4 },
        response: { read: "edge", gain: 1.0 },
        write: { mode: "palette", palette: "cold", advance: 0 } },
    ],
  },
};


// ---- THE SPEC ------------------------------------------------------------
//
// A look is a point; a spec is a path. The look library records where the knobs
// are, a spec records what they DO over time. It is a program, and it is what an
// agent composes with.
//
// THE LOAD-BEARING RULE: A SPEC COMPILES TO KEYFRAMES. It does not get its own
// evaluator. Generators already emit keyframes rather than evaluating
// themselves, so there is exactly one evaluation path; a second evaluator that
// only the spec understood would be the shader-duplication defect in new
// clothes. Compiling also makes a spec inspectable before it is ever run.

const SECONDS = (v, dur) => {
  if (typeof v === "number") return v;
  const s = String(v).trim();
  if (s.endsWith("ms")) return parseFloat(s) / 1000;
  if (s.endsWith("s"))  return parseFloat(s);
  if (s.endsWith("%"))  return (parseFloat(s) / 100) * dur;
  const n = parseFloat(s);
  // A bare number under 1 on a time field is a fraction of the run, which is how
  // people write "halfway" without knowing the duration.
  return Number.isFinite(n) ? (n <= 1 ? n * dur : n) : 0;
};

// One scalar lane -> keyframes. Every form the grammar accepts lands here, and
// nothing downstream needs to know which form it came from.
export function compileLane(value, duration) {
  if (value === undefined || value === null) return null;
  if (typeof value === "number") return [{ t: 0, v: value }];

  if (Array.isArray(value)) {
    return value.map((k) => ({ t: SECONDS(k.t, duration), v: k.v, ease: k.ease || "smooth" }));
  }
  if (value.keyframes) {
    return value.keyframes.map((k) => ({ t: SECONDS(k.t, duration), v: k.v, ease: k.ease || "smooth" }));
  }
  if (value.ramp) {
    const [a, b] = value.ramp;
    return [{ t: 0, v: a, ease: value.ease || "linear" }, { t: duration, v: b, ease: value.ease || "linear" }];
  }
  if (value.pulse) {
    // Compiled at author time rather than evaluated at run time, so the result
    // is inspectable and there is still one evaluator.
    const p = value.pulse;
    const every = SECONDS(p.every ?? 0.5, duration);
    const [lo, hi] = p.range || [0, 1];
    const out = [];
    for (let t = 0; t <= duration + 1e-6; t += Math.max(0.01, every)) {
      out.push({ t: +t.toFixed(4), v: lo, ease: "snap" });
      out.push({ t: +(t + Math.min(every * 0.5, 0.012)).toFixed(4), v: hi, ease: "snap" });
      out.push({ t: +(t + every * 0.6).toFixed(4), v: lo, ease: "smooth" });
    }
    return out;
  }
  // from-audio and from-video are resolved by the server, which has the clip.
  // HAND — motion with a person in it.
  //
  // A ramp is machine motion: constant velocity, no correction, no hesitation.
  // The original scanner's whole character came from somebody DRAGGING a photo
  // on the glass, and a hand does none of those things. Rather than imitate the
  // LOOK of that, reproduce the MECHANISM, which is well characterised:
  //
  //   MINIMUM JERK. A reaching movement between two points follows
  //   10u^3 - 15u^4 + 6u^5 -- not a line, and not a smoothstep. It accelerates
  //   slowly, peaks mid-flight and settles gently. This is the single biggest
  //   difference between hand motion and an eased ramp.
  //   OVERSHOOT AND CORRECTION. A fast reach lands past its target and comes
  //   back. That small reversal is most of what reads as alive.
  //   HESITATION. A hand stops -- not rhythmically, at irregular via-points.
  //   TREMOR. Physiological tremor sits around 8-12Hz at tiny amplitude and
  //   never switches off, so even a held hand is never quite still.
  //
  // Sampled densely to keyframes like every other generator, so there is still
  // exactly ONE evaluation path and the result stays inspectable and editable.
  if (value.hand) {
    const h = value.hand;
    const [lo, hi] = h.range || [0, 1];
    const pace       = Math.max(0.05, h.pace ?? 0.55);
    const tremor     = h.tremor ?? 0.22;
    const hesitation = Math.min(0.9, Math.max(0, h.hesitation ?? 0.35));
    const overshoot  = h.overshoot ?? 0.28;
    const hz         = Math.min(60, Math.max(10, h.hz ?? 30));
    // Deterministic, because a look you cannot reproduce is not a look.
    let s = ((h.seed ?? 1) >>> 0) || 1;
    const rnd = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
    const minJerk = (u) => u * u * u * (10 - 15 * u + 6 * u * u);

    // Via-points first: where the hand goes, how long the reach takes, and where
    // it pauses. Irregular by construction -- a regular interval is a metronome,
    // which is the thing being avoided.
    const legs = [];
    let t = 0, from = lo + rnd() * (hi - lo);
    while (t < duration) {
      const travel = (0.45 + rnd() * 1.1) / pace;
      let to = lo + rnd() * (hi - lo);
      if (Math.abs(to - from) < (hi - lo) * 0.12) to = from + (rnd() < 0.5 ? -1 : 1) * (hi - lo) * 0.3;
      to = Math.max(lo, Math.min(hi, to));
      const over = rnd() < 0.55 ? (to - from) * overshoot * (0.4 + rnd()) : 0;
      legs.push({ t0: t, t1: Math.min(duration, t + travel), from, to, over });
      t += travel;
      if (rnd() < hesitation) t += (0.15 + rnd() * 0.9) / pace;
      from = to;
    }

    const out = [];
    const step = 1 / hz;
    const phase = rnd() * 6.283;
    const tremHz = 8 + rnd() * 4;
    for (let x = 0; x <= duration + 1e-9; x += step) {
      const leg = legs.find((l) => x >= l.t0 && x <= l.t1);
      let v;
      if (!leg) {
        const past = legs.filter((l) => l.t1 <= x);
        v = past.length ? past[past.length - 1].to : (legs[0] ? legs[0].from : lo);
      } else {
        const u = leg.t1 > leg.t0 ? (x - leg.t0) / (leg.t1 - leg.t0) : 1;
        const m = minJerk(Math.min(1, Math.max(0, u)));
        v = leg.from + (leg.to - leg.from) * m + leg.over * Math.sin(Math.PI * m) * m;
      }
      v += Math.sin(x * tremHz * 6.283 + phase) * tremor * (hi - lo) * 0.012;
      out.push({ t: +x.toFixed(3), v: +Math.max(lo, Math.min(hi, v)).toFixed(4), ease: "linear" });
    }
    return out;
  }

  if (value["from-audio"] || value["from-video"]) return { derive: value };
  return null;
}

// ---- CLOCKS --------------------------------------------------------------
//
// A clock is a named function from the master clock to a transport's own time.
// Naming them rather than giving each transport a bare rate is what makes a
// CHAIN tractable: two stages have six transports, and six independent rate
// numbers is noise, while three named clocks that six transports REFERENCE is a
// structure you can reason about.
//
//   clocks:
//     drift: { rate: 1.07 }                                  # runs slightly fast
//     slow:  { rate: 0.4 }
//     pulse: { from-audio: { mode: envelope, range: [0.2, 3] } }   # TIME ITSELF
//                                                                  # speeds up
//                                                                  # with the music
//
// The last one is the reason this is worth the indirection. A rate that is
// itself a lane means the clock ACCELERATES — the transport is not moving to
// the music, time is. That is unreachable with a scalar rate per transport.
//
// `master` always exists and is the identity. Anything referencing an undefined
// clock falls back to master and SAYS SO in problems, rather than silently
// running at a rate nobody chose.
export const CLOCK_MASTER = "master";

// ---- STAGES --------------------------------------------------------------
//
// A stage is one complete scanner: a source, a bed, a head, a response, a write
// target. `source.from` names an EARLIER stage instead of a clip, and that is
// the whole chaining mechanism.
//
// WHY CHAINING IS NOT JUST "TWO EFFECTS": a scanner turns one SPATIAL axis into
// TIME. Stage one with a vertical head makes its output's x-axis time. Stage two
// reading that with a HORIZONTAL head makes y time as well -- so the final image
// has no spatial axis left, both are time at different orders. Chain them on the
// SAME axis instead and each pass compounds the last one's warp, which is
// dubbing: generation loss, tape to tape.
//
// It also retires a limit recorded in the original research: true slit-scan
// "needs each row from a different input frame, i.e. a ring buffer of 1080
// frames -- not viable". A chained stage gets that buffer for free, because the
// upstream tape IS the materialised time history.

const laneGroups = {
  bed:      ["x", "y", "rotate", "scale"],
  head:     ["position", "width", "angle", "softness"],
  response: ["gain", "bias", "threshold"],
  write:    ["advance", "persistence"],
};
const passthroughKeys = [
  ["response", "read", "read"], ["response", "invert", "invert"],
  ["response", "targetColor", "targetColor"],
  ["write", "mode", "writeMode"], ["write", "palette", "palette"],
  ["write", "displace", "displace"], ["write", "direction", "direction"],
  ["write", "frames", "frames"], ["write", "fps", "fps"],
  ["head", "axis", "axis"],
];
const nameOf = (group, key) =>
  group === "bed" || group === "head"
    ? group + key[0].toUpperCase() + key.slice(1)
    : key;

function compileStage(st, duration, problems, index) {
  const tracks = {}, constants = {}, derived = [];
  for (const [group, keys] of Object.entries(laneGroups)) {
    const block = st?.[group];
    if (!block) continue;
    for (const key of keys) {
      if (!(key in block)) continue;
      const name = nameOf(group, key);
      const lane = compileLane(block[key], duration);
      if (lane === null) { problems.push(`stage ${index}: ${group}.${key} is not a form the lane grammar accepts`); continue; }
      if (Array.isArray(lane)) {
        if (lane.length === 1 && lane[0].t === 0) constants[name] = lane[0].v;
        else tracks[name] = lane;
      } else derived.push({ param: name, spec: lane.derive });
    }
  }
  for (const [group, key, out] of passthroughKeys) {
    if (st?.[group] && key in st[group]) constants[out] = st[group][key];
  }
  return {
    id: st?.id || `stage${index}`,
    // WHEN THIS STAGE STARTS WRITING. A chained stage can only record what its
    // upstream has already laid down, so running both from t=0 leaves a causal
    // frontier -- a diagonal edge where the downstream head outran the tape it
    // was reading. Letting the upstream get ahead is the whole remedy, and it is
    // a property of the SPEC rather than a knob, because it is about the shape
    // of the run and not about the look.
    startAt: SECONDS(st?.startAt ?? 0, duration),
    // WHICH CLOCK EACH TRANSPORT FOLLOWS. Declared per transport, defaulting to
    // master, so the locked case needs no ceremony and a drift is always visible
    // in the spec rather than implied by a number.
    clocks: {
      bed:    st?.bed?.clock    || CLOCK_MASTER,
      head:   st?.head?.clock   || CLOCK_MASTER,
      write:  st?.write?.clock  || CLOCK_MASTER,
      source: st?.source?.clock || CLOCK_MASTER,
    },
    source: st?.source || {},
    from: st?.source?.from || null,
    constants, tracks, derived,
  };
}

// The whole spec -> a track set the existing curve engine can evaluate, plus the
// constants that are not lanes. Returns what could NOT be compiled rather than
// throwing, because a spec with one bad lane should still show you the rest.
export function compileSpec(spec) {
  const duration = SECONDS(spec?.scan?.duration ?? 8, 8);
  const problems = [];

  // CLOCKS FIRST, because stages reference them by name.
  const clocks = { [CLOCK_MASTER]: { rate: 1 } };
  for (const [name, def] of Object.entries(spec?.clocks || {})) {
    if (name === CLOCK_MASTER) { problems.push("clock 'master' is built in and cannot be redefined"); continue; }
    const lane = compileLane(def?.rate ?? def, duration);
    if (lane === null) { problems.push(`clock ${name}: rate is not a form the lane grammar accepts`); continue; }
    if (Array.isArray(lane)) {
      clocks[name] = lane.length === 1 && lane[0].t === 0
        ? { rate: lane[0].v }
        : { rateTrack: lane };
    } else {
      clocks[name] = { derive: lane.derive };
    }
  }

  // STAGES. A bare (stage-less) spec is treated as a one-stage chain so the
  // simple case stays simple and there is still only ONE code path.
  const rawStages = Array.isArray(spec?.stages) && spec.stages.length
    ? spec.stages
    : [{ id: "a", source: spec?.source, bed: spec?.bed, head: spec?.head,
         response: spec?.response, write: spec?.write }];
  const stages = rawStages.map((st, i) => compileStage(st, duration, problems, i));

  // Validate the graph: a stage may only read a stage BEFORE it, or a clip.
  // Refusing forward and self references is what keeps the chain a chain --
  // feedback is a real and interesting thing, but it needs its own deliberate
  // mechanism rather than arriving as an ordering accident.
  const seen = new Set();
  for (const st of stages) {
    if (st.from) {
      if (st.from === st.id) problems.push(`stage ${st.id} reads itself; feedback is not expressible yet`);
      else if (!seen.has(st.from)) problems.push(`stage ${st.id} reads ${st.from}, which is not an earlier stage`);
    }
    seen.add(st.id);
    for (const [transport, clock] of Object.entries(st.clocks)) {
      if (!clocks[clock]) {
        problems.push(`stage ${st.id}: ${transport} names clock '${clock}', which is not defined -- using master`);
        st.clocks[transport] = CLOCK_MASTER;
      }
    }
  }

  return {
    duration, unit: "seconds",
    output: spec?.output || {},
    clocks, stages, problems,
  };
}
