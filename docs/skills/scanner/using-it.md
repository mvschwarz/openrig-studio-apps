# Using it

## Getting a picture in ninety seconds

1. Open the SCANNER surface.
2. Pick a clip from **`— source —`**.
3. Pick **`01-the-hand.json`** from **`— saved spec —`**.
4. Press **`▶ run`**.

`run` clears the tapes first, so a run always starts at the beginning and the
same spec gives the same result every time. Generators are seeded.

The transport is at the top and sticky. Left to right: run/pause, clear, save
final, saved-spec picker, built-in chain picker, source picker.

## Reading the panels

Panels stack top to bottom in signal order:

```
BED — source + head      the live clip with the head drawn on it
      ↓
a · reads the clip       the first tape
      ↓
FINAL — b · reads a      the last tape, outlined in accent
```

Each caption states what the stage reads and **how its head lies and travels** —
`head upright, travels →` or `head flat, travels ↑`. That second half exists
because `axis: horizontal` sweeps *upward*, which reads as a contradiction until
both are said.

The meta line under the panels reports scan time, stage count, final write
position, every clock's own time, any stage still waiting on `startAt`, and
**steps per second measured against the wall clock**. If a recording looks dead,
read the rate before believing it — the first run of a new configuration can
take many seconds to get going, and it says `warming up` until it has enough
samples to mean anything.

## The shipped specs, and what each one is for

They live in `<media>/specs/`. `save as…` writes new ones there.

| spec | what it demonstrates |
|---|---|
| `01-the-hand` | three independent hands on the bed under a mechanical head, read as ember contours |
| `02-placed-not-waved` | the same with low `pace` and high `hesitation` — someone *placing* a photo rather than waving it |
| `03-both-axes-are-time` | two stages on perpendicular axes; the final has no spatial axis left |
| `04-time-runs-on-the-beat` | a clock whose *rate* comes from the clip's envelope, so time accelerates with the music |
| `05-motion-bends-the-tape` | one stage, `motion` → `displace`: movement bends the recording rather than colouring it |
| `06-no-frontier` | upstream at `advance: 3` wraps and stays fresh; downstream waits via `startAt` |
| `07-both-axes-no-frontier` | the same remedy on the two-axis chain |

## The five techniques, and the settings that produce them

**Flatbed warp** — the original. Head sweeps, output advances in step, bed moved
by a hand. Straight edges shatter into offset ribbons.
`head.position: {ramp:[0,1]}`, `write.advance: 0`, `bed.x: {hand:{...}}`.

**Slit-scan** — hold the head still and let the output advance. The x-axis of
the recording *becomes* time. This is the photo-finish camera.
`head.position: 0.5`, `write.advance: 0`, `source.rate: 1`.

**Time compression** — sweep fast, advance slowly. A whole sweep squeezed into a
band. Raise `head` clock rate against `write.advance`.

**Dubbing** — chain two stages on the *same* axis. Each pass compounds the
previous one's warp; that is generation loss, tape to tape.

**Both axes are time** — chain two stages on *perpendicular* axes. Stage one
makes x time; stage two makes y time. Neither axis is spatial in the result.

## Making it look good

**The bed is the performance; the head is the metronome.** A real flatbed's head
is a motor and the person is the only nuance in the system. Driving both
smoothly reads as machine-made. Put `hand` on the bed and leave the head on a
ramp.

**Rotation during the sweep is the signature artifact.** Turning the bed while
the head crosses it makes straight edges *curve*, because each strip was taken at
a different angle. Nothing else in the tool produces that.

**Watch the gain.** `chroma` and `edge` saturate easily — at gain 1.7 a chroma
scan blows out to a flat wash. Start near 0.8 and come up.

**Longer runs are calmer.** Slow bed motion over 25–30s produces painterly
smears; the same motion over 8s reads as jitter.

**`hand` tuning:** low `pace` with high `hesitation` gives long holds and sharp
moves between them — a photo being *placed*. High `pace` with low `hesitation`
is someone waving it around.

## Driving it as an agent

`window.scanner` on the surface:

| call | does |
|---|---|
| `stages()` | id, source, clocks, params, lane names, write position per stage |
| `clocks()` | the clock definitions and each one's current time |
| `effective(id)` | the values *actually being rendered* for a stage, lanes applied |
| `set(id, params)` | change parameters on a stage |
| `spec(text)` | compile and load a spec |
| `record(bool)`, `clear()`, `scanTime()`, `params()` | transport and schema |

The reverse channel is `POST /api/effects/drive` with a `scanner` key:

```json
{ "scanner": { "specFile": "06-no-frontier.json", "clear": true, "record": true,
               "say": "what the person should look for" } }
```

`specFile` names a saved spec, so "play this file" is one instruction. `spec`
takes a spec inline. `params` applies to a named `stage`. `say` writes the status
line, which is how you narrate a change to someone watching rather than letting
controls twitch silently.

**Prefer handing over a spec file to pushing settings.** A file is something the
person can re-run, edit and keep; a pushed parameter set exists only until the
next one.
