// ANALOG — a composite-video round trip. The frame is encoded to a one-dimensional
// signal with colour modulated onto a subcarrier, that signal is degraded, and then
// decoded by a deliberately imperfect separator. Because the separation is
// imperfect, colour leaks into brightness and brightness leaks into colour.
//
// THAT LEAK IS THE WHOLE EFFECT. Dot crawl, rainbow shimmer on fine detail and
// sideways colour bleed are not three features — they are one phenomenon, and you
// get all three for free by doing the round trip honestly. Every cheaper approach
// (blur the chroma, overlay a checkerboard) produces a dead imitation, because it
// paints the symptoms instead of reproducing the cause.
//
// LINEAGE, so it is legible: the technique descends from the composite-video
// simulator family — a full YIQ encode/decode round trip — rather than from
// lookup-table filters, which are faster but cannot process arbitrary video. Ours
// is written from a description of the technique, which is a published broadcast
// standard from 1953, not from anyone's implementation.
//
// TWO DELIBERATE DEPARTURES from how this is usually built:
//
//   1. THE CARRIER IS DEFINED IN CYCLES PER LINE, not in Hz against an assumed
//      sample rate. The usual approach locks the sample rate to four times the
//      subcarrier so the quadrature tables collapse to integers — elegant, but it
//      silently assumes a particular line width and then needs a fudge factor
//      threaded through every filter. Cycles-per-line is resolution-independent
//      for free.
//   2. CONTINUOUS sin/cos rather than the four-entry tables. Slightly more
//      arithmetic, and it buys continuous phase error, which the table form cannot
//      express at all — it can only step in ninety-degree jumps.

// ONE DEFINITION OF THE SAMPLING GEOMETRY, because three places need it and two
// places computing the same property WILL drift — and this particular drift does
// not raise an error, it tints the picture.
//
// The shader walks a fixed number of taps; the windows are measured in pixels. If
// a window is wider than the reach it is silently truncated, and truncating the
// CHROMA window at a non-integer number of carrier periods demodulates luma into
// colour. Measured on a white UI capture at 1920 wide: a solid yellow-green cast.
export const ANALOG_TAP_REACH = 20;

// Real NTSC resolves only ~440 luma pixels across a line, so rendering at 1080p
// simulates detail the format could never carry. Capping the internal width is
// therefore the more authentic choice as well as the one that keeps the windows
// inside the reach.
export const ANALOG_INTERNAL_WIDTH = 720;

// The base window has to track the carrier because that is what demodulation
// needs. The bleed on top is a sideways smear in PIXELS — which is what the knob
// says it is. Scaling the whole window by the carrier period instead made the
// window explode with resolution and collide with the reach.
export function analogWindows(params, renderWidth) {
  const period = renderWidth / Math.max(params.subcarrierCycles, 1);
  const luma = Math.max(0.5, period * (1.0 - 0.45 * params.dotCrawl));
  const chroma = Math.max(1, period * 1.2 + params.chromaBleed * 4.0);
  return {
    period,
    lumaTaps: Math.min(ANALOG_TAP_REACH, luma),
    chromaTaps: Math.min(ANALOG_TAP_REACH, chroma),
    // Reported rather than hidden: a clamped window means the look asked for more
    // bleed than the engine can represent, and a caller deserves to know.
    clamped: chroma > ANALOG_TAP_REACH || luma > ANALOG_TAP_REACH,
  };
}

export const ANALOG_VERTEX = `#version 300 es
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

export const ANALOG_FRAGMENT = `#version 300 es
precision highp float;

const float TAU = 6.283185307;

// FCC 1953 matrices. Note these are the standard rounded pair rather than exact
// inverses, so the round trip is very slightly lossy even with every degradation
// off — which is true of the real thing too.
const mat3 RGB2YIQ = mat3(0.299,  0.596,  0.212,
                          0.587, -0.275, -0.523,
                          0.114, -0.321,  0.311);
const mat3 YIQ2RGB = mat3(1.0,    1.0,    1.0,
                          0.956, -0.272, -1.106,
                          0.621, -0.647,  1.703);

uniform sampler2D uSrc;
uniform vec2  uRes;
uniform float uCycles;        // subcarrier cycles per line; 188.5 is the real one
uniform float uPhaseAlt;      // 0 = frozen, 1 = 180 deg per line
uniform float uPhaseJitter;
uniform float uHueError;      // radians
uniform int   uFrame;         // FIELD index, from the VIDEO clock
uniform float uCombMix;       // 0 = notch separator, 1 = one-line comb
uniform float uLumaTaps;      // carrier periods in the luma window; detune to leak
uniform float uChromaTaps;    // wider -> more sideways bleed
uniform float uChromaQRatio;
uniform float uSharpen;
uniform float uSmear;
uniform float uNoise;
uniform float uChromaNoise;
uniform vec2  uChromaDelay;   // x px, y rows
uniform float uVertBlend;
uniform float uScanlines;
out vec4 fragColor;

float hash(vec2 p) { return fract(sin(dot(p, vec2(41.7, 289.3)) + float(uFrame) * 0.017) * 43758.5453); }

// PHASE IS A PURE FUNCTION OF (x, line, frame) — no state, no extra pass, three
// lines of arithmetic. And it is the single highest-value-per-cost thing in the
// whole effect: without the per-line flip and the per-frame advance the artifacts
// are static and read as compression damage. With them they CRAWL, and the crawl
// is what makes a viewer say "television" rather than "filter".
float phaseAt(float x, float line) {
  float flip   = uPhaseAlt * 0.5 * mod(line + float(uFrame), 2.0);
  float wobble = uPhaseJitter * (hash(vec2(line, 7.0)) - 0.5);
  return TAU * (uCycles * x / uRes.x + flip + wobble) + uHueError;
}

// TWO VERTICAL AXES, AND CONFLATING THEM FLIPS THE PICTURE. The raw fragment
// coordinate y counts UP from the bottom, and it is the only thing the
// texture may be sampled with — the source is uploaded with UNPACK_FLIP_Y_WEBGL,
// so raw y already reads the right way up. The BROADCAST scan line counts DOWN
// from the top, and it is what the carrier phase must advance along or the dot
// crawl crawls the wrong way. Measured: passing the scan line to the texture
// fetch renders the whole frame upside down while every artifact still looks
// plausible, which is why it survived a render check and failed a look.
float scanLine(float y) { return uRes.y - y; }

// One sample of the composite waveform. Kept local so it can be recomputed inside
// the decode loop — the composite never has to be materialised into a buffer, which
// is what keeps this to a single pass.
float composite(float x, float py) {
  vec2 uv = vec2(x, py) / uRes;
  vec3 c = RGB2YIQ * texture(uSrc, uv).rgb;
  float th = phaseAt(x, scanLine(py));

  // PRE-EMPHASIS APPLIED AFTER MODULATION, and the ordering is the trick. Because
  // the chroma subcarrier is already riding in the signal, sharpening boosts the
  // carrier along with luma detail — that is where the bright edge halos AND the
  // amplified dot crawl both come from. Sharpening before modulation looks
  // completely different and much less like video.
  //
  // THE HIGH-PASS MUST BE ZERO ON FLAT INPUT, and an earlier form of this line was
  // not: it carried a DC term equal to half the luma, so raising sharpen raised
  // the BRIGHTNESS of the whole frame instead of only the edges. Measured with
  // every other degradation off — mean luma went 72.8 at sharpen 0 to 104.5 at
  // sharpen 2, a 44% lift. It read as a washed-out picture rather than as a broken
  // control, which is why looking at it found this and a render check did not.
  float lft = (RGB2YIQ * texture(uSrc, (uv + vec2(-1.5 / uRes.x, 0.0))).rgb).x;
  float rgt = (RGB2YIQ * texture(uSrc, (uv + vec2( 1.5 / uRes.x, 0.0))).rgb).x;
  float hi  = c.x - 0.5 * (lft + rgt);
  float y = mix(c.x, c.x + hi * 0.5, uSharpen);

  float s = y + c.y * cos(th) + c.z * sin(th) * uChromaQRatio;
  // Noise injected into the COMPOSITE, before demodulation, so it decodes into
  // correlated luma-and-chroma grain rather than independent RGB static. That is
  // the difference between video noise and film grain.
  return s + uNoise * (hash(vec2(x, scanLine(py))) - 0.5);
}

void main() {
  vec2  px = gl_FragCoord.xy;
  float y  = px.y;

  // THE LOOP'S REACH IS PART OF THE CONTRACT, NOT AN IMPLEMENTATION DETAIL. A
  // window wider than TAP_REACH is silently truncated — and truncating the chroma
  // window at a non-integer number of carrier periods leaks luma into chroma,
  // which shows up as a colour cast over flat bright areas rather than as
  // anything that looks like a filter problem. The surface clamps the windows it
  // sends to this number; the two must be changed together.
  const int TAP_REACH = ${ANALOG_TAP_REACH};   // interpolated from the one definition above
  float sy = 0.0, si = 0.0, sq = 0.0, wy = 0.0, wc = 0.0;
  for (int k = -TAP_REACH; k <= TAP_REACH; ++k) {
    float fk = abs(float(k));
    // Causal, right-biased sampling. Real analog smear TRAILS, and a symmetric
    // blur is the thing that makes an imitation look digital.
    float x  = px.x + float(k) - uSmear * 6.0;

    float cur = composite(x, y);
    // ONE-LINE COMB. Because the carrier flips 180 degrees per line, chroma cancels
    // on the sum of two adjacent lines and doubles on their difference. It costs
    // one extra encode and nothing else — no buffer, no second pass.
    // The PRECEDING broadcast line sits one row HIGHER on screen, which is y + 1
    // in raw coordinates, not y - 1.
    float up  = composite(x, y + 1.0);
    float lum = mix(cur, 0.5 * (cur + up), uCombMix);
    float chr = mix(cur, 0.5 * (cur - up), uCombMix);

    // A luma window exactly one carrier period wide is a PERFECT carrier null.
    // Every deviation leaks residual subcarrier into luma, and that leak IS dot
    // crawl — so one float spans "expensive comb-filter television" to "cheap RF
    // modulator", with correct physics at both ends rather than a switch between
    // hand-tuned modes.
    float lw = max(0.0, 1.0 - fk / max(uLumaTaps, 0.5));
    float cw = max(0.0, 1.0 - fk / max(uChromaTaps, 0.5));

    float th = phaseAt(x, scanLine(y));
    sy += lum * lw;                 wy += lw;
    si += chr * cos(th) * cw;
    sq += chr * sin(th) * cw;       wc += cw;
  }

  // Factor two because the mean of cos squared over a cycle is one half.
  float Y = sy / max(wy, 1e-4);
  float I = 2.0 * si / max(wc, 1e-4);
  float Q = 2.0 * sq / max(wc, 1e-4);

  // CHROMA DELAY. Two lines of code and the strongest single "cheap tape" tell
  // there is: colour sitting visibly to the right of the object that owns it.
  if (uChromaDelay.x != 0.0 || uChromaDelay.y != 0.0) {
    float dx = px.x - uChromaDelay.x;
    // A POSITIVE delay pulls colour DOWN the screen, so it adds in raw
    // coordinates where the scan line would subtract.
    float dy = y + uChromaDelay.y;
    float ci = 0.0, cq = 0.0, cw2 = 0.0;
    for (int k = -8; k <= 8; ++k) {
      float fk = abs(float(k));
      float x = dx + float(k);
      float cur = composite(x, dy);
      float up  = composite(x, dy + 1.0);
      float chr = mix(cur, 0.5 * (cur - up), uCombMix);
      float w = max(0.0, 1.0 - fk / max(uChromaTaps, 0.5));
      float th = phaseAt(x, scanLine(dy));
      ci += chr * cos(th) * w; cq += chr * sin(th) * w; cw2 += w;
    }
    I = 2.0 * ci / max(cw2, 1e-4);
    Q = 2.0 * cq / max(cw2, 1e-4);
  }

  // Vertical chroma blend — tape chroma line-doubling. One line, sells VHS.
  if (uVertBlend > 0.0) {
    float cur = composite(px.x, y + 1.0);
    float up  = composite(px.x, y + 2.0);
    float chr = 0.5 * (cur - up);
    float th  = phaseAt(px.x, scanLine(y + 1.0));
    I = mix(I, 0.5 * (I + 2.0 * chr * cos(th)), uVertBlend);
    Q = mix(Q, 0.5 * (Q + 2.0 * chr * sin(th)), uVertBlend);
  }

  float cn = uChromaNoise * (hash(vec2(px.x * 0.31, scanLine(y))) - 0.5);
  vec3 rgb = YIQ2RGB * vec3(Y, I + cn, Q + cn);

  if (uScanlines > 0.0) rgb *= 1.0 - uScanlines * 0.5 * (0.5 + 0.5 * cos(scanLine(y) * 3.14159));

  fragColor = vec4(clamp(rgb, 0.0, 1.0), 1.0);
}`;
