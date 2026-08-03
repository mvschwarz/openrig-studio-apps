import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = path.join(REPO, "apps", "mini-nle", "app.json");
const SURFACE = path.join(REPO, "apps", "mini-nle", "app", "mini-nle.html");

const forbidden = [
  "/api/note",
  "/api/note/done",
  "/api/note/flush",
  "/api/reveal-file",
];

// Exact routes the surface legitimately uses. Parameterized export-status is
// asserted separately once the SDK's approved prefix syntax lands.
const requiredExact = [
  "/api/annotation",
  "/api/approve",
  "/api/export-final",
  "/api/export-review",
  "/api/focus",
  "/api/health",
  "/api/history-since",
  "/api/library",
  "/api/library/media",
  "/api/library/route",
  "/api/media",
  "/api/patch",
  "/api/patch/apply",
  "/api/patch/discard",
  "/api/patch/validate",
  "/api/probe-duration",
  "/api/project-assets",
  "/api/project-assets/rebuild",
  "/api/project-info",
  "/api/reconform",
  "/api/slot-history",
  "/api/tags",
  "/api/templates",
  "/api/thumb",
  "/api/timeline/doc",
  "/api/timeline/select",
  "/api/timelines",
  "/api/validate-audio",
  "/api/validate-export",
];

const requiredPrefixes = ["/api/export-status/"];

function readContract() {
  return {
    manifest: JSON.parse(fs.readFileSync(MANIFEST, "utf8")),
    surface: fs.readFileSync(SURFACE, "utf8"),
  };
}

// AUTHORSHIP NOTE, since this moved under studio-video's provider lift: the
// PROPERTIES below came from an independent QA review and are unchanged. Only where the app records a
// route moved — `verbs` (a flat list doing double duty as both "what I need" and
// "what my provider routes") became `calls` (what this app CALLS, with per-call
// required-ness). Reading `verbs` here would now read `undefined` and every one of
// these checks would either throw or pass vacuously, so the reader is re-pointed
// rather than the assertions rewritten.
function declaredRoutes(manifest) {
  return Object.keys(manifest.calls ?? {});
}

function missingRoutes(manifest) {
  const declared = new Set(declaredRoutes(manifest));
  return requiredExact.filter((route) => !declared.has(route));
}

function resolvePathFromSurface(surface, input, protocol = "http:") {
  const match = surface.match(/function resolvePath\(p\) \{[\s\S]*?\n    \}/);
  assert.ok(match, "resolvePath must remain inspectable in the shipped surface");
  const invoke = new Function(
    "input",
    "protocol",
    `const EXPORT_API_BASE = "";
     const location = { protocol };
     function basename(p) { return String(p || "").split("/").filter(Boolean).pop() || ""; }
     return (${match[0]})(input);`,
  );
  return invoke(input, protocol);
}

test("MINI-NLE declares every legitimate exact route it uses", () => {
  const { manifest } = readContract();
  assert.deepEqual(missingRoutes(manifest), []);
});

test("MINI-NLE declares parameterized status polling with the SDK trailing-slash prefix contract", () => {
  const { manifest, surface } = readContract();
  assert.match(surface, /callExportApi\(`\/api\/export-status\/\$\{encodeURIComponent\(jobId\)\}`/);
  for (const prefix of requiredPrefixes) assert.ok(declaredRoutes(manifest).includes(prefix), `${prefix} prefix is undeclared`);
});

test("the route checker demonstrably fails when a known declaration is removed", () => {
  const { manifest } = readContract();
  // Re-pointed at `calls`, and this one MATTERED: filtering the retired `verbs`
  // field left `calls` untouched, so the control went on "passing" while proving
  // nothing — every required route read as missing because the field was gone, not
  // because the removal was detected. A control that cannot fail is not protection.
  assert.deepEqual(missingRoutes(manifest), [], "baseline: the unaltered manifest is complete");
  const calls = { ...manifest.calls };
  delete calls["/api/patch"];
  const altered = { ...manifest, calls };
  assert.ok(missingRoutes(altered).includes("/api/patch"));
});

test("ruled-out rig injection and Finder reveal have no live surface callers", () => {
  const { manifest, surface } = readContract();
  for (const route of forbidden) {
    assert.ok(!declaredRoutes(manifest).includes(route), `${route} must not be declared`);
    const escaped = route.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.doesNotMatch(
      surface,
      new RegExp(`(?:callExportApi|fetch)\\(\\s*[\\\"'\\x60]${escaped}(?:[?\\\"'\\x60])`),
      `${route} still has a live network caller`,
    );
  }
});

test("disabled review handoff points to the agent sidebar at the interaction point", () => {
  const { surface } = readContract();
  assert.match(surface, /review handoff[^<\n]*agent sidebar|agent sidebar[^<\n]*review handoff/i);
  assert.doesNotMatch(surface, /AGENTS/);
});

test("dynamic export mode resolves to concrete declared review and final routes", () => {
  const { manifest, surface } = readContract();
  assert.match(surface, /callExportApi\(`\/api\/export-\$\{mode\}`/);
  assert.ok(declaredRoutes(manifest).includes("/api/export-review"));
  assert.ok(declaredRoutes(manifest).includes("/api/export-final"));
  assert.ok(!declaredRoutes(manifest).includes("/api/export-"), "dynamic source fragment is not a route declaration");
});

test("timeline media resolves through the declared provider route, not relative to /surfaces/", () => {
  const { surface } = readContract();
  assert.equal(
    resolvePathFromSurface(surface, "media/captures/qa-source.mp4"),
    "/api/media?path=media%2Fcaptures%2Fqa-source.mp4",
  );
  assert.equal(
    resolvePathFromSurface(surface, "/private/tmp/project/media/captures/qa-source.mp4"),
    "/api/media?path=%2Fprivate%2Ftmp%2Fproject%2Fmedia%2Fcaptures%2Fqa-source.mp4",
  );
  assert.equal(resolvePathFromSurface(surface, "https://example.test/clip.mp4"), "https://example.test/clip.mp4");
});
