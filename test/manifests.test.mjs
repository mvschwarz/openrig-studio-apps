// Every app and provider manifest describes a working install: the page, provider, run entries, vendor folders and icons it
// names are all in this repository, and every verb an app requires is answered by a provider here.
// Copyright 2026 mvschwarz. Licensed under the Apache License, Version 2.0.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const json = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const dirs = (d) =>
  fs
    .readdirSync(path.join(ROOT, d), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
const APPS = dirs("apps").map((id) => ({
  id,
  dir: path.join(ROOT, "apps", id),
  m: json(path.join(ROOT, "apps", id, "app.json")),
}));
const PROVIDERS = dirs("providers")
  .filter((p) => fs.existsSync(path.join(ROOT, "providers", p, "provider.json")))
  .map((p) => ({
    name: p,
    dir: path.join(ROOT, "providers", p),
    d: json(path.join(ROOT, "providers", p, "provider.json")),
  }));
const verbMatches = (declared, wanted) =>
  declared === wanted || (declared.endsWith("/") && wanted.startsWith(declared));

test("the first public set is exactly these apps and providers", () => {
  assert.deepEqual(APPS.map((a) => a.id).sort(), [
    "canvas",
    "files",
    "hello",
    "rig-designer",
    "system",
    "terminal",
    "workspace",
  ]);
  assert.deepEqual(PROVIDERS.map((p) => p.name).sort(), [
    "studio-artifacts",
    "studio-hello",
    "studio-host",
    "studio-system",
  ]);
});

test("every app's identity and page: id is its folder, its page exists and is served flat under /surfaces/, maker is OpenRig", async () => {
  const { ICONS } = await import(pathToFileURL(path.join(ROOT, "vendor/kit/icons.mjs")));
  for (const { id, dir, m } of APPS) {
    assert.equal(m.manifest_version, 1, id);
    assert.equal(m.id, id);
    assert.ok(
      m.name && m.summary && m.surface?.glyph && m.surface?.hint,
      `${id}: name, summary, glyph and hint`,
    );
    assert.ok(fs.existsSync(path.join(dir, m.surface.entry)), `${id}: ${m.surface.entry}`);
    assert.equal(m.surface.path, `/surfaces/${path.basename(m.surface.entry)}`, id);
    assert.ok(
      Object.hasOwn(ICONS, m.surface.icon ?? ""),
      `${id}: icon "${m.surface.icon}" is a kit registry name`,
    );
    assert.deepEqual(m.maker, { name: "OpenRig", url: "https://openrig.dev" }, id);
  }
});

test("every provider an app names is here, with its run entry and companions, and its package.json agrees", () => {
  const byPackage = new Map(PROVIDERS.map((p) => [p.d.package, p]));
  for (const { id, m } of APPS) {
    if (!m.provider?.package) continue;
    assert.ok(byPackage.has(m.provider.package), `${id}: ${m.provider.package}`);
    assert.equal(
      m.provider.run,
      undefined,
      `${id}: an app references its provider, never says how to run it`,
    );
  }
  for (const { name, dir, d } of PROVIDERS) {
    assert.ok(fs.existsSync(path.join(dir, d.run.entry)), `${name}: ${d.run.entry}`);
    for (const c of d.run.companions ?? [])
      assert.ok(fs.existsSync(path.join(dir, c.entry)), `${name}: ${c.entry}`);
    const pkg = json(path.join(dir, "package.json"));
    assert.equal(pkg.name, d.package, name);
    assert.equal(pkg.license, "Apache-2.0", name);
    assert.equal(pkg.type, "module", name);
    assert.equal(pkg.dependencies, undefined, `${name}: no dependencies, so nothing to install`);
  }
});

test("every verb an app requires is answered by a provider here, and no verb is claimed by two providers", () => {
  const owner = new Map();
  for (const { name, d } of PROVIDERS)
    for (const v of d.verbs ?? []) {
      assert.ok(!owner.has(v), `${v} is claimed by ${owner.get(v)} and ${name}`);
      owner.set(v, name);
    }
  for (const { id, m } of APPS)
    for (const [verb, spec] of Object.entries(m.calls ?? {})) {
      if (!spec.required) continue;
      assert.ok(
        [...owner.keys()].some((d) => verbMatches(d, verb)),
        `${id}: required ${verb} has no provider`,
      );
    }
});

test("every vendor folder an app declares resolves (its own vendor/, then the shared vendor/), and every /vendor/ folder a page loads is declared", () => {
  for (const { id, dir, m } of APPS) {
    for (const v of m.vendor ?? [])
      assert.ok(
        fs.existsSync(path.join(dir, "vendor", v)) || fs.existsSync(path.join(ROOT, "vendor", v)),
        `${id}: vendor ${v}`,
      );
    const page = fs.readFileSync(path.join(dir, m.surface.entry), "utf8");
    for (const [, folder] of page.matchAll(/\/vendor\/([\w.-]+)\//g))
      assert.ok(
        (m.vendor ?? []).includes(folder),
        `${id}: loads /vendor/${folder}/ without declaring it`,
      );
  }
});

test("manifests carry reasons, not history: no dated stamps in any app, provider or package manifest", () => {
  const files = [
    ...APPS.map((a) => path.join(a.dir, "app.json")),
    ...PROVIDERS.flatMap((p) => [
      path.join(p.dir, "provider.json"),
      path.join(p.dir, "package.json"),
    ]),
    path.join(ROOT, "package.json"),
  ];
  for (const f of files)
    assert.doesNotMatch(
      fs.readFileSync(f, "utf8"),
      /\b20\d\d-[01]\d-[0-3]\d\b/,
      path.relative(ROOT, f),
    );
});
