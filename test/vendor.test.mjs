// The shared UI kit (vendor/kit/) and its page theme (vendor/theme16/): content-hashed links are current, each icon is its
// Lucide file under Lucide's licence, and <or-icon> draws the registry's markup. Copyright 2026 mvschwarz. Licensed under the
// Apache License, Version 2.0.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { vendorLinks } from "../scripts/pin-vendor.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const KIT = path.join(ROOT, "vendor/kit");

test("every content-hashed /vendor/ link names a file that exists and its current sha256 (npm run pin rewrites them)", () => {
  const links = vendorLinks(ROOT);
  assert.ok(links.length >= 10, `found ${links.length} links`);
  for (const l of links) {
    const at = `${path.relative(ROOT, l.file)}: ${l.link.split("?")[0]}`;
    assert.ok(l.target, `${at} names no file`);
    assert.ok(l.current, `${at} is stale`);
  }
});

test("the theme is the kit underneath: kit-app.css imports the kit's tokens and components, and nothing loads web fonts", () => {
  const kitApp = fs.readFileSync(path.join(ROOT, "vendor/theme16/kit-app.css"), "utf8");
  assert.match(kitApp, /@import url\("\/vendor\/kit\/tokens\.css\?v=[0-9a-f]{64}"\);/);
  assert.match(kitApp, /@import url\("\/vendor\/kit\/components\.css\?v=[0-9a-f]{64}"\);/);
  for (const f of [
    "vendor/theme16/kit-app.css",
    "vendor/theme16/tokens.css",
    "vendor/kit/tokens.css",
    "vendor/kit/components.css",
  ])
    assert.doesNotMatch(
      fs.readFileSync(path.join(ROOT, f), "utf8"),
      /@font-face|fonts\.googleapis/,
      f,
    );
});

test("every icon is its Lucide file, under Lucide's ISC licence beside it, and every icon file is used", async () => {
  assert.match(
    fs.readFileSync(path.join(KIT, "icons/LICENSE"), "utf8"),
    /ISC License[\s\S]*Lucide Icons and Contributors[\s\S]*The MIT License/,
  );
  const { ICONS } = await import(pathToFileURL(path.join(KIT, "icons.mjs")));
  const inner = (svg) =>
    svg
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/^[\s\S]*?<svg[^>]*>/, "")
      .replace(/<\/svg>\s*$/, "")
      .replace(/\s*\/>/g, "/>")
      .replace(/>\s+</g, "><")
      .trim();
  for (const [name, { file, body }] of Object.entries(ICONS)) {
    const src = fs.readFileSync(path.join(KIT, "icons", file), "utf8");
    assert.match(src, /@license lucide-static v[\d.]+ - ISC/, file);
    assert.equal(body, inner(src), `${name}: ${file}`);
  }
  const used = new Set(Object.values(ICONS).map((i) => i.file));
  for (const f of fs.readdirSync(path.join(KIT, "icons")).filter((f) => f.endsWith(".svg")))
    assert.ok(used.has(f), `${f} is unused`);
});

test("<or-icon> draws the registry's markup, and an unknown name draws nothing, never a glyph", async () => {
  const { icon } = await import(pathToFileURL(path.join(KIT, "icons.mjs")));
  const defined = {};
  globalThis.HTMLElement ??= class {};
  const { defineOrIcon } = await import(pathToFileURL(path.join(KIT, "or-icon.mjs")));
  defineOrIcon({
    get: (n) => defined[n],
    define: (n, c) => {
      defined[n] = c;
    },
  });
  const el = new defined["or-icon"](),
    attrs = { name: "settings", size: "20" };
  Object.assign(el, { isConnected: true, getAttribute: (k) => attrs[k] ?? null });
  el.connectedCallback();
  assert.equal(el.innerHTML, icon("settings", { size: 20 }));
  attrs.name = "nope";
  el.attributeChangedCallback();
  assert.equal(el.innerHTML, "");
});

test("Files' vendored marked carries its own licence beside it, for the same release", () => {
  const dir = path.join(ROOT, "apps/files/vendor/marked");
  const min = fs.readFileSync(path.join(dir, "marked.min.js"), "utf8");
  const version = min.match(/marked v(\d+\.\d+\.\d+)/)?.[1];
  assert.ok(version, "marked.min.js names its version");
  assert.match(
    fs.readFileSync(path.join(dir, "PROVENANCE.md"), "utf8"),
    new RegExp(`marked@${version.replace(/\./g, "\\.")}`),
    "the provenance note names the same release",
  );
  assert.match(
    fs.readFileSync(path.join(dir, "LICENSE.md"), "utf8"),
    /Copyright \(c\) 2018\+, MarkedJS[\s\S]*Permission is hereby granted, free of charge/,
  );
});
