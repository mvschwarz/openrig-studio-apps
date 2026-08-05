# The workspace

Where the things you make live, and how they stay findable once there are
hundreds of them.

## The one rule

**The spec is its own record.** A spec carries a `_card` block naming what it is,
what footage made it, and what came out. There is no sidecar metadata file and
there should never be one: a sidecar drifts from the spec the first time either
is moved or renamed, and then the shelf is confidently wrong about what an effect
does. One file, one truth.

```json
{
  "_": "prose about what this does and how to steer it",
  "_card": {
    "title": "Marbled tears",
    "tags": ["scanner", "mosh"],
    "source": "plain-with-beats.mp4",
    "preview": "exp-i-marble-gentle.mp4"
  },
  "scan": { "duration": "10s" },
  "stages": [ ... ]
}
```

Everything in `_card` is optional. A spec with no card still appears on the
shelf, titled by its filename — a spec somebody saved by hand is part of their
workspace too, and hiding it would make the shelf a liar about what is there.

`compileSpec` ignores both `_` and `_card`. They are for people and for the
shelf; the compiler only reads `scan`, `clocks` and `stages`.

## Where things go

```
<media>/                 the media root
  plain-with-beats.mp4   your footage
  exp-*.mp4              outputs, which are ALSO valid sources
  specs/                 the workspace: one .json per effect
```

**Outputs live in the media root, not in a subfolder**, and that is deliberate:
anything in the media root appears in the source picker, so what the scanner made
can immediately be scanned again. A tape of a tape is a real technique here, and
filing outputs somewhere tidy would break it.

Specs live in `<media>/specs/` — the same folder SCANNER's `save as…` writes to
and lists under **yours**. A saved spec of the same name wins over a shipped
example, so an example can be adapted and kept without renaming it.

## What the shelf does with it

`SHELF` (`/surfaces/gallery.html`) reads `<media>/specs/*.json` through
`/api/gallery/cards` and renders one card per spec: the preview playing on loop,
the title, the tags, the footage it came from, and the spec itself.

- **run in scanner** — hands the spec to SCANNER on the footage it was made from.
- **run on chosen footage** — the same spec against something else, which is how
  an effect becomes a reusable treatment rather than a one-off.
- **spec** / **copy spec** — the text, because sometimes you want to edit rather
  than run.

It sends **the spec**, not the filename. A card therefore keeps working if the
file is renamed, and a card handed to somebody else carries everything needed to
reproduce it except the footage.

The route checks that a named preview is actually on disk and marks the card
`preview missing` when it is not, rather than rendering a dead player. Cards with
previews sort first — a shelf browsed by motion should not open on a wall of
black rectangles.

## Driving it as an agent

`window.gallery` on the surface:

| call | does |
|---|---|
| `cards()` | every card's metadata, without the spec bodies |
| `spec(name)` | one spec, by filename or title |
| `run(name, source)` | send it to SCANNER, optionally on different footage |
| `filter(query, tag)` | set the search and tag filter; returns the count shown |
| `reload()` | re-read the workspace from disk |

## Adding an effect to the workspace

1. Get it working in SCANNER.
2. `save clip to media` — the output lands in the media root.
3. `save as…` — the spec lands in `<media>/specs/`.
4. Add `_card` to that spec naming the `preview` file from step 2 and the
   `source` you used.
5. **reload workspace** on the shelf.

Step 4 is the one that is easy to skip and the one that makes the difference in a
month. A spec without a card still runs; it just cannot show you what it does,
which is the entire reason the shelf exists.

## Why this is a second app rather than a tab in SCANNER

SCANNER is an instrument: one thing, deeply adjustable, and its surface is a
steering surface for the run in front of you. A shelf is a different job — it is
about everything you have already made, and it wants a grid rather than a signal
chain.

It also needed no new provider. A workspace is a folder of specs the effects
provider already owns, so the shelf is a second *reading* of that folder rather
than a second copy of it. That is the cheap way to add a surface, and it is worth
reaching for before adding a provider.
