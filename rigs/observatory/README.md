# Observatory launch rig

Adds the Observatory to an OpenRig machine: one container running the Studio with the Observatory
app, and an agent that sets it up, keeps it running and answers questions from what it shows.

## Start it

From a checkout of this repository, on Linux with Docker Compose:

```sh
rig up rigs/observatory/rig.yaml
```

`rig up` builds the image, starts the `openrig-observatory` Compose project, waits until the studio
answers, then starts the agent. It does not wait for the observatory provider behind the studio: if
that is not serving, the agent sees it (below) and deals with it. Open http://127.0.0.1:9440/surfaces/observatory.html.

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

## Health

The container is healthy when the studio and the observatory provider both answer
(`/api/observatory/ready`, through the studio's port). The ready check never reads a daemon: an
unreachable OpenRig daemon is a reading the app shows, not an unhealthy app. Docker does not restart an
unhealthy container; the app's agent sees `studio: running (unhealthy)` in `rig env status`, reads the
logs, restarts `studio` once and reports. It does not keep restarting.

## Stop it

`rig down observatory` stops the agent and the container and keeps the volume.

## Checking that it recovers from a crash

A crash test has to crash the studio process, not stop the container:

```sh
docker compose -p openrig-observatory -f rigs/observatory/observatory.compose.yaml \
  exec -T studio node - < rigs/observatory/p6/kill-studio.cjs
```

The script prints the studio's pid and then kills that process inside the container; the exec may
end with the container rather than cleanly. Compose then restarts the
container (`restart: unless-stopped`; `init: true` makes the studio a child of PID 1, so this is a
real crash). `docker stop` and `docker kill` are not crash tests: Docker treats both as a deliberate
stop and does not restart the container.
