# Spec reference

A spec is a **program**, not a snapshot. A saved look records where the knobs
are; a spec records what they *do over time*. It is the complete surface of this
tool — anything the app can do is expressible here, and the panel shows a subset.

Specs are JSON files in `<media>/specs/`. `POST /api/scanner/compile` returns the
compiled form, so a spec can be inspected before it is run.

## Top level

```json
{
  "scan":   { "duration": "22s" },
  "output": { "when-full": "wrap" },
  "clocks": { "drift": { "rate": 1.09 } },
  "stages": [ ... ]
}
```

| field | meaning |
|---|---|
| `scan.duration` | total master-clock time. `"22s"`, `"1500ms"`, or a number of seconds |
| `output.when-full` | `wrap` (default) — the tape loops and overwrites, which is what a tape does |
| `clocks` | named clocks; see below. `master` always exists and is the identity |
| `stages` | the chain, in order. A spec with no `stages` is treated as a one-stage chain, so the simple case stays simple |

Times accept `"12s"`, `"250ms"`, `"50%"` (of the duration), or a bare number.
A bare number ≤ 1 on a time field is read as a fraction.

## Clocks

```json
"clocks": {
  "drift": { "rate": 1.09 },
  "slow":  { "rate": 0.4 },
  "pulse": { "rate": { "from-audio": { "mode": "envelope", "range": [0.25, 2.6] } } }
}
```

A clock is a named function from the master clock to a transport's own time.
Each transport *references* one by name.

Naming them is what makes a chain tractable: two stages have six transports, and
six loose rate numbers are noise, while three named clocks that six transports
reference is a structure you can reason about.

**A clock's rate may itself be a lane.** That is the reason for the indirection —
a rate that varies means the clock *accelerates*, so time speeds up rather than a
transport merely moving faster. The clock's time is the integral of its rate.

Referencing an undefined clock falls back to `master` and reports a problem
rather than silently running at a rate nobody chose.

## A stage

```json
{
  "id": "a",
  "startAt": "34%",
  "source":   { "clip": "plain-with-beats.mp4", "rate": 1 },
  "bed":      { "clock": "drift", "x": { "hand": { "range": [-330, 330] } } },
  "head":     { "axis": "vertical", "position": { "ramp": [0, 1] }, "width": 3 },
  "response": { "read": "edge", "gain": 0.85 },
  "write":    { "mode": "palette", "palette": "ember", "advance": 0 }
}
```

| field | meaning |
|---|---|
| `id` | referenced by a later stage's `source.from` |
| `startAt` | time before which this stage writes nothing and does not advance. Lanes on a delayed stage measure from *its* start |
| `source.clip` | a file in the media root |
| `source.from` | **an earlier stage's id** — this is the whole chaining mechanism |
| `source.rate` | clip time per unit of master clock. `0` freezes the frame, `1` is normal playback |

A stage may only read a stage *before* it. Forward and self references are
refused by name at compile time, so a bad graph is a message rather than a
mystery. Feedback is therefore not expressible yet, deliberately.

### bed — what is being scanned

| lane | range | meaning |
|---|---|---|
| `x`, `y` | ±2000 px | slide the picture on the glass |
| `rotate` | ±180° | turn it. **Rotating during a sweep is the signature artifact** — straight edges become curves |
| `scale` | 0.1–4 | how large it sits |
| `clock` | name | which clock the bed follows |

### head — where it reads and how

| lane | range | meaning |
|---|---|---|
| `axis` | `vertical` \| `horizontal` | **how the head LIES, perpendicular to how it travels.** Vertical stands upright and sweeps sideways (writes columns); horizontal lies flat and sweeps upward (writes rows) |
| `position` | 0–1 | where it reads across the bed. Hold it still for slit-scan |
| `width` | 1–128 px | strip thickness |
| `angle` | ±60° | tilt off-axis, so it samples a diagonal |
| `softness` | 0–1 | feather the strip edges; 0 is a hard slit |
| `clock` | name | which clock the head follows |

### response — what the head responds to

| `read` | measures |
|---|---|
| `passthrough` | the pixels themselves |
| `luma` | brightness |
| `motion` | temporal magnitude — how much a point changed, sign discarded |
| `chroma` | nearness to `targetColor`, so the head can scan *for* something |
| `edge` | gradient magnitude — structure kept, tone discarded |
| `difference` | signed change — which *way* it moved. Deliberately not a second name for `motion`; on real footage they look nothing alike |

Plus `gain` (0–8), `bias` (±1), `threshold` (0–1), `invert`, `targetColor`.
`chroma` and `edge` saturate easily; start near 0.8.

### write — what lands on the tape

| `mode` | writes |
|---|---|
| `direct` | the strip as read |
| `intensity` | the response as greyscale |
| `palette` | the response through a ramp — `ember`, `cold`, `mono`, `paper` |
| `matte` | source pixels only where the response clears `threshold` |
| `displace` | **the response bends the strip.** The only mode that changes *where* it sampled |

| field | meaning |
|---|---|
| `advance` | output columns per step. **`0` FITS the recording to the duration** and is the sane default; `1` is one column per step; every other value is a deliberate disagreement with the sweep |
| `direction` | `forward` \| `reverse` |
| `persistence` | `1` the tape retains; below 1 it fades as it is laid down |
| `displace` | how far the response bends the strip, in pixels |
| `clock` | which clock the output transport follows |

## The lane grammar

Every scalar above accepts any of these instead of a number. This is the whole
automation surface, and it is identical for every parameter.

| form | behaviour |
|---|---|
| `0.5` | a constant, held for the whole scan |
| `{ "ramp": [a, b], "ease": "smooth" }` | travel from a to b across the duration. `linear` \| `smooth` \| `snap` |
| `{ "keyframes": [ {"t":0,"v":0}, {"t":"50%","v":1,"ease":"smooth"} ] }` | explicit points. **Outside its keyframes a lane HOLDS** rather than extrapolating — extrapolation invents motion and on a loop never stops |
| `{ "pulse": { "every": "0.5s", "range": [a,b] } }` | a repeating figure, compiled to keyframes at author time so it stays inspectable |
| `{ "from-audio": { "mode": "onsets"\|"envelope", "range": [a,b], "decay": 0.22, "sensitivity": 1.6 } }` | derived from the clip's own audio |
| `{ "hand": { "range": [a,b], "pace": 0.55, "hesitation": 0.35, "overshoot": 0.28, "tremor": 0.22, "seed": 7 } }` | **motion with a person in it** — see below |
| `{ "from-video": { ... } }` | **not wired yet.** Reports a problem rather than failing silently |

### hand

A ramp is machine motion: constant velocity, no correction, no hesitation. A
hand does none of those things, and rather than imitate the *look*, `hand`
reproduces the *mechanism*, which is well characterised:

- **Minimum jerk** — a reach follows `10u³ − 15u⁴ + 6u⁵`. Not a line, not a
  smoothstep. Slow start, peak mid-flight, gentle settle. This is the biggest
  single difference from an eased ramp.
- **Overshoot and correction** — a fast reach lands past its target and comes
  back. That reversal is most of what reads as alive.
- **Hesitation** — the hand stops at irregular via-points, never on a beat.
- **Tremor** — 8–12 Hz, tiny, and it never switches off.

Measured against a ramp on a 20s lane: 601 keyframes, velocity swinging **10×
from mean to peak** and touching **exactly zero** at the pauses. A ramp is two
keyframes at constant velocity by construction.

`seed` makes it reproducible. A look you cannot reproduce is not a look.

**Tuning:** low `pace` + high `hesitation` = long holds with sharp moves between,
which reads as someone *placing* a photo. High `pace` + low `hesitation` reads as
waving it around.

## What the compiler returns

```
{ ok, duration, clocks, stages: [ { id, from, startAt, clocks, constants, tracks } ], problems }
```

A lane that reduces to a single value at t=0 becomes a **constant**; anything
else becomes a **track** of keyframes. `problems` is a list rather than a throw,
because a spec with one bad lane should still show you the rest.
