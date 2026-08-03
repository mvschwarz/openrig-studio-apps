// EXPORT — save-frame and the look sheet.
//
// These pin the two ways a look sheet can label a cell wrongly, because both
// were found in review and neither produced an error, a blank, or anything that
// looked degraded. A look sheet is a REFERENCE ARTIFACT: its entire job is to
// tell you what each named look looks like. When it is wrong it does not look
// broken — it looks finished, and it teaches whoever reads it the wrong thing
// about their own tool.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SURFACE = fs.readFileSync(path.join(HERE, "../apps/effects/app/effects.html"), "utf8");

// The body of contactSheet(), so these assertions cannot be satisfied by an
// unrelated part of the file.
const SHEET = SURFACE.slice(
  SURFACE.indexOf("async function contactSheet("),
  SURFACE.indexOf("return sheet.toDataURL('image/png');"),
);

test("the sheet waits for the render it asked for, and never sleeps instead", () => {
  // MEASURED IN REVIEW: with animation callbacks delayed, a fixed 260ms wait
  // produced a valid, complete, correctly-labelled PNG in which five of seven
  // cells held a DIFFERENT look — no error, and the UI reported success. A
  // longer timeout only moves the threshold; it does not remove the defect.
  assert.ok(SHEET.length > 200, "contactSheet body not located");
  assert.match(SHEET, /await awaitRender\(/, "each capture must wait on the render fence");
  assert.equal(/setTimeout\(/.test(SHEET), false,
    "a sleep standing in for a signal is the defect this pins");
});

test("the fence is a delivery counter, not the intent counter", () => {
  // paramGen counts what was ASKED FOR. Waiting on it would be waiting on
  // yourself: it advances the moment the request is made, so the fence would be
  // satisfied before anything had been drawn.
  assert.match(SURFACE, /let lastDrawnGen = -1;/, "a delivery counter must exist");
  // Every completed render marks delivery — the tile path and BOTH GPU exits.
  const marks = SURFACE.match(/lastDrawnGen = gen;/g) || [];
  assert.equal(marks.length, 3,
    `expected the tile draw and both GPU exit points to mark delivery, found ${marks.length}`);
});

test("the fence FAILS rather than capturing a frame it cannot vouch for", () => {
  // The bound exists to stop a hang, not to stand in for the signal. Resolving on
  // timeout would reintroduce exactly the defect with extra steps.
  // Bounded by the next function, not by a marker that sits EARLIER in the file —
  // the first form silently produced an empty slice and the test failed against
  // correct code.
  const fence = SURFACE.slice(SURFACE.indexOf("function awaitRender("),
                              SURFACE.indexOf("async function contactSheet("));
  assert.ok(fence.length > 200, "awaitRender body not located");
  assert.match(fence, /reject\(new Error\(/, "reaching the bound must throw");
  assert.equal(/resolve\(\);?\s*\}\s*if \(performance/.test(fence), false,
    "the timeout path must not resolve");
  assert.match(fence, /nothing was captured/, "and must say nothing was captured");
});

test("a sheet of NAMED LOOKS suspends curves, so the labels are true", () => {
  // MEASURED IN REVIEW, and no timing involved: with a drift curve active, ALL
  // SEVEN labelled scan cells matched the curve-modified renders and ZERO matched
  // the bare presets. The sheet could not be used for the one comparison it
  // exists to make, and nothing on it disclosed that.
  assert.match(SHEET, /curveSpec = null;/, "curves must be suspended for the duration");
  // and restored with everything else, not left cleared
  const restore = SURFACE.slice(SURFACE.indexOf("} finally {", SURFACE.indexOf("async function contactSheet(")));
  assert.match(restore.slice(0, 400), /curveSpec = beforeCurve;/,
    "the caller's curve must come back");
});

test("state is captured before the sheet runs and restored in a finally", () => {
  // A tool that silently kept the last preset it rendered would lose the thing
  // the user was working on — and the restore has to survive a throw, which is
  // now reachable because the fence can reject.
  assert.match(SHEET, /const before = \{ \.\.\.params \}, beforeCurve = curveSpec;/);
  assert.match(SURFACE.slice(SURFACE.indexOf("async function contactSheet(")), /\} finally \{/);
});

test("save-frame reads the live canvas rather than assuming one renderer", () => {
  // The tile family draws to a second canvas; picking the wrong one would export
  // a stale or blank image while the screen looked correct.
  assert.match(SURFACE, /const liveCanvas = \(\) =>[\s\S]{0,120}c2d : canvas;/);
  assert.match(SURFACE, /function frameDataUrl\(\) \{ return liveCanvas\(\)\.toDataURL/);
});
