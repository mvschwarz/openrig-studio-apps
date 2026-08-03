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
