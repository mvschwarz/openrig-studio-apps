import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SURFACE = path.join(REPO, "apps", "agents", "app", "agents.html");

test("AGENTS turns explicit no-rig state into an honest setup action", () => {
  const surface = fs.readFileSync(SURFACE, "utf8");
  assert.match(surface, /fetch\(["']\/api\/factory\/state["']/);
  assert.match(surface, /attached\s*===\s*false/);
  assert.match(surface, /Stand up a rig/i);
  assert.match(surface, /check[^<\n]*reuse[^<\n]*create/i);
  assert.match(surface, /postMessage\(\{\s*type:\s*["']open-agent["']/);
});

test("AGENTS keeps failed attachment discovery distinct from an empty rig", () => {
  const surface = fs.readFileSync(SURFACE, "utf8");
  assert.match(surface, /no-rig-cli/);
  assert.match(surface, /rig-error/);
  assert.match(surface, /Diagnose rig connection/i);
  assert.match(surface, /do not create a parallel rig/i);
  assert.match(surface, /Could not confirm rig attachment|Rig status could not be confirmed/i);
});
