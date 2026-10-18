# Fleet Studio launch rig

A starter operations agent for an OpenRig machine, with the fleet know-how it carries:

- recovering a stranded seat (a usage limit, a lost login, a restart)
- reading subscription usage honestly
- keeping agents' context healthy

The know-how is three context packs in `context/fleet-ops/`. At startup the agent adds any that are
missing to the machine's context library, so **every** agent on the machine can find them with
`rig context list` and read them with `rig context get fleet-ops/<name>`. You can also add them
yourself, without the agent:

```sh
rig context add rigs/fleet-studio/context/fleet-ops/recover-a-stranded-seat
rig context add rigs/fleet-studio/context/fleet-ops/read-usage-honestly
rig context add rigs/fleet-studio/context/fleet-ops/keep-context-healthy
```

## Start it

From a checkout of this repository:

```sh
rig up rigs/fleet-studio/rig.yaml
```

An app for viewing the fleet is not part of this rig yet. The Observatory (`rigs/observatory/`) is an optional,
separate launch rig; Fleet Studio does not need it. Both rigs use the same starter operations agent
(`rigs/agents/starter-ops/`), each with its own startup context.

## What it touches

Its own rig and its own files. It reads the rest of the environment with OpenRig's commands and
changes nothing outside its rig; see the agent's role.
