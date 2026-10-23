# Fleet Studio launch rig

A starter operations agent for an OpenRig machine, with the fleet know-how it carries:

- recovering a stranded seat (a usage limit, a lost login, a restart)
- reading subscription usage honestly
- keeping agents' context healthy
- managing subscriptions when the person enables that job

The know-how is four context packs in `context/fleet-ops/`. At startup the agent adds any that are
missing to the machine's context library, so **every** agent on the machine can find them with
`rig context list` and read them with `rig context get fleet-ops/<name>`. You can also add them
yourself, without the agent:

```sh
rig context add rigs/fleet-studio/context/fleet-ops/recover-a-stranded-seat
rig context add rigs/fleet-studio/context/fleet-ops/read-usage-honestly
rig context add rigs/fleet-studio/context/fleet-ops/keep-context-healthy
rig context add rigs/fleet-studio/context/fleet-ops/manage-subscriptions
```

## Start it

From a checkout of this repository:

```sh
rig up rigs/fleet-studio/rig.yaml
```

The rig also runs the Fleet page in its own container (Compose project `openrig-fleet-studio`, port
9450): open http://127.0.0.1:9450/surfaces/fleet.html. It answers which accounts have room, which
machines report here, what the rigs are doing, and the managing agent’s dated subscription move reports, from what OpenRig's own daemons report. It is read
only, needs no other app, and never asks for a sign-in or reads a token. The Observatory (`rigs/observatory/`) is an optional,
separate launch rig; Fleet Studio does not need it. Both rigs use the same starter operations agent
(`rigs/agents/starter-ops/`), each with its own startup context.

## What it touches

Its own rig and its own files. It reads the rest of the environment with OpenRig's commands and
changes nothing outside its rig unless the person separately enables the subscription-management job;
see the agent's role. Installing the bundle alone does not enable it.
