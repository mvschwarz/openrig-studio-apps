# Extending it

The tool is built so the common extensions are small and local. Each one below
is a real recipe with the ordering contract that will otherwise bite you.

## The invariants any change must preserve

1. **One evaluation path.** Generators emit keyframes. Nothing evaluates itself
   at render time. If you find yourself writing a second evaluator so that some
   new form can be "live", stop — compile it to keyframes instead.
2. **Every clock is declared.** No new transport may read the render loop, wall
   time, or `Date.now()`.
3. **The spec is complete; the panel is a subset.** Never add a capability that
   only the UI can reach.
4. **The write pass never reads the tape.** If your feature needs the previous
   contents, it is a separate pass with its own target, like the fade.
5. **Both halves on any path.** Sanitise to a single segment *and* validate the
   resolved path against a realpath'd root — for reads and writes alike.

## Add a `read` mode

The head's response function.

1. **`engine/scanner.mjs`** — add the name to `READS`. **Append, do not insert**:
   the shader branches on the index, and the surface derives that index from this
   same list. Inserting renumbers every saved spec's meaning.
2. In `SCANNER_WRITE_FRAGMENT`, add a branch to `respond()`. It returns the
   response as one number and sets `rgb` for the `direct` write mode. Follow the
   existing threshold ordering — the branches are `uRead < 0.5`, `< 1.5`, and so
   on.
3. If it needs a new uniform, declare it in the shader and set it in
   `writeStage()` in the surface.
4. Add anything user-facing to `SCANNER_PARAMS` with a `says` written for what a
   person *perceives*, never for the DSP.

**Make it genuinely different from what exists.** `difference` was nearly a second
name for `motion` until it was made *signed* — magnitude versus direction. Two
names for one behaviour is worse than one name.

## Add a `write` mode

What lands on the tape.

1. Append to `WRITES` in `engine/scanner.mjs`. Same append-only rule.
2. Add a branch in `main()` of the write shader. Note the ordering: **`displace`
   is checked first and returns early**, because it is the only mode that changes
   *where* it sampled rather than how the sample is coloured. A mode that
   re-reads belongs with it; a mode that re-tints belongs in the `outc` chain.
3. Set any new uniform in `writeStage()`.

## Add a lane form

A new way to express a parameter over time — this is the highest-leverage
extension, because **every parameter gets it for free**.

1. **`compileLane()`** in `engine/scanner.mjs`. Return an array of
   `{t, v, ease}`. That is all a lane is.
2. If it needs the clip (audio, video), return `{ derive: value }` instead and
   resolve it in the `/api/scanner/compile` route, which has the filesystem. Do
   both the stage loop *and* the clock loop — a clock's rate is a lane too, and
   forgetting that half is easy.
3. Seed anything random. A look you cannot reproduce is not a look.
4. Document it in `spec-reference.md`, because the spec is the surface.

`hand` is the model to copy: it samples densely to keyframes rather than becoming
a special case anywhere downstream.

## Add a clock kind

Clocks are `{rate}` or `{rateTrack}`. A new kind is a new way to produce one of
those in `compileSpec()`. The surface integrates `clockRate(name) * dt` per frame
and needs no change.

Anything referencing an undefined clock must fall back to `master` **and report a
problem** — never silently run at a rate nobody chose.

## Add a stage-level feature

`startAt` is the worked example, and it shows the two halves people forget:

1. Compile it in `compileStage()`.
2. Honour it in the surface loop.
3. **Ask what it means for lanes.** A delayed stage measures its lanes from *its*
   start, not the master's zero — otherwise a stage that waits arrives mid-sweep
   with its ramp already spent.

## What is deliberately not built

- **`from-video` lanes.** `cuts`, `motion` and `brightness` already exist in the
  provider's `watch.mjs`; this is wiring, not design. The compiler reports a
  problem rather than failing silently.
- **Feedback.** A stage reading itself is refused by name. It deserves a
  deliberate mechanism, not an ordering accident.
- **Video output.** One complete sweep = one frame is the precise meaning, and it
  is how slit-scan cinematography works. It forces the headless-render question
  rather than sneaking around it, because a video output is the first thing here
  that genuinely cannot be a screenshot.
- **An automation-lane UI.** The spec is the interface, which keeps the agent
  path primary rather than bolted on.

## Checks that actually catch things here

The suite is `node --test test/*.test.mjs`. Note the glob — `node --test test/`
resolves `test` as a module and fails confusingly.

Beyond the suite, this tool has specific ways of looking fine while being wrong:

- **Assert NON-BLACK, not merely DISTINCT.** A check that four modes produced four
  different hashes cannot detect an empty tape, because four different
  almost-black images hash differently. This exact check passed over a blank
  recording.
- **Read the rate before believing a dead-looking run.** The first run of a new
  configuration can stall for many seconds and blocks the main thread, so in-page
  timers are unreliable during it. Start the recording, poll `scanTime()` from
  outside, and stop when it has actually advanced.
- **A handle reports the transport, not the picture.** `recording: true` and a
  healthy `scanTime` are both true over a black screen. Sample the canvas.
- **A partial tape has a low mean.** Measuring mean brightness across the whole
  tape while only 12% is written reads as black. Measure the written region, or
  measure coverage.
- **Never suppress the output of a drive call.** A setter that silently fails
  turns every later assertion into a measurement of the previous state.
