# Startup context: the Observatory

## Where things are

- The app: http://127.0.0.1:9440/surfaces/observatory.html
- Its readings as JSON: http://127.0.0.1:9440/api/observatory/hosts, `/seats`, `/queues`, `/health`
- Its Compose project: `openrig-observatory`, service `studio`, volume `observatory-data`
- The OpenRig daemon it reads: `OBSERVATORY_DAEMON_URL` (default http://127.0.0.1:7433), plus every
  HTTP machine in that daemon's host list

## First steps

1. `rig whoami --json`: confirm who and where you are.
2. `rig env status observatory`: is the app's service up and healthy? The rig comes up as soon as the
   studio answers, so the observatory provider may not be serving yet. Look at the `studio` line:
   healthy means the studio and the provider both answer (`/api/observatory/ready`); `unhealthy` with
   the studio still answering means "shell answers; provider not confirmed". Then: read the logs,
   restart `studio` once, and report. Docker does not restart an unhealthy container by itself, and
   you restart only once: no loop.
3. Open the hosts reading (`curl -s http://127.0.0.1:9440/api/observatory/hosts`) and tell the
   person:
   - which machines were read
   - which were not, and why (unreachable, needs a token, ssh only, error)
   - where to open the app
4. Register one reminder to yourself to check the app every 30 minutes:
   `rig watchdog register --policy periodic-reminder` with yourself as the target. On each reminder,
   run step 2, check the readings' ages, and act only on the app (see your role).

## Shaping the app

Changing the Observatory itself (its panels, views, reports and settings, in `apps/observatory/` and
`providers/studio-observatory/`) is part of the job. Your role lists what that covers and what it
never covers. The subscription-rotation job is yours to run only if its owner has enabled it for you.

## Limits to say out loud when they matter

- Machines reachable only over ssh are listed but not read.
- Ceremony, subscriptions and productivity panels are not set up yet.
- This app reads open GET routes. It holds no token and asks for none.
