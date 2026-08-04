// CODEC — what lossy compression actually does to a picture.
//
// This is the DCT round trip a JPEG or an intra-coded video frame performs: the
// image is cut into 8x8 blocks, each block is transformed into frequency
// coefficients, those coefficients are DIVIDED BY A QUANTISATION TABLE and
// rounded, and then the whole thing is inverted. Everything people recognise as
// "compression artifacts" — the blocking, the ringing around hard edges, the
// colour smearing, the mosquito noise — falls out of that rounding. None of it is
// drawn on.
//
// WHY IMPLEMENT THE TRANSFORM RATHER THAN FAKE IT: a filter that draws 8x8 squares
// gives you blocking and nothing else. Real quantisation destroys high-frequency
// coefficients FIRST, which is why a compressed picture keeps its flat areas and
// falls apart at edges — and why ringing appears only next to contrast. You
// cannot get that by blurring or by drawing squares; it is a property of what was
// thrown away.
//
// The quantisation table is the actual Annex K luminance table from the JPEG
// specification, scaled by quality the same way libjpeg scales it. So "quality
// 30" here means what quality 30 means in a real encoder.

// JPEG Annex K, table K.1 (luminance) and K.2 (chrominance), in zigzag-free
// natural order.
export const Q_LUMA = [
  16, 11, 10, 16, 24, 40, 51, 61,
  12, 12, 14, 19, 26, 58, 60, 55,
  14, 13, 16, 24, 40, 57, 69, 56,
  14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77,
  24, 35, 55, 64, 81, 104, 113, 92,
  49, 64, 78, 87, 103, 121, 120, 101,
  72, 92, 95, 98, 112, 100, 103, 99,
];
export const Q_CHROMA = [
  17, 18, 24, 47, 99, 99, 99, 99,
  18, 21, 26, 66, 99, 99, 99, 99,
  24, 26, 56, 99, 99, 99, 99, 99,
  47, 66, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
];

// The zigzag order, so "keep the first N coefficients" means what it means in a
// real encoder — lowest frequencies first.
export const ZIGZAG = [
   0, 1, 8,16, 9, 2, 3,10,
  17,24,32,25,18,11, 4, 5,
  12,19,26,33,40,48,41,34,
  27,20,13, 6, 7,14,21,28,
  35,42,49,56,57,50,43,36,
  29,22,15,23,30,37,44,51,
  58,59,52,45,38,31,39,46,
  53,60,61,54,47,55,62,63,
];

// libjpeg's scaling: quality 50 uses the table as published, above 50 it shrinks
// toward 1, below 50 it grows. Reproduced rather than invented so a number here
// means the same thing as the same number in any other encoder.
export function scaleTable(table, quality) {
  const q = Math.min(100, Math.max(1, quality));
  const s = q < 50 ? 5000 / q : 200 - q * 2;
  return table.map((v) => Math.min(255, Math.max(1, Math.floor((v * s + 50) / 100))));
}

const glArray = (name, arr) => `const float ${name}[64] = float[64](${arr.map((v) => v.toFixed(1)).join(",")});`;

export const CODEC_VERTEX = `#version 300 es
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

export const CODEC_FRAGMENT = `#version 300 es
precision highp float;
out vec4 fragColor;

uniform sampler2D uSrc;
uniform vec2  uRes;
uniform float uQuality;      // luma quality, 1..100
uniform float uChromaQuality;
uniform float uBlock;        // block size in pixels (8 is the real one)
uniform vec2  uGridOffset;    // shift the block grid off alignment
uniform float uKeep;         // how many zigzag coefficients survive, 1..64
uniform float uJitter;       // per-block quantiser variation
uniform float uDcBias;       // push DC around, per block, independently
uniform float uDcDrift;      // ...and this one PROPAGATES along the row
uniform float uDriftRate;    // how often a block corrupts its DC delta
uniform float uRestart;      // blocks between DC prediction resets
uniform float uSubsample;    // 0 = 4:4:4, 1 = 4:2:2, 2 = 4:2:0
uniform float uSeed;

${glArray("Q_LUMA", Q_LUMA)}
${glArray("Q_CHROMA", Q_CHROMA)}
const int ZZ[64] = int[64](${ZIGZAG.join(",")});

float hash(vec2 p) {
  return fract(sin(dot(p + uSeed, vec2(127.1, 311.7))) * 43758.5453);
}

// Rec.601, the space JPEG and composite video both quantise in. Chroma is
// deliberately treated separately from luma because that is the whole reason
// colour survives compression worse than brightness does.
vec3 toYCbCr(vec3 c) {
  return vec3(
     0.299*c.r + 0.587*c.g + 0.114*c.b,
    -0.168736*c.r - 0.331264*c.g + 0.5*c.b,
     0.5*c.r - 0.418688*c.g - 0.081312*c.b);
}
vec3 toRGB(vec3 y) {
  return vec3(
    y.x + 1.402*y.z,
    y.x - 0.344136*y.y - 0.714136*y.z,
    y.x + 1.772*y.y);
}

// libjpeg's quality scaling, matching scaleTable() on the JS side so the preview
// and any headless render agree.
float qscale(float quality) {
  float q = clamp(quality, 1.0, 100.0);
  return q < 50.0 ? 5000.0 / q : 200.0 - q * 2.0;
}

void main() {
  vec2 texel = 1.0 / uRes;
  float B = max(2.0, floor(uBlock));
  vec2 pix = gl_FragCoord.xy - uGridOffset;
  vec2 blockOrigin = floor(pix / B) * B + uGridOffset;
  vec2 inBlock = floor(gl_FragCoord.xy - blockOrigin);

  float jitter = uJitter > 0.0 ? (hash(blockOrigin) - 0.5) * 2.0 * uJitter : 0.0;
  float sL = qscale(uQuality) * (1.0 + jitter);
  float sC = qscale(uChromaQuality) * (1.0 + jitter);

  // Fetch the block once, in YCbCr, applying chroma subsampling as we go — the
  // real order of operations: subsample, then transform, then quantise.
  vec3 blk[64];
  for (int j = 0; j < 64; j++) {
    float bx = float(j - (j / 8) * 8);
    float by = float(j / 8);
    if (bx >= B || by >= B) { blk[j] = vec3(0.0); continue; }
    vec2 sp = (blockOrigin + vec2(bx, by) + 0.5) * texel;
    vec3 ycc = toYCbCr(texture(uSrc, sp).rgb);
    if (uSubsample > 0.5) {
      // Average chroma over 2 horizontally (4:2:2) or 2x2 (4:2:0), which is what
      // the encoder actually stores.
      vec2 o = vec2(texel.x, 0.0);
      vec3 n1 = toYCbCr(texture(uSrc, sp + o).rgb);
      vec3 acc = ycc + n1;
      float cnt = 2.0;
      if (uSubsample > 1.5) {
        vec2 o2 = vec2(0.0, texel.y);
        acc += toYCbCr(texture(uSrc, sp + o2).rgb) + toYCbCr(texture(uSrc, sp + o + o2).rgb);
        cnt = 4.0;
      }
      ycc.yz = (acc / cnt).yz;
    }
    blk[j] = vec3(ycc.x - 0.5, ycc.y, ycc.z);
  }

  // Forward DCT-II, separable: rows then columns. 8x8 twice rather than 64x64
  // once, which is the same maths for an eighth of the work.
  vec3 rows[64];
  for (int y = 0; y < 8; y++) {
    if (float(y) >= B) continue;
    for (int u = 0; u < 8; u++) {
      if (float(u) >= B) continue;
      vec3 sum = vec3(0.0);
      for (int x = 0; x < 8; x++) {
        if (float(x) >= B) break;
        float c = cos((2.0 * float(x) + 1.0) * float(u) * 3.14159265 / (2.0 * B));
        sum += blk[y * 8 + x] * c;
      }
      float cu = u == 0 ? sqrt(1.0 / B) : sqrt(2.0 / B);
      rows[y * 8 + u] = sum * cu;
    }
  }
  vec3 coef[64];
  for (int u = 0; u < 8; u++) {
    if (float(u) >= B) continue;
    for (int v = 0; v < 8; v++) {
      if (float(v) >= B) continue;
      vec3 sum = vec3(0.0);
      for (int y = 0; y < 8; y++) {
        if (float(y) >= B) break;
        float c = cos((2.0 * float(y) + 1.0) * float(v) * 3.14159265 / (2.0 * B));
        sum += rows[y * 8 + u] * c;
      }
      float cv = v == 0 ? sqrt(1.0 / B) : sqrt(2.0 / B);
      coef[v * 8 + u] = sum * cv;
    }
  }

  // QUANTISE — this is where the picture is actually damaged, and everything
  // recognisable about compression comes from this one rounding.
  for (int i = 0; i < 64; i++) {
    int zzRank = 0;
    for (int k = 0; k < 64; k++) { if (ZZ[k] == i) { zzRank = k; break; } }
    if (float(zzRank) >= uKeep) { coef[i] = vec3(0.0); continue; }
    float qL = clamp(floor((Q_LUMA[i] * sL + 50.0) / 100.0), 1.0, 255.0) / 255.0;
    float qC = clamp(floor((Q_CHROMA[i] * sC + 50.0) / 100.0), 1.0, 255.0) / 255.0;
    coef[i] = vec3(
      floor(coef[i].x / qL + 0.5) * qL,
      floor(coef[i].y / qC + 0.5) * qC,
      floor(coef[i].z / qC + 0.5) * qC);
  }
  coef[0].x += uDcBias * (hash(blockOrigin + 7.3) - 0.5);

  // DIFFERENTIAL DC — the mechanism behind the horizontal colour streak, and the
  // reason bitstream damage looks nothing like a filter.
  //
  // A codec does not store each block's average level outright. It stores the
  // DIFFERENCE from the previous block in scan order, because neighbouring
  // blocks are usually similar and the difference is cheap. So a single
  // corrupted delta is not a corrupted block — every block after it inherits the
  // error, and the picture shifts brightness and hue in a band that runs
  // sideways until the decoder is resynchronised.
  //
  // That resynchronisation is a RESTART MARKER, and it is why real corruption
  // streaks in bounded runs rather than smearing to the frame edge. Bounding the
  // loop by the restart interval is therefore not an optimisation for the
  // shader's benefit — it is the actual mechanism, and it keeps the cost fixed.
  //
  // NOTE THE DIFFERENCE FROM uDcBias, which sits one line above: that one
  // perturbs each block INDEPENDENTLY and gives a blotchy patchwork. This one
  // ACCUMULATES and gives streaks. Same quantity, different failure, and only
  // the propagating version reads as a broken file.
  if (uDcDrift > 0.0) {
    float colIdx = floor(pix.x / B);
    float rowIdx = floor(pix.y / B);
    float ri     = uRestart >= 1.0 ? floor(uRestart) : 64.0;
    float start  = floor(colIdx / ri) * ri;
    vec3  acc    = vec3(0.0);
    for (int i = 0; i < 64; i++) {
      float c = start + float(i);
      if (c > colIdx) break;
      vec2 key = vec2(c, rowIdx);
      if (hash(key + 3.7) < uDriftRate) {
        acc += (vec3(hash(key + 11.0), hash(key + 23.0), hash(key + 31.0)) - 0.5) * uDcDrift;
      }
    }
    // Chroma drifts with luma, which is what makes the band change COLOUR rather
    // than only brightness.
    coef[0] += acc;
  }

  // Inverse DCT for THIS pixel only. Every pixel in the block recomputes the same
  // coefficients, which is wasteful and exactly what a fragment shader is for.
  vec3 out3 = vec3(0.0);
  for (int v = 0; v < 8; v++) {
    if (float(v) >= B) break;
    for (int u = 0; u < 8; u++) {
      if (float(u) >= B) break;
      float cu = u == 0 ? sqrt(1.0 / B) : sqrt(2.0 / B);
      float cv = v == 0 ? sqrt(1.0 / B) : sqrt(2.0 / B);
      float cx = cos((2.0 * inBlock.x + 1.0) * float(u) * 3.14159265 / (2.0 * B));
      float cy = cos((2.0 * inBlock.y + 1.0) * float(v) * 3.14159265 / (2.0 * B));
      out3 += cu * cv * coef[v * 8 + u] * cx * cy;
    }
  }

  vec3 rgb = toRGB(vec3(out3.x + 0.5, out3.y, out3.z));
  fragColor = vec4(clamp(rgb, 0.0, 1.0), 1.0);
}`;
