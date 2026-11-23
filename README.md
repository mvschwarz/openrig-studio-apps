# OpenRig Studio Apps

Apps for [OpenRig Studio](https://openrig.dev): a browser shell for working beside your coding agents. Studio puts a
rail of apps on the left, the app you're using in the middle, and your agents' terminals on the right, so an agent
can change the thing you're looking at while you watch.

An **app** is one HTML page. When it needs more than the browser can do, it has a **provider**: a small local server
the Studio starts for it and reaches through the Studio's own address. This repository holds a set of apps and their
providers. The shell itself, and the launcher that runs everything, are the Studio SDK, a separate repository.

## The apps

| App | What it does | Provider |
|---|---|---|
| **Hello** | The smallest working app: a page that asks its provider for a greeting. Copy it to start your own. | `studio-hello` |
| **Canvas** | Documents and canvases you and an agent build together. Paste screenshots, arrange them, and mark them up with the Studio's MARKUP tool; every mark stays attached to a named element, so an agent can read exactly what you pointed at. A document is shown as written but never runs its own script, so nothing stored in Canvas can act as your Studio. | `studio-artifacts` |
| **Files** | Browse, search, tag and edit the folders you give the Studio. Markdown previews safely, PDFs and media open in the browser, and an agent can open a file here for you. | `studio-host` |
| **Machine** | How full this machine is (storage, memory, CPU), what's slowing it down, and a few safe cleanups: package caches that download again, and container images nothing uses. Works on macOS and Linux. | `studio-system` |
| **Projects** | One screen over what this Studio has: the agents of your OpenRig rig, the apps installed here, and your files. It needs no provider of its own, which makes it the app to read to learn the SDK. | none |
| **Rig designer** | Design an OpenRig rig by talking to the agent in your sidebar and watching the pods and seats appear. When it's ready, copy the commands that write the rig's files and start it with `rig up`. | none |
| **Terminal** | A terminal on your machine, as your own user, inside the Studio. | none |

`studio-host` also writes the live state of your OpenRig rig (its seats and open work) for the Studio's own FLOOR
page and for Projects. With no rig running, or no `rig` command installed, they say so instead of showing an empty
team.

## Run them

You need Node 22 or later and a checkout of the Studio SDK. From an empty folder for your Studio, write a
`studio.json` that points `appsRoot` at this repository and binds the folders the apps use:

```json
{
  "apps": ["hello", "canvas", "files", "system", "workspace", "rig-designer", "terminal"],
  "appsRoot": "/path/to/openrig-studio-apps",
  "port": 8890,
  "roots": {
    "project": "/path/to/the/folder/you/work/in",
    "artifacts": "./artifacts"
  }
}
```

Then start the Studio with the SDK's launcher, from that folder:

```sh
OPENRIG_STUDIO_DIR="$PWD" node /path/to/openrig-studio/tools/studio.mjs
```

Open http://127.0.0.1:8890/ and the apps are on the rail. The launcher starts each provider an enabled app needs; you
never start one yourself.

- `project` is the folder Files opens and Machine never cleans. `artifacts` is where Canvas keeps its documents.
  Relative paths resolve against the Studio's folder.
- **Your agents.** Projects and FLOOR read your rig through the `rig` command, and the sidebar shows your agents'
  terminals when OpenRig is running and [`ttyd`](https://github.com/tsl0922/ttyd) is installed. The SDK's own
  `docs/getting-started.md` walks through connecting your rig.
- **Terminal** needs [`ttyd`](https://github.com/tsl0922/ttyd) installed: a local Studio then starts its own shell, and
  Terminal opens it. Without `ttyd`, Terminal says so. To run the shell listener yourself instead (on another socket, or
  under your own supervisor), start it with the SDK's tool and start the Studio from a shell with the same variable set:

  ```sh
  export STUDIO_TERMINAL_SOCKET="$HOME/.studio-terminals/shell.sock"
  node /path/to/openrig-studio/tools/start-terminal.mjs shell
  ```

Providers answer only this machine's own Studio: a request must name a loopback address, and a change sent from a
browser must come from the Studio's own page. A Studio reached from another machine needs its own version of
`providers/lib/owner-check.mjs`, with the same two exports (its `ownerCheck` may be async).

## Write an app: the Hello pair

Hello is the whole pattern in four short files. Copy `apps/hello` and `providers/studio-hello`, rename them, and change
what they say.

**The manifest**, `apps/hello/app.json`, says what the app is and what it needs:

```json
{
  "manifest_version": 1,
  "id": "hello",
  "name": "Hello",
  "summary": "The smallest working app: one page that asks its provider for a greeting. Copy it to start your own.",
  "category": "example",
  "maker": { "name": "OpenRig", "url": "https://openrig.dev" },
  "surface": {
    "entry": "app/hello.html",
    "path": "/surfaces/hello.html",
    "glyph": "✋",
    "icon": "app-hello",
    "hint": "say hello to this Studio's provider"
  },
  "calls": {
    "/api/hello": { "required": true }
  },
  "provider": { "package": "@openrig/studio-hello", "required": true }
}
```

- `surface` is the page: where it lives in this repository, and where the Studio serves it.
- `calls` lists the routes the page uses. With `required: true`, the Studio refuses to start without a provider that
  answers them, rather than show a page whose buttons fail.
- `provider` names the provider the app needs. It doesn't say how to start it; the provider says that itself.

**The page**, `apps/hello/app/hello.html`, is plain HTML with no build step. It calls its provider with a relative
URL, `fetch("/api/hello?name=…")`. The Studio routes `/api/hello` to the provider, so the page never needs to know a
port.

**The provider's manifest**, `providers/studio-hello/provider.json`, says how to start it and which routes it answers:

```json
{
  "package": "@openrig/studio-hello",
  "run": {
    "entry": "hello-server.mjs",
    "args": ["--port", "{{port}}"]
  },
  "verbs": ["/api/hello"]
}
```

The provider's folder is named after the last part of its package (`providers/studio-hello` for `@openrig/studio-hello`):
that's how the Studio finds it. The Studio picks the port and fills in `{{port}}`. A provider that needs a folder asks for it by kind, for example
`"--root", "{{root:project}}"`, and `studio.json`'s `roots` binds the kind to a real folder; a manifest never holds a
path from one machine.

**The provider**, `providers/studio-hello/hello-server.mjs`, is a small Node HTTP server on 127.0.0.1 that answers
`GET /api/hello` with JSON. It runs the shared owner check first, as every provider here does.

Add your app's id to `studio.json`'s `apps`, restart the Studio, and it's on the rail. The SDK's `contract/` folder is
the full reference: `contract/app-manifest.md` for manifests, `contract/shell-protocol.md` for what the shell gives a
page, and `contract/drive.md` for letting an agent operate your app (Rig designer uses it).

## Shared files

- `vendor/` holds files several apps load, served once to every app that lists them in its manifest's `vendor`:
  `kit/` is the OpenRig UI kit (design tokens, components and icons), and `theme16/kit-app.css` is the stylesheet an
  app page links first. An app's own `vendor/` folder holds files only it uses.
- `providers/lib/` holds what providers share: `owner-check.mjs` (who a provider answers) and `admit.mjs` (which runs
  it before anything else and refuses unless it said yes), `send-file.mjs` (a file's
  bytes, with ranges, where no one request can stop the provider) and `local-daemon.mjs` (one bounded, JSON call to
  the local `rig` command).

## Check and test

```sh
npm ci
npm run check        # ESLint, Prettier, the comment check and the tests
npm test             # the tests alone
```

`test/studio-boot.test.mjs` boots a real Studio from the SDK with every app enabled and checks each page, each
provider and Hello's round trip through the Studio. It runs when it can find the SDK:

```sh
STUDIO_SDK_DIR=/path/to/openrig-studio npm test
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). The icons are Lucide's, under their ISC licence
(`vendor/kit/icons/LICENSE`), and Files previews Markdown with marked (MIT, `apps/files/vendor/marked/`).
