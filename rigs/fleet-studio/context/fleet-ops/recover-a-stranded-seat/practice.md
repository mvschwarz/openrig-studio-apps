# Recover a stranded seat

**When this applies:** an agent seat has stopped doing work: it hit its subscription's usage limit, its login expired
or was lost, or it was left stopped after a machine restart.

## Recognise it

- `rig ps --nodes --json` shows each seat's `agentActivity` (`state`, `reason`, and when it was sampled) and its
  attention state. A seat waiting on a person shows `needs_input` with a reason.
- `rig parked` diagnoses stopped seats that still owe work, for your rig (`--rig <name>`) or one seat.
- `rig capture <session>` shows the seat's screen, where a usage-limit or sign-in message usually appears.
- `rig provider status --json` shows accounts, which seat is configured for which account, and usage signals with
  their reset times when the machine has them (see the `fleet-ops/read-usage-honestly` practice).
- `rig auth status` shows login state without secrets. Check `rig auth status --help` for the runtimes it covers on your
  version.

## Choose a path

**At a usage limit:**
1. Read the reset time from `rig provider status` (or the seat's own screen). Say how old that reading is.
2. If the reset is soon, wait. When it has passed, nudge the seat in its own conversation:
   `rig send <session> "Your usage limit has reset; carry on with your work."`
3. If work can't wait, a different account is a decision for whoever owns account moves on this machine. Ask them;
   don't move accounts yourself unless that job has been enabled for you.

**After a lost or expired login:**
1. Confirm it: `rig auth status`, and the seat's screen.
2. Signing in needs a person. Ask them **once**, plainly: which machine, which tool, and that the seat is waiting.
3. When they say it's done, check `rig auth status` again. For a Codex seat, `rig seat restart <seat> --keep-conversation
   --reason "<why>" --plan` shows what a restart would keep; run it again without `--plan` to pick up the new login in
   the seat's own conversation. A Claude seat usually needs the person to finish signing in inside the seat itself.

**After a machine restart:** `rig ps` shows which rigs are stopped. `rig up --existing <rig-name>` brings a stopped rig
back from its saved state; seats resume their own conversations where they can.

## What needs a person

Signing in, choosing to use another account, and anything that spends money. Ask once, say exactly what is needed, then
carry on with what you can do.

## Traps

- **Starting a fresh seat to "fix" it** (`rig seat launch`) loses its conversation. Prefer waiting, resuming, or
  restoring.
- **Checking usage by sending a model request.** That spends the very allowance you are reading. Use the readings the
  machine already has.
- **Treating "I asked for a switch" as "the seat moved".** Check the seat's own state afterwards.
- **Asking the person again and again.** Once, then continue and report.
- **Copying credentials** between seats or machines. Never.
