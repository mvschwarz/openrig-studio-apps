// SCAN — a photograph pulled through a flatbed scanner while somebody slides it
// around on the glass. Rows stay sharp; each one is displaced sideways by a
// different amount, so straight edges shatter into offset ribbons and anything
// dragged off the platen leaves flat paper.
//
// THE IDEA WORTH KEEPING: the effect is not image processing, it is TIME. Output
// row y was captured when the scan head was at y, and the image had some offset
// at that instant. So the whole thing collapses to one gather:
//
//     out(x, y) = src(x − dx(t(y)), y − dy(t(y)))
//
// which is a plain row-offset remap and is mathematically the same shape as a
// rolling-shutter warp. No accumulation buffer, no animation loop, deterministic
// and instantly scrubbable — an agent changes a number and gets a new frame.
//
// WHAT MAKES IT OURS RATHER THAN A REBUILD: in the tools that inspired this, the
// interesting displacement comes from a HUMAN DRAGGING THE PHOTO. Automate that
// with a sine and it looks like a sine — monotonously periodic. The displacement
// here is a PARAMETRIC PATH: drift, sine, correlated jitter and sparse hard
// tears, generated into a lookup texture. That is what makes it drivable by
// something other than a mouse.

// The GLSL is exported as a string because it has exactly ONE definition and two
// consumers: the interactive preview in the browser, and headless export in this
// provider. Two copies would drift, and the day they drift is the day an export
// stops matching the preview it was approved from — the worst bug an effects tool
// can have, because you only discover it after committing to a render.
export const SCAN_FRAGMENT = `#version 300 es
precision highp float;

uniform sampler2D uSrc;
// The path LUT is an ORDINARY 8-BIT TEXTURE carrying 16-bit fixed point, not a
// float texture. Float textures with filtering are a portability minefield: on one
// renderer here OES_texture_float_linear reported as supported, the data read back
// correctly through a framebuffer, and sampling in a shader still returned zero.
// The displacement silently vanished and the picture merely looked "subtle" —
// which is the worst way for a shader to fail, because nothing errors.
//
// A pixel offset does not need float precision. 16 bits over ±PATH_RANGE px is
// finer than a pixel, and 8-bit textures work everywhere with no extension.
uniform sampler2D uPath;   // rg = dx (16-bit fixed), b = rotation, a = scale
uniform vec2  uRes;
uniform vec2  uAxis;       // (0,1) scan down, (1,0) scan across
uniform float uAmp;        // master displacement, px
uniform float uChroma;     // per-channel scan-time skew, px
uniform float uGrain;
uniform float uGrainScale;
uniform vec3  uPaper;
uniform float uMono;
uniform float uSubpixel;
uniform float uSeed;
out vec4 fragColor;

float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; return fract(p * (p + p)); }

// The source as it stood when the head was at scan position s.
const float PATH_RANGE = 1024.0;   // must match the encoder in scan.mjs

vec4 tapAt(vec2 px, float s) {
  vec4  p = texture(uPath, vec2(s / max(dot(uRes, uAxis), 1.0), 0.5));
  float dx = ((p.r * 255.0 * 256.0 + p.g * 255.0) / 65535.0 * 2.0 - 1.0) * PATH_RANGE;
  vec2  d = vec2(dx, 0.0) * uAmp;
  if (uSubpixel < 0.5) d = floor(d + 0.5);
  float a = (p.b * 2.0 - 1.0) * 0.7854;          // +/- 45 degrees
  float k = max(0.5 + p.a * 1.5, 1e-3);           // 0.5 .. 2.0
  vec2  c = uRes * 0.5;
  vec2  q = (px - d - c) / k;
  q = mat2(cos(a), sin(a), -sin(a), cos(a)) * q + c;
  vec2 uv = q / uRes;
  // Dragged off the glass. Flat paper here is what makes the warp read as a
  // SCANNER rather than as a generic distortion — it is the strongest single cue
  // in the effect and it costs one branch.
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return vec4(uPaper, 1.0);
  return texture(uSrc, uv);
}

// Photoshop 'overlay'. The grain is a contrast modulation rather than additive
// noise, which is why it reads as dirt on the glass instead of film grain.
float ovl(float b, float s) { return b < 0.5 ? 2.0 * b * s : 1.0 - 2.0 * (1.0 - b) * (1.0 - s); }

void main() {
  vec2  px = gl_FragCoord.xy;
  // gl_FragCoord.y COUNTS UP FROM THE BOTTOM, and the source texture is uploaded
  // flipped so the picture sits the right way up. Feeding the raw y into the path
  // lookup therefore runs the scan head UPWARDS: displacement accumulates from the
  // bottom of the frame, which is backwards for a device whose head starts at the
  // top. Measured, not reasoned about — a pure downward drift put the whole offset
  // on the top row and none on the bottom.
  float s  = dot(vec2(px.x, uRes.y - px.y), uAxis);

  // Once displacement is a function of scan TIME, per-channel skew is two extra
  // taps — and it stays true to the metaphor, because a three-pass CCD scanner
  // really does sample the channels at different instants.
  vec3 col = (uChroma == 0.0)
    ? tapAt(px, s).rgb
    : vec3(tapAt(px, s + uChroma).r, tapAt(px, s).g, tapAt(px, s - uChroma).b);

  col = mix(col, vec3(dot(col, vec3(0.299, 0.587, 0.114))), uMono);

  float n = hash11(floor(dot(floor(px / max(uGrainScale, 1.0)), vec2(1.0, 7919.0))) + uSeed);
  col = mix(col, vec3(ovl(col.r, n), ovl(col.g, n), ovl(col.b, n)), uGrain * 0.45);

  fragColor = vec4(col, 1.0);
}`;

export const SCAN_VERTEX = `#version 300 es
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// Deterministic value noise with an explicit correlation length. A hand shake is
// not white noise — it is smooth over a few tens of pixels — so uncorrelated
// jitter reads as digital chatter rather than as a person holding something.
function valueNoise(i, scale, seed) {
  const x = i / Math.max(scale, 1);
  const i0 = Math.floor(x);
  const f = x - i0;
  const h = (n) => {
    let t = Math.sin((n + seed) * 12.9898) * 43758.5453;
    return (t - Math.floor(t)) * 2 - 1;
  };
  const smooth = f * f * (3 - 2 * f);
  return h(i0) * (1 - smooth) + h(i0 + 1) * smooth;
}

// THE PATH IS THE PRODUCT. It is data, not code, which is what lets an agent —
// or a keyframe track, or an audio envelope — supply one without touching the
// shader.
export const PATH_RANGE = 1024;

export function buildPath(length, p = {}) {
  const {
    wobbleAmount = 24, wobbleFrequency = 3, wobblePhase = 0,
    jitterAmount = 0, jitterScale = 24,
    tearAmount = 0, tearFrequency = 6,
    drift = 0, rotationDrift = 0, scaleDrift = 1,
    seed = 0,
  } = p;

  // Encoded to 8-bit here rather than in the surface, so the browser preview and
  // any headless render read exactly the same bytes.
  const out = new Uint8Array(length * 4);
  const tears = [];
  if (tearAmount > 0 && tearFrequency > 0) {
    // Tears are SPARSE IMPULSES HELD FOR A RUN OF ROWS, not per-row noise. A hand
    // does not jerk for one scanline; it slips, and the slip persists. Held runs
    // are what produce the hard cliffs — per-row randomness just looks like more
    // jitter.
    const n = Math.max(1, Math.round(tearFrequency));
    for (let k = 0; k < n; k++) {
      const at = Math.floor(((valueNoise(k * 97 + 3, 1, seed) + 1) / 2) * length);
      const run = 2 + Math.floor(((valueNoise(k * 131 + 7, 1, seed) + 1) / 2) * 18);
      tears.push({ at, run, mag: valueNoise(k * 57 + 11, 1, seed) * tearAmount });
    }
  }

  for (let i = 0; i < length; i++) {
    const t = length <= 1 ? 0 : i / (length - 1);
    let dx = drift * t;
    dx += Math.sin((i / Math.max(length, 1)) * wobbleFrequency * Math.PI * 2 + (wobblePhase * Math.PI) / 180) * wobbleAmount;
    if (jitterAmount) dx += valueNoise(i, jitterScale, seed + 13) * jitterAmount;
    for (const tr of tears) if (i >= tr.at && i < tr.at + tr.run) dx += tr.mag;

    const q = Math.round(((Math.max(-PATH_RANGE, Math.min(PATH_RANGE, dx)) / PATH_RANGE) + 1) / 2 * 65535);
    out[i * 4 + 0] = (q >> 8) & 255;
    out[i * 4 + 1] = q & 255;
    const rot = (rotationDrift * t) / 45;                       // -1 .. 1
    out[i * 4 + 2] = Math.round((Math.max(-1, Math.min(1, rot)) + 1) / 2 * 255);
    const sc = (1 + (scaleDrift - 1) * t - 0.5) / 1.5;          // 0 .. 1
    out[i * 4 + 3] = Math.round(Math.max(0, Math.min(1, sc)) * 255);
  }
  return out;
}
