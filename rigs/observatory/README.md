# Observatory launch rig

Adds the Observatory to an OpenRig machine: one container running the Studio with the Observatory
app, and an agent that sets it up, keeps it running and answers questions from what it shows.

## Start it

From a checkout of this repository, on Linux with Docker Compose:

```sh
rig up rigs/observatory/rig.yaml
```

`rig up` builds the image, starts the `openrig-observatory` Compose project, waits until the studio
answers, then starts the agent. Open http://127.0.0.1:9440/surfaces/observatory.html.

## What it reads

The OpenRig daemon on this machine (`OBSERVATORY_DAEMON_URL`, default http://127.0.0.1:7433) and
every HTTP machine in that daemon's host list, through their open GET routes. To include another
machine, add it to OpenRig's host list (`rig host add`); the Observatory picks it up on its next
read. Machines reachable only over ssh are listed but not read.

## What it needs and touches

- Docker with Compose, and host networking (Linux). On macOS, Docker Desktop's host networking is a
  separate opt-in and is not verified.
- Port 9440 on 127.0.0.1.
- Its own named volume, `observatory-data`. It mounts nothing else from the host and holds no
  token.
- Pinned: Node `22.22.1-bookworm-slim` by digest, and the Studio SDK at commit
  `e7346bbdbd01539e6003ccccb38c44763236545b`. The app and provider come from the checkout you start
  it from.

## Stop it

`rig down observatory` stops the agent and the container and keeps the volume.

## Checking that it recovers from a crash

A crash test has to crash the studio process, not stop the container:

```sh
docker compose -p openrig-observatory -f rigs/observatory/observatory.compose.yaml \
  exec -T studio node - < rigs/observatory/p6/kill-studio.cjs
```

The script kills the studio process inside the container and prints its pid. Compose then restarts the
container (`restart: unless-stopped`; `init: true` makes the studio a child of PID 1, so this is a
real crash). `docker stop` and `docker kill` are not crash tests: Docker treats both as a deliberate
stop and does not restart the container.
