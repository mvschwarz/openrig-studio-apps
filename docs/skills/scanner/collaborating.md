# Collaborating

This tool was built with a person watching the whole time, and that shaped it
more than any design document did. This file is the working method, because it is
the part that does not survive in the code.

## The division that makes this work

**The person is not a slower agent.** They are the one who can look at a picture
and say "that's machine-made" — which is a judgement no measurement in this repo
can produce.

So: **the spec is the complete surface and the panel is a steering surface.** Do
not design around what a human can manage. An agent gets every parameter, every
clock, every stage. The person gets the controls that are *load-bearing for the
current configuration*, derived from what the spec is actually doing, plus one
toggle to see everything.

This is the general form of "highlight the sliders that matter for this preset":
the subset shown is a function of the state, not a hand-curated list.

## Hand over a spec, not a screenshot

The single most useful change to this tool's workflow came from the person
saying, in effect: *stop pushing settings at me and give me something I can run.*

A pushed parameter set exists until the next one. **A spec file is an artifact** —
they can pick it, run it, re-run it, edit it, and keep it. Specs live in
`<media>/specs/` and the surface has a picker.

When you want someone to see something:

1. Write the spec to a file with a name that says what it demonstrates.
2. Tell them the filename and what to look for.
3. Let them press run.

The drive channel's `specFile` does this in one instruction if they want it
pushed, but the file is the thing that matters.

## Narrate through the surface

`say` writes the status line. Use it. A watcher seeing controls change with no
explanation is watching something twitch; a watcher seeing "MOTION → DISPLACE —
movement bends the recording instead of colouring it" is watching a
demonstration.

## Drive their surface, not your own

The reverse channel exists so an already-open page follows an agent's intent.
It is easy — and this happened repeatedly — to start driving your *own* session
because it is faster to measure, and then report what you saw as though it were
what they saw. It is not.

If a person says they cannot see something, check first whether their page
predates the feature. Surfaces are copied at boot, so a page opened before a
restart has no idea the reverse channel exists.

## The verification discipline this tool has already paid for

Every one of these was a real wrong conclusion during the build, and each one is
cheap to avoid once named.

**A handle reports intent, not effect.** `recording: true` and a healthy
`scanTime` are both true over a completely black screen. They tell you the
transport is running. **Look at the picture.**

**Assert non-black, not merely distinct.** A check that four modes produced four
different hashes passed over a blank tape, because four different almost-black
images hash differently. The check was structurally incapable of failing the way
that mattered.

**Check the check before believing a defect.** A brightness threshold that counted
a faint grid reported "88.9% moving" on a nearly-empty field. A mean taken across
a whole tape read as black when only 12% was written. Twice, the artifact was
fine and the instrument was wrong — and once that produced a filed regression
against working code, which is worse than filing nothing.

**Never suppress the output of a drive call.** Three screenshots came back
byte-identical because the setter had been failing silently the whole time, with
its output piped away.

**A number that does not fit its neighbours is the tell.** 92.8% coverage against
a 27.8% write head. A field of confident vectors on a static clip. When two
readings disagree, one of the instruments is lying, and it is usually the newest.

**Measure the thing that separates the two explanations.** "Is this a static clip
or my bug?" was settled in one step by grabbing two frames one refresh apart
(differed by 0) and two 120ms apart (differed by 4.27). Pick the measurement that
can only come out one way if you are right.

## Take the correction

The best decisions in this tool came from the person pushing back:

- **"Human motion, not smooth curves."** The bed was being driven by smooth
  automation on both sides, which is exactly why it read as machine-made. That
  became `hand` — minimum-jerk reaches, overshoot, hesitation, tremor — and the
  asymmetry that makes it work: the bed gets hands, **the head stays a motor**,
  because that is what a flatbed *is*.
- **"If getting the clocks wrong looks like an effect, I want to see it."** A
  warning about a hazard became a feature table. Declaring every clock made the
  drift available *and* removed the hazard, because there is no implicit clock
  left to read by accident.
- **"I should be able to pick a spec and hit play."** The transport moved to the
  top, `record` became `run`, and specs became files.
- **"`axis: horizontal` but it moves vertically."** A correct observation that
  revealed a genuinely ambiguous parameter name.

None of those came from a measurement. All of them came from someone looking.

## Say what is not established

This tool has a standing example: **no hardware frame-rate figure exists.** Every
performance number in this documentation came from a software rasteriser, which
is not evidence about a real GPU in either direction. It is written down as
unknown rather than estimated, and it should stay that way until someone measures
it.

When you cannot prove something, say which part you can prove. "These named
things are absent from every commit in this range" and "this range is clean" are
different sentences, and only one of them is usually evidenced.
