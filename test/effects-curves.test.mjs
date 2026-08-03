// CURVES — a parameter as a function of time.
//
// What makes these worth writing: a curve is the one part of the effects tier
// that is pure data and pure arithmetic, so it is the part a headless test can
// actually judge. The renderers need eyes; this does not.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evalCurves, curveTime, pulses, ramp, fromBeats, EASING_NAMES,
} from "../providers/studio-effects/engine/curves.mjs";
import { FAMILIES } from "../providers/studio-effects/engine/schema.mjs";

const analog = FAMILIES.analog;
const tile = FAMILIES.tile;

test("a keyframed number moves between its keyframes", () => {
  const spec = { tracks: { chromaBleed: [{ t: 0, v: 0 }, { t: 1, v: 2 }] } };
  assert.equal(evalCurves(spec, analog, 0, 10).patch.chromaBleed, 0);
  assert.equal(evalCurves(spec, analog, 10, 10).patch.chromaBleed, 2);
  assert.equal(evalCurves(spec, analog, 5, 10).patch.chromaBleed, 1);
});

test("outside its keyframes a curve HOLDS rather than extrapolating", () => {
  // Extrapolating invents motion the author never asked for, and on a looping
  // clip it would keep going forever.
  const spec = { tracks: { chromaBleed: [{ t: 0.25, v: 1 }, { t: 0.75, v: 2 }] } };
  assert.equal(evalCurves(spec, analog, 0, 10).patch.chromaBleed, 1);
  assert.equal(evalCurves(spec, analog, 10, 10).patch.chromaBleed, 2);
});

test("what CANNOT be interpolated steps instead of being invented", () => {
  // There is no palette halfway between gameboy and cga. Interpolating would
  // either produce nonsense or silently pick one.
  const spec = { tracks: { palette: [{ t: 0, v: "gameboy" }, { t: 1, v: "cga" }] } };
  assert.equal(evalCurves(spec, tile, 4, 10).patch.palette, "gameboy", "must hold, not blend");
  assert.equal(evalCurves(spec, tile, 9.9, 10).patch.palette, "gameboy");
  assert.equal(evalCurves(spec, tile, 10, 10).patch.palette, "cga");
});

test("an int track lands on integers", () => {
  const spec = { tracks: { gridSize: [{ t: 0, v: 24 }, { t: 1, v: 25 }] } };
  const v = evalCurves(spec, tile, 5, 10).patch.gridSize;
  assert.equal(Number.isInteger(v), true, `got ${v}`);
});

test("a curve that overshoots is clamped and SAID SO, not refused", () => {
  // Same contract coerce() offers: an out-of-range value is the normal case when
  // something else is driving, so it is corrected and reported.
  const spec = { tracks: { chromaBleed: [{ t: 0, v: 0 }, { t: 1, v: 99 }] } };
  const r = evalCurves(spec, analog, 10, 10);
  assert.equal(r.patch.chromaBleed, analog.params.chromaBleed.max);
  assert.ok(r.notes.some((n) => n.includes("chromaBleed")), "a clamp must be visible");
});

test("a track naming a parameter that does not exist is reported, not ignored", () => {
  const r = evalCurves({ tracks: { notAKnob: [{ t: 0, v: 1 }] } }, analog, 0, 10);
  assert.deepEqual(r.patch, {});
  assert.ok(r.notes.some((n) => n.includes("notAKnob")));
});

test("the patch contains ONLY what the curves drive", () => {
  // So it layers over a preset instead of replacing it. If this returned a whole
  // parameter set, attaching a curve would silently discard the look.
  const r = evalCurves({ tracks: { smear: [{ t: 0, v: 0.5 }] } }, analog, 0, 10);
  assert.deepEqual(Object.keys(r.patch), ["smear"]);
});

test("the time base is declared rather than assumed", () => {
  // A curve written against a 14s clip and replayed on a 40s one either stretches
  // or keeps its absolute timings, and only the author knows which.
  assert.equal(curveTime({ unit: "fraction" }, 5, 10), 0.5);
  assert.equal(curveTime({ unit: "seconds" }, 5, 10), 5);
  // fraction is the default and is clamped, so a bad duration cannot produce NaN
  assert.equal(curveTime({}, 5, 10), 0.5);
  assert.equal(curveTime({}, 50, 10), 1);
  assert.equal(curveTime({}, 5, 0), 0);
});

test("keyframes out of order are sorted rather than trusted", () => {
  // The likely author of a track is an agent composing JSON.
  const spec = { tracks: { smear: [{ t: 1, v: 1 }, { t: 0, v: 0 }] } };
  assert.equal(evalCurves(spec, analog, 5, 10).patch.smear, 0.5);
});

test("every declared easing is real and monotonic from 0 to 1", () => {
  // A named easing that did not reach its target would leave a curve permanently
  // short of the value the author wrote.
  for (const ease of EASING_NAMES) {
    const spec = { tracks: { smear: [{ t: 0, v: 0 }, { t: 1, v: 1, ease }] } };
    const at = (f) => evalCurves(spec, analog, f * 10, 10).patch.smear;
    assert.equal(at(0), 0, `${ease} must start at the first keyframe`);
    assert.equal(at(1), 1, `${ease} must REACH the second keyframe`);
    if (ease !== "hold") {
      let prev = -Infinity;
      for (let f = 0; f <= 1.0001; f += 0.1) {
        const v = at(f);
        assert.ok(v >= prev - 1e-9, `${ease} is not monotonic at ${f.toFixed(1)}`);
        prev = v;
      }
    }
  }
});

test("hold really holds — the negative control for the easing sweep", () => {
  // Without this, "every easing reaches its target" would also pass if easings
  // were silently all linear.
  const spec = { tracks: { smear: [{ t: 0, v: 0 }, { t: 1, v: 1, ease: "hold" }] } };
  assert.equal(evalCurves(spec, analog, 9, 10).patch.smear, 0);
  const lin = { tracks: { smear: [{ t: 0, v: 0 }, { t: 1, v: 1, ease: "linear" }] } };
  assert.equal(evalCurves(lin, analog, 9, 10).patch.smear, 0.9);
});

test("easings differ from each other, or naming them is decoration", () => {
  const at = (ease) => {
    const spec = { tracks: { smear: [{ t: 0, v: 0 }, { t: 1, v: 1, ease }] } };
    return evalCurves(spec, analog, 3, 10).patch.smear;
  };
  const vals = ["linear", "smooth", "snap", "settle"].map(at);
  assert.equal(new Set(vals.map((v) => v.toFixed(4))).size, vals.length, `easings collapsed: ${vals}`);
});

test("a pulse returns to where it started — an effect AT a cut, not after it", () => {
  // The oldest trick in analog video: a one-frame spike at each edit. If it did
  // not return, the first cut would permanently change the look.
  const track = pulses([0.5], { from: 0.1, to: 1, width: 0.05 });
  const spec = { tracks: { smear: track } };
  const at = (f) => evalCurves(spec, analog, f * 10, 10).patch.smear;
  assert.equal(at(0), 0.1, "starts at rest");
  assert.ok(at(0.5) > 0.9, `spike did not fire: ${at(0.5)}`);
  assert.ok(Math.abs(at(0.8) - 0.1) < 1e-9, `did not return to rest: ${at(0.8)}`);
});

test("pulses stay inside the clip and stay ordered whatever order the times arrive in", () => {
  const track = pulses([0.8, 0.2, 0.5]);
  for (let i = 1; i < track.length; i++) {
    assert.ok(track[i].t >= track[i - 1].t, `keyframes out of order at ${i}`);
  }
  assert.ok(track.length >= 9, "expected three spikes' worth of keyframes");
});

test("a beat envelope is a pulse track — one representation, not two", () => {
  // Generators emit KEYFRAMES. A second evaluator that only one consumer
  // understands is the same class of defect as a second copy of the shader.
  assert.deepEqual(fromBeats([0.25, 0.5]), pulses([0.25, 0.5]));
});

test("a ramp reaches both ends", () => {
  const spec = { tracks: { chromaBleed: ramp(0, 2) } };
  assert.equal(evalCurves(spec, analog, 0, 10).patch.chromaBleed, 0);
  assert.equal(evalCurves(spec, analog, 10, 10).patch.chromaBleed, 2);
});

test("no curve at all is not an error", () => {
  // The app is a still-image tool by default; curves are opt-in.
  assert.deepEqual(evalCurves({}, analog, 3, 10).patch, {});
  assert.deepEqual(evalCurves(null, analog, 3, 10).patch, {});
  assert.deepEqual(evalCurves({ tracks: {} }, analog, 3, 10).patch, {});
});

test("an empty or malformed track is reported rather than silently dropped", () => {
  const r = evalCurves({ tracks: { smear: [] } }, analog, 0, 10);
  assert.deepEqual(r.patch, {});
  assert.ok(r.notes.some((n) => n.includes("smear")));
  const r2 = evalCurves({ tracks: { smear: [{ v: 1 }] } }, analog, 0, 10);
  assert.ok(r2.notes.length > 0, "a keyframe with no time is not usable");
});

test("the same curve at the same time gives the same answer", () => {
  // Determinism is in the PRD's proof contract, and a curve that drifted would
  // make a rendered clip differ from the preview it was approved from.
  const spec = { tracks: { chromaBleed: ramp(0, 2), smear: pulses([0.3, 0.6]) } };
  const once = evalCurves(spec, analog, 4.2, 10);
  const twice = evalCurves(spec, analog, 4.2, 10);
  assert.deepEqual(once.patch, twice.patch);
});
