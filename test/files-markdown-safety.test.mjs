// Files: a Markdown preview shows the file, it never runs it. The page's markdown-safety block runs here against the vendored
// marked (the same bytes the page loads), so a marked upgrade or an edit to the block is checked by effect, not by reading the code.
// Copyright 2026 mvschwarz. Licensed under the Apache License, Version 2.0.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const html = fs.readFileSync(new URL("../apps/files/app/files.html", import.meta.url), "utf8");
const markedSrc = fs.readFileSync(
  new URL("../apps/files/vendor/marked/marked.min.js", import.meta.url),
  "utf8",
);
const block = html.match(/\/\/ markdown-safety:begin\n([\s\S]*?)\/\/ markdown-safety:end/)?.[1];
const escLine = html.match(/^\s*const esc = .*$/m)?.[0];

function render(md) {
  const ctx = vm.createContext({
    URL,
    location: { href: "https://studio.example.invalid/surfaces/files.html" },
  });
  vm.runInContext(markedSrc, ctx);
  vm.runInContext(`${escLine}\n${block}\nglobalThis.marked.use(MARKDOWN_SAFETY);`, ctx);
  return ctx.marked.parse(md);
}

test("the page has one markdown-safety block and applies it before its only preview render", () => {
  assert.ok(
    block && escLine,
    "the markdown-safety block and the page's esc are where the test expects them",
  );
  assert.match(html, /globalThis\.marked\?\.use\(MARKDOWN_SAFETY\)/);
  assert.equal(html.match(/marked\.parse\(/g)?.length, 1, "one render path, the preview");
  assert.ok(html.indexOf("use(MARKDOWN_SAFETY)") < html.indexOf("marked.parse("));
});

test("raw HTML in a Markdown file is shown as text, never as markup", () => {
  for (const md of [
    "<script>alert(1)</script>",
    "para <img src=x onerror=alert(1)> end",
    '<div onclick="x()">hi</div>',
    '<iframe src="https://example.invalid"></iframe>',
    "x <svg onload=alert(1)></svg>",
  ]) {
    const out = render(md);
    assert.doesNotMatch(out, /<(script|img|div|iframe|svg)\b/i, md);
    assert.doesNotMatch(out, /<[^>]*\son\w+\s*=/i, `no live event handler: ${md}`);
    assert.match(out, /&lt;/, `the markup is visible as text: ${md}`);
  }
});

test("links and images keep an address only for schemes that can't execute", () => {
  for (const md of [
    "[x](javascript:alert(1))",
    "[x](JaVaScRiPt:alert(1))",
    "[x](vbscript:msgbox)",
    "[x](data:text/html,<b>)",
    "![a](javascript:alert(1))",
    "![a](data:image/svg+xml,<svg onload=alert(1)>)",
  ]) {
    const out = render(md);
    assert.doesNotMatch(out, /\b(href|src)\s*=\s*"\s*(javascript|vbscript|data):/i, md);
    assert.doesNotMatch(out, /<img\b/i, `no image for an unsafe source: ${md}`);
  }
  // An encoded scheme stays encoded in the attribute: the browser can't decode it back into javascript:.
  assert.doesNotMatch(render("[x](javascript&colon;alert(1))"), /href="[^"]*[^;]&colon;/);
  // Quotes in alt text and titles can't break out of the attribute: the tag keeps exactly its own attributes.
  const img = render('![a" onerror="alert(1)](https://ok.example/i.png "t\\" onload=\\"x")').match(
    /<img\b[^>]*>/,
  )?.[0];
  assert.match(img, /^<img src="[^"]*" alt="[^"]*"( title="[^"]*")?>$/, img);
  const a = render('[x" onclick="y](https://ok.example "t\\" onmouseover=\\"alert(1)")').match(
    /<a\b[^>]*>/,
  )?.[0];
  assert.match(a, /^<a href="[^"]*"( title="[^"]*")?>$/, a);
  assert.match(
    render('![say "hi"](https://ok.example/i.png)'),
    /alt="say &quot;hi&quot;"/,
    "escaped once, not twice",
  );
});

test("ordinary Markdown still renders: links, relative paths, anchors, mail, images and tables", () => {
  assert.match(
    render("[site](https://example.com/x)"),
    /<a href="https:\/\/example\.com\/x">site<\/a>/,
  );
  assert.match(render("[notes](notes/b.md)"), /<a href="notes\/b\.md">notes<\/a>/);
  assert.match(render("[top](#top)"), /<a href="#top">top<\/a>/);
  assert.match(render("[mail](mailto:a@example.com)"), /<a href="mailto:a@example\.com">mail<\/a>/);
  assert.match(render("![chart](img/c.png)"), /<img src="img\/c\.png" alt="chart">/);
  assert.match(render("| a | b |\n|---|---|\n| 1 | 2 |"), /<table>[\s\S]*<td>1<\/td>/);
  assert.match(render("**bold** and `code`"), /<strong>bold<\/strong> and <code>code<\/code>/);
});
