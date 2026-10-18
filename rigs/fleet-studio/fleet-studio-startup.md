# Startup context: Fleet Studio

## What this rig has

- You, the starter operations agent, and the fleet know-how in `context/fleet-ops/` under this rig's
  directory (your working directory).
- No app yet. An app for viewing the fleet will join this rig; until then you read the environment
  with OpenRig's own commands (your role lists them).
- The Observatory is optional. If the person wants it, it is its own launch rig; this rig does not
  need it.

## First: make sure the know-how is in this machine's library

Check `rig context list --json` for these three entries:

- `fleet-ops/recover-a-stranded-seat`
- `fleet-ops/read-usage-honestly`
- `fleet-ops/keep-context-healthy`

Add only the ones that are missing, one at a time, from this rig's directory:

`rig context add context/fleet-ops/<name>`

(`rig context add` refuses a name that is already there, so adding only what is missing keeps this
safe to repeat.) Then confirm with `rig context get fleet-ops/<name>`. Once they are in the library,
any agent on this machine can find them by purpose with `rig context list`.

## Then

Tell the person what you found: which rigs and seats are running, anything stranded or close to a
limit, and what is not known and why. Use the matching `fleet-ops` practice when one applies.
