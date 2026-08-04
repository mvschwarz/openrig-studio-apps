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
  // AND THE COUNT IS NOT THE PROPERTY — this assertion previously pinned exactly
  // three exits and broke the moment the two GPU exits were correctly refactored
  // into one shared stage renderer. The comment three lines above says counting
  // assignment sites is the wrong shape, and this did it anyway, one assertion
  // later. What matters is that every exit claims delivery through the guard, not
  // how many exits there happen to be.
  const exits = SURFACE.match(/return finish\(gen\);/g) || [];
  assert.ok(exits.length >= 2,
    `every render exit must route through the delivery guard, found ${exits.length}`);
  const runDraw = SURFACE.slice(SURFACE.indexOf("async function runDraw()"),
                                SURFACE.indexOf("function drawTileSpec("));
  assert.equal(/\n\s*return;\s*\n/.test(runDraw.replace(/if \(!PROGRAM[^\n]*\n/, "")), false,
    "a bare return from runDraw would leave the renderer marked busy forever");
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
// 🛑 THE FRAME WAS WRONG FOR SIX ROUNDS, AND FIXING IT DELETED THE MACHINERY.
// This scanner used to blank template bodies WHOLE — text and `${...}` alike —
// which created a blind spot inside the interpolation, which needed a walker,
// which needed its own control, which needed a body-level backstop, which needed
// an await/yield absence assertion. Review defeated each in turn.
//
// THE PREMISE UNDER ALL OF IT: "the shader lives in a template literal, so
// treating bodies as code would scan GLSL as JavaScript." It was wrong TWICE.
//
// WRONG ONCE — re-measured independently on the only file this scanner is pointed
// at: #version / void main / gl_FragColor / gl_Position / precision / varying all
// ZERO; 19 template bodies, ZERO multi-line, longest 101 chars. The shaders are
// FETCHED from /api/effects/shader and the real GLSL lives in
// providers/studio-effects/engine/*.mjs, which this scanner never opens.
//
// WRONG TWICE, and this is the part that mattered: even if a shader WERE embedded
// it would be template TEXT. GLSL is not written inside a dollar-brace. So
// blanking TEXT is the whole of what protecting GLSL ever required, and blanking
// INTERPOLATIONS was never load-bearing for it — while an interpolation is the one
// part of a template that IS executable code. The blind spot existed because the
// only executable part was the part being discarded.
//
// SO: template TEXT is blanked, `${...}` is walked AS CODE in the same pass. No
// companion, no span to find, no gap held by prose. Review's compound stops
// existing rather than being defended against.
//
// MEASURED AGAINST THE ALTERNATIVE, because I had already committed the blunter
// version — delete the template case entirely and scan text as code too. That one
// HIDES A BIND: a template whose text contains `//` swallows the rest of the line,
// including a real bind after it, and it passed. This walk catches it. The blunt
// version's stated limit ("wrong only if pointed at the engine files") was itself
// too generous — it bites on this surface the moment anyone writes a template
// containing a slash-slash.
function scan(src) {
  const n = src.length;
  const out = src.split("");
  const blank = (i) => { if (out[i] !== "\n") out[i] = " "; };
  const OPENS_REGEX = "(,=:[!&|?{};+-*%~^<>";
  const KEYWORDS = ["return", "typeof", "case", "in", "of", "new", "delete", "void", "instanceof"];
  // Does the '/' at `at` open a regex literal, or is it division? Decided by the
  // previous significant character. Without it a regex containing a quote or a
  // `//` would flip the scanner into a phantom string and silently blank real code.
  //
  // THIS IS A HEURISTIC OVER AN ENUMERATED KEYWORD SET, NOT COMPLETE
  // DISAMBIGUATION. An earlier comment called it "the standard disambiguation" and
  // review falsified that by finding `await` and `yield` missing.
  //
  // I ADDED THOSE TWO KEYWORDS AND THEN TOOK THEM BACK OUT. Adding them makes the
  // demonstrated case pass, which is exactly why it is the wrong fix: it is the
  // sixth widening of a check narrowed five times, and it makes the errors point
  // the WRONG WAY. With `await` in the list, `await / 2` — legal division — reads
  // as a regex and blanks live code after it: silent, and the direction that ships
  // a bug. Without it, `await /re/` reads as division and the regex text merely
  // survives as code: noisy at worst, and it cannot hide a bind.
  //
  // For a guard, prefer an over-approximation that can only be TOO STRICT over a
  // precise rule that can be silently TOO LOOSE. So the list stays short.
  //
  // (This paragraph used to continue "…the undecidable case is asserted ABSENT by
  // a test of its own, and the interpolation check no longer depends on this
  // heuristic being right at all." BOTH HALVES WENT FALSE when those two things
  // were deleted — stale on success, in the commit that earned it. The surviving
  // statement is smaller and better: this heuristic's blast radius is ORDINARY
  // CODE ONLY, because there is no separate interpolation path left to get wrong.)
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
  const skipLineComment = (i) => { while (i < n && src[i] !== "\n") i++; return i; };
  const skipBlockComment = (i) => {
    i += 2;
    while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
    return Math.min(n, i + 2);
  };
  const skipString = (i) => {
    const q = src[i++];
    while (i < n && src[i] !== q) { if (src[i] === "\\") i++; i++; }
    return Math.min(n, i + 1);
  };
  const skipRegex = (i) => {
    i++;
    let inClass = false;
    while (i < n && src[i] !== "\n") {
      if (src[i] === "\\") { i += 2; continue; }
      if (src[i] === "[") inClass = true;
      else if (src[i] === "]") inClass = false;
      else if (src[i] === "/" && !inClass) return i + 1;
      i++;
    }
    return i;
  };
  const blankBody = (i, end) => { i++; while (i < end - 1) blank(i++); return end; };
  // OPTION D: a template's TEXT is blanked; its ${...} is CODE and is walked as
  // code in the same pass. GLSL, if ever embedded, is TEXT — it is never written
  // inside a dollar-brace — so blanking text is the whole of what protecting GLSL
  // required, and blanking interpolations never was.
  function walkTemplate(i) {
    blank(i); i++;                                  // opening backtick
    while (i < n && src[i] !== "`") {
      if (src[i] === "\\") { blank(i); blank(i + 1); i += 2; continue; }
      if (src[i] === "$" && src[i + 1] === "{") {
        blank(i); blank(i + 1); i += 2;             // ${ is not code
        let depth = 0;
        while (i < n) {
          const c = src[i], d2 = src[i + 1];
          if (c === "}" && depth === 0) { blank(i); i++; break; }
          if (c === "{") depth++;
          else if (c === "}") depth--;
          else if (c === "/" && d2 === "/") { const e = skipLineComment(i); while (i < e) blank(i++); continue; }
          else if (c === "/" && d2 === "*") { const e = skipBlockComment(i); while (i < e) blank(i++); continue; }
          else if (c === '"' || c === "'") { i = blankBody(i, skipString(i)); continue; }
          else if (c === "`") { i = walkTemplate(i); continue; }
          else if (c === "/" && opensRegex(i)) { i = blankBody(i, skipRegex(i)); continue; }
          i++;                                      // ordinary code character: KEPT
        }
        continue;
      }
      blank(i); i++;                                // template text: blanked
    }
    if (i < n) { blank(i); i++; }                   // closing backtick
    return i;
  }
  let i = 0;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === "/" && d === "/") { const e = skipLineComment(i); while (i < e) blank(i++); continue; }
    if (c === "/" && d === "*") { const e = skipBlockComment(i); while (i < e) blank(i++); continue; }
    if (c === '"' || c === "'") { i = blankBody(i, skipString(i)); continue; }
    if (c === "`") { i = walkTemplate(i); continue; }
    if (c === "/" && opensRegex(i)) { i = blankBody(i, skipRegex(i)); continue; }
    i++;
  }
  return { code: out.join("") };
}

const SCAN = scan(SURFACE);
const CODE = SCAN.code;

test("the scanner reads code and only code — the control for the guard below", () => {
  // A CONTROL HARNESS NEEDS ITS OWN CONTROL. The guard is only as good as what it
  // is looking at, and the last two defects were both in this layer rather than
  // in the rule. These are review's exact defeating inputs, committed so they
  // re-run rather than being a claim I made once.
  const stripped = scan([
    `// gl.bindTexture(gl.TEXTURE_2D, deadTex);`,
    `const endpoint = "https://example.test"; gl.bindTexture(gl.TEXTURE_2D, liveTex);`,
    `if (/\\/\\/'"/.test(x)) gl.bindTexture(gl.TEXTURE_2D, afterRegexTex);`,
    `/* gl.bindTexture(gl.TEXTURE_2D, blockTex); */ gl.bindTexture(gl.TEXTURE_2D, afterBlockTex);`,
  ].join("\n")).code;
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
  // ADJACENCY, NOT SCOPE. This replaces a brace-depth rule that review defeated
  // in both directions, and the reason it was defeated is the point:
  //
  //   ACCEPTED BUT WRONG: `const act = () => gl.activeTexture(...)` never called,
  //   then a bind. An expression-bodied arrow opens no block, so its activation
  //   had the same computed depth as the later bind. The braced form failed and
  //   the arrow form passed — the SAME uncalled helper, discriminated by syntax.
  //   That is the uncalled-helper defect relocated from a character window to a
  //   brace shape, which is the third proxy this guard has worn.
  //
  //   REJECTED BUT RIGHT: `if (true) /[{]/.test("{");` between an activation and
  //   its bind. The regex heuristic reads `/` after `)` as division, so the `{`
  //   inside the character class counted as a real block opener and correct code
  //   was rejected. Two heuristics COMPOUNDED: a grammar misread became a scope
  //   error. Deriving scope needs JavaScript statement grammar, and a hand-written
  //   lexer does not have it.
  //
  // A PARSER WOULD SETTLE IT AND WAS NOT TAKEN. The first version of this comment
  // justified that with "this repository has no dependencies at all", which is
  // FALSE — five provider packages carry lockfiles and two declare four
  // third-party dependencies (ffmpeg-static, ffprobe-static). Corrected wording,
  // taken verbatim from the review that measured it:
  //
  //   "The root test surface has no package, lockfile, dependency install, or
  //    test-tool dependency. A parser would introduce the first dependency and
  //    install step for that test surface; provider runtime dependencies are a
  //    separate existing category."
  //
  // The gate is unchanged; the premise supporting it was wrong, and a public
  // artifact explaining a design decision is the worst place to leave that
  // standing.
  //
  // SO THE RULE ASKS ONLY WHAT A TOKEN STREAM CAN ANSWER EXACTLY: the activation
  // must sit IMMEDIATELY BEFORE the bind — nothing between them but whitespace and
  // semicolons — and must itself follow a STATEMENT DELIMITER (`;`, `{`, `}`, or
  // the start of the file). No depth, no window, no inference about what executes.
  //
  // THAT IS DELIMITER ADJACENCY, NOT STATEMENT POSITION, and the distinction is
  // review's, earned against an earlier version of this comment that claimed the
  // stronger thing. A `for` header satisfies it:
  //
  //     for (; gl.activeTexture(gl.TEXTURE0 + UNIT_SRC);
  //            gl.bindTexture(gl.TEXTURE_2D, srcTex)) break;
  //
  // Neither call is a standalone statement — the semicolons are the header's, not
  // statement terminators — and the check accepts them. Review measured that this
  // does NOT reproduce the original wrong-unit corruption (with `break`, the
  // update expression never runs), so it is a coverage mismatch rather than a
  // product defect. It is recorded here rather than patched because closing it
  // means telling a `for` header apart from a statement list, which is grammar,
  // which is the inference that has been defeated three times in this file.
  //
  // Both defeating cases still die on the definition rather than on a better
  // guess: an arrow helper's activation is preceded by `=>`, which is not a
  // delimiter, and a braced helper's activation has a `}` between it and the bind.
  // A regex misclassification can no longer become a scope error because there is
  // no scope being computed.
  const calls = [...CODE.matchAll(/gl\.(activeTexture|bindTexture)\s*\(/g)]
    .map((m) => ({ kind: m[1], at: m.index }));
  const lineOf = (idx) => CODE.slice(0, idx).split("\n").length;

  // end of a call's argument list, by paren matching over already-lexed code
  const callEnd = (at) => {
    let i = CODE.indexOf("(", at), d = 0;
    for (; i < CODE.length; i++) {
      if (CODE[i] === "(") d++;
      else if (CODE[i] === ")" && --d === 0) return i + 1;
    }
    return CODE.length;
  };
  const afterStatementDelimiter = (at) => {
    for (let i = at - 1; i >= 0; i--) {
      const c = CODE[i];
      if (c === " " || c === "\t" || c === "\n" || c === "\r") continue;
      return c === ";" || c === "{" || c === "}";
    }
    return true;                                   // start of file
  };
  const onlyGapBetween = (a, b) => /^[\s;]*$/.test(CODE.slice(a, b));

  assert.ok(calls.filter((c) => c.kind === "bindTexture").length >= 3,
    "expected the source, path and draw-time binds to be present");

  const unowned = [];
  let pending = null;              // an activation not yet claimed by a bind
  for (const c of calls) {
    if (c.kind === "activeTexture") { pending = c.at; continue; }
    const owns = pending !== null
      && afterStatementDelimiter(pending)
      && onlyGapBetween(callEnd(pending), c.at);
    if (!owns) unowned.push(lineOf(c.at));
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
    `THE SUPPORTED FORM: gl.activeTexture(...) immediately before the bind, with\n` +
    `nothing between them but whitespace and semicolons, and itself following a\n` +
    `semicolon, a brace, or the start of the file.\n` +
    `\n` +
    `That is DELIMITER adjacency, not statement position, and the difference is\n` +
    `real: a for-header satisfies it too. That is a documented coverage gap rather\n` +
    `than a supported form — closing it means telling a for-header apart from a\n` +
    `statement list, which is grammar, which is the inference this guard has had\n` +
    `defeated three times. Anything else fails on purpose: this asks only what a\n` +
    `token stream can answer exactly, because every earlier version that tried to\n` +
    `infer SCOPE was defeated by a syntax it had not anticipated.\n` +
    `\n` +
    `SO YOUR CODE MAY WELL BE CORRECT AND STILL FAIL HERE. Cases that are correct\n` +
    `at runtime and rejected anyway, all measured rather than supposed:\n` +
    `  - the activation factored into a helper, braced or arrow. NOT analysed.\n` +
    `  - any statement between the activation and its bind, even a harmless one.\n` +
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
// It cannot follow a helper, an alias, or a bind reached through either.
//
// IT DOES NOW READ INSIDE A TEMPLATE INTERPOLATION — that line used to say it did
// not, and it is the one item in this block that was ever false. Under the current
// scan a `${...}` is walked as code, so a bind written there is subject to the
// convention like any other. Worth correcting loudly rather than quietly: review
// singled this block out as demonstrated rather than imagined, which is exactly
// what makes a stale item in it more expensive than one anywhere else in the file.
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
  // UNIT_STAGE joined them when a second effect became stackable — it holds stage
  // one's output while stage two reads it. Pinned by NAME rather than by the exact
  // line, so adding a fourth unit does not fail a test about naming discipline.
  assert.match(SURFACE, /const UNIT_SRC = 0, UNIT_PATH = 1, UNIT_STAGE = 2;/);
  // The source sampler is now told which unit to read, because a stacked second
  // effect reads stage one's output on UNIT_STAGE rather than the source on
  // UNIT_SRC. So the property is not "it says UNIT_SRC" — it is that NO sampler
  // uniform is ever handed a bare integer, which is the mistake the named
  // constants exist to prevent.
  assert.match(SURFACE, /gl\.uniform1i\(u\('uSrc'\), (?:unit|UNIT_[A-Z]+)\)/);
  assert.match(SURFACE, /gl\.uniform1i\(u\('uPath'\), UNIT_PATH\)/);
  assert.equal(/gl\.uniform1i\(u\('u(?:Src|Path)'\), \d/.test(SURFACE), false,
    "a sampler unit was passed as a bare integer instead of a named unit");
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
