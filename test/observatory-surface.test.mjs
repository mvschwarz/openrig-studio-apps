// The Observatory page is only worth opening if it never makes a machine look better, fresher
// or bigger than its reading. These tests render the page's own functions over the fleet
// reader's real output (from stand-in daemons with invented data) and over hand-built
// failure cases, and pin the ways a page could quietly mislead.
//
// The page is one self-contained HTML file, because the studio serves only the declared entry.
// Its render functions are exports of the page's single module script, which is imported here
// directly; the browser boot at its end does not run outside a page.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFleet } from "../providers/shared/fleet-reader.mjs";
import { startFakeDaemon, closedPortUrl, seat, qitem } from "./observatory-fake-daemon.mjs";
import { loadPage, pagePath } from "./observatory-page.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

const NOW = Date.parse("2030-01-02T12:00:00.000Z");
const now = () => NOW;
const started = [];
async function daemon(opts) { const d = await startFakeDaemon(opts); started.push(d); return d; }
test.afterEach(async () => { await Promise.all(started.splice(0).map((d) => d.close())); });
const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ");

async function twoMachinesOneGone(extra = {}) {
  const gone = await closedPortUrl();
  const a = await daemon({ selfHostId: "box-a", hosts: [{ id: "gone", transport: "http", url: gone }], ...extra });
  return readFleet({ daemonUrl: a.url, now, reads: ["seats", "queues", "health"] });
}

test("an unreachable machine shows its status and reason in every panel, never as empty or healthy", async () => {
  const page = await loadPage();
  const fleet = await twoMachinesOneGone();
  const out = text(page.renderPage({ hosts: fleet, seats: fleet, queues: fleet, health: fleet }, NOW));
  const goneLines = out.split("This is a failure to read").length - 1;
  assert.equal(goneLines, 3, "seats, queue and health each say the machine was not read");
  assert.match(out, /identity not reported : seats not read: unreachable · ECONNREFUSED/);
  assert.match(out, /1 of 2 machines read/);
  assert.match(out, /this view is incomplete/);
  assert.doesNotMatch(out, /identity not reported : read, and it reports no rigs/);
  assert.doesNotMatch(out, /No rows matched this filter on identity not reported/);
  assert.doesNotMatch(out, /No active findings among those evaluated\. [^]*identity not reported/);
});

test("a machine that wants a token, or is ssh-only, says so in words", async () => {
  const page = await loadPage();
  const a = await daemon({ selfHostId: "box-a", hosts: [{ id: "shell", hostId: "box-s", transport: "ssh", target: "box-s.example" }], routes: { "/api/queue/list": () => [401, { error: "unauthorized" }] } });
  const fleet = await readFleet({ daemonUrl: a.url, now, reads: ["queues"] });
  const out = text(page.renderQueues(fleet, NOW));
  assert.match(out, /box-a : queue not read: needs a token \(not read\) · HTTP 401/);
  assert.match(out, /box-s : queue not read: not readable over HTTP/);
});

test("a reading's age is measured from when the source sampled it, not from the poll", async () => {
  const page = await loadPage();
  const threeHoursBefore = new Date(NOW - 3 * 3600 * 1000).toISOString();
  const a = await daemon({ selfHostId: "box-a", rigs: { "rig-1": { name: "alpha", nodes: [seat("dev.impl", { agentActivity: { state: "idle", reason: "no turn", evidenceSource: "pane_heuristic", sampledAt: threeHoursBefore, evidence: null, stale: true } })] } } });
  const fleet = await readFleet({ daemonUrl: a.url, now, reads: ["seats"] });
  assert.equal(fleet.hosts[0].reads.seats.polledAt, new Date(NOW).toISOString(), "the poll itself is fresh");
  const out = text(page.renderSeats(fleet, NOW));
  assert.match(out, /alpha\/dev\.impl on box-a idle no turn pane_heuristic 3 h ago stale \(the source says\)/);
  assert.doesNotMatch(out, /just now|0 s ago/);
});

test("ages cover the ranges people read, and a missing time is not invented", async () => {
  const page = await loadPage();
  const ago = (s) => text(page.ageText(new Date(NOW - s * 1000).toISOString(), NOW)).trim();
  assert.equal(ago(5), "5 s ago");
  assert.equal(ago(600), "10 min ago");
  assert.equal(ago(7200), "2 h ago");
  assert.equal(ago(3 * 86400), "3 d ago");
  assert.equal(text(page.ageText(null, NOW)).trim(), "time not reported");
  assert.equal(text(page.ageText("not a date", NOW)).trim(), "time not reported");
});

test("health summaries say their time is not reported instead of borrowing the poll time", async () => {
  const page = await loadPage();
  const a = await daemon({ selfHostId: "box-a" });
  const fleet = await readFleet({ daemonUrl: a.url, now, reads: ["health"] });
  const out = text(page.renderHealth(fleet, NOW));
  assert.match(out, /Seats 2 seats · running 2 · 0 need attention time not reported/);
  assert.match(out, /Gateway inactive time not reported/);
  assert.match(out, /Findings evaluated 36 h ago · showing 1 of 1/);
});

test("truncated findings and partly evaluated sources are labelled", async () => {
  const page = await loadPage();
  const a = await daemon({
    selfHostId: "box-a",
    routes: { "/api/health": () => [200, { evaluatedAt: "2030-01-02T11:59:00.000Z", total: 340, limit: 200, truncated: true, records: [{ id: "f1", detector: "process.review-carousel", severity: "warning", status: "active", summary: "invented", lastObservedAt: "2030-01-02T11:00:00.000Z" }], coverage: [{ source: "coordination-lineage", status: "unavailable", partial: true, reason: "x", evaluatedAt: null }] }] },
  });
  const fleet = await readFleet({ daemonUrl: a.url, now, reads: ["health"] });
  const out = text(page.renderHealth(fleet, NOW));
  assert.match(out, /showing 1 of 340 \(truncated\)/);
  assert.match(out, /sources not fully evaluated: coordination-lineage/);
});

test("a 503 on health reads as not read, never as a clean bill of health", async () => {
  const page = await loadPage();
  const down = () => [503, { error: "health_projection_unavailable" }];
  const a = await daemon({ selfHostId: "box-a", routes: { "/api/health": down, "/api/health-summary/nodes": down } });
  const fleet = await readFleet({ daemonUrl: a.url, now, reads: ["health"] });
  const out = text(page.renderHealth(fleet, NOW));
  assert.match(out, /Findings not read: error · health_projection_unavailable · HTTP 503\. This is a failure to read, not a clean bill of health/);
  assert.match(out, /Seats error · health_summary_unavailable · HTTP 503|Seats error · health_projection_unavailable · HTTP 503/);
  assert.doesNotMatch(out, /No active findings/);
});

test("a queue list is labelled filtered and bounded, never a total, and a full page says more may exist", async () => {
  const page = await loadPage();
  const a = await daemon({ selfHostId: "box-a", queue: [qitem(1), qitem(2), qitem(3, { state: "blocked", blockedOn: "external:vendor" })] });
  const full = await readFleet({ daemonUrl: a.url, now, reads: ["queues"], queueLimit: 3 });
  const out = text(page.renderQueues(full, NOW));
  assert.match(out, /box-a : filtered and bounded; not a total\. States pending, in-progress, blocked, at most 3 rows, 3 returned\. The page is full, so more rows may exist\./);
  assert.doesNotMatch(out, /\btotal\b(?!\.)/i, "the word total appears only in 'not a total'");
  assert.match(out, /q-3 item 3 blocked on external:vendor/);

  const roomy = await readFleet({ daemonUrl: a.url, now, reads: ["queues"], queueLimit: 50 });
  assert.doesNotMatch(text(page.renderQueues(roomy, NOW)), /more rows may exist/);
});

test("unknown values read as unknown, and activity is not called productivity", async () => {
  const page = await loadPage();
  const a = await daemon({ selfHostId: "box-a", rigs: { "rig-1": { name: "alpha", nodes: [seat("dev.impl", { agentActivity: undefined, contextUsage: { availability: "unknown" }, assignedWorkCount: undefined, inProgressWorkCount: undefined, blockedWorkCount: undefined })] } } });
  const fleet = await readFleet({ daemonUrl: a.url, now, reads: ["seats"] });
  const out = text(page.renderSeats(fleet, NOW));
  assert.match(out, /alpha\/dev\.impl on box-a unknown the daemon reported no activity sample method not reported time not reported unknown unknown \/ unknown \/ unknown/);
  assert.match(out, /It is not a measure of productivity\./);
  assert.doesNotMatch(out, /productivity:/i);
});

test("two machines with the same rig and seat names are told apart by machine", async () => {
  const page = await loadPage();
  const same = { "rig-1": { name: "alpha", nodes: [seat("dev.impl")] } };
  const b = await daemon({ selfHostId: "box-b", rigs: same });
  const a = await daemon({ selfHostId: "box-a", rigs: same, hosts: [{ id: "second", transport: "http", url: b.url }] });
  const fleet = await readFleet({ daemonUrl: a.url, now, reads: ["seats"] });
  const out = text(page.renderSeats(fleet, NOW));
  assert.match(out, /alpha\/dev\.impl on box-a/);
  assert.match(out, /alpha\/dev\.impl on box-b/);
});

test("text from a daemon is escaped, never interpreted as markup", async () => {
  const page = await loadPage();
  const a = await daemon({ selfHostId: "box-a", rigs: { "rig-1": { name: "<img src=x onerror=alert(1)>", nodes: [seat("dev.impl")] } } });
  const fleet = await readFleet({ daemonUrl: a.url, now, reads: ["seats"] });
  const html = page.renderSeats(fleet, NOW);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test("later panels say they are not set up yet rather than showing estimates", async () => {
  const page = await loadPage();
  assert.match(text(page.renderLater()), /Productivity has no agreed definition yet, so only activity is shown\. The oversight team's readings are not connected\. Nothing here estimates them\. Move history is shown in the Fleet page when installed\./);
});

test("subscription moves are never called not connected or not set up: the Fleet page shows them", () => {
  const html = fs.readFileSync(pagePath, "utf8");
  assert.doesNotMatch(html, /moves[^.<]*not (connected|set up)/i);
});

test("the page asks only for verbs the app declares and the provider serves", async () => {
  const html = fs.readFileSync(pagePath, "utf8");
  const app = JSON.parse(fs.readFileSync(path.resolve(here, "../apps/observatory/app.json"), "utf8"));
  const provider = JSON.parse(fs.readFileSync(path.resolve(here, "../providers/studio-observatory/provider.json"), "utf8"));
  const asked = [...new Set([...html.matchAll(/['"`](\/api\/[^'"`?$]+)['"`?]/g)].map((m) => m[1]))].sort();
  assert.deepEqual(asked, Object.keys(app.calls).sort());
  for (const v of asked) assert.ok(provider.verbs.includes(v), `${v} is not a verb the provider serves`);
  assert.equal(app.provider.package, provider.package);
  assert.doesNotMatch(html, /method:\s*['"](POST|PUT|PATCH|DELETE)/i, "the page never writes");
});
