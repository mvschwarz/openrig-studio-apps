// What the observatory provider actually runs must not carry anyone's machine,
// account or credentials with it.
//
// The check walks the provider's runtime closure: every file its provider.json
// starts (the entry and any companions), and everything those files import,
// statically or through a literal dynamic import. A pattern check over a
// hand-picked file list would pass forever while a new import pulled something
// in. This one follows the imports, so whatever the provider starts is checked.
//
// It deliberately does NOT scan the whole repository. Other providers have their
// own history and their own owners; this test makes a claim about this provider
// only, and says so.
//
// Extra patterns (for example names that must not appear but must not be
// written down here either) can be supplied one regular expression per line in
// the file named by OBSERVATORY_NEVER_SHIP_PATTERNS_FILE.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const providerDir = path.resolve(here, "../providers/studio-observatory");

const PATTERNS = [
  { name: "a macOS home path", re: /\/Users\// },
  { name: "a Linux home path", re: /\/home\/[A-Za-z0-9_.-]+\// },
  { name: "a credentials file", re: /credentials\.json/ },
  { name: "an auth file", re: /\bauth\.json/ },
  { name: "an ssh key or config path", re: /\.ssh\// },
  { name: "a tailnet host name", re: /\.ts\.net\b/ },
  { name: "a model provider endpoint", re: /api\.anthropic\.com|api\.openai\.com|chatgpt\.com/ },
  // The provider reads open GET routes. It never acquires or sends a token, so an
  // authorization header anywhere in what it runs is a design change, not a detail.
  { name: "an authorization header", re: /authorization|\bbearer\b/i },
];

function extraPatterns() {
  const file = process.env.OBSERVATORY_NEVER_SHIP_PATTERNS_FILE;
  if (!file) return [];
  return fs.readFileSync(file, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))
    .map((src, i) => ({ name: `supplied pattern ${i + 1}`, re: new RegExp(src, "i") }));
}

const IMPORT_RE = /(?:^|[^\w.])(?:import|export)\s[^"'`]*?from\s*["']([^"']+)["']|(?:^|[^\w.])import\s*\(\s*["']([^"']+)["']\s*\)|(?:^|[^\w.])import\s*["']([^"']+)["']/g;

export function runtimeClosure(dir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "provider.json"), "utf8"));
  const roots = [manifest.run.entry, ...(manifest.run.companions ?? []).map((c) => c.entry)];
  const seen = new Set();
  const problems = [];
  const queue = roots.map((r) => path.resolve(dir, r));
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    if (!file.startsWith(dir + path.sep)) { problems.push(`${file} is outside the provider`); continue; }
    if (!fs.existsSync(file)) { problems.push(`${path.relative(dir, file)} is started or imported but missing`); continue; }
    const src = fs.readFileSync(file, "utf8");
    for (const m of src.matchAll(IMPORT_RE)) {
      const spec = m[1] ?? m[2] ?? m[3];
      if (spec.startsWith("node:")) continue;
      if (spec.startsWith(".")) { queue.push(path.resolve(path.dirname(file), spec)); continue; }
      problems.push(`${path.relative(dir, file)} imports the package "${spec}"; this provider runs on Node's standard library only`);
    }
  }
  return { files: [...seen], problems, manifest };
}

test("the closure is found by following imports from what provider.json starts", () => {
  const { files, problems } = runtimeClosure(providerDir);
  assert.deepEqual(problems, []);
  const rel = files.map((f) => path.relative(providerDir, f)).sort();
  // The positive control: if the walk silently stopped at the entry, every pattern
  // check below would pass on one file.
  assert.ok(rel.includes("observatory-server.mjs"));
  assert.ok(rel.includes(path.join("lib", "fleet-reader.mjs")), `the reader must be in the closure, got ${rel.join(", ")}`);
});

test("nothing in the closure names a machine, an account path or a credential", () => {
  const { files } = runtimeClosure(providerDir);
  const patterns = [...PATTERNS, ...extraPatterns()];
  const hits = [];
  for (const file of files) {
    const lines = fs.readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      for (const p of patterns) if (p.re.test(line)) hits.push(`${path.relative(providerDir, file)}:${i + 1} ${p.name}`);
    });
  }
  assert.deepEqual(hits, []);
});

test("the pattern check does catch a planted path", () => {
  // Without this, a regular expression that never matches would keep the test
  // above green whatever the provider contained.
  const planted = ["const home = '/Users/someone/.config';", "fetch(url, { headers: { Authorization: x } })", "read('~/.codex/auth.json')"];
  for (const line of planted) assert.ok(PATTERNS.some((p) => p.re.test(line)), `no pattern caught: ${line}`);
});
