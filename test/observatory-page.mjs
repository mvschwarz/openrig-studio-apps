// Loads the Observatory page's render functions for tests. The page is one self-contained HTML file
// (the studio serves only the declared entry), and its render functions are exports of its single
// module script; this imports that script directly. Its browser boot does not run outside a page.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const pagePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../apps/observatory/app/observatory.html");

export async function loadPage(file = pagePath) {
  const html = fs.readFileSync(file, "utf8");
  const m = html.match(/<script type="module">([\s\S]*?)<\/script>/);
  assert.ok(m, "the page has one module script");
  return import(`data:text/javascript;base64,${Buffer.from(m[1]).toString("base64")}`);
}
