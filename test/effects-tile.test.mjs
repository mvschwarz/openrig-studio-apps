// The tile engine's contract. The interesting assertions are the three places it
// deliberately differs from the tool it was learned from — each was a measured
// defect there, and each is silent if it regresses.
import test from "node:test";
import assert from "node:assert/strict";
import { lStar, luminanceGrid, planBlocks, pickTile, TILE_FAMILIES, PALETTES, tileSpec,
         levelWindow, applyLevels }
  from "../providers/studio-effects/engine/tile.mjs";
import { FAMILIES, applyPreset } from "../providers/studio-effects/engine/schema.mjs";

// A stand-in for ImageData: flat colour, so the expected lightness is computable.
const flat = (r, g, b, w = 8, h = 8) => ({
  width: w, height: h,
  data: Uint8ClampedArray.from({ length: w * h * 4 }, (_, i) => [r, g, b, 255][i % 4]),
});

test("lightness is measured in linear light, not in gamma", () => {
  // THE FIRST DEFECT. Averaging is a physical energy average. Mid-grey sRGB 128 is
  // only ~21% of the light of white — a gamma-space average would call it 50%.
  const mid = lStar(...[128, 128, 128].map((c) => {
    const s = c / 255; return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  }));
  assert.ok(mid > 50 && mid < 56, `sRGB 128 should sit near L* 53, got ${mid.toFixed(1)}`);
  assert.ok(lStar(0, 0, 0) < 1 && lStar(1, 1, 1) > 99, "the ends are anchored");
});

test("a tile is chosen by MEASURED lightness, not by its position in a list", () => {
  // THE SECOND DEFECT, and the highest-value difference. Rank lookup assumes the
  // inventory is spread evenly through the tonal range. Measured on a real palette
  // it was not — rank 0 was actually brightness 23 — so the output was permanently
  // washed at both ends. Here the tiles are deliberately BUNCHED and a mid request
  // must still land on the nearest real lightness.
  const bunched = [{ id: "a", l: 5 }, { id: "b", l: 8 }, { id: "c", l: 11 }, { id: "d", l: 96 }];

  // THE DISCRIMINATING CASE, chosen so the two strategies disagree. Asking for 30:
  //   by RANK   -> 30% of the way along a 4-item list is index 1, tile "b" (l=8)
  //   by LIGHT  -> nearest measured lightness to 30 is 11, tile "c"
  // Rank spreads the inventory evenly across the request range whether or not the
  // inventory IS evenly spread. When it is bunched, every request lands wrong.
  const mid = pickTile(bunched, 30, { toneLevels: 64, variety: 1 });
  assert.equal(mid.id, "c", "must pick nearest MEASURED lightness, not the rank-proportional slot");

  const light = pickTile(bunched, 97, { toneLevels: 64, variety: 1 });
  assert.equal(light.id, "d", "a light request must reach the only light tile");
  const dark = pickTile(bunched, 6, { toneLevels: 64, variety: 1 });
  assert.ok(["a", "b"].includes(dark.id), "a dark request stays in the dark cluster");
});

test("flat regions merge and detail subdivides", () => {
  // This is what separates the effect from a uniform grid of stamps. A flat half
  // and a noisy half must not produce the same block sizes.
  const cols = 16, rows = 16;
  const grid = new Float32Array(cols * rows);
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++)
    grid[y * cols + x] = y < rows / 2 ? 50 : (x % 2 ? 5 : 95);
  const blocks = planBlocks(grid, cols, rows, { tolerance: 0.2 });
  const flatSide = blocks.filter((b) => b.y + b.h <= rows / 2);
  const noisy = blocks.filter((b) => b.y >= rows / 2);
  const area = (bs) => bs.reduce((a, b) => a + b.w * b.h, 0) / bs.length;
  assert.ok(area(flatSide) > area(noisy) * 4,
    `flat regions should merge much larger: flat ${area(flatSide).toFixed(1)} vs detail ${area(noisy).toFixed(1)}`);
});

test("a single bright speck is not swallowed by a flat rectangle", () => {
  // Max-deviation rather than variance, on purpose: variance lets one bright cell
  // hide inside an otherwise flat block, and that cell is usually the subject.
  const cols = 8, rows = 8;
  const grid = new Float32Array(cols * rows).fill(50);
  grid[3 * cols + 3] = 100;
  const blocks = planBlocks(grid, cols, rows, { tolerance: 0.2 });
  assert.ok(blocks.length > 1, "the speck must force a subdivision");
  const holding = blocks.find((b) => 3 >= b.x && 3 < b.x + b.w && 3 >= b.y && 3 < b.y + b.h);
  assert.ok(holding.w * holding.h <= 4, "and it must end up in a small block, not a large flat one");
});

test("the same input and seed produce the same mosaic", () => {
  // Variety is chosen BY POSITION, not at random. A mosaic that reshuffles cannot
  // be compared between runs and boils on video.
  const tiles = Array.from({ length: 12 }, (_, i) => ({ id: i, l: i * 9 }));
  const a = pickTile(tiles, 45, { variety: 6, x: 3, y: 7, seed: 2 });
  const b = pickTile(tiles, 45, { variety: 6, x: 3, y: 7, seed: 2 });
  const c = pickTile(tiles, 45, { variety: 6, x: 4, y: 7, seed: 2 });
  assert.equal(a.id, b.id, "same cell, same tile");
  assert.ok(tiles.includes(c), "a neighbouring cell still resolves");
});

test("every family and palette an agent can ask for actually exists", () => {
  const declared = FAMILIES.tile.params;
  for (const v of declared.tileSet.values) assert.ok(TILE_FAMILIES[v], `tileSet ${v} is published but missing`);
  for (const v of declared.palette.values) assert.ok(PALETTES[v], `palette ${v} is published but missing`);
  for (const [, cols] of Object.entries(PALETTES))
    for (const c of cols) assert.match(c, /^#[0-9a-f]{6}$/i, `palette colour ${c} is malformed`);
  for (const name of Object.keys(FAMILIES.tile.presets)) {
    const r = applyPreset("tile", name);
    assert.ok(!r.error, `preset ${name} must resolve`);
    if (r.params.tileSet) assert.ok(TILE_FAMILIES[r.params.tileSet], `${name} names a missing tileSet`);
    if (r.params.palette) assert.ok(PALETTES[r.params.palette], `${name} names a missing palette`);
  }
});

test("every family produces a spec across its whole range", () => {
  for (const [id, fam] of Object.entries(TILE_FAMILIES)) {
    for (const i of [0, Math.floor(fam.count / 2), fam.count - 1]) {
      const spec = tileSpec(id, i, fam.count);
      assert.ok(spec, `${id}[${i}] produced nothing`);
      assert.ok(spec.t >= 0 && spec.t <= 1, `${id}[${i}] tone out of range`);
    }
  }
});

// ---- SOURCE NORMALISATION -------------------------------------------------
// Added after an independent QA drive found the family renders successfully and
// still erases the picture on real footage: matching against ABSOLUTE lightness
// assumes a source that uses the whole range, and neither a dark photograph nor
// a white screen does. Measured on real material — a low-key frame occupies
// L* 0-50 and a modern UI capture L* 86-99.6.

test("the level window is percentile-based, so one stray pixel cannot define it", () => {
  // min/max would be defined entirely by the two outliers and normalise nothing.
  const grid = new Float32Array(1000).fill(40);
  grid[0] = 0; grid[999] = 100;
  const w = levelWindow(grid);
  assert.ok(w.lo > 0 && w.hi < 100, `outliers captured the window: ${w.lo}..${w.hi}`);
});

test("a genuinely flat source is left alone rather than amplified into noise", () => {
  // Stretching a 2-unit span across the full ramp invents structure that was
  // never in the source, which is worse than showing the flat field honestly.
  const flat = new Float32Array(500).fill(50);
  const w = levelWindow(flat);
  assert.equal(w.degenerate, true);
  const out = applyLevels(flat, w, 1);
  assert.deepEqual(Array.from(out.slice(0, 3)), [50, 50, 50]);
});

test("a narrow real range is spread across the full tile ramp", () => {
  // The low-key case: everything between 0 and 50 must reach the whole ramp, or
  // every cell quantises into the bottom buckets and the subject disappears.
  const grid = Float32Array.from({ length: 200 }, (_, i) => (i / 199) * 50);
  const w = levelWindow(grid);
  const out = applyLevels(grid, w, 1);
  assert.ok(Math.max(...out) > 90, `top of range only reached ${Math.max(...out)}`);
  assert.ok(Math.min(...out) < 10, `bottom of range only reached ${Math.min(...out)}`);
});

test("autoLevels at 0 is exactly the old absolute behaviour", () => {
  // The previous mapping stays reachable rather than being removed, so a look
  // that wanted it can still ask.
  const grid = Float32Array.from({ length: 100 }, (_, i) => (i / 99) * 50);
  const w = levelWindow(grid);
  assert.deepEqual(Array.from(applyLevels(grid, w, 0)), Array.from(grid));
});

test("normalisation is monotonic — it must not reorder tones", () => {
  // A tone mapping that swapped light and dark would still 'work' by every count
  // and produce a negative of the picture.
  const grid = Float32Array.from({ length: 100 }, (_, i) => 20 + (i / 99) * 30);
  const out = applyLevels(grid, levelWindow(grid), 1);
  for (let i = 1; i < out.length; i++) assert.ok(out[i] >= out[i - 1], `not monotonic at ${i}`);
});

test("the looks whose structure IS the grid do not merge cells away", () => {
  // Halftone's dot grid and chunky's coarse grid are the look; merging on top of
  // them collapsed a UI capture's topology and a dark photo's subject.
  for (const name of ["newspaper", "chunky"]) {
    assert.equal(FAMILIES.tile.presets[name].adaptiveMerge, false,
      `${name} must not merge — its grid is the look`);
  }
});

test("autoLevels is declared as a knob an agent can find and reach for", () => {
  const spec = FAMILIES.tile.params.autoLevels;
  assert.ok(spec, "autoLevels must be published in the schema");
  assert.ok(spec.says.length > 20, "it needs to say what it does in plain words");
  assert.equal(spec.default, 1, "normalisation is the sane default for real footage");
});
