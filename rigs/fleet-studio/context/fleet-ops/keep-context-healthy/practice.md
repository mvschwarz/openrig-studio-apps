# Keep context healthy

**When this applies:** a seat's context is filling up, its answers are getting worse, or you want warning before that
happens.

## Check

- `rig ps --nodes --json` shows each seat's `contextUsage`: how full it is, whether the sample is fresh, and when it was
  sampled.
- `rig health` lists findings, including context pressure, with how fresh each finding is.
- `rig compact-plan` (`--rig <name>`, `--refresh` to re-sample first, `--json`) is a **read-only** plan of which Claude
  seats are candidates for compacting in place. It changes nothing.

## Act

1. **Compacting in place** is done inside the seat's own conversation, at a quiet moment between tasks. Agree it with
   whoever owns that seat's work.
2. **Handing over** to a fresh successor is better when the seat's work is long-running and its context is no longer
   trustworthy. `rig seat handover <seat> --dry-run` plans it without changing anything; give the real handover a
   `--reason`, so the record says why.
3. **An early warning:** a `context-usage-threshold` watchdog sends a message before the limit:
   `rig watchdog register --policy context-usage-threshold --target-session <seat> --interval-seconds <n>
   --registered-by <you> --threshold-mb <n> --message "<what to do>"`. Check `rig watchdog register --help` for the
   current options.
4. A rig can also choose a compaction strategy per seat in its rig spec (`compaction_strategy`). That's a change to that
   rig, for its owner.

## What needs a person

Compacting or handing over a seat whose work belongs to someone else: ask that owner first.

## Traps

- **Compacting in the middle of a task.** Wait for a boundary.
- **Trusting a stale sample.** Check when it was taken; `--refresh` where it matters.
- **Starting a fresh seat when a handover would keep the work's continuity.**
