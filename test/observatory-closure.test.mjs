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
// Code both read-only providers run (the fleet reader and the server core). It ships with them and is
// checked as part of each provider's closure.
const sharedDir = path.resolve(here, "../providers/shared");
// The Fleet provider and app get every check the Observatory's get.
const fleetProviderDir = path.resolve(here, "../providers/studio-fleet-view");
const PROVIDER_DIRS = [providerDir, fleetProviderDir];

const PATTERNS = [
  { name: "a macOS home path", re: /\/Users\// },
  { name: "a Linux home path", re: /\/home\/[A-Za-z0-9_.-]+\// },
  { name: "a credentials file", re: /credentials\.json/ },
  { name: "an auth file", re: /\bauth\.json/ },
  { name: "an ssh key or config path", re: /\.ssh\// },
  { name: "a tailnet host name", re: /\.ts\.net\b/ },
  { name: "a model provider endpoint", re: /api\.anthropic\.com|api\.openai\.com|chatgpt\.com/ },
  // A request that spends an account's allowance, or an OAuth or sign-in flow: never in these apps.
  { name: "a model request or sign-in flow", re: /\/v1\/messages|\boauth\b|device[_-]?code|sign-?in code/i },
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

export function runtimeClosure(dir, allowed = [dir, sharedDir]) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "provider.json"), "utf8"));
  // Plus the container healthcheck script, which runs inside the image too.
  const roots = [manifest.run.entry, ...(manifest.run.companions ?? []).map((c) => c.entry), ...(fs.existsSync(path.join(dir, "healthcheck.mjs")) ? ["healthcheck.mjs"] : [])];
  const seen = new Set();
  const problems = [];
  const queue = roots.map((r) => path.resolve(dir, r));
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    if (!allowed.some((root) => file.startsWith(root + path.sep))) { problems.push(`${file} is outside the provider`); continue; }
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
  assert.ok(rel.includes(path.join("..", "shared", "fleet-reader.mjs")) && rel.includes(path.join("..", "shared", "reader-server.mjs")), `the shared code must be in the closure, got ${rel.join(", ")}`);
  assert.ok(rel.includes("healthcheck.mjs"), "the healthcheck the container runs is checked too");
});

test("nothing in either provider's closure names a machine, an account path or a credential", () => {
  const files = new Set(PROVIDER_DIRS.flatMap((d) => runtimeClosure(d).files));
  assert.ok([...files].some((f) => f.endsWith("fleet-view-server.mjs")), "the Fleet provider is scanned");
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

// The app's closure is what a browser loads for it: the declared entry page, anything that page
// references by src, href or import, and any vendor directory the manifest ships. Nothing may come
// from another origin, so a page can't quietly pull code or data from somewhere unreviewed.
const appDir = path.resolve(here, "../apps/observatory");
const APP_DIRS = [appDir, path.resolve(here, "../apps/fleet")];
const REF_RE = /\b(?:src|href)\s*=\s*["']([^"'#]+)["']|\bimport\s*(?:[^"'`]*?from\s*)?["']([^"']+)["']|@import\s+(?:url\()?["']?([^"')]+)/g;

export function appClosure(dir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "app.json"), "utf8"));
  const files = [path.join(dir, "app.json")];
  const problems = [];
  const queue = [path.resolve(dir, manifest.surface.entry)];
  for (const v of manifest.vendor ?? []) {
    const vd = path.join(dir, "vendor", v);
    if (!fs.existsSync(vd)) { problems.push(`vendor/${v} is declared but missing`); continue; }
    for (const f of fs.readdirSync(vd, { recursive: true })) { const p = path.join(vd, f); if (fs.statSync(p).isFile()) files.push(p); }
  }
  const seen = new Set();
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    if (!file.startsWith(dir + path.sep)) { problems.push(`${file} is outside the app`); continue; }
    if (!fs.existsSync(file)) { problems.push(`${path.relative(dir, file)} is loaded but missing`); continue; }
    files.push(file);
    if (!/\.(html|m?js|css)$/.test(file)) continue;
    for (const m of fs.readFileSync(file, "utf8").matchAll(REF_RE)) {
      const ref = (m[1] ?? m[2] ?? m[3]).trim();
      if (/^(https?:)?\/\//i.test(ref)) { problems.push(`${path.relative(dir, file)} loads ${ref} from another origin`); continue; }
      if (ref.startsWith("/") || ref.startsWith("data:")) continue; // same-origin runtime routes and inline data
      queue.push(path.resolve(path.dirname(file), ref));
    }
  }
  return { files, problems };
}

test("the app's closure loads nothing from another origin and nothing missing", () => {
  const { files, problems } = appClosure(appDir);
  assert.deepEqual(problems, []);
  const rel = files.map((f) => path.relative(appDir, f)).sort();
  assert.deepEqual(rel, ["app.json", path.join("app", "observatory.html")]);
});

test("nothing in either app's closure names a machine, an account path or a credential", () => {
  const files = APP_DIRS.flatMap((d) => appClosure(d).files);
  assert.ok(files.some((f) => f.endsWith("fleet.html")), "the Fleet page is scanned");
  const patterns = [...PATTERNS, ...extraPatterns()];
  const hits = [];
  for (const file of files) {
    fs.readFileSync(file, "utf8").split("\n").forEach((line, i) => {
      for (const p of patterns) if (p.re.test(line)) hits.push(`${path.relative(appDir, file)}:${i + 1} ${p.name}`);
    });
  }
  assert.deepEqual(hits, []);
});

test("the app check does catch a page that loads from another origin", () => {
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync(path.resolve(here, "..")), ".closure-"));
  try {
    fs.mkdirSync(path.join(tmp, "app"));
    fs.writeFileSync(path.join(tmp, "app.json"), JSON.stringify({ surface: { entry: "app/x.html" }, vendor: [] }));
    fs.writeFileSync(path.join(tmp, "app", "x.html"), '<script src="https://cdn.example/lib.js"></script><script type="module">import "./gone.mjs";</script>');
    const { problems } = appClosure(tmp);
    assert.equal(problems.length, 2, problems.join("; "));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// The launch rigs ship whole: their specs, compose file, Dockerfile, the shared agent, the know-how and
// notes. Every file under rigs/ gets the same patterns.
test("nothing in the launch rigs names a machine, an account path or a credential", () => {
  const rigDir = path.resolve(here, "../rigs");
  const patterns = [...PATTERNS, ...extraPatterns()];
  const files = fs.readdirSync(rigDir, { recursive: true }).map((f) => path.join(rigDir, f)).filter((f) => fs.statSync(f).isFile());
  assert.ok(files.length >= 18, `expected the rigs' files, found ${files.length}`);
  const hits = [];
  for (const file of files) {
    fs.readFileSync(file, "utf8").split("\n").forEach((line, i) => {
      for (const p of patterns) if (p.re.test(line)) hits.push(`${path.relative(rigDir, file)}:${i + 1} ${p.name}`);
    });
  }
  assert.deepEqual(hits, []);
});

// Subscriptions are shown as usage and resets, never as money. Neither the provider nor the page
// may carry a currency field or label.
const MONEY = /\bUSD\b|\busd\b|costUsd|CostUsd|CostEstimate|\bdollars?\b|\bbilling\b/i;

test("nothing the providers run or the pages load deals in money", () => {
  const files = [...new Set(PROVIDER_DIRS.flatMap((d) => runtimeClosure(d).files)), ...APP_DIRS.flatMap((d) => appClosure(d).files)];
  const hits = [];
  for (const file of files) fs.readFileSync(file, "utf8").split("\n").forEach((line, i) => { if (MONEY.test(line)) hits.push(`${path.relative(path.resolve(here, ".."), file)}:${i + 1}`); });
  assert.deepEqual(hits, []);
  assert.ok(MONEY.test("clientCostEstimateUsd: 1.2") && MONEY.test("12 dollars"), "the money pattern catches a planted field");
});

// The drill-down stays on open, bounded reads: no transcripts, and none of the routes that need a
// token (generation record, previews, compaction, the terminal).
const GUARDED_ROUTES = /\/generation-record|\/preview\b|\/api\/compaction|\/api\/transcripts|\/api\/terminal|\/api\/startup\//;

test("nothing the providers run or the pages load asks for transcripts or token-guarded routes", () => {
  const files = [...new Set(PROVIDER_DIRS.flatMap((d) => runtimeClosure(d).files)), ...APP_DIRS.flatMap((d) => appClosure(d).files)];
  const hits = [];
  for (const file of files) fs.readFileSync(file, "utf8").split("\n").forEach((line, i) => { if (GUARDED_ROUTES.test(line)) hits.push(`${path.relative(path.resolve(here, ".."), file)}:${i + 1}`); });
  assert.deepEqual(hits, []);
  assert.ok(GUARDED_ROUTES.test("/api/sessions/x/generation-record"), "the guarded-route pattern catches a planted call");
});

test("the pattern check does catch a planted path", () => {
  // Without this, a regular expression that never matches would keep the test
  // above green whatever the provider contained.
  const planted = ["const home = '/Users/someone/.config';", "fetch(url, { headers: { Authorization: x } })", "read('~/.codex/auth.json')", "read('~/.claude/.credentials.json')", "fetch(base + '/v1/messages')", "start the OAuth device_code flow"];
  for (const line of planted) assert.ok(PATTERNS.some((p) => p.re.test(line)), `no pattern caught: ${line}`);
});
