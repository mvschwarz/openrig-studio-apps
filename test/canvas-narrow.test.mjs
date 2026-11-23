// Canvas on a phone: at 390 px the library's 170 px column and the work pane's 300 px minimum ran the page off the
// right edge, cutting off the welcome, its button and New. The narrow layout lets the work pane shrink in both library states, and a
// phone-width screen starts with the library as a strip unless the person chose otherwise (a default never saved as their choice).
// Copyright 2026 mvschwarz. Licensed under the Apache License, Version 2.0.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const html = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "../apps/canvas/app/canvas.html"),
  "utf8",
);

test("Canvas's narrow layout never needs more width than the screen has", () => {
  const narrow = html.match(/@media\(max-width:760px\)\s*\{(.*)\}\s*$/m)?.[1] ?? "";
  assert.match(narrow, /main \{ grid-template-columns:170px minmax\(0,1fr\); \}/);
  assert.match(
    narrow,
    /body\.lib-collapsed main \{ grid-template-columns:46px minmax\(0,1fr\); \}/,
  );
  assert.doesNotMatch(narrow, /minmax\(300px/);
});

test("a phone starts with the library as a strip, and that default isn't stored as the person's choice", () => {
  assert.match(html, /return matchMedia\("\(max-width: 520px\)"\)\.matches; \}\)\(\), false\);/);
  assert.match(html, /if \(remember\) try \{ localStorage\.setItem\("canvas\.lib"/);
});
