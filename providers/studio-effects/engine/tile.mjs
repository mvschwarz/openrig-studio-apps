// TILE — an image rebuilt out of other pictures. A grid of tiles is chosen so each
// one's brightness matches the region it replaces, and flat areas merge into large
// rectangles while detail subdivides, so the block structure traces the subject.
//
// THE FINDING THIS IS BUILT ON, and it is worth more than the effect:
//
//   A BRIGHTNESS-RANKED TILE SET IS A GENERALISED ORDERED DITHER.
//
// An ordered dither reproduces a middle tone with a fixed spatial pattern of two
// extremes whose spatial mean equals the target. A half-black, half-white triangle
// tile IS a 50% dither cell. Bayer is the special case where the pattern is a
// threshold matrix and the tile is one pixel.
//
// So ONE engine, parameterised by its tile inventory, yields ordered dithering,
// ASCII art, halftone, photomosaic and geometric mosaic. That is five recognisable
// looks from one implementation and one parameter, which is why this is a family
// rather than an effect.
//
// THREE PLACES WE DELIBERATELY DIFFER FROM THE TOOL THAT INSPIRED IT, all measured:
//
//   1. AVERAGE IN LINEAR LIGHT. Averaging is a physical energy average. Summing a
//      gamma-encoded luma across a tile's pixels ranks a 50/50 black-and-white tile
//      at about 127 when its true perceived luminance encodes to about 188 — so
//      high-contrast tiles land ~60 levels too dark, which misplaces exactly the
//      most graphically interesting tiles in the ramp.
//   2. MATCH BY LUMINANCE, NOT BY RANK. Rank lookup assumes the tiles are evenly
//      spread through the tonal range. Measured on a real palette they are not:
//      rank 0 was actually brightness 23 and rank 255 was 236, so the output was
//      permanently low-contrast and washed at both ends.
//   3. SPACE TONE LEVELS IN CIE L*, so the steps are perceptually even. There is no
//      3-D colour distance to choose here — the match is one-dimensional on
//      lightness.

// sRGB -> linear light. Averaging happens here and nowhere else.
const toLinear = (c) => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
};

// Relative luminance, then CIE L*. L* is the space to COMPARE and SPACE levels in;
// linear is the space to AVERAGE in. Using one for both is the usual mistake.
export function lStar(rLin, gLin, bLin) {
  const y = 0.2126 * rLin + 0.7152 * gLin + 0.0722 * bLin;
  return y > 0.008856 ? 116 * Math.cbrt(y) - 16 : 903.3 * y;
}

// Mean lightness of a whole tile, averaged in linear light. This is what makes a
// tile's position in the ramp honest.
export function tileLightness(imageData) {
  const d = imageData.data;
  let r = 0, g = 0, b = 0;
  const n = d.length / 4;
  for (let i = 0; i < d.length; i += 4) {
    r += toLinear(d[i]); g += toLinear(d[i + 1]); b += toLinear(d[i + 2]);
  }
  return lStar(r / n, g / n, b / n);
}

// The grid the quadtree runs over: one L* value per cell, averaged in linear light.
export function luminanceGrid(imageData, cols, rows) {
  const { data, width, height } = imageData;
  const out = new Float32Array(cols * rows);
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const x0 = Math.floor((cx * width) / cols), x1 = Math.max(x0 + 1, Math.floor(((cx + 1) * width) / cols));
      const y0 = Math.floor((cy * height) / rows), y1 = Math.max(y0 + 1, Math.floor(((cy + 1) * height) / rows));
      let r = 0, g = 0, b = 0, n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * width + x) * 4;
          r += toLinear(data[i]); g += toLinear(data[i + 1]); b += toLinear(data[i + 2]); n++;
        }
      }
      out[cy * cols + cx] = n ? lStar(r / n, g / n, b / n) : 0;
    }
  }
  return out;
}

// ADAPTIVE MERGE. A rectangle whose cells all sit within `tolerance` of their mean
// becomes ONE tile. This is what separates the effect from a uniform grid of
// stamps: flat regions go calm and large, detail stays fine, and the block
// structure ends up tracing the edges of the subject.
//
// The test is MAX DEVIATION rather than variance on purpose — variance lets a
// single bright speck hide inside an otherwise flat rectangle, and that speck is
// usually the thing worth keeping.
export function planBlocks(grid, cols, rows, { tolerance = 0.2, minCells = 1 } = {}) {
  const tol = tolerance * 50; // tolerance is 0..1 over half the L* range
  const blocks = [];
  const at = (x, y) => grid[y * cols + x];

  const uniform = (x, y, w, h) => {
    let sum = 0;
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) sum += at(i, j);
    const mean = sum / (w * h);
    for (let j = y; j < y + h; j++) {
      for (let i = x; i < x + w; i++) if (Math.abs(at(i, j) - mean) > tol) return null;
    }
    return mean;
  };

  const emit = (x, y, w, h, mean) => blocks.push({ x, y, w, h, l: mean });

  const walk = (x, y, w, h) => {
    if (w <= 0 || h <= 0) return;
    const m = uniform(x, y, w, h);
    if (m !== null || (w <= minCells && h <= minCells)) {
      emit(x, y, w, h, m ?? uniform(x, y, 1, 1) ?? at(x, y));
      return;
    }
    // Halves before quadrants: a horizon or a wall edge splits cleanly in one
    // direction, and taking quadrants first would fragment it into four.
    if (h > 1) {
      const hh = Math.floor(h / 2);
      const a = uniform(x, y, w, hh), b = uniform(x, y + hh, w, h - hh);
      if (a !== null && b !== null) { emit(x, y, w, hh, a); emit(x, y + hh, w, h - hh, b); return; }
    }
    if (w > 1) {
      const hw = Math.floor(w / 2);
      const a = uniform(x, y, hw, h), b = uniform(x + hw, y, w - hw, h);
      if (a !== null && b !== null) { emit(x, y, hw, h, a); emit(x + hw, y, w - hw, h, b); return; }
    }
    if (w === 1 && h === 1) { emit(x, y, 1, 1, at(x, y)); return; }
    const hw = Math.max(1, Math.floor(w / 2)), hh = Math.max(1, Math.floor(h / 2));
    walk(x, y, hw, hh); walk(x + hw, y, w - hw, hh);
    walk(x, y + hh, hw, h - hh); walk(x + hw, y + hh, w - hw, h - hh);
  };

  walk(0, 0, cols, rows);
  return blocks;
}

// Quantise to K levels spaced evenly in L*, then pick a tile whose MEASURED
// lightness is nearest that level. Nearest-by-lightness rather than by rank is the
// single highest-value difference from the original: it keeps the tonal transfer
// honest instead of washed.
export function pickTile(tiles, l, { toneLevels = 32, variety = 6, x = 0, y = 0, seed = 1 } = {}) {
  if (!tiles.length) return null;
  const k = Math.round((Math.max(0, Math.min(100, l)) / 100) * (toneLevels - 1));
  const target = (k / Math.max(1, toneLevels - 1)) * 100;

  let best = [];
  let bestErr = Infinity;
  for (const t of tiles) {
    const e = Math.abs(t.l - target);
    if (e < bestErr - 1e-6) { bestErr = e; best = [t]; }
    else if (Math.abs(e - bestErr) <= 1e-6) best.push(t);
  }
  // Within a tone bucket, vary by POSITION rather than at random, so the same
  // input always produces the same output. A mosaic that reshuffles every frame
  // boils on video and cannot be compared between runs.
  const pool = best.slice(0, Math.max(1, variety));
  const h = Math.abs(Math.imul(x * 374761393 + y * 668265263 + seed, 1274126177)) % pool.length;
  return pool[h];
}

// TILE FAMILIES AS DATA, not as drawing code. Each entry describes WHAT a tile is;
// the surface turns the description into pixels. Keeping the inventory declarative
// is what makes "the tile set is a parameter" true rather than aspirational — a
// family can be added, or supplied by an agent, without touching the renderer.
//
// Every family is generated across the full 0..100 lightness range, and the ramp is
// then MEASURED rather than assumed. A generated tile's actual lightness is what
// places it, so a family whose shapes happen to cluster dark still produces an
// honest ramp instead of a washed one.
export const TILE_FAMILIES = {
  solid:    { count: 48, kind: "solid",
              says: "flat blocks — the plainest reading, closest to a pixelation" },
  bayer:    { count: 17, kind: "bayer", matrix: 4,
              says: "ordered dither cells; with a two-colour palette this IS classic dithering" },
  halftone: { count: 32, kind: "dot",
              says: "a dot per cell, sized by tone — newspaper print" },
  glyph:    { count: 24, kind: "glyph", ramp: " .:-=+*#%@",
              says: "characters chosen by density — ASCII art, same engine" },
  geometric:{ count: 64, kind: "shapes",
              says: "triangles, bars, arcs and checkers — reads as a poster rather than a photo" },
};

// Named palettes. Ours, or hardware palettes old enough to be nobody's expression.
export const PALETTES = {
  mono:     ["#000000", "#ffffff"],
  gameboy:  ["#0f380f", "#306230", "#8bac0f", "#9bbc0f"],
  cga:      ["#000000", "#55ffff", "#ff55ff", "#ffffff"],
  amber:    ["#0b0700", "#7a4a00", "#ffb000", "#ffd28a"],
  paper:    ["#12100e", "#5c554b", "#a8a094", "#efe9dd"],
  cold:     ["#0b0e13", "#2a3550", "#5f7fb8", "#cfe0ff"],
  ember:    ["#140a08", "#5c1f14", "#c04a24", "#ffcf9e"],
};

// What a family looks like at a given tone, described so the surface can draw it.
// Returned as a plain object on purpose: an agent can read these, and a future
// family can arrive as JSON without new drawing code.
export function tileSpec(familyId, i, count) {
  const fam = TILE_FAMILIES[familyId];
  if (!fam) return null;
  const t = count <= 1 ? 0 : i / (count - 1);   // 0 = darkest, 1 = lightest
  switch (fam.kind) {
    case "solid":  return { kind: "solid", t };
    case "bayer":  return { kind: "bayer", t, matrix: fam.matrix };
    case "dot":    return { kind: "dot", t, radius: Math.sqrt(t) };
    case "glyph":  return { kind: "glyph", t, char: fam.ramp[Math.min(fam.ramp.length - 1, Math.floor(t * fam.ramp.length))] };
    case "shapes": return { kind: "shapes", t, shape: i % 8, rotation: (i % 4) * 90 };
    default:       return { kind: "solid", t };
  }
}
