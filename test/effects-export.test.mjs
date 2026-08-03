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

// LEX, DO NOT REGEX. Review defeated the previous regex strip in BOTH directions
// and they were the same mistake:
//   - a commented-out bind still counted (dead text read as program);
//   - a `//` inside a STRING LITERAL truncated the line and hid a LIVE bind
//     (`const endpoint = "https://example.test"; gl.bindTexture(...)`).
// A line-oriented regex cannot know which state a character is in, so every fix
// at that level trades one direction for the other. This walks the source once
// and blanks everything that is not executable code, preserving length and line
// breaks so reported line numbers stay true.
//
// KNOWN AND DELIBERATE: the inside of a template literal is blanked whole,
// including any `${...}` interpolation. The shader lives in one of those, so
// treating it as code would scan GLSL as JavaScript. A bind written inside an
// interpolation would be missed; none is, and the limits test below says so.
function codeOnly(src) {
  const out = src.split("");
  const blank = (i) => { if (out[i] !== "\n") out[i] = " "; };
  const OPENS_REGEX = "(,=:[!&|?{};+-*%~^<>";
  const KEYWORDS = ["return", "typeof", "case", "in", "of", "new", "delete", "void", "instanceof"];
  // Does the '/' at `at` open a regex literal, or is it division? Decided by the
  // previous significant character — the standard disambiguation. Without this a
  // regex containing a quote or a `//` would flip the scanner into a phantom
  // string and silently blank real code after it.
  const opensRegex = (at) => {
    for (let k = at - 1; k >= 0; k--) {
      const c = src[k];
      if (c === " " || c === "\t" || c === "\n" || c === "\r") continue;
      if (OPENS_REGEX.includes(c)) return true;
      if (/[A-Za-z0-9_$]/.test(c)) {
        const word = src.slice(0, k + 1).match(/[A-Za-z]+$/);
        return !!word && KEYWORDS.includes(word[0]);
      }
      return false;
    }
    return true;
  };
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === "/" && d === "/") { while (i < n && src[i] !== "\n") blank(i++); continue; }
    if (c === "/" && d === "*") {
      blank(i++); blank(i++);
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) blank(i++);
      if (i < n) { blank(i++); blank(i++); }
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      i++;                                        // keep the delimiter, blank the body
      while (i < n && src[i] !== c) {
        if (src[i] === "\\") { blank(i++); if (i < n) blank(i++); continue; }
        blank(i++);
      }
      if (i < n) i++;
      continue;
    }
    if (c === "/" && opensRegex(i)) {
      i++;
      let inClass = false;
      while (i < n && src[i] !== "\n") {
        if (src[i] === "\\") { blank(i++); if (i < n) blank(i++); continue; }
        if (src[i] === "[") inClass = true;
        else if (src[i] === "]") inClass = false;
        else if (src[i] === "/" && !inClass) break;
        blank(i++);
      }
      if (i < n && src[i] === "/") i++;
      continue;
    }
    i++;
  }
  return out.join("");
}

const CODE = codeOnly(SURFACE);

test("the scanner reads code and only code — the control for the guard below", () => {
  // A CONTROL HARNESS NEEDS ITS OWN CONTROL. The guard is only as good as what it
  // is looking at, and the last two defects were both in this layer rather than
  // in the rule. These are review's exact defeating inputs, committed so they
  // re-run rather than being a claim I made once.
  const stripped = codeOnly([
    `// gl.bindTexture(gl.TEXTURE_2D, deadTex);`,
    `const endpoint = "https://example.test"; gl.bindTexture(gl.TEXTURE_2D, liveTex);`,
    `if (/\\/\\/'"/.test(x)) gl.bindTexture(gl.TEXTURE_2D, afterRegexTex);`,
    `/* gl.bindTexture(gl.TEXTURE_2D, blockTex); */ gl.bindTexture(gl.TEXTURE_2D, afterBlockTex);`,
  ].join("\n"));
  const seen = [...stripped.matchAll(/gl\.bindTexture/g)].length;
  assert.equal(seen, 3,
    `expected the live binds only: commented-out gone, the ones after a string, a\n` +
    `quote-bearing regex and a block comment kept. Saw ${seen}.`);
  assert.equal(stripped.split("\n").length, 4, "line count must be preserved for line numbers");
  assert.ok(!stripped.includes("deadTex") && !stripped.includes("blockTex"), "dead code survived");
  assert.ok(stripped.includes("liveTex") && stripped.includes("afterRegexTex"), "live code was eaten");
});

test("CONVENTION: each texture bind spells out its own unit selection", () => {
  // WHAT THIS IS, AND THE NAME NOW SAYS IT: a CONVENTION about how binds are
  // WRITTEN. It is not a proof about what the program DOES, and after five
  // rounds of review defeating wider versions, it no longer claims to be.
  //
  // THE SUPPORTED FORM IS THE ONLY FORM: a literal gl.activeTexture(...) call,
  // then the gl.bindTexture(...) that consumes it. Nothing else is analysed.
  //
  // WHY HELPER-FOLLOWING WAS DELETED RATHER THAN FIXED. The previous version
  // tried to accept an activation factored into a helper, and review measured it
  // failing in BOTH directions at once:
  //   - it counted gl.activeTexture INSIDE a function body as though the function
  //     had run, so an UNCALLED helper passed while the bind landed on the wrong
  //     unit (traced under SwiftShader: helper uncalled -> source on unit 1);
  //   - it looked for that text within 400 characters of the declaration, so the
  //     SAME correct helper failed once inert padding pushed its activation past
  //     an undocumented boundary.
  // A declaration-body token is not execution and a character count is not scope.
  // Both are the proximity proxy that three earlier rounds already removed from
  // this file — so the answer is to stop advertising the capability, not to
  // measure it slightly better.
  // AND PAIR ONLY WITHIN A BLOCK. Deleting the helper layer did NOT fix review's
  // uncalled-helper case, and I verified that by planting it rather than assuming
  // the smaller guard was safer: the BASE scan already counted a gl.activeTexture
  // sitting inside a function body as though it had executed, so
  //
  //     function activate() { gl.activeTexture(gl.TEXTURE0 + UNIT_SRC); }
  //     gl.bindTexture(gl.TEXTURE_2D, srcTex);          // helper never called
  //
  // still passed with the bind landing on whatever unit was current. The root
  // cause was one level below the layer I removed.
  //
  // Brace depth settles it exactly, and it is structure rather than distance: an
  // activation can only be consumed by a bind in the SAME block, with no block
  // closing between them. A body-scoped activation therefore cannot pay for a
  // bind outside that body, however near it sits. This is computable precisely
  // from the token stream — no window, no threshold, nothing to tune.
  const depth = new Array(CODE.length);
  { let d = 0;
    for (let i = 0; i < CODE.length; i++) {
      if (CODE[i] === "}") d--;
      depth[i] = d;
      if (CODE[i] === "{") d++;
    } }
  const minDepthBetween = (a, b) => {
    let m = Infinity;
    for (let i = a; i <= b; i++) if (depth[i] < m) m = depth[i];
    return m;
  };
  const calls = [...CODE.matchAll(/gl\.(activeTexture|bindTexture)\s*\(/g)]
    .map((m) => ({ kind: m[1], at: m.index }));
  const lineOf = (idx) => CODE.slice(0, idx).split("\n").length;

  assert.ok(calls.filter((c) => c.kind === "bindTexture").length >= 3,
    "expected the source, path and draw-time binds to be present");

  const unowned = [];
  let pending = null;              // an activation not yet claimed by a bind
  for (const c of calls) {
    if (c.kind === "activeTexture") { pending = c.at; continue; }
    const sameBlock = pending !== null
      && depth[pending] === depth[c.at]
      && minDepthBetween(pending, c.at) >= depth[c.at];
    if (!sameBlock) unowned.push(lineOf(c.at));
    pending = null;                // a bind CONSUMES it; the next needs its own
  }
  assert.deepEqual(unowned, [],
    `CONVENTION NOT FOLLOWED at lines ${unowned}: a gl.bindTexture with no literal\n` +
    `gl.activeTexture of its own in front of it.\n` +
    `\n` +
    `READ THIS BEFORE DECIDING WHETHER YOUR CODE IS WRONG. This check reads SOURCE\n` +
    `TEXT. It cannot prove which unit is current at runtime, and it does not try.\n` +
    `It enforces one house style — select, then bind — because that is the form a\n` +
    `human can audit by reading, and because a bind inheriting someone else's\n` +
    `active unit is the defect that put both samplers on the path texture.\n` +
    `\n` +
    `SO YOUR CODE MAY WELL BE CORRECT AND STILL FAIL HERE. Cases that are correct\n` +
    `at runtime and rejected anyway, all measured rather than supposed:\n` +
    `  - the activation factored into a helper. Helpers are NOT analysed at all.\n` +
    `  - an unbind (binding null) while its unit is already current. Traced: that\n` +
    `    genuinely clears the right unit. It is rejected because this check cannot\n` +
    `    tell it apart from the same call made while a DIFFERENT unit is current,\n` +
    `    which clears the wrong one. The convention covers both; only one is a bug.\n` +
    `\n` +
    `WHAT TO DO: write the explicit activeTexture — that is the whole convention,\n` +
    `and it costs one line. If the supported form genuinely does not fit what you\n` +
    `are building, change this guard DELIBERATELY and say in its place what carries\n` +
    `the evidence instead. The runtime evidence has always been the GL-level trace\n` +
    `in review, never this file. Deleting it silently is the only wrong answer.`);
});

// WHAT THIS GUARD CANNOT SEE. Knowing where it stops holding is worth more than
// a pass, and every item here was demonstrated against it rather than imagined.
//
// TEXTUAL ORDER IS NOT EXECUTION ORDER. `if (false) gl.activeTexture(...)` before
// a bind satisfies it. So does one activation outside a loop whose body binds
// twice — traced, and the second iteration puts the path texture on unit 0, which
// is the original corruption passing the guard that exists for it.
// It cannot follow a helper, an alias, or a bind reached through either, and it
// does not read inside template interpolation.
//
// THERE WAS A TEST HERE ASSERTING THE COVERED BINDS ARE STRAIGHT-LINE. It is
// deleted, not repaired. It searched two preceding lines for a control-flow
// keyword, so review passed an exact dangerous loop through it and then failed
// the SAME loop by inserting one harmless declaration — proximity again, in the
// test written to document the limit of the last proximity fix. A check that
// reports on distance while claiming to report on reachability is worse than an
// honest paragraph, because it looks like a mechanism.

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
