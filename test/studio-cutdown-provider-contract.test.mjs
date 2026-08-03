// The cutdown lift. Closer to the FILES/live-state case than to studio-video's,
// because this provider owns a COMPANION — and a companion declared by an app dies
// with that app. That is not hypothetical here: retiring the AGENTS app removed the
// only declaration of {{state}} and a deployed box served an invented rig under a
// green live signal. Cutdown was one retirement away from the same story, except the
// thing that would have vanished is the renderer.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = path.join(REPO, "providers", "studio-cutdown");
const PROVIDER = path.join(DIR, "provider.json");
const APP = path.join(REPO, "apps", "cutdown", "app.json");
const read = (p) => JSON.parse(fs.readFileSync(p, "utf8"));

test("the cut lane travels with the provider that ships it", () => {
  const p = read(PROVIDER);
  const lane = (p.run?.companions ?? []).find((c) => c.entry === "watch-markers.mjs");

  assert.equal(p.package, "@openrig/studio-cutdown", "positive control: wrong manifest loaded");
  assert.ok(lane, "retiring any single consumer must not drop the renderer");
  assert.ok(fs.existsSync(path.join(DIR, lane.entry)),
    "a declared companion whose file is absent is refused at boot, not skipped");
  // The write verbs ENQUEUE; this process PERFORMS. Without it they accept work
  // nothing ever does — the verb returns ok, a real marker lands on disk, and only
  // the product is inert. Ruling 16's third rung, which defeats both the
  // verbs-answer check and the data-changed-on-disk check.
  assert.ok(lane.args.includes("{{root:footage}}") && lane.args.includes("{{root:project}}"),
    "the lane needs both roots bound or it watches nothing and renders nowhere");
});

test("no app declares how to run cutdown, so none can take the lane away", () => {
  const a = read(APP);
  assert.equal(a.id, "cutdown", "positive control: wrong app manifest loaded");
  assert.equal(a.provider?.package, "@openrig/studio-cutdown");
  assert.equal(a.provider?.run, undefined, "an app references a provider, never runs it");
  assert.equal(a.provider?.serves, undefined, "byte routes are the provider's fact");
  assert.equal(a.provider?.supplies, undefined, "who satisfies a binary need is the provider's fact");
  assert.equal(a.verbs, undefined, "verbs was doing double duty; the provider answers, the app calls");
  assert.ok(Object.keys(a.calls ?? {}).length > 0, "an app declares what it CALLS");
});

test("every byte route the server answers is declared, including /master/", () => {
  // THE ONE THIS LIFT FOUND. `/master/` is handled at cutdown-server.mjs and the
  // surface navigates to it on the download-full control — but only three prefixes
  // were ever declared, so it matched no `serves` entry, skipped the /api/-only
  // sole-provider fallback, and reached the SDK runtime, which 404s. A dead button
  // on every studio.
  //
  // Derived from the source rather than hand-listed, because hand-listing is exactly
  // how it went missing: a prefix is easy to add to a server and easy to forget in a
  // manifest, and nothing fails at build time.
  const src = fs.readFileSync(path.join(DIR, "cutdown-server.mjs"), "utf8");
  const answered = [...src.matchAll(/startsWith\("(\/[a-z][a-z0-9-]*\/)"\)/g)].map((m) => m[1]);
  const declared = new Set(read(PROVIDER).serves ?? []);

  assert.ok(answered.length >= 4, `positive control: only found ${answered.length} byte routes in the server`);
  for (const route of answered) {
    assert.ok(declared.has(route), `the server answers ${route} and nothing declares it — it will 404`);
  }
});

test("the surface's download-full control points at a declared route", () => {
  // The other half, and the half that makes the first mean something: a route can be
  // declared and unused, or used and undeclared. This pins the pairing that was broken.
  const surface = fs.readFileSync(path.join(REPO, "apps", "cutdown", "app", "cutdown.html"), "utf8");
  const declared = read(PROVIDER).serves ?? [];

  assert.match(surface, /location\.href = "\/master\/"/,
    "positive control: the download-full control no longer targets /master/");
  assert.ok(declared.includes("/master/"),
    "the surface navigates to /master/, so the provider must declare it");
});
