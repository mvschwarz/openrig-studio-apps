# Architecture — how it works and why

## The premise that decides everything

The tool this descends from has **no image-processing algorithm in it**. Across
its whole bundle: five `drawImage` calls, two `createPattern`, one `putImageData`
for a noise tile, and **zero `getImageData`**. Source rect equals destination
rect, so the blit does no warping at all.

The distortion is produced by **time**. A head advances a few pixels per frame
across a canvas somebody is simultaneously dragging, and each output column is
the picture at a *different instant* under a *different transform*, accumulated
into a buffer that is never cleared.

So this is **a recorder, not a filter**. Its output is state, not a function of
its inputs. That single fact is why it is a separate app from the effect
families, why it has a transport, and why "just make it an effect stage" is the
wrong move whenever it is proposed.

## Where the code is

| file | holds |
|---|---|
| `providers/studio-effects/engine/scanner.mjs` | the shaders, the parameter schema, the presets, and the spec compiler |
| `providers/studio-effects/effects-server.mjs` | the routes: `params`, `shader`, `compile`, `specs` |
| `apps/scanner/app/scanner.html` | the surface: render loop, stage graph, clocks, panels, drive channel |
| `apps/scanner/app.json` | the manifest — declares `calls`, roots, and the provider it is a client of |

It shares the `@openrig/studio-effects` provider with the EFFECTS app rather than
owning a second engine. It is a different *surface* over the same capability.

## The render passes

**One WebGL2 context on an offscreen canvas.** Each stage's tape is a texture in
it; the on-screen canvases are 2D and receive a blit per frame. N stages would
otherwise need N contexts, which browsers cap aggressively.

Per stage, per step:

1. **Roll the history.** A one-frame copy of the stage's *source*, used by
   `motion` and `difference`. Kept per stage, because an upstream tape changes on
   a different schedule from the clip.
2. **Write one strip.** A full-screen triangle **scissored to the write column**,
   so the cost is O(strip) rather than O(frame). That is what makes an
   accumulation buffer affordable at all, and it is what the original does.
3. **Blit** the tape to that stage's on-screen canvas.

**There is no ping-pong on the write, deliberately: the write pass never READS
the recording**, so the output texture can be its own target. The fade pass is
the single exception — it is the only pass that reads the tape, so it gets its
own scratch target rather than doubling the buffer for every other pass. It also
only runs when `persistence < 1`, because a tape that retains is the common case
and should cost nothing.

## The stage graph

A stage's source is either the clip or an earlier stage's tape. That is the
whole chaining mechanism — one line in `sourceFor()`.

Stages render **in order within a frame**, because a later stage reads an earlier
one's tape and must see *this* frame's version, not last frame's.

The compiler refuses forward and self references by name. Feedback is therefore
not expressible, which is deliberate: it is a real and interesting thing, and it
deserves its own mechanism rather than arriving as an ordering accident.

### Why chaining is not "two effects"

A scanner turns one **spatial** axis into **time**. Stage one with a vertical
head makes its output's x-axis time. Stage two reading that with a horizontal
head makes y time as well — so the final image has no spatial axis left, both are
time at different orders. Chain them on the *same* axis instead and each pass
compounds the previous one's warp, which is dubbing.

It also retires a limit recorded in the original research. That document says
true slit-scan "needs each row from a different input frame, which means a ring
buffer of 1080 frames — not viable." **A chained stage gets that buffer for
free**, because the upstream tape *is* the materialised time history.

### The causal frontier

Stage b writes rows as time advances while stage a fills columns at the same
time, so the row b writes at time *t* can only contain the fraction of a that
existed at *t*. Stack those rows and the boundary is exactly `y = x` — a diagonal
edge across the final.

**That is not an artifact. It is data that did not exist yet.** `startAt` is the
remedy: let the upstream get ahead. Combining it with a fast upstream `advance`
so the source wraps keeps the upstream both complete *and* fresh.

## Clocks

Every transport — bed, head, write, source — names a clock. `master` is the
identity. Each clock accumulates **its own time as the integral of its rate**, so
a rate that is itself a lane makes time *accelerate* rather than merely run fast.

**Every clock is declared, and that is what removes the real hazard.** Three
independent time streams could be reconciled wrongly in a way that *looks like an
effect rather than a bug* — the worst failure shape available. Once every clock
is named there is no implicit clock left to read by accident, and the safe design
and the interesting one turn out to be the same design.

**The render loop's own frame rate never enters any calculation.** This has bitten
this codebase for real: a previous-frame buffer rolled on `requestAnimationFrame`
at ~60Hz while video decoded at 24–30, so consecutive uploads carried the *same
decoded frame*, and matching two identical pictures returns a perfect zero for
every block. An empty result that was the correct answer to the wrong question.
The video clock is the clock.

## The spec compiler

`compileSpec()` turns a spec into clocks, stages, constants, tracks and problems.

**The load-bearing rule: a spec compiles to keyframes and does not get its own
evaluator.** Generators already emit keyframes rather than evaluating themselves,
so there is exactly one evaluation path — a second evaluator that only the spec
understood would be the same defect as a second copy of a shader, which is the
worst bug an effects tool can have because it only surfaces after someone commits
to a render.

Compiling also makes a spec **inspectable**: you can compile and read the
resulting lanes before running anything.

Lanes that need the clip — `from-audio` — are resolved **server-side**, for both
stage parameters and clock rates, because the compiler has no filesystem.

`problems` is a list rather than a throw. A spec with one bad lane should still
show you the rest.

## The surface

**The panel is not a mirror of the spec.** It shows what the current chain is
actually *using*: anything a lane drives, anything moved off its default, plus a
small always-relevant set. A lane-driven parameter shows `lane` instead of a
slider, because a slider there would be a control that silently loses every
frame. One toggle exposes everything.

This generalises the highlight idea from "which sliders matter for this preset"
to "which matter for this chain". The spec stays the complete surface; the panel
is a steering surface.

## Performance, honestly

- Two stages measured **12.9 steps/s** against one stage's ~12 on the same
  software rasteriser. A stage costs a *strip*, not a frame.
- **There is a startup cost on the first run of a new configuration.** Measured
  under a software rasteriser: a 4000ms sleep took **18.2s of wall clock** and
  advanced the scan by a single step, while the next two configurations ran 41
  steps in 4.1s. The shape fits per-branch shader specialisation paid once. It
  **blocks the main thread**, so in-page timers are unreliable during it.
- The meta line reports steps/second against the wall clock for exactly this
  reason, and says `warming up` until it has enough samples.
- A two-stage chain with a rotating, scaling bed has locked a software
  rasteriser completely. On hardware it is fine.

**No hardware frame-rate figure exists.** Every number here came from a software
rasteriser, which is not evidence about a real GPU in either direction. Do not
invent one; measure it.
