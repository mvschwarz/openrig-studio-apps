// MOTION — the field a codec computes, computed ourselves.
//
// Datamosh is not a filter. It is what happens when motion compensation runs
// against the wrong reference: a P-frame says "move these blocks by these
// vectors", and if the picture those vectors were measured against is gone, the
// image melts along the motion while the colour stays where it was.
//
// A shader cannot read the encoder's vectors — those live in the bitstream. So
// this computes its own by block matching, which is the same operation an
// encoder performs when it MAKES those vectors. The artifact is then generated
// by the same mechanism; only the source of the vectors differs.
//
// WHY THIS LOOKS LIKE DATAMOSH AND OPTICAL FLOW DOES NOT: a good flow field is
// smooth, dense and sub-pixel, and moshing with one produces melting rather than
// the blocky slide people recognise. Real vectors are per-macroblock and
// quantised, so the whole field is a coarse staircase. We reproduce that on
// purpose — the field is computed AT BLOCK RESOLUTION and never interpolated.
// Throwing the precision away is the step that makes it read as compression.
//
// The field is also the honest place to start looking. A vector field is a real
// object with a real failure mode: in flat areas every candidate matches equally
// well and the search returns noise. That is not a bug to hide — it is why
// datamosh smears wildly across skies and holds together on faces — so the
// estimator reports a CONFIDENCE alongside each vector rather than pretending
// every block is equally known.

export const MOTION_VERTEX = `#version 300 es
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// PASS ONE — block matching. Rendered to a target of one texel per macroblock,
// which is not an optimisation: one vector per block IS the representation. At
// 1920x1080 with 16px blocks that is a 120x68 target, so the search runs 8,160
// times rather than 2,073,600 times.
export const MOTION_ESTIMATE_FRAGMENT = `#version 300 es
precision highp float;
out vec4 fragColor;

uniform sampler2D uCur;
uniform sampler2D uPrev;
uniform vec2  uRes;      // full resolution of the source, in pixels
uniform float uBlock;    // macroblock size in pixels; 16 is what H.264 uses
uniform float uSearch;   // how far to look, in pixels
uniform float uTaps;     // samples per axis inside a block

float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

// Sum of absolute differences on luma, which is what encoders actually match on
// — chroma is subsampled and contributes little, and matching on it mostly finds
// compression noise. Subsampled inside the block: comparing all 256 pixels costs
// 256 fetches per candidate and buys nothing, because the result is quantised to
// the block grid regardless.
float sad(vec2 origin, vec2 off, vec2 texel) {
  float n = clamp(floor(uTaps), 2.0, 8.0);
  float stepPx = uBlock / n;
  float sum = 0.0;
  for (int j = 0; j < 8; j++) {
    if (float(j) >= n) break;
    for (int i = 0; i < 8; i++) {
      if (float(i) >= n) break;
      vec2 p = origin + (vec2(float(i), float(j)) + 0.5) * stepPx;
      float a = luma(texture(uCur,  p * texel).rgb);
      float b = luma(texture(uPrev, (p + off) * texel).rgb);
      sum += abs(a - b);
    }
  }
  return sum / (n * n);
}

void main() {
  vec2 texel  = 1.0 / uRes;
  vec2 origin = floor(gl_FragCoord.xy) * uBlock;

  // The zero-motion cost is the baseline every candidate is judged against, and
  // it is also what makes confidence meaningful: a block that matches just as
  // well unmoved has no motion worth reporting.
  float zeroCost = sad(origin, vec2(0.0), texel);
  vec2  best     = vec2(0.0);
  float bestCost = zeroCost;

  // THREE-STEP SEARCH, the classic one. Exhaustive search over a 32px radius is
  // 4,225 candidates; this is about 45 and finds the same vector for real
  // footage. It can settle in a local minimum — that is a known property of the
  // algorithm, not a defect here, and encoders live with it too.
  float stepSize = max(1.0, floor(uSearch * 0.5));
  for (int s = 0; s < 6; s++) {
    if (stepSize < 1.0) break;
    vec2  roundBest = best;
    float roundCost = bestCost;
    for (int k = 0; k < 9; k++) {
      if (k == 4) continue;
      vec2 d = vec2(float(k - (k / 3) * 3) - 1.0, float(k / 3) - 1.0) * stepSize;
      vec2 cand = best + d;
      if (abs(cand.x) > uSearch || abs(cand.y) > uSearch) continue;
      float c = sad(origin, cand, texel);
      if (c < roundCost) { roundCost = c; roundBest = cand; }
    }
    best = roundBest;
    bestCost = roundCost;
    stepSize = floor(stepSize * 0.5);
  }

  // How much motion compensation actually helped. Near zero means the block is
  // flat or the motion is unfindable, and a mosh driven by those vectors is
  // guessing — which is exactly where real datamosh goes wild.
  float confidence = zeroCost > 0.0001
    ? clamp((zeroCost - bestCost) / zeroCost, 0.0, 1.0)
    : 0.0;

  // Encoded into 8 bits per axis across the full search range. At radius 32 that
  // is a quarter-pixel step, which is the precision H.264 vectors carry anyway.
  vec2 enc = best / max(uSearch, 1.0) * 0.5 + 0.5;
  fragColor = vec4(enc, confidence, 1.0);
}`;

// PASS TWO — THE MOSH ITSELF. An accumulator that keeps applying motion without
// ever refreshing its reference.
//
// This is the whole trick. A decoder holds a reference picture and each P-frame
// says "move these blocks, then add this correction". Datamosh is what you get
// when the correction and the keyframe are gone but the motion keeps arriving:
// the buffer slides along vectors measured from a picture it no longer contains.
//
// TWO KNOBS DO THE REAL WORK, and they are different in kind:
//   uRefresh  — a flat amount of the live picture let back in every frame. This
//               is the crude one; at 1.0 you have ordinary video, at 0 the
//               buffer never recovers and melts to abstraction.
//   uResidual — the live picture let back in ONLY WHERE PREDICTION FAILED,
//               weighted by the estimator's own confidence. This is what a real
//               codec does: it sends a residual exactly where motion
//               compensation could not do the job. It is the difference between
//               a smear and something that still reads as a picture, because
//               the parts the model cannot predict keep being corrected while
//               the parts it can predict slide away.
export const MOSH_ACCUMULATE_FRAGMENT = `#version 300 es
precision highp float;
out vec4 fragColor;

uniform sampler2D uAcc;     // what the buffer held last frame
uniform sampler2D uSrc;     // the live picture
uniform sampler2D uField;
uniform vec2  uRes;
uniform float uSearch;
uniform float uStrength;
uniform float uQuantise;
uniform float uRefresh;     // flat share of the live picture per frame
uniform float uResidual;    // share let in where the prediction was poor
uniform float uReset;       // 1 on an I-frame — take the live picture whole

void main() {
  vec2 uv    = gl_FragCoord.xy / uRes;
  vec2 texel = 1.0 / uRes;
  vec4 f     = texture(uField, uv);
  vec2 mv    = (f.rg * 2.0 - 1.0) * uSearch;
  if (uQuantise > 0.5) mv = floor(mv / uQuantise + 0.5) * uQuantise;

  vec3 live = texture(uSrc, uv).rgb;
  if (uReset > 0.5) { fragColor = vec4(live, 1.0); return; }

  // THE DISPLACEMENT. Reading the accumulator rather than the source is the
  // entire difference between datamosh and a warp: a warp moves the current
  // picture, this moves whatever the buffer has accumulated, so error compounds
  // frame over frame instead of resetting.
  vec3 moved = texture(uAcc, uv - mv * uStrength * texel).rgb;

  // Where confidence is low the prediction failed, so that is where a real
  // encoder would have spent bits on a correction.
  float correction = clamp(uRefresh + uResidual * (1.0 - f.b), 0.0, 1.0);
  fragColor = vec4(mix(moved, live, correction), 1.0);
}`;

// PASS THREE — look at it. The field is rendered with NEAREST sampling and the
// macroblock grid drawn on, because the coarseness is the property worth seeing:
// if this came out smooth, the mosh built on it would be wrong.
export const MOSH_FRAGMENT = `#version 300 es
precision highp float;
out vec4 fragColor;

uniform sampler2D uField;
uniform sampler2D uSrc;
uniform sampler2D uPrev;
uniform sampler2D uAcc;
uniform vec2  uRes;
uniform float uBlock;
uniform float uSearch;
// The view number is the ORDER OF THE show ENUM IN THE SCHEMA:
// 0 mosh, 1 field, 2 magnitude, 3 confidence, 4 compensated.
uniform float uShow;
uniform float uGrid;
uniform float uStrength;
uniform float uQuantise;    // snap vectors to this many pixels

vec3 hsv(float h, float s, float v) {
  vec3 k = mod(vec3(5.0, 3.0, 1.0) + h * 6.0, 6.0);
  return v - v * s * clamp(min(k, 4.0 - k), 0.0, 1.0);
}

void main() {
  vec2 uv    = gl_FragCoord.xy / uRes;
  vec2 texel = 1.0 / uRes;
  vec4 f     = texture(uField, uv);
  vec2 mv    = (f.rg * 2.0 - 1.0) * uSearch;

  // Quantising the vector is what keeps neighbouring blocks sliding in LOCKSTEP
  // rather than each drifting its own way. Real vectors are already coarse; this
  // is the knob that decides how coarse ours pretend to be.
  if (uQuantise > 0.5) mv = floor(mv / uQuantise + 0.5) * uQuantise;

  float mag = length(mv);
  vec3 col;

  if (uShow < 0.5) {
    // The accumulator, straight out. Everything that makes it a mosh already
    // happened in the pass that wrote it.
    col = texture(uAcc, uv).rgb;
  } else if (uShow < 1.5) {
    // Direction as hue, speed as brightness — the standard way a flow field is
    // read. sqrt on the magnitude so slow motion is still visible instead of
    // sitting in the black end of the ramp.
    float h = atan(mv.y, mv.x) / 6.28318530718 + 0.5;
    col = hsv(h, 1.0, sqrt(clamp(mag / max(uSearch, 1.0), 0.0, 1.0)));
  } else if (uShow < 2.5) {
    col = vec3(sqrt(clamp(mag / max(uSearch, 1.0), 0.0, 1.0)));
  } else if (uShow < 3.5) {
    // Confidence alone: bright where the match is trustworthy, dark where the
    // estimator is guessing. The dark regions are where a mosh will smear.
    col = vec3(f.b);
  } else {
    // The mechanism itself, one step: fetch the PREVIOUS frame displaced by this
    // block's vector. With a correct field this reconstructs the current frame
    // almost exactly — which is the point of motion compensation, and the proof
    // that the vectors mean something. Break the reference and it moshes.
    col = texture(uPrev, uv - mv * uStrength * texel).rgb;
  }

  // Grid on the diagnostic views only — drawing it over the mosh would be
  // furniture on top of the effect.
  if (uGrid > 0.5 && uShow > 0.5 && uShow < 2.5) {
    vec2 inBlock = mod(gl_FragCoord.xy, max(uBlock, 2.0));
    if (inBlock.x < 1.0 || inBlock.y < 1.0) col = mix(col, vec3(0.12), 0.55);
  }
  fragColor = vec4(col, 1.0);
}`;

// uShow's numbering is the ORDER OF THE show ENUM IN THE SCHEMA. The surface
// derives the number from that list rather than carrying its own copy, so there
// is one definition of what "confidence" means and no way for the two to drift.
