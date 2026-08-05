// THE DESTINATION OF A WRITE IS AN INPUT TOO.
//
// /api/library/route validated its SOURCE properly — realpath, then checked
// against the configured media roots, returning 403 for anything outside. Then it
// built its DESTINATION by interpolating a caller-supplied `slot` straight into a
// path, and `path.join` collapses `../` for you.
//
// The tell is one line apart: baseName IS sanitised on the line above. Whoever
// wrote it was thinking about the file name and never asked where the directory
// came from. Every review since examined the source check, found it careful, and
// moved on — which is exactly why a validated source never implies a validated
// destination. Read and write are separate operations and each end of each one
// needs its own answer.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { routeDestination } from "../providers/studio-video/library-route.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "libroute-"));

test("a slot cannot walk the destination out of the slice root", () => {
  // The measured escape: this exact value wrote outside the project before the
  // fix. It is kept as the control rather than described, so the guard has to
  // keep refusing it rather than be trusted to.
  const root = tmp();
  for (const slot of ["../../../tmp/evil", "..", "../sibling", "a/../../b", "/etc/passwd"]) {
    const r = routeDestination({ sliceRoot: root, destDir: "media/captures", baseName: "clip.mp4", slot });
    assert.equal(r.ok, false, `slot ${JSON.stringify(slot)} must be refused, got ${r.dest}`);
    if (r.dest) {
      assert.ok(path.resolve(r.dest).startsWith(path.resolve(root) + path.sep),
        `slot ${JSON.stringify(slot)} produced a destination outside the slice root: ${r.dest}`);
    }
  }
});

test("an ordinary slot still routes, which is the half a refuse-everything guard would pass", () => {
  // POSITIVE CONTROL. A boundary that rejects everything looks identical to a
  // correct one under an attack-only test, and this repository has shipped that
  // mistake before — a containment fix that refused the legitimate operation and
  // passed every security check.
  const root = tmp();
  const r = routeDestination({ sliceRoot: root, destDir: "media/captures", baseName: "clip.mp4", slot: "take-2" });
  assert.equal(r.ok, true, r.error);
  assert.ok(path.resolve(r.dest).startsWith(path.resolve(root) + path.sep), "a legitimate slot must land inside the root");
  assert.match(path.basename(r.dest), /^take-2-lib-clip\.mp4$/);
});

test("no slot at all is still allowed, because routing without a take is a real case", () => {
  const root = tmp();
  const r = routeDestination({ sliceRoot: root, destDir: "media/images", baseName: "still.png", slot: "" });
  assert.equal(r.ok, true, r.error);
  assert.match(path.basename(r.dest), /^lib-still\.png$/);
});

test("the guard is BOTH a sanitiser and a boundary check, not either", () => {
  // Defence in depth, deliberately. Sanitising alone is one careless concatenation
  // from the same bug; a boundary check alone accepts junk names that happen to
  // stay inside. The boundary is the load-bearing half — it holds regardless of
  // how the name was built — and this asserts the sanitiser did not simply get
  // replaced by it.
  const src = fs.readFileSync(new URL("../providers/studio-video/library-route.mjs", import.meta.url), "utf8");
  assert.match(src, /replace\(/, "the slot must be sanitised to a single safe segment");
  assert.match(src, /startsWith\(/, "and the RESOLVED destination must be checked against the root");
});
