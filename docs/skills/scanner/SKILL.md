---
name: scanner
description: Use when working with the SCANNER studio app — recording or composing scans, writing or debugging a scan spec, chaining stages, driving the surface as an agent, or extending the tool with new response modes, write modes, lane forms or clock kinds.
---

# Scanner

A tape head for images and video. A head sweeps across a bed, and each strip it
takes is written into a recording that is never cleared. Because the head takes
its strips at different *moments*, **the distortion is time** — not a filter.

The tool it descends from contains no image processing at all: five `drawImage`
calls and zero `getImageData`. Its source rect equals its destination rect, so
the copy does no warping. Everything interesting came from a person dragging a
photo on the glass while the head crossed it. That fact decides the whole
architecture, and it is worth holding on to before changing anything here.

**This is a recorder, not a filter.** Its output is *state* accumulated over
time, not a function of its inputs. That is why it is a separate app from the
effects families, and why it has a transport.

## The shape of it, in one pass

Three things that are normally locked together are separate here:

- **BED** — what is being scanned, with its own x / y / rotate / scale. In the
  original, a human dragged this, and that drag *was* the effect.
- **HEAD** — where it reads, how wide, at what angle, and **what it responds to**:
  the picture itself, or its brightness, motion, colour-nearness, edges, or
  signed change. The configurable response is the part that is ours.
- **OUTPUT** — a tape that advances at its own rate and direction. When output
  advance matches the sweep you get the picture back. **Everything interesting is
  a mismatch.**

**Stages chain.** A stage's source can be an earlier stage's *tape* instead of a
clip. One scanner turns a spatial axis into time; two chained on perpendicular
axes leave no spatial axis at all, and two on the same axis compound each
other's warp, which is dubbing.

**Every transport runs on a named clock**, and a clock's rate can itself be a
lane — so time can *accelerate*, not merely run fast.

**A spec is the whole performance, as a file.** Specs live in `<media>/specs/`,
are picked from the surface, and replay identically because generators are
seeded.

## What is true here that will otherwise surprise you

- **`axis` names how the head LIES, not how it travels.** They are
  perpendicular. A `horizontal` head lies flat and sweeps *upward*. Watching a
  run you see the travel, so the name reads as the opposite of what you observe.
- **A chained stage cannot record what its source has not written yet.** Run two
  stages from t=0 and the final has a diagonal edge — that is a causal frontier,
  not an artifact. `startAt` is the remedy.
- **The tape is a fixed size, so recording length is a resolution question**, not
  a time one. When it fills it wraps, which is what a tape does.
- **A spec compiles to keyframes and never gets its own evaluator.** There is
  exactly one evaluation path. Do not add a second.
- **The UI is deliberately not a mirror of the spec.** It shows what the current
  chain is actually using; the spec is the complete surface.

## Where to go next

| If you are | Read |
|---|---|
| running it, or composing a scan | [using-it.md](using-it.md) |
| writing a spec, or need the exact grammar | [spec-reference.md](spec-reference.md) |
| changing the code, or debugging a render | [architecture.md](architecture.md) |
| adding a response, write mode, lane form or clock | [extending-it.md](extending-it.md) |
| driving this for someone who is watching | [collaborating.md](collaborating.md) |
| saving what you made so it is findable later | [the-workspace.md](the-workspace.md) |

## The short version of each

**using-it.md** — the transport, the spec picker, the seven shipped specs and
what each demonstrates, the steering panel and why it hides things, and the
recipes for the known techniques (flatbed warp, slit-scan, dubbing, both-axes,
motion-bends-the-tape).

**spec-reference.md** — every field of a spec: `scan`, `output`, `clocks`,
`stages`, and inside a stage `source` / `bed` / `head` / `response` / `write`.
The complete lane grammar (`ramp`, `keyframes`, `pulse`, `from-audio`, `hand`)
and every parameter with its range and meaning.

**architecture.md** — the render passes and why the write is scissored to a
strip; how the tape, the chain and the previous-frame history are held; how
clocks are integrated; where the spec is compiled; the three-clock model and why
every clock is declared; the performance profile and what is known and unknown
about it.

**extending-it.md** — the exact steps and the ordering contract for adding a
`read`, a `write` mode, a lane form, a clock kind or a stage-level feature;
which invariants must survive; and the checks that actually catch mistakes here.

**collaborating.md** — how to work this tool *with* a person watching: the drive
channel, what to show and in what order, how to hand over a spec rather than a
screenshot, and the verification discipline this tool has already paid for —
including the specific ways a healthy-looking handle can lie about a black
screen.

## The rules that must survive any change

1. **One evaluation path.** Generators emit keyframes; nothing evaluates itself
   at render time. A second evaluator is the same defect as a second copy of a
   shader.
2. **Every clock is declared.** No transport reads an implicit clock, and the
   render loop's own frame rate never enters any calculation.
3. **The spec is complete; the UI is a subset.** Never add a capability that
   only the panel can reach.
4. **Both halves on any path.** Sanitise the name *and* validate the resolved
   path, for reads and writes alike.
5. **Look at the output.** A handle reporting `recording: true` has told you
   about the transport, not the picture.
