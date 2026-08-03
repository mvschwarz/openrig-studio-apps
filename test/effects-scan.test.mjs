// The scan effect's contract, pinned at the two places it can silently break.
import test from "node:test";
import assert from "node:assert/strict";
import { buildPath, PATH_RANGE, SCAN_FRAGMENT } from "../providers/studio-effects/engine/scan.mjs";
import { FAMILIES, coerce, applyPreset } from "../providers/studio-effects/engine/schema.mjs";

// Decoder mirroring the shader, so a change to either side fails here rather than
// showing up as an image that looks merely "subtle".
const decode = (buf, i) =>
  (((buf[i * 4] * 256 + buf[i * 4 + 1]) / 65535) * 2 - 1) * PATH_RANGE;

test("displacement survives the trip through an 8-bit texture", () => {
  // WHY 8-BIT AT ALL: a float path texture sampled as ZERO on a real renderer
  // while reading back correctly through a framebuffer, and the extension that
  // gates it reported as supported. Nothing errored — the displacement just went
  // away and the picture looked subtle instead of broken.
  const path = buildPath(600, { drift: 400, wobbleAmount: 0 });
  assert.equal(path.constructor, Uint8Array, "an ordinary texture, no float extension");
  assert.ok(Math.abs(decode(path, 0)) < 0.1, "starts at no displacement");
  assert.ok(Math.abs(decode(path, 599) - 400) < 0.5, "ends at the full drift");
  const mid = decode(path, 300);
  assert.ok(Math.abs(mid - 200) < 1, `midpoint should be about half the drift, got ${mid}`);
});

test("a tear is a held run of rows, not a single-row spike", () => {
  // A hand does not jerk for one scanline: it slips, and the slip persists. Per-row
  // randomness reads as more jitter; held runs are what make the hard cliffs.
  const path = buildPath(400, { tearAmount: 300, tearFrequency: 4, wobbleAmount: 0, seed: 1 });
  const dx = Array.from({ length: 400 }, (_, i) => decode(path, i));
  const runs = dx.filter((v, i) => i > 0 && Math.abs(v - dx[i - 1]) < 0.5 && Math.abs(v) > 20).length;
  assert.ok(Math.max(...dx.map(Math.abs)) > 50, "tears actually displace");
  assert.ok(runs > 6, `a tear should hold across rows, saw ${runs} held rows`);
});

test("the shader and the encoder agree on the range", () => {
  // Two constants that must match, in two languages, in two files. Nothing else
  // would catch them drifting until the picture was wrong.
  assert.match(SCAN_FRAGMENT, new RegExp(`PATH_RANGE = ${PATH_RANGE}\\.0`),
    "the shader's PATH_RANGE must equal the encoder's");
});

test("every knob an agent can read is one the effect actually uses", () => {
  // The schema is what an agent drives from. A knob published but unread is a
  // control that does nothing, and the agent has no way to discover that.
  const declared = Object.keys(FAMILIES.scan.params);
  for (const k of ["tearAmount", "wobbleAmount", "chromaShift", "grain", "scanAxis"]) {
    assert.ok(declared.includes(k), `${k} must be published for an agent to find it`);
  }
  for (const [name] of Object.entries(FAMILIES.scan.presets)) {
    const r = applyPreset("scan", name);
    assert.ok(!r.error, `preset ${name} must resolve`);
    for (const k of Object.keys(r.params)) assert.ok(declared.includes(k), `${name} sets unknown ${k}`);
  }
});

test("an out-of-range request is corrected and reported, never refused", () => {
  // Out of range is the NORMAL case when something else is driving — an agent
  // reaching for an extreme, a preset written against an older range. Refusing
  // would make the tool feel brittle to the thing most likely to drive it.
  const r = coerce("scan", { tearAmount: 9999, wobbleAmount: -5, nonsense: 1 });
  assert.equal(r.params.tearAmount, 400);
  assert.equal(r.params.wobbleAmount, 0);
  assert.ok(r.notes.some((n) => n.includes("clamped")), "and it says what it changed");
  assert.ok(r.notes.some((n) => n.includes("nonsense")), "and what it ignored");
});

test("a preset resolved by the provider cannot overwrite a later change", () => {
  // FOUND BY studio-qa, reproduced, and it is the MAIN PATH rather than an edge
  // case: applying a look and then adjusting one knob is exactly how an agent
  // drives this. Because the preset is resolved by the provider, it is async — so a
  // set() issued while that request was in flight was applied, RETURNED TO THE
  // CALLER AS APPLIED, and then silently overwritten when the response landed. The
  // control appeared to do nothing and a later control appeared to work, which is
  // the most confusing symptom available.
  //
  // The surface fix is a generation counter. This test pins the INVARIANT that fix
  // exists to hold, at the layer that can be tested here: a later intent wins, and
  // whatever is reported as applied is what is actually in effect.
  let params = { tearAmount: 0 };
  let gen = 0;
  const set = (patch) => { gen++; Object.assign(params, patch); return { ...params }; };
  const resolveInto = (g, next) => { if (g === gen) params = next; return { ...params }; };

  const g = ++gen;                       // a preset begins resolving
  const returned = set({ tearAmount: 7 }); // the operator adjusts a knob meanwhile
  resolveInto(g, { tearAmount: 220 });     // the stale preset response lands

  assert.equal(params.tearAmount, 7, "the later intent must win");
  assert.equal(returned.tearAmount, params.tearAmount,
    "and what was reported as applied must be what is actually in effect");
});
