// The studio-video lift: three apps stopped declaring how to run one backend.
//
// canvas, media-manager and mini-nle each carried a BYTE-IDENTICAL copy of this
// provider's run spec, because an app was the only place the format let you write
// one. Three copies of a single fact drift, and this repo has already paid for that
// exact shape once: retiring the AGENTS app deleted the only declaration of
// {{state}}, and a deployed box served an invented rig under a green live signal.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROVIDER = path.join(REPO, "providers", "studio-video", "provider.json");
const CONSUMERS = ["canvas", "media-manager", "mini-nle"];
const app = (id) => JSON.parse(fs.readFileSync(path.join(REPO, "apps", id, "app.json"), "utf8"));

test("the video provider declares how to run itself, and ships what it declares", () => {
  const p = JSON.parse(fs.readFileSync(PROVIDER, "utf8"));

  assert.equal(p.package, "@openrig/studio-video",
    "positive control: the expected provider declaration was not loaded");
  assert.equal(p.run?.entry, "export-server.mjs");
  assert.ok(fs.existsSync(path.join(REPO, "providers", "studio-video", p.run.entry)),
    "a declared entry whose file is absent is a refusal at boot, not a working studio");
  assert.deepEqual(p.supplies, ["ffmpeg", "ffprobe"],
    "who SATISFIES a binary need is the provider's fact; the app declares the NEED");
});

test("no app declares how to run studio-video, so none can take it away", () => {
  for (const id of CONSUMERS) {
    const a = app(id);
    assert.equal(a.provider?.package, "@openrig/studio-video", `${id}: positive control`);
    assert.equal(a.provider?.run, undefined, `${id}: an app references a provider, never runs it`);
    assert.equal(a.provider?.supplies, undefined, `${id}: supplies is the provider's fact`);
    assert.equal(a.verbs, undefined, `${id}: verbs was doing double duty; the provider answers, the app calls`);
    assert.ok(Object.keys(a.calls ?? {}).length > 0, `${id}: an app declares what it CALLS`);
  }
});

test("every verb these apps call is one this provider answers", () => {
  // The reconciliation the composer performs, pinned here so a call can never be
  // silently unroutable. Before `calls` existed a verb resolved to the DECLARING
  // APP'S OWN provider, so an app could only ever name verbs it already had.
  const served = new Set(JSON.parse(fs.readFileSync(PROVIDER, "utf8")).verbs);
  for (const id of CONSUMERS) {
    for (const verb of Object.keys(app(id).calls)) {
      assert.ok(served.has(verb), `${id} calls ${verb} and studio-video does not declare it`);
    }
  }
});

test("the rig-injecting note verbs stay OUT of the declared answer set", () => {
  // THE LOAD-BEARING ONE. export-server.mjs still contains live handlers for
  // /api/note* which reach execFile("rig", ["queue","create", ...]) — a Studio
  // surface injecting work into the rig's coordination system — and /api/reveal-file,
  // which shells out to `open -R`.
  //
  // On any multi-provider box these do not route today, because no app declares them
  // and the runtime's sole-provider fallback needs exactly one provider. Declaring
  // them here would ENABLE something currently unreachable: a policy change smuggled
  // inside a format migration. A migration moves where a fact is written; it must not
  // change what the product does.
  //
  // This is a test rather than a comment because the honest way to write this list is
  // to read the handlers out of the server, and that reading would sweep these in.
  const p = JSON.parse(fs.readFileSync(PROVIDER, "utf8"));
  const WITHHELD = ["/api/note", "/api/note/done", "/api/note/flush",
                    "/api/note/reconciled", "/api/reveal-file"];

  const src = fs.readFileSync(path.join(REPO, "providers", "studio-video", "export-server.mjs"), "utf8");
  assert.match(src, /execFile\(\s*"rig"/,
    "positive control: if the injection call is gone, this exclusion is stale and should be revisited");

  for (const verb of WITHHELD) {
    assert.ok(src.includes(`"${verb}"`), `positive control: ${verb} no longer exists in the server`);
    assert.ok(!p.verbs.includes(verb), `${verb} must not be declared: it is reachable only if declared`);
    for (const id of CONSUMERS) {
      assert.equal(app(id).calls[verb], undefined, `${id} must not call ${verb}`);
    }
  }
});

test("the canvas license byte route is declared, because nothing else can route it", () => {
  // Found by doing this lift. canvas.html fetches /canvas-license.json; this provider
  // answers it and deliberately returns {} rather than 404. But it is not an /api/
  // path, so the runtime's sole-provider fallback never applies to it — an undeclared
  // byte route reaches the SDK runtime and 404s on EVERY studio, one provider or ten.
  //
  // Invisible in dev and fatal in production: unkeyed tldraw only unmounts the editor
  // on a production https non-loopback origin, so canvas looks perfect on 127.0.0.1
  // and dies five seconds in on a deployed box.
  const p = JSON.parse(fs.readFileSync(PROVIDER, "utf8"));
  const canvasHtml = fs.readFileSync(path.join(REPO, "apps", "canvas", "app", "canvas.html"), "utf8");

  assert.match(canvasHtml, /fetch\("\/canvas-license\.json"\)/,
    "positive control: canvas no longer fetches the license, so this route may be droppable");
  assert.ok(p.serves?.includes("/canvas-license.json"),
    "a byte route the surface fetches must be declared or it never reaches the provider");
});
