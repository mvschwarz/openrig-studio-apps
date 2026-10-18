// The Fleet page: a small, read-only view of the person's machines, rigs and accounts, needing no other
// app. These pin the ways it could mislead (an unreachable machine shown as fine, a reading's age taken
// from the poll, usage that's off shown as room, a configured account shown as the one in use, a shared
// allowance added up), its independence from the Observatory, and the provider's cached-reading rule.
// Stand-in daemons on loopback with invented data.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFleet } from "../providers/shared/fleet-reader.mjs";
import { createFleetCache } from "../providers/shared/reader-server.mjs";
import { createFleetViewServer, FLEET_READS, FLEET_ROUTE, READY_ROUTE } from "../providers/studio-fleet-view/fleet-view-server.mjs";
import { check, LABELS } from "../providers/studio-fleet-view/healthcheck.mjs";
import { runtimeClosure, appClosure } from "./observatory-closure.test.mjs";
import { startFakeDaemon, closedPortUrl, seat } from "./observatory-fake-daemon.mjs";
import { loadPage } from "./observatory-page.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const pagePath = path.join(root, "apps/fleet/app/fleet.html");
const NOW = Date.parse("2030-01-02T12:00:00.000Z");
const now = () => NOW;
const started = [];
async function daemon(opts) { const d = await startFakeDaemon(opts); started.push(d); return d; }
test.afterEach(async () => { await Promise.all(started.splice(0).map((d) => d.close())); });
const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/\s+/g, " ");
const read = (url) => readFleet({ daemonUrl: url, reads: [...FLEET_READS], now });
const fleetPage = () => loadPage(pagePath);
const render = async (fleet) => { const p = await fleetPage(); const o = p.renderPage(fleet, NOW); return { ...o, all: text(o.meta + " " + o.body) }; };

const usage = (observations, extra = {}) => ({ items: [{ provider: "codex", key: "acct-1", linkage: "same", notes: [], observations }], hosts: [], skipped: [], registry: { state: "read" }, seatAccounts: [], asOf: "2030-01-02T11:59:50.000Z", ...extra });
const obs = (hostId, usedPercent, level = "ok", resetsAt = "2030-01-05T00:00:00.000Z") => ({ hostId, readAt: "2030-01-02T11:59:00.000Z", row: { identity: { planType: "team" }, observedAt: "2030-01-02T11:30:00.000Z", currentAvailability: "known", windows: [{ window: "weekly", usedPercent, resetsAt, observedAt: "2030-01-02T11:30:00.000Z", freshness: "fresh", level }] } });

// --- independence and boundaries -----------------------------------------------------------------

test("the page asks only for Fleet's own route, which the app declares and the Fleet provider serves", () => {
  const html = fs.readFileSync(pagePath, "utf8");
  const app = JSON.parse(fs.readFileSync(path.join(root, "apps/fleet/app.json"), "utf8"));
  const provider = JSON.parse(fs.readFileSync(path.join(root, "providers/studio-fleet-view/provider.json"), "utf8"));
  const asked = [...new Set([...html.matchAll(/['"`](\/api\/[^'"`?$]+)['"`?]/g)].map((m) => m[1]))].sort();
  assert.deepEqual(asked, ["/api/fleet-view/fleet"]);
  assert.deepEqual(Object.keys(app.calls), asked);
  assert.equal(app.provider.package, "@openrig/studio-fleet-view");
  assert.equal(provider.package, app.provider.package);
  assert.deepEqual(provider.verbs, [FLEET_ROUTE, READY_ROUTE]);
  assert.equal(app.id, "fleet");
  assert.equal(app.surface.path, "/surfaces/fleet.html");
});

test("Fleet depends on nothing of the Observatory's: no Observatory route, file or provider in what it runs or loads", () => {
  const provider = JSON.parse(fs.readFileSync(path.join(root, "providers/studio-fleet-view/provider.json"), "utf8"));
  assert.ok(provider.verbs.every((v) => !v.includes("observatory")));
  const { files, problems } = runtimeClosure(path.join(root, "providers/studio-fleet-view"));
  assert.deepEqual(problems, []);
  assert.ok(files.every((f) => !f.includes(`${path.sep}studio-observatory${path.sep}`)), "no Observatory provider file in Fleet's closure");
  const app = appClosure(path.join(root, "apps/fleet"));
  assert.deepEqual(app.problems, []);
  assert.deepEqual(app.files.map((f) => path.relative(path.join(root, "apps/fleet"), f)).sort(), ["app.json", path.join("app", "fleet.html")]);
  // The page links to the Observatory for history; it does not call it.
  assert.doesNotMatch(fs.readFileSync(pagePath, "utf8"), /fetch\([^)]*observatory/);
});

test("nothing Fleet runs or loads reads a credential, asks for a sign-in, or makes a model request", () => {
  const files = [...runtimeClosure(path.join(root, "providers/studio-fleet-view")).files, ...appClosure(path.join(root, "apps/fleet")).files];
  const bad = /credentials\.json|\bauth\.json|\/v1\/messages|api\.anthropic\.com|api\.openai\.com|\boauth\b|authorization|\bbearer\b|access_?token/i;
  const hits = [];
  for (const f of files) fs.readFileSync(f, "utf8").split("\n").forEach((l, i) => { if (bad.test(l)) hits.push(`${path.relative(root, f)}:${i + 1}`); });
  assert.deepEqual(hits, []);
  assert.ok(bad.test("fetch('https://api.anthropic.com/v1/messages')") && bad.test("read ~/.claude/.credentials.json"), "the pattern catches a planted request or credential read");
});

// --- what the page says --------------------------------------------------------------------------

test("an unreachable machine is named as not reporting, never shown as fine or empty", async () => {
  const gone = await closedPortUrl();
  const a = await daemon({ selfHostId: "box-a", hosts: [{ id: "gone", transport: "http", url: gone }] });
  const { all } = await render(await read(a.url));
  assert.match(all, /1 of 2 report here/);
  assert.match(all, /Not reporting here: gone \(unreachable\)\./);
  assert.doesNotMatch(all, /gone live/);
});

test("a seat's 'since' is when its machine sampled it, not when the page asked", async () => {
  const a = await daemon({ selfHostId: "box-a", rigs: { "rig-1": { name: "alpha", nodes: [seat("dev.impl", { agentActivity: { state: "idle", reason: "no turn", evidenceSource: "pane_heuristic", sampledAt: new Date(NOW - 3 * 3600_000).toISOString() } })] } } });
  const { all } = await render(await read(a.url));
  assert.match(all, /dev\.impl idle since 3 h ago/);
  assert.doesNotMatch(all, /since 0 s ago/);
});

test("usage that is off reads 'not connected', never zero or room", async () => {
  const a = await daemon({ selfHostId: "box-a" });
  const { all } = await render(await read(a.url));
  assert.match(all, /Capacity Usage: not connected Usage readings are turned off on this machine\./);
  assert.doesNotMatch(all, /\b0%|has room|No account is low or out/);
});

test("a shared allowance appears once, with its machines, and is never added up", async () => {
  const b = await daemon({ selfHostId: "box-b" });
  const a = await daemon({ selfHostId: "box-a", hosts: [{ id: "second", transport: "http", url: b.url }], usageHosts: usage([obs("local", 40), obs("second", 40)]) });
  const { all } = await render(await read(a.url));
  assert.equal(all.match(/codex acct-1/g)?.length, 1, "one row for one account");
  assert.match(all, /box-a: weekly 40% used .* · box-b: weekly 40% used/);
  assert.doesNotMatch(all, /80%/);
});

test("accounts are sorted out, then low, then the rest; ones without a reading fold into one named line", async () => {
  const items = [
    { provider: "codex", key: "ok-acct", linkage: "single", notes: [], observations: [obs("local", 10, "ok")] },
    { provider: "claude", key: "out-acct", linkage: "single", notes: [], observations: [obs("local", 100, "exhausted", "2030-01-03T00:00:00.000Z")] },
    { provider: "codex", key: "low-acct", linkage: "single", notes: [], observations: [obs("local", 85, "nearing")] },
    { provider: "codex", key: "blind-acct", linkage: "unknown", notes: [], observations: [{ hostId: "local", readAt: "2030-01-02T11:59:00.000Z", row: { windows: [] } }] },
  ];
  const a = await daemon({ selfHostId: "box-a", usageHosts: { ...usage([]), items } });
  const { all } = await render(await read(a.url));
  const order = ["claude out-acct", "codex low-acct", "codex ok-acct"].map((k) => all.indexOf(k));
  assert.ok(order.every((i, n) => i > 0 && (n === 0 || i > order[n - 1])), `order ${order}`);
  assert.match(all, /Capacity 1 out · 1 low claude out-acct: out, resets in 12 h 2 with no reading/);
  // A configured account (the fixture's seat link) with no usage reading folds into the same line.
  assert.match(all, /No reading yet: codex blind-acct, team plan A\./);
});

test("planned, default login and seen-using stay three separate columns; a configured account is never shown as the one in use", async () => {
  const a = await daemon({
    selfHostId: "box-a",
    usageHosts: usage([obs("local", 10)], { seatAccounts: [{ hostId: "local", seats: [{ seatSession: "dev-impl@alpha", rigName: "alpha", configured: { source: "registry", profileRef: "team-a" }, observed: { lastSampledAt: "2030-01-02T11:00:00.000Z", differsFrom: true } }, { seatSession: "dev-qa@alpha", rigName: "alpha", configured: { source: "default_login" } }] }] }),
  });
  const p = await fleetPage();
  const fleet = await read(a.url);
  const rows = p.seatAccountsRows(fleet);
  const impl = rows.find((r) => r.seat === "dev-impl@alpha");
  assert.equal(impl.planned, "team plan A");
  assert.equal(impl.seen, "a different account");
  assert.equal(rows.find((r) => r.seat === "dev-qa@alpha").login, "default login");
  const { all } = await render(fleet);
  assert.match(all, /Seat Planned Default login Seen using/);
  assert.doesNotMatch(all, /current account|currently using/i);
});

test("a column with no values is cut", async () => {
  const a = await daemon({ selfHostId: "box-a" });
  const { all } = await render(await read(a.url));
  assert.match(all, /Seat Planned dev-impl@alpha/);
  assert.doesNotMatch(all, /Default login|Seen using/);
});

test("the honesty rule is stated once, rows show '—' in grey, and a stale reading says so", async () => {
  const html = fs.readFileSync(pagePath, "utf8");
  assert.equal(html.match(/— means not reported here yet\. Old readings show their time\. An account shared by machines is counted once\./g)?.length, 1);
  const a = await daemon({ selfHostId: "box-a", rigs: { "rig-1": { name: "alpha", nodes: [seat("dev.impl", { agentActivity: undefined, assignedWorkCount: 0, inProgressWorkCount: 0, blockedWorkCount: 0 })] } } });
  const fleet = await read(a.url);
  const { body, meta } = await render({ ...fleet, served: { polledAt: "2030-01-02T11:55:00.000Z", stale: true, refreshing: true } });
  assert.match(body, /<span class="none">—<\/span>/);
  assert.doesNotMatch(text(body), /not declared|not reported(?! here:)/);
  assert.match(meta, /Showing the last good reading, from 5 min ago; a fresh one is on its way\./);
});

test("rigs: running first by what needs the operator, a state bar with words, the rest folded", async () => {
  const a = await daemon({ selfHostId: "box-a", rigs: {
    "rig-1": { name: "calm", nodes: [seat("a.one")] },
    "rig-2": { name: "busy", nodes: [seat("b.one", { agentActivity: { state: "needs_input", reason: "x", sampledAt: "2030-01-02T11:59:00.000Z" } }), seat("b.two", { blockedWorkCount: 1 })] },
    "rig-3": { name: "parked", status: "stopped", nodes: [] },
  } });
  const { body, all } = await render(await read(a.url));
  assert.ok(all.indexOf("busy box-a") < all.indexOf("calm box-a"));
  assert.match(all, /busy box-a · 2 seats 1 waiting · 1 blocked/);
  assert.match(body, /<div class="bar"><span class="low" style="width:50\.0%"><\/span><span class="out" style="width:50\.0%"><\/span><\/div>/);
  assert.match(all, /Not running: parked \(box-a\)\./);
});

test("the layout fits 390 px wide: no fixed width wider than the screen, cards that wrap", () => {
  const css = fs.readFileSync(pagePath, "utf8").match(/<style>([\s\S]*?)<\/style>/)[1];
  for (const m of css.matchAll(/(min-width|width)\s*:\s*(\d+)px/g)) assert.ok(Number(m[2]) <= 358, `${m[0]} is wider than a 390 px screen with its margins`);
  assert.match(css, /grid-template-columns: repeat\(auto-fit, minmax\(240px, 1fr\)\)/);
  assert.match(css, /overflow-wrap: anywhere/);
});

// --- the provider ---------------------------------------------------------------------------------

test("once a reading exists, a request never waits for the fan-out: the kept read is served, labelled stale, and refreshed outside", async () => {
  let reads = 0, release;
  const gate = new Promise((r) => { release = r; });
  const readFn = async () => { reads++; if (reads > 1) await gate; return { polledAt: `t${reads}`, hosts: [{ key: "box-a", status: "ok" }] }; };
  let clock = 0;
  const get = createFleetCache({ daemon: "http://x", read: readFn, ttlMs: 15_000, now: () => clock });
  await get(); // the first reading
  clock = 20_000; // past the keep time; the next read will hang until released
  const answered = await Promise.race([get(), new Promise((r) => setTimeout(() => r("waited"), 300))]);
  assert.notEqual(answered, "waited", "the request did not wait for the refresh");
  assert.equal(answered.served.stale, true);
  assert.equal(answered.served.refreshing, true);
  assert.equal(answered.polledAt, "t1");
  assert.equal(reads, 2, "one refresh started");
  await get(); // still refreshing: no second refresh
  assert.equal(reads, 2);
  release();
  await get.pending();
  clock = 21_000;
  assert.equal((await get()).polledAt, "t2", "the refreshed reading is served next");
});

test("nothing is read when nobody asks: no timer polls", async () => {
  let reads = 0;
  const get = createFleetCache({ daemon: "http://x", read: async () => { reads++; return { polledAt: "t", hosts: [{ key: "a", status: "ok" }] }; }, ttlMs: 50, now: Date.now });
  await get();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(reads, 1);
});

test("Fleet's ready route makes no daemon call, and its healthcheck passes only on Fleet's provider", async () => {
  const a = await daemon({ selfHostId: "box-a" });
  const server = createFleetViewServer({ daemon: a.url });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const body = await (await fetch(base + READY_ROUTE)).json();
    assert.equal(body.ready, true);
    assert.equal(body.provider, "@openrig/studio-fleet-view");
    assert.equal(a.calls.length, 0);
    assert.equal((await fetch(`${base}/api/observatory/hosts`)).status, 404, "no Observatory route in Fleet's provider");
    const fleet = await (await fetch(base + FLEET_ROUTE)).json();
    assert.ok(fleet.hosts[0].reads.seats && fleet.hosts[0].reads.subscriptions === undefined && fleet.subscriptions, "Fleet reads seats, health, links and usage");
    assert.equal(fleet.hosts[0].reads.ceremony, undefined, "no ceremony reading");
    // The healthcheck asks the ready route through the studio's port; here the provider stands in for it.
    const r = await check({ base: a.url });
    assert.equal(r.healthy, false, "something that is not Fleet's provider is not a pass");
    const ok = await check({ base, readyPath: READY_ROUTE });
    assert.deepEqual(ok, { healthy: true, label: LABELS.ready });
  } finally {
    await new Promise((r) => { server.closeAllConnections?.(); server.close(r); });
  }
});
