# Read subscription usage honestly

**When this applies:** someone asks how much of their subscription is left, when it resets, or whether a seat can keep
working.

## Where the readings come from

- `rig provider status` (add `--json` for structure) shows accounts, which seat is configured for which account, and
  usage signals.
- **Usage windows** (how much of each window is used, and when it resets) are only read when the machine's
  `provider.usage_windows` setting is on. It is off by default. Turning it on is the machine owner's choice:
  `rig config set provider.usage_windows true`. Ask before changing it.
- `rig provider status --refresh` reads the current windows natively first (it can take up to about 35 seconds, and needs
  the setting on).
- **Several machines:** newer versions offer `rig provider status --all-hosts` (or `--hosts <ids>`) to see each
  registered machine's readings side by side. Check `rig provider status --help` on your version.
- `rig usage` is per-seat **token** telemetry over time. It is not your subscription allowance; don't present it as one.

## Read it honestly

- **Every reading has an age.** Say when it was measured, not when you looked. An old reading is old.
- **Unknown is unknown.** A missing or unreadable window is "not known", never 0% and never "fine".
- **Each machine's reading stays separate.** Two machines can report the same shared allowance; adding them together
  double-counts it. Show each, and say whether they agree.
- **Configured is not observed.** Which account a seat is set up for and which account it is actually using are two
  different facts. Say which one you are quoting.
- **No money.** Subscriptions are read as usage and resets, not as a price.

## What needs a person

Turning on usage windows, and any decision to move a seat to another account (that belongs to whoever owns account
moves on the machine).

## Traps

- **Sending a model request to "check" usage.** It spends the allowance you are trying to read.
- **Adding readings from several machines into one total.**
- **Showing a missing window as zero.**
- **Quoting a configured account as the one in use.**
