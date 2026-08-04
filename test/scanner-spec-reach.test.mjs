// THE SPEC IS THE COMPLETE SURFACE. That is the scanner's central design claim,
// and this file is the only thing that can hold it true.
//
// It exists because the same defect has now landed three times, and each time it
// presented as "the effect just isn't happening" rather than as an error:
//
//   headSoftness  declared, set by a spec, and never read by the shader.
//   bedRate/headRate  declared for an agent to find, read by nothing at all.
//   sourceRate    read by the surface, but no spec key ever produced it — so the
//                 one knob that governs temporal shear could not be set from a
//                 spec, and every "raise source.rate" experiment silently ran at 1.
//
// A knob that is published but unreachable is worse than a missing one: an agent
// finds it in the schema, writes it into a spec, sees no error, and gets no effect.
import test from "node:test";
import assert from "node:assert/strict";
import { SCANNER_PARAMS, SCANNER_WRITE_FRAGMENT, compileSpec }
  from "../providers/studio-effects/engine/scanner.mjs";

// Every group of the documented grammar, exercised at once. If a published
// parameter cannot be reached from THIS spec, it cannot be reached from any.
const EVERYTHING = {
  scan: { duration: "10s" },
  stages: [{
    id: "a",
    source: { rate: 2 },
    bed: { x: 10, y: 20, rotate: 5, scale: 1.5 },
    head: { axis: "horizontal", position: 0.5, width: 8, angle: 3, softness: 0.25 },
    response: { read: "edge", gain: 1.2, bias: 0.1, threshold: 0.2,
                invert: true, targetColor: "#c84a2a" },
    write: { mode: "direct", palette: "ember", displace: 40,
             advance: 4, frames: 3, fps: 12, persistence: 0.9 },
  }],
};

const producedBy = (spec) => {
  const r = compileSpec(spec);
  assert.deepEqual(r.problems, [], "the reference spec must compile without complaint");
  const st = r.stages[0];
  return new Set([
    ...Object.keys(st.constants),
    ...Object.keys(st.tracks),
    ...st.derived.map((d) => d.param),
  ]);
};

test("every published parameter is reachable from a spec", () => {
  const produced = producedBy(EVERYTHING);
  const unreachable = Object.keys(SCANNER_PARAMS).filter((k) => !produced.has(k));
  assert.deepEqual(unreachable, [],
    `published but unreachable from any spec: ${unreachable.join(", ")}`);
});

test("source.rate reaches sourceRate, because it is the whole temporal-shear knob", () => {
  // The source-seconds between two adjacent columns is
  //     headWidth * sourceRate / (advance * 60)
  // and sourceRate is the only term you can raise without also slowing the sweep.
  // Dropping it on the floor is the difference between water and a clean scan.
  const r = compileSpec({ scan: { duration: "10s" },
    stages: [{ id: "a", source: { rate: 6 }, head: { width: 8 }, write: { advance: 4 } }] });
  assert.deepEqual(r.problems, []);
  assert.equal(r.stages[0].constants.sourceRate, 6);
});

test("source.rate accepts a lane, so the footage can speed up mid-scan", () => {
  const r = compileSpec({ scan: { duration: "10s" },
    stages: [{ id: "a", source: { rate: { ramp: [1, 8] } } }] });
  assert.deepEqual(r.problems, []);
  assert.ok(Array.isArray(r.stages[0].tracks.sourceRate),
    "a ramped rate must compile to a track, not be flattened to a constant");
});

test("the feather ramps across the OVERLAP, never across the strip's own core", () => {
  // The seam feather crossfades a new strip with what is already on the tape. It
  // can only do that in the region the scissor widens BACKWARD into the previous
  // strip. Anchoring the ramp at uStripAt instead fades in across the new strip's
  // own first pixels — which nothing has written yet — so the crossfade partner
  // is black and every strip lays a thin dark seam. Confirmed by the one
  // measurement that can only come out one way: the same run at softness 0 has no
  // striations at all, and at softness 0.25 on an 8px strip has a dark line every
  // 8 pixels across the whole tape.
  const m = SCANNER_WRITE_FRAGMENT.match(/float pos = \([^)]*\)[^;]*;/);
  assert.ok(m, "the feather ramp must still be a single readable expression");
  assert.match(m[0], /uStripAt - f/,
    "the ramp must be anchored a feather-width BEFORE the strip, inside the overlap");
});

test("sourceRate's published range admits the rates the surface will actually apply", () => {
  // The surface clamps to [0.0625, 16] because that is what a video element takes.
  // A schema that stops at 4 tells an agent 6 is out of bounds when it is not.
  const p = SCANNER_PARAMS.sourceRate;
  assert.ok(p.max >= 16, `sourceRate.max is ${p.max}, but the surface applies up to 16`);
  assert.ok(p.min <= 0, "0 must be admissible — it freezes the footage into a still");
});
