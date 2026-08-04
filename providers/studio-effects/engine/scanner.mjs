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
uniform float uAxis;         // 0 vertical head (writes columns), 1 horizontal
uniform float uWriteAt;      // where in the output this strip lands, 0..1
uniform float uHeadAt;       // where on the bed the head is reading, 0..1
uniform float uHeadWidth;
uniform float uHeadAngle;    // degrees off-axis
uniform float uSoftness;

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

  fragColor = vec4(outc * on, 1.0);
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
                 says: "which way the head lies — vertical writes columns, horizontal writes rows" },
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
  persistence: { type: "float", min: 0.9, max: 1, default: 1, group: "output",
                 says: "1 means the tape retains, which is what a tape does; below 1 the recording fades as it is laid down" },
  sourceRate:  { type: "float", min: -4, max: 4, default: 1, group: "output",
                 says: "clip time per unit of master clock; 0 freezes the frame and 1 is normal playback" },
};

export const SCANNER_PRESETS = {
  "flatbed":      { axis: "vertical", headPosition: 0, advance: 0, sourceRate: 0, read: "passthrough", headWidth: 6 },
  "slit-scan":    { axis: "vertical", headPosition: 0.5, advance: 0, sourceRate: 1, read: "passthrough", headWidth: 4 },
  "motion tape":  { axis: "vertical", headPosition: 0.5, advance: 0, sourceRate: 1, read: "motion", writeMode: "intensity", gain: 2.2, headWidth: 4 },
  "drift":        { axis: "vertical", headPosition: 0.5, advance: 0, sourceRate: 1, bedRate: 1.07, headRate: 1, read: "passthrough" },
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
  if (value["from-audio"] || value["from-video"]) return { derive: value };
  return null;
}

// The whole spec -> a track set the existing curve engine can evaluate, plus the
// constants that are not lanes. Returns what could NOT be compiled rather than
// throwing, because a spec with one bad lane should still show you the rest.
export function compileSpec(spec) {
  const duration = SECONDS(spec?.scan?.duration ?? 8, 8);
  const tracks = {};
  const derived = [];
  const constants = {};
  const problems = [];

  const GROUPS = {
    bed:      ["x", "y", "rotate", "scale", "rate"],
    head:     ["position", "width", "angle", "softness", "rate"],
    response: ["gain", "bias", "threshold"],
    write:    ["advance", "persistence"],
    source:   ["rate"],
  };
  const PREFIX = { bed: "bed", head: "head", response: "", write: "", source: "source" };
  const nameOf = (group, key) => {
    const p = PREFIX[group];
    return p ? p + key[0].toUpperCase() + key.slice(1) : key;
  };

  for (const [group, keys] of Object.entries(GROUPS)) {
    const block = spec?.[group];
    if (!block) continue;
    for (const key of keys) {
      if (!(key in block)) continue;
      const name = nameOf(group, key);
      const lane = compileLane(block[key], duration);
      if (lane === null) { problems.push(`${group}.${key} is not a form the lane grammar accepts`); continue; }
      if (Array.isArray(lane)) {
        if (lane.length === 1 && lane[0].t === 0) constants[name] = lane[0].v;
        else tracks[name] = lane;
      } else {
        derived.push({ param: name, spec: lane.derive });
      }
    }
  }

  // Enums and non-lane settings pass through untouched.
  for (const [group, key, out] of [
    ["response", "read", "read"], ["response", "invert", "invert"],
    ["write", "mode", "writeMode"], ["write", "direction", "direction"],
    ["head", "axis", "axis"],
  ]) {
    if (spec?.[group] && key in spec[group]) constants[out] = spec[group][key];
  }

  return {
    duration,
    unit: "seconds",
    source: spec?.source || {},
    output: spec?.output || {},
    constants,
    tracks,
    derived,
    problems,
  };
}
