# Contributing an app

Apps here run in OpenRig Studio. Start with the README's walkthrough of the Hello pair, and the Studio SDK's
`contract/` folder for the manifest and page contracts.

You need Node 22 or later. Run `npm ci` once, then `npm run check` before you open a pull request: it runs ESLint,
the Prettier format check, the comment check and the tests. `npm run format` applies the formatting.

## A new app

1. **Copy Hello.** `apps/hello` becomes `apps/<your-id>`, and if your app needs a server, `providers/studio-hello`
   becomes `providers/<your-provider>`. Rename the id, the name, the page and the provider's package. The provider's folder name
   must be the last part of its package name (`providers/studio-hello` holds `@openrig/studio-hello`): the Studio finds a
   provider by that name, and says "has no runnable entry" when they differ.
2. **Declare, don't assume.** Every route your page needs goes in `calls`; every folder your provider needs is a root
   kind (`{{root:<kind>}}`), bound by the person in `studio.json`, never a path written into the code. Pick a rail
   icon from `vendor/kit/icons.mjs` (add an `app-<your-id>` entry for your own).
3. **Answer only this machine's Studio.** A provider awaits `checked(req)` from `providers/lib/admit.mjs` on every
   request (it runs `ownerCheck` from `providers/lib/owner-check.mjs`, which may be async), and resolves every path a request names against the folders it was given. Studio providers listen on
   127.0.0.1 only. One provider serves every page of its app, so no one request may stop it: send a file's bytes with
   `sendFile` from `providers/lib/send-file.mjs`, and never write a second set of headers.
4. **Say what isn't true.** When something can't be read, the page says so and why; it never shows an empty list or a
   zero that looks like a real answer.
5. **Test it the way a person meets it.** Add a test under `test/` (or `providers/<name>/test/`) that runs your
   provider over real HTTP and your page's script against it, and add your app to a Studio booted with
   `STUDIO_SDK_DIR=<sdk checkout> npm test -- test/studio-boot.test.mjs`, which boots every app in this repository.
6. **Keep it dependency-free if you can.** These apps run with no build step and no `npm install`. If you vendor a
   library, put it in your app's `vendor/` folder with its licence, and say where it came from.

Shared files: a file several apps load goes in the repository's `vendor/` folder, and each app lists it in its
manifest's `vendor`. Links to vendor files carry a content hash (`?v=<sha256>`); after you change one, run
`npm run pin` to update every link to it.

## Comments and history

Comments say why the code is the way it is. Who asked for a change, who reviewed it, ticket ids and dates belong in
commit messages, not in source; `npm run check:comments` refuses them.

## Licence

By contributing you agree that your contribution is licensed under the Apache License 2.0, like the rest of this
repository. Keep the licences and notices of anything you vendor. Don't commit credentials, real people's details,
or files copied from a real machine; tests build what they need in a temporary folder.
