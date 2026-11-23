#!/usr/bin/env node
// Content-hashed vendor links: every `/vendor/<folder>/<file>?v=<sha256>` in the apps and the shared vendor folder names the
// current sha256 of the file it points at, so a browser fetches a changed file at once and keeps an unchanged one.
//
//   node scripts/pin-vendor.mjs           rewrite stale hashes in place
//   node scripts/pin-vendor.mjs --check   list stale ones and exit 1 (test/vendor.test.mjs runs this check)
//
// A link resolves against an app's own vendor/ first, then the shared vendor/ at the repository root, the same order the
// Studio launcher composes them in. Copyright 2026 mvschwarz. Licensed under the Apache License, Version 2.0.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LINK = /\/vendor\/([\w.-]+)\/([\w./-]+)\?v=([0-9a-f]{64})/g;
const sha = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

const walk = (dir) =>
  fs.existsSync(dir)
    ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name);
        return e.isDirectory() ? (e.name === "node_modules" ? [] : walk(p)) : [p];
      })
    : [];

// [file, appDir|null] for every page, stylesheet and module that can carry a link.
export function linkingFiles(root = ROOT) {
  const out = walk(path.join(root, "vendor")).map((f) => [f, null]);
  for (const app of fs.readdirSync(path.join(root, "apps"))) {
    const dir = path.join(root, "apps", app);
    for (const f of walk(dir)) out.push([f, dir]);
  }
  return out.filter(([f]) => /\.(html|css|js|mjs)$/.test(f));
}

const target = (root, appDir, folder, rest) =>
  [appDir && path.join(appDir, "vendor", folder, rest), path.join(root, "vendor", folder, rest)]
    .filter(Boolean)
    .find((f) => fs.existsSync(f));

// Every link, with the file it names (null when it names none) and whether its hash is current.
export function vendorLinks(root = ROOT) {
  const out = [];
  for (const [file, appDir] of linkingFiles(root)) {
    const text = fs.readFileSync(file, "utf8");
    for (const [link, folder, rest, hash] of text.matchAll(LINK)) {
      const t = target(root, appDir, folder, rest);
      out.push({
        file,
        link,
        target: t ?? null,
        current: t ? sha(t) === hash : false,
        want: t && sha(t),
      });
    }
  }
  return out;
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === self) {
  const check = process.argv.includes("--check");
  // Rewrite until nothing changes: a stylesheet's own hash moves when the links inside it are rewritten.
  for (let pass = 0; pass < 5; pass++) {
    const stale = vendorLinks().filter((l) => !l.current);
    if (!stale.length) break;
    if (check) {
      for (const l of stale)
        console.log(
          `${path.relative(ROOT, l.file)}: ${l.link.split("?")[0]} ${l.target ? "is stale" : "names no file"}`,
        );
      process.exit(1);
    }
    for (const l of stale) {
      if (!l.target) {
        console.error(`${path.relative(ROOT, l.file)}: ${l.link} names no file`);
        process.exit(1);
      }
      const text = fs.readFileSync(l.file, "utf8");
      fs.writeFileSync(l.file, text.split(l.link).join(`${l.link.split("?v=")[0]}?v=${l.want}`));
    }
  }
  console.log("vendor links: every hash is current");
}
