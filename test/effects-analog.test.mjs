// ANALOG — contract tests.
//
// What these pin is deliberately narrow: the things that, when they broke, did
// NOT produce an error. Every defect this family shipped during its build was
// silent — an upside-down picture, a brightness control disguised as a sharpness
// control, a colour cast from a truncated filter window. A render check passed
// all three. So these tests assert on the geometry and the declared contract,
// which are the parts a headless run can actually see; the look itself is QA's
// job in a browser and no test here pretends otherwise.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ANALOG_FRAGMENT, ANALOG_VERTEX, ANALOG_TAP_REACH, ANALOG_INTERNAL_WIDTH, analogWindows,
} from "../providers/studio-effects/engine/analog.mjs";
import { FAMILIES, coerce, applyPreset } from "../providers/studio-effects/engine/schema.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SURFACE = fs.readFileSync(path.join(HERE, "../apps/effects/app/effects.html"), "utf8");

const defaultsOf = (fam) =>
  Object.fromEntries(Object.entries(FAMILIES[fam].params).map(([k, s]) => [k, s.default]));

test("the shader's tap reach is the exported one, not a second copy", () => {
  // The GLSL interpolates the constant rather than restating it. Asserting the
  // rendered NUMBER appears — not that the source says the right words — is what
  // makes this structural instead of a prose grep.
  assert.match(ANALOG_FRAGMENT, new RegExp(`const int TAP_REACH = ${ANALOG_TAP_REACH};`));
  assert.match(ANALOG_FRAGMENT, /for \(int k = -TAP_REACH; k <= TAP_REACH; \+\+k\)/);
});

test("the surface takes its sampling geometry from the engine and defines none of its own", () => {
  // The failure mode being prevented: the surface computing its own window while
  // the shader walks a different reach. That disagreement does not error — it
  // leaks luma into chroma and tints flat bright areas.
  assert.match(SURFACE, /ANALOG\.analogWindows\(params, canvas\.width\)/);
  assert.match(SURFACE, /ANALOG\.ANALOG_INTERNAL_WIDTH/);
  assert.equal(/const ANALOG_TAP_REACH\s*=/.test(SURFACE), false, "surface must not redefine the reach");
  assert.equal(/const ANALOG_INTERNAL_WIDTH\s*=/.test(SURFACE), false, "surface must not redefine the width");
});

test("every shipped look fits the tap reach unclamped at the internal render width", () => {
  // A clamped window silently caps a knob: 'more VHS' would stop meaning anything
  // past a point, with nothing on screen to say so.
  const checked = [];
  for (const name of Object.keys(FAMILIES.analog.presets)) {
    const { params } = applyPreset("analog", name);
    const w = analogWindows(params, ANALOG_INTERNAL_WIDTH);
    checked.push([name, +w.chromaTaps.toFixed(2)]);
    assert.equal(w.clamped, false, `preset "${name}" needs a wider window than the shader can walk`);
  }
  const dflt = analogWindows(defaultsOf("analog"), ANALOG_INTERNAL_WIDTH);
  assert.equal(dflt.clamped, false, "the defaults must fit");
  assert.ok(checked.length >= 6, "expected the full shipped look set");
});

test("a window WIDER than the reach is reported as clamped, not silently truncated", () => {
  // The negative control for the test above. Without it, "nothing is clamped"
  // would also pass if clamping could never be detected at all.
  const p = { ...defaultsOf("analog"), chromaBleed: 3, subcarrierCycles: 60 };
  const w = analogWindows(p, 4096);
  assert.equal(w.clamped, true);
  assert.ok(w.chromaTaps <= ANALOG_TAP_REACH, "a clamped window must still be walkable");
});

test("chroma bleed adds pixels rather than multiplying carrier periods", () => {
  // Why this is pinned: the period-multiplying form made the window grow with
  // RESOLUTION, so the same look was correct at 720 and badly wrong at 1920.
  const base = defaultsOf("analog");
  const at720 = analogWindows(base, 720).chromaTaps;
  const at1440 = analogWindows({ ...base }, 1440).chromaTaps;
  // Doubling the width doubles the carrier period, so the carrier-tracking part
  // doubles — but the bleed term must NOT, so the window is less than double.
  assert.ok(at1440 < at720 * 2, `window scaled with resolution: ${at720} -> ${at1440}`);

  const more = analogWindows({ ...base, chromaBleed: base.chromaBleed + 1 }, 720).chromaTaps;
  assert.ok(more > at720, "raising chromaBleed must widen the window");
});

test("the internal render width keeps the default window inside the reach", () => {
  // This is the property that made a white UI capture come out yellow-green when
  // it did not hold: at 1920 the default window wanted 42.8px against a 16px
  // reach. It is asserted at the width the surface actually renders at.
  const w = analogWindows(defaultsOf("analog"), ANALOG_INTERNAL_WIDTH);
  assert.equal(w.clamped, false);
  assert.ok(ANALOG_INTERNAL_WIDTH <= 960, "PRD: render internally at 640-960 and upscale");
});

test("the analog family publishes what an agent needs to drive it", () => {
  const fam = FAMILIES.analog;
  assert.equal(fam.engine, "webgl2");
  for (const [key, spec] of Object.entries(fam.params)) {
    assert.ok(spec.says, `${key} must say what it does in plain words`);
    if (spec.type === "float" || spec.type === "int") {
      assert.equal(typeof spec.min, "number", `${key} needs a min`);
      assert.equal(typeof spec.max, "number", `${key} needs a max`);
      assert.ok(spec.default >= spec.min && spec.default <= spec.max, `${key} default out of range`);
    }
  }
  assert.ok(fam.guidance.length >= 4, "vague asks need disambiguation lines");
  // The named looks are the natural-language surface; a preset that sets nothing
  // real would still 'apply' and change nothing.
  for (const [name, patch] of Object.entries(fam.presets)) {
    assert.ok(Object.keys(patch).length > 0, `preset ${name} is empty`);
    for (const k of Object.keys(patch)) assert.ok(k in fam.params, `preset ${name} sets unknown ${k}`);
  }
});

test("presets resolve from DEFAULTS, so a look is reproducible whatever preceded it", () => {
  const a = applyPreset("analog", "vhs").params;
  const b = applyPreset("analog", "vhs").params;
  assert.deepEqual(a, b);
  // A knob the preset does not mention must come back to its default rather than
  // inherit whatever was on screen.
  const untouched = Object.keys(FAMILIES.analog.params)
    .find((k) => !(k in FAMILIES.analog.presets.vhs));
  assert.equal(a[untouched], FAMILIES.analog.params[untouched].default);
});

test("out-of-range input is clamped and REPORTED rather than refused", () => {
  const r = coerce("analog", { chromaBleed: 99, subcarrierCycles: -5 });
  assert.equal(r.params.chromaBleed, FAMILIES.analog.params.chromaBleed.max);
  assert.equal(r.params.subcarrierCycles, FAMILIES.analog.params.subcarrierCycles.min);
  assert.ok(r.notes.some((n) => n.includes("chromaBleed")), "a clamp must be visible to the caller");
});

test("the shader source survives being a template literal", () => {
  // Twice during this build a backtick inside a GLSL comment terminated the
  // template and broke the module — with an error pointing at prose, not at code.
  // Importing the module at all is the real guard; these assert the string
  // arrived whole rather than truncated at a stray delimiter.
  assert.ok(ANALOG_FRAGMENT.includes("void main()"), "fragment shader is truncated");
  assert.ok(ANALOG_VERTEX.includes("gl_Position"), "vertex shader is truncated");
  assert.match(ANALOG_FRAGMENT, /^#version 300 es/);
  assert.equal(ANALOG_FRAGMENT.includes("`"), false, "a backtick in the shader would have broken the module");
});

test("the two vertical axes stay separate — the fix for an upside-down picture", () => {
  // The texture may only be sampled with the raw fragment coordinate; the carrier
  // phase may only advance along the broadcast scan line. Conflating them flipped
  // the frame while every artifact still looked plausible.
  assert.match(ANALOG_FRAGMENT, /float scanLine\(float y\) \{ return uRes\.y - y; \}/);
  assert.match(ANALOG_FRAGMENT, /vec2 uv = vec2\(x, py\) \/ uRes;/);
  // and the phase must be taken through scanLine(), never from the raw y
  assert.match(ANALOG_FRAGMENT, /phaseAt\(x, scanLine\(py\)\)/);
});
