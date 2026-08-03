// THE PARAMETER SCHEMA IS THE AGENT-DRIVABILITY SEAM, and it is the reason these
// are studio apps rather than web toys.
//
// An agent does not read our source and it should not have to be told the knobs
// out of band. It GETs this, and then knows what exists, what range each thing
// takes, what a sensible default is, and — the part that actually matters — what
// a human phrase maps onto.
//
// DESIGN RULE, and it is the one to hold: NAME KNOBS AFTER WHAT A PERSON
// PERCEIVES, NEVER AFTER THE DSP. `chromaShift`, not `perChannelScanTimeSkewPx`.
// Somebody asking for "more scanline tearing" should be one lookup away from the
// parameter, and an agent should never need to understand the algorithm to drive
// the effect.

export const FAMILIES = {
  analog: {
    id: "analog",
    name: "Analog video",
    summary: "A composite-video round trip. Colour is modulated onto a subcarrier, the signal is degraded, and an imperfect separator decodes it — so colour leaks into brightness and brightness leaks into colour.",
    engine: "webgl2",
    params: {
      subcarrierCycles: { type: "float", min: 60, max: 320, default: 188.5,
                          says: "carrier cycles per line; lower makes the dot pattern coarser and more visible" },
      phaseAlternation: { type: "bool", default: true,
                          says: "flip the carrier every line — this is what makes the artifacts CRAWL rather than sit still" },
      phaseJitter:      { type: "float", min: 0, max: 1, default: 0.02,
                          says: "per-line hue instability" },
      hueError:         { type: "float", unit: "deg", min: -180, max: 180, default: 0,
                          says: "global tint, as if the tint control were mistuned" },
      combMix:          { type: "float", min: 0, max: 1, default: 0.35,
                          says: "0 is a cheap set with heavy dot crawl, 1 is a good one with clean luma" },
      dotCrawl:         { type: "float", min: 0, max: 2, default: 1,
                          says: "residual carrier left in the brightness — the moving checkerboard on colour edges" },
      chromaBleed:      { type: "float", min: 0, max: 3, default: 1,
                          says: "how far colour smears sideways past its object" },
      chromaQRatio:     { type: "float", min: 0.2, max: 1, default: 0.47,
                          says: "blues and purples carry less detail than oranges — the real ratio is about 0.47" },
      chromaDelayX:     { type: "float", unit: "px", min: -20, max: 20, default: 1.5,
                          says: "colour sitting to the right of the thing it belongs to" },
      chromaDelayY:     { type: "float", unit: "rows", min: -4, max: 4, default: 0,
                          says: "colour sitting above or below its object" },
      chromaVertBlend:  { type: "float", min: 0, max: 1, default: 0.2,
                          says: "colour smeared vertically, as tape does" },
      sharpen:          { type: "float", min: 0, max: 2, default: 0.6,
                          says: "edge halos — and it amplifies dot crawl too, because it boosts the carrier" },
      smear:            { type: "float", min: 0, max: 1, default: 0.15,
                          says: "brightness trailing to the RIGHT, the way analog does" },
      noise:            { type: "float", min: 0, max: 1, default: 0.04,
                          says: "signal grain, injected before decoding so it colours as well as speckles" },
      chromaNoise:      { type: "float", min: 0, max: 1, default: 0.05,
                          says: "drifting colour blotches" },
      scanlines:        { type: "float", min: 0, max: 1, default: 0,
                          says: "visible line structure" },
    },
    presets: {
      "1980s broadcast": { combMix: 0.6, dotCrawl: 0.5, chromaBleed: 1, sharpen: 1, noise: 0.02,
                           chromaDelayX: 0.5, scanlines: 0.15, chromaVertBlend: 0.1 },
      "vhs":             { combMix: 0.2, chromaBleed: 2.4, chromaDelayX: 4, chromaVertBlend: 1,
                           smear: 0.5, chromaNoise: 0.3, noise: 0.12, dotCrawl: 1.2 },
      "worn tape":       { combMix: 0.15, chromaBleed: 2.8, chromaDelayX: 6, chromaVertBlend: 1,
                           smear: 0.8, chromaNoise: 0.45, noise: 0.2, phaseJitter: 0.15, scanlines: 0.2 },
      "bad cable":       { combMix: 0, dotCrawl: 2, chromaBleed: 1, phaseJitter: 0.35, noise: 0.3,
                           sharpen: 1.4, hueError: 12 },
      "old video game":  { subcarrierCycles: 120, combMix: 0, dotCrawl: 1.6, scanlines: 0.4, sharpen: 0.3 },
      "just a hint":     { combMix: 0.8, dotCrawl: 0.2, chromaBleed: 0.5, noise: 0.01, chromaNoise: 0.01,
                           sharpen: 0.3, chromaDelayX: 0.5 },
    },
    guidance: [
      "'more VHS' lowers combMix and raises chromaBleed, chromaDelayX, chromaVertBlend and smear together — the look is bandwidth loss, not noise.",
      "'bad cable' is the OPPOSITE: keep the bandwidth wide and wreck the separation instead — combMix to 0, dotCrawl and phaseJitter up.",
      "'make it crawl' or 'make it move' means phaseAlternation must be on; with it off every artifact freezes and reads as compression damage.",
      "'more rainbow' or 'shimmery' raises dotCrawl and lowers combMix.",
      "'softer' raises smear and lowers subcarrierCycles rather than blurring.",
    ],
  },
  tile: {
    id: "tile",
    name: "Tile mosaic",
    summary: "The picture rebuilt out of other pictures — flat blocks, dither cells, halftone dots, characters or geometry. Flat areas merge into big tiles; detail subdivides.",
    engine: "canvas2d",
    params: {
      gridSize:       { type: "int", min: 8, max: 256, default: 64,
                        says: "how many tiles across — the chunkiness" },
      tileSet:        { type: "enum", values: ["solid", "bayer", "halftone", "glyph", "geometric"], default: "geometric",
                        says: "what a tile IS; bayer with two colours is classic dithering" },
      palette:        { type: "enum", values: ["mono", "gameboy", "cga", "amber", "paper", "cold", "ember"], default: "paper",
                        says: "the colours tiles are drawn in" },
      adaptiveMerge:  { type: "bool", default: true,
                        says: "let flat areas become big tiles instead of a uniform grid" },
      mergeTolerance: { type: "float", min: 0, max: 1, default: 0.2,
                        says: "how similar cells must be to merge — higher is blockier" },
      minBlockCells:  { type: "int", min: 1, max: 8, default: 1,
                        says: "floor on how small a tile can get" },
      toneLevels:     { type: "int", min: 2, max: 64, default: 24,
                        says: "how many distinct tones — low is posterised" },
      tileVariety:    { type: "int", min: 1, max: 16, default: 6,
                        says: "distinct tiles per tone; 1 is rigid, high is lively" },
      autoLevels:     { type: "float", min: 0, max: 1, default: 1,
                        says: "spread the source's own darkest and lightest onto the full tile ramp — without it a dark photo or a white screen collapses to one tile" },
      contrast:       { type: "float", min: 0, max: 2, default: 1,
                        says: "applied before the tones are chosen" },
      outline:        { type: "bool", default: false, says: "draw the tile edges" },
      seed:           { type: "int", min: 0, max: 2147483647, default: 1, says: "same seed, same mosaic" },
    },
    presets: {
      "game boy":     { palette: "gameboy", tileSet: "solid", toneLevels: 4, adaptiveMerge: false, gridSize: 80 },
      "classic dither":{ tileSet: "bayer", palette: "mono", toneLevels: 2, adaptiveMerge: false, gridSize: 180 },
      // Halftone's dot grid IS the look, so merging cells erases it — measured on
      // a modern UI capture, merge collapsed 8,160 cells to 777 blocks and the
      // topology went with them.
      "newspaper":    { tileSet: "halftone", palette: "paper", toneLevels: 6, gridSize: 120, adaptiveMerge: false },
      "ascii":        { tileSet: "glyph", palette: "mono", toneLevels: 10, gridSize: 100, adaptiveMerge: false },
      "poster":       { tileSet: "geometric", palette: "ember", toneLevels: 12, mergeTolerance: 0.28, tileVariety: 8 },
      // Chunkiness comes from the GRID being coarse, not from merging on top of a
      // coarse grid — with both, a low-key source merged to a single block and the
      // subject disappeared entirely.
      "chunky":       { gridSize: 24, minBlockCells: 2, toneLevels: 8, adaptiveMerge: false },
      "fine":         { gridSize: 160, mergeTolerance: 0.07, toneLevels: 48 },
    },
    guidance: [
      "'chunkier pixels' lowers gridSize before anything else; raise minBlockCells if it is still too fine.",
      "'more posterised' halves toneLevels; below 4 also drop tileVariety to 1 or it reads as noise.",
      "'classic dithering' is not a separate effect — it is tileSet:bayer with a two-colour palette.",
      "'more abstract' raises mergeTolerance and tileVariety together and prefers the geometric set.",
    ],
  },
  scan: {
    id: "scan",
    name: "Scanner",
    summary: "A photograph pulled across scanner glass while it is being read. Rows stay sharp; each one lands somewhere slightly different.",
    engine: "webgl2",
    params: {
      scanAxis:        { type: "enum", values: ["vertical", "horizontal"], default: "vertical",
                         says: "which way the head travels; displacement is perpendicular to it" },
      wobbleAmount:    { type: "float", unit: "px", min: 0, max: 200, default: 24,
                         says: "how far the image drifts side to side" },
      wobbleFrequency: { type: "float", unit: "cycles/scan", min: 0.25, max: 24, default: 3,
                         says: "how many times it swings during one pass" },
      wobblePhase:     { type: "float", unit: "deg", min: 0, max: 360, default: 0,
                         says: "where in the swing the scan starts" },
      jitterAmount:    { type: "float", unit: "px", min: 0, max: 120, default: 0,
                         says: "unsteadiness, as if held by hand" },
      jitterScale:     { type: "float", unit: "px", min: 2, max: 200, default: 24,
                         says: "low is shaky, high is a loose sway" },
      tearAmount:      { type: "float", unit: "px", min: 0, max: 400, default: 0,
                         says: "hard sideways slips — the cliffs rather than the curves" },
      tearFrequency:   { type: "float", unit: "tears/scan", min: 0, max: 40, default: 6,
                         says: "how many slips happen" },
      drift:           { type: "float", unit: "px", min: -800, max: 800, default: 0,
                         says: "steady pull in one direction across the whole scan" },
      rotationDrift:   { type: "float", unit: "deg", min: -45, max: 45, default: 0,
                         says: "twist accumulating as it scans" },
      scaleDrift:      { type: "float", min: 0.5, max: 2, default: 1,
                         says: "grows or shrinks across the scan" },
      chromaShift:     { type: "float", unit: "px", min: -40, max: 40, default: 0,
                         says: "colour channels read at different instants" },
      grain:           { type: "float", min: 0, max: 1, default: 0.35,
                         says: "dirt on the glass" },
      grainScale:      { type: "float", unit: "px", min: 1, max: 8, default: 1,
                         says: "how coarse the dirt is" },
      mono:            { type: "bool", default: false, says: "black and white" },
      paperColor:      { type: "color", default: "#ffffff",
                         says: "what shows where the image was dragged off the glass" },
      subpixel:        { type: "bool", default: true,
                         says: "off gives harder, more digital tears" },
      seed:            { type: "int", min: 0, max: 2147483647, default: 1,
                         says: "same seed, same result" },
    },
    // Presets are the natural-language surface. An agent hearing a phrase does not
    // interpolate between knobs — it applies a set that was composed to read as
    // that thing.
    presets: {
      "clean":            { wobbleAmount: 0, jitterAmount: 0, tearAmount: 0, grain: 0.12 },
      "hand held":        { wobbleAmount: 14, wobbleFrequency: 2, jitterAmount: 26, jitterScale: 30, grain: 0.3 },
      "more tearing":     { tearAmount: 90, tearFrequency: 14, wobbleAmount: 18, subpixel: false },
      "dragged":          { drift: 260, wobbleAmount: 30, wobbleFrequency: 1.5, grain: 0.4 },
      "broken scanner":   { tearAmount: 220, tearFrequency: 22, jitterAmount: 40, chromaShift: 9,
                            wobbleAmount: 40, subpixel: false, grain: 0.5 },
      "photocopier":      { mono: true, grain: 0.75, grainScale: 2, wobbleAmount: 6, tearAmount: 20 },
      "colour separation":{ chromaShift: 22, wobbleAmount: 10, tearAmount: 30, grain: 0.2 },
    },
    // Stated so an agent asking for something vague picks the parameter that is
    // actually meant, rather than the nearest-sounding one.
    guidance: [
      "'more tearing' raises tearAmount AND tearFrequency together — moving one alone reads as a mistake.",
      "'more glitchy' is ambiguous: prefer tearAmount over chromaShift unless colour was mentioned, because chroma shift breaks the scanner metaphor.",
      "'cleaner' lowers wobbleAmount and grain before anything else.",
      "scanAxis changes which way the ribbons run; it is the cheapest way to change the whole look.",
    ],
  },
};

// Clamp and coerce to the schema. A parameter arriving out of range is the normal
// case when something else is driving — an agent reaching for an extreme, a
// preset written against an older range — so it is corrected rather than refused.
// Refusing would make the tool feel brittle to the thing most likely to drive it.
export function coerce(familyId, input = {}) {
  const fam = FAMILIES[familyId];
  if (!fam) return { error: `no such effect family: ${familyId}` };
  const out = {};
  const notes = [];
  for (const [key, spec] of Object.entries(fam.params)) {
    let v = input[key];
    if (v === undefined || v === null || v === "") { out[key] = spec.default; continue; }
    if (spec.type === "bool") { out[key] = Boolean(v === true || v === "true" || v === 1); continue; }
    if (spec.type === "enum") {
      out[key] = spec.values.includes(v) ? v : spec.default;
      if (out[key] !== v) notes.push(`${key}: ${v} is not one of ${spec.values.join("/")}, used ${spec.default}`);
      continue;
    }
    if (spec.type === "color") { out[key] = /^#[0-9a-f]{6}$/i.test(String(v)) ? v : spec.default; continue; }
    const n = Number(v);
    if (!Number.isFinite(n)) { out[key] = spec.default; notes.push(`${key}: ${v} is not a number, used ${spec.default}`); continue; }
    const c = Math.min(spec.max ?? Infinity, Math.max(spec.min ?? -Infinity, n));
    if (c !== n) notes.push(`${key}: ${n} clamped to ${c}`);
    out[key] = spec.type === "int" ? Math.round(c) : c;
  }
  const unknown = Object.keys(input).filter((k) => !(k in fam.params));
  if (unknown.length) notes.push(`ignored unknown: ${unknown.join(", ")}`);
  return { params: out, notes };
}

// Applying a preset means applying it ON TOP OF THE DEFAULTS, not on top of
// whatever the knobs happen to be. A preset that inherits the previous state is
// not reproducible, and "make it look like X" would give a different answer every
// time depending on what was tried before it.
export function applyPreset(familyId, presetName) {
  const fam = FAMILIES[familyId];
  if (!fam) return { error: `no such effect family: ${familyId}` };
  const preset = fam.presets[presetName];
  if (!preset) return { error: `no such preset: ${presetName}`, available: Object.keys(fam.presets) };
  return coerce(familyId, preset);
}
