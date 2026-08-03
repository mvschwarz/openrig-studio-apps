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

function missingRoutes(manifest) {
  const declared = new Set(manifest.verbs ?? []);
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
  for (const prefix of requiredPrefixes) assert.ok(manifest.verbs.includes(prefix), `${prefix} prefix is undeclared`);
});

test("the route checker demonstrably fails when a known declaration is removed", () => {
  const { manifest } = readContract();
  const altered = { ...manifest, verbs: (manifest.verbs ?? []).filter((route) => route !== "/api/patch") };
  assert.ok(missingRoutes(altered).includes("/api/patch"));
});

test("ruled-out rig injection and Finder reveal have no live surface callers", () => {
  const { manifest, surface } = readContract();
  for (const route of forbidden) {
    assert.ok(!(manifest.verbs ?? []).includes(route), `${route} must not be declared`);
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
  assert.ok(manifest.verbs.includes("/api/export-review"));
  assert.ok(manifest.verbs.includes("/api/export-final"));
  assert.ok(!manifest.verbs.includes("/api/export-"), "dynamic source fragment is not a route declaration");
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
