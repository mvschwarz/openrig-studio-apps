// An app manifest never repeats a top-level key. JSON.parse keeps the LAST of two equal keys without a word, so a merge that
// leaves two "vendor" lines silently drops one app's vendor folders. Copyright 2026 mvschwarz. Licensed under the Apache License,
// Version 2.0.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("every apps/*/app*.json names each top-level key once", () => {
  for (const app of fs.readdirSync(path.join(ROOT, "apps"))) {
    const dir = path.join(ROOT, "apps", app);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir).filter((n) => /^app(\.[a-z]+)?\.json$/.test(n))) {
      const text = fs.readFileSync(path.join(dir, f), "utf8"),
        parsed = JSON.parse(text);
      // Top-level keys sit at two spaces of indentation in every manifest; count each one's lines.
      for (const k of Object.keys(parsed)) {
        const n = text.split("\n").filter((l) => l.startsWith(`  "${k}":`)).length;
        assert.ok(n <= 1, `apps/${app}/${f}: "${k}" appears ${n} times`);
      }
    }
  }
});
