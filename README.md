# openrig-studio-apps

The apps and providers for OpenRig Studio. Every app here is a **surface** that
runs in the SDK's shell (`@openrig/studio`) — the shell is a rail of tabs, a
stage, and an agent sidebar, plus the contract a surface speaks to reach them.

## Layout

```
apps/<id>/
  app.json          the manifest: surface, provider, roots, verbs
  app/<id>.html     the surface
  vendor/           assets that travel with THIS app
providers/<name>/
  package.json      declares roots (as KINDS), binaries, first-run, peers
  *.mjs             the server(s)
```

## Ultralight vs heavy — the only distinction that matters

**Who serves the bytes.**

| | ultralight | heavy |
|---|---|---|
| ships | HTML + a script or two | its own service |
| served by | the shell (`path:` row) | itself (`url:` row) |
| install | drop the file, register a row | npm / docker / git — normal distribution |
| needs the SDK | **yes — the shell is its runtime** | only to appear as a tab |

That inverts the intuitive reading: the *ultralight* app is the one that needs
the SDK. `files` is ultralight. `media-manager`, `canvas` and `mini-nle` are
clients of `@openrig/studio-video`. `cutdown` is a client of
`@openrig/studio-cutdown`.

## Manifests declare; they do not imply

Every field in `app.json` and in a provider's `openrig` block exists because
leaving it out is how bespokeness happens. Roots are declared as **kinds**
(`project`, `media`, `footage`) and bound to real directories at install. Every
hardcoded path removed from this code — `content-piece-1/assembly`,
`workspace/<project>`, `$HOME/studio/app` — existed because there was nowhere to
say this. **If there is a field for it, nobody inlines it.**

A manifest authored on a machine that already has everything installed will
always under-declare. Test one by installing it somewhere that has nothing.

## Provenance

Ported from the frozen `studio-box` spike, then de-bespoked: the original
project each tool was built for was still wired in as a default. The code is
ported, not extracted — hand-extracting it silently broke three contracts that
answered HTTP 200 with real data while the pane rendered empty.
