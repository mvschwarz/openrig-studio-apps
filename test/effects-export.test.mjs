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
  // Asserting the PROPERTY rather than counting assignment sites — an earlier
  // form of this test counted three literal assignments and broke when they were
  // correctly refactored into one guarded helper. Shape is not content, and that
  // applies to my own assertions.
  assert.match(SURFACE, /if \(gen === paramGen\) lastDrawnGen = gen;/,
    "delivery may only be claimed while this render is still the newest intent");
  const exits = SURFACE.match(/return finish\(gen\);/g) || [];
  assert.equal(exits.length, 3,
    `the tile path and both GPU exits must route through the guard, found ${exits.length}`);
});

test("renders are serialised, so two cannot interleave over one GL context", () => {
  // MEASURED IN REVIEW: the old flag was cleared at the START of the animation
  // callback, before an async body that awaits the displacement path. A second
  // draw began while the first was in flight and the two interleaved — one
  // uploading a path texture while the other set uniforms and drew. The result
  // belonged to NEITHER intent: a visibly corrupted third image, while the
  // authored params AND the provider request at capture were both correct.
  //
  // "Right params, right request, an image that is not any look at all" is a
  // STATE bug, not a timing one, and it is why a mutex is the fix rather than
  // more waiting.
  assert.match(SURFACE, /let drawing = false, drawPending = false;/,
    "a render in progress must exclude another");
  assert.match(SURFACE, /if \(drawing\) \{ drawPending = true; return; \}/,
    "a request arriving mid-render must be remembered, not dropped");
  assert.match(SURFACE, /if \(drawPending\) \{ drawPending = false; draw\(\); \}/,
    "and replayed, or the newest intent never reaches the screen");
  assert.equal(/let drawQueued/.test(SURFACE), false,
    "the flag that only guarded queueing is the defect this replaces");
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

// STRIP COMMENTS BEFORE SCANNING. Review commented out all four binds and the
// guard still passed: four textual occurrences remained, and the check counted
// them. A lexical guard that reads its own dead code is measuring the file, not
// the program.
const CODE = SURFACE
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");

test("every direct texture bind is preceded by an activation it consumes", () => {
  // WHAT THIS IS, STATED HONESTLY BECAUSE REVIEW MEASURED IT: this enforces a
  // CONVENTION — direct gl.activeTexture / gl.bindTexture calls, alternating —
  // and it does NOT prove runtime ownership. Independent review demonstrated both
  // directions with GL traces:
  //
  //   ACCEPTED BUT WRONG AT RUNTIME: `if (false) gl.activeTexture(...)` before a
  //   bind, and one activation outside a loop whose body binds twice. The trace
  //   showed the second iteration binding the path texture onto unit 0, exactly
  //   the original corruption. Textual order is not execution order, and textual
  //   cardinality is not runtime cardinality.
  //
  //   REJECTED BUT RIGHT AT RUNTIME: the activation moved into a hoisted helper.
  //   Traced correct — and this guard fails it, because it cannot follow calls.
  //
  // The convention is still worth enforcing: it keeps the property AUDITABLE by
  // reading, and it caught both real defects. But the runtime evidence is the GL
  // trace, and this cannot replace it.
  // FOLLOW ONE LEVEL OF INDIRECTION, because rejecting correct code is how a guard
  // dies. Review demonstrated it: an activation factored into a hoisted helper is
  // CORRECT at runtime — traced, source on unit 0 and path on unit 1 — and the
  // direct-call form failed it. Someone will do that legitimately, hit this under
  // deadline, and delete the check rather than restructure.
  //
  // So a local function whose body itself calls gl.activeTexture COUNTS as an
  // activation. That covers the realistic factoring without pretending to resolve
  // arbitrary indirection: a helper calling a helper is still outside this, and
  // the message says so rather than leaving it to be discovered.
  const activators = new Set();
  const declRe = /(?:function\s+(\w+)\s*\(|(?:const|let|var)\s+(\w+)\s*=\s*(?:\([^)]*\)|\w+)\s*=>)/g;
  for (const d of CODE.matchAll(declRe)) {
    const name = d[1] || d[2];
    if (!name) continue;
    if (/gl\.activeTexture\s*\(/.test(CODE.slice(d.index, d.index + 400))) activators.add(name);
  }
  const activatorCall = activators.size
    ? new RegExp(`\\b(?:${[...activators].join("|")})\\s*\\(`, "g") : null;

  const calls = [...CODE.matchAll(/gl\.(activeTexture|bindTexture)\s*\(/g)]
    .map((m) => ({ kind: m[1], at: m.index }));
  if (activatorCall) {
    for (const m of CODE.matchAll(activatorCall)) {
      // the declaration itself is not a call site
      if (/(?:function|const|let|var)\s+$/.test(CODE.slice(Math.max(0, m.index - 12), m.index))) continue;
      calls.push({ kind: "activeTexture", at: m.index });
    }
    calls.sort((a, b) => a.at - b.at);
  }
  const lineOf = (idx) => CODE.slice(0, idx).split("\n").length;

  assert.ok(calls.filter((c) => c.kind === "bindTexture").length >= 3,
    "expected the source, path and draw-time binds to be present");

  const unowned = [];
  let pending = null;              // an activation not yet claimed by a bind
  for (const c of calls) {
    if (c.kind === "activeTexture") { pending = c.at; continue; }
    if (pending === null) unowned.push(lineOf(c.at));
    pending = null;                // a bind CONSUMES it; the next needs its own
  }
  assert.deepEqual(unowned, [],
    `these binds do not select a unit of their own (lines ${unowned}).\n` +
    `Each writes into whichever unit the previous caller left active.\n` +
    `\n` +
    `IF THIS IS AN UNBIND (binding null): it still needs a unit. Clearing the\n` +
    `wrong unit is the same defect as binding to it — that is why this fires on\n` +
    `something that looks harmless. Select the unit; do not delete the check.\n` +
    `\n` +
    `IF YOU MOVED THE ACTIVATION INTO A HELPER: a local function that itself\n` +
    `calls gl.activeTexture IS recognised. A helper calling ANOTHER helper is not\n` +
    `— this follows one level, deliberately. Inline it, flatten the helper, or\n` +
    `change this guard and say what replaces the audit. Do not just delete it.`);
});

// WHAT THIS GUARD CANNOT SEE, written down so nobody trusts it further than it
// reaches. Knowing where a guard stops holding is worth more than a pass.
//
// IT READS SOURCE TEXT, AND TEXTUAL ORDER IS NOT EXECUTION ORDER. An activeTexture
// inside a branch that does not run, a bind inside a loop with the activation
// outside it, or an activation in a branch the bind does not share will all
// satisfy this and still be wrong at runtime. It also cannot follow a bind reached
// through an alias or a helper.
//
// Those are the honest boundary of any source-reading check, not defects in it.
// The runtime evidence that the current code is correct comes from GL-level
// traces in review, not from here — this exists to stop a NEW unguarded bind
// being added, which is a different job.
test("the binds this guard covers are straight-line, so its reading is sound today", () => {
  // The limit above only bites if a bind sits under control flow. None does right
  // now, and this fails if that changes — at which point the guard needs runtime
  // evidence rather than a wider regex.
  const lines = SURFACE.split("\n");
  const risky = [];
  lines.forEach((line, i) => {
    if (!line.includes("bindTexture")) return;
    const before = lines.slice(Math.max(0, i - 2), i).join(" ");
    // an activation and a bind separated by a branch or loop opening
    if (/\b(if|for|while)\s*\(/.test(before) && !before.includes("activeTexture")) risky.push(i + 1);
  });
  assert.deepEqual(risky, [],
    `a bind sits under control flow (lines ${risky}); textual order no longer implies execution order there`);
});

test("the sampler units are named once rather than spelled out at each call", () => {
  // Two call sites agreeing on a bare 0 and 1 is how one of them ended up on the
  // wrong unit with nothing looking odd.
  assert.match(SURFACE, /const UNIT_SRC = 0, UNIT_PATH = 1;/);
  assert.match(SURFACE, /gl\.uniform1i\(u\('uSrc'\), UNIT_SRC\)/);
  assert.match(SURFACE, /gl\.uniform1i\(u\('uPath'\), UNIT_PATH\)/);
});

test("uploading the path leaves the active unit as it found it", () => {
  // So a caller cannot depend on our side effects, and a later edit cannot
  // silently inherit them.
  const fn = SURFACE.slice(SURFACE.indexOf("async function refreshPath("),
                           SURFACE.indexOf("let frameCounter"));
  assert.ok(fn.length > 200, "refreshPath body not located");
  assert.match(fn, /gl\.activeTexture\(gl\.TEXTURE0 \+ UNIT_PATH\);/, "must select its own unit");
  assert.match(fn, /gl\.activeTexture\(gl\.TEXTURE0 \+ UNIT_SRC\);\s*\n\s*pathKey = key;/,
    "and restore the caller's before returning");
});
