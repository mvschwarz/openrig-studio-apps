// One seat's drill-down: its current reading, its context trend, its generations and its own queue
// rows. The ways this could mislead: merging two machines' same-named seats, drawing points at the
// poll time, filling holes with zeros, smoothing over a restart, and passing off a partial
// generation history as the whole one. Stand-in daemons, invented data.
import test from "node:test";
import assert from "node:assert/strict";
import { readFleet, readSeat, findSeat } from "../providers/shared/fleet-reader.mjs";
import { createObservatoryServer } from "../providers/studio-observatory/observatory-server.mjs";
import { startFakeDaemon, seat, qitem } from "./observatory-fake-daemon.mjs";
import { loadPage } from "./observatory-page.mjs";

const NOW = Date.parse("2030-01-02T12:00:00.000Z");
const now = () => NOW;
const started = [];
async function daemon(opts) { const d = await startFakeDaemon(opts); started.push(d); return d; }
test.afterEach(async () => { await Promise.all(started.splice(0).map((d) => d.close())); });
const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&gt;/g, ">").replace(/\s+/g, " ");
const at = (minAgo) => new Date(NOW - minAgo * 60_000).toISOString();
const sample = (minAgo, usedPercentage, extra = {}) => ({ id: 1000 - minAgo, lane: "context", seatSession: "dev-impl@alpha", nodeId: "node-dev.impl", source: "claude_statusline_json", sampledAt: at(minAgo), capturedAt: at(minAgo - 0.5), usedPercentage, ...extra });

async function fleetAndSeat(opts, key = "box-a/alpha/dev.impl", extra = {}) {
  const a = await daemon({ selfHostId: "box-a", ...opts });
  const fleet = await readFleet({ daemonUrl: a.url, now, reads: ["seats", "queues"], ...extra.fleet });
  return { a, fleet, s: await readSeat({ fleet, key, now, ...extra.seat }) };
}

test("a seat key must name its machine; same-named seats on two machines stay apart", async () => {
  const same = { "rig-1": { name: "alpha", nodes: [seat("dev.impl")] } };
  const b = await daemon({ selfHostId: "box-b", rigs: { "rig-1": { name: "alpha", nodes: [seat("dev.impl", { nodeId: "node-on-b" })] } } });
  const a = await daemon({ selfHostId: "box-a", rigs: same, hosts: [{ id: "second", transport: "http", url: b.url }] });
  const fleet = await readFleet({ daemonUrl: a.url, now, reads: ["seats"] });
  assert.equal(findSeat(fleet, "alpha/dev.impl").code, "seat_host_unknown", "a bare rig/seat name is refused");
  assert.equal(findSeat(fleet, "box-a/alpha/dev.impl").seat.nodeId, "node-dev.impl");
  assert.equal(findSeat(fleet, "box-b/alpha/dev.impl").seat.nodeId, "node-on-b");
  const onB = await readSeat({ fleet, key: "box-b/alpha/dev.impl", now });
  assert.ok(b.calls.some((c) => c.path === "/api/telemetry/v1/nodes/node-on-b/tenures"), "B's seat is read on B");
  assert.ok(!a.calls.some((c) => c.path.includes("/tenures")), "and not on A");
  assert.equal(onB.host.hostId, "box-b");
});

test("trend points keep the daemon's sample and capture times, never the poll time", async () => {
  const { s } = await fleetAndSeat({ seriesRows: [sample(50, 20), sample(40, 25), sample(30, 31)] });
  assert.equal(s.trend.status, "ok");
  assert.deepEqual(s.trend.points.map((p) => p.sampledAt), [at(50), at(40), at(30)]);
  assert.equal(s.trend.points[0].capturedAt, at(49.5));
  assert.ok(s.trend.points.every((p) => p.sampledAt !== s.polledAt));
  assert.equal(s.trend.window.hours, 6);
});

test("a sample with no value stays a hole, never a zero", async () => {
  const page = await loadPage();
  const { s } = await fleetAndSeat({ seriesRows: [sample(50, 20), sample(40, null), sample(30, 31)] });
  const shaped = page.trendSegments(s.trend.points, page.trendBreaks(s));
  assert.equal(shaped.segments.length, 2, "the line stops at the hole and starts again after it");
  assert.ok(shaped.segments.flat().every((p) => p.usedPercentage !== 0 && p.usedPercentage !== null));
  const out = text(page.renderSeat(s, NOW));
  assert.match(out, /the sample has no value/);
  assert.doesNotMatch(out, /\b0%/);
  assert.match(out, /unknown/, "the hole's row reads unknown");
});

test("a daemon restart between samples breaks the line and says so", async () => {
  const page = await loadPage();
  const { s } = await fleetAndSeat({ seriesRows: [sample(50, 20), sample(45, 22), sample(40, 24), sample(35, 5), sample(30, 7)] });
  s.host.restart = { status: "restarted", method: "boot epoch", between: [at(39), at(37)] };
  const shaped = page.trendSegments(s.trend.points, page.trendBreaks(s));
  assert.equal(shaped.segments.length, 2);
  assert.match(shaped.breaks[0].why, /the daemon restarted/);
  assert.match(text(page.renderSeat(s, NOW)), /The line is broken 1 time: the daemon restarted \(between/);
});

test("a new generation breaks the line too", async () => {
  const page = await loadPage();
  const { s } = await fleetAndSeat({ seriesRows: [sample(200, 60), sample(190, 62), sample(170, 3), sample(160, 4)], tenureRows: [{ generationOrdinal: "2", generationUuid: "g2", kind: "handover", originalTimestamp: at(180) }] });
  const shaped = page.trendSegments(s.trend.points, page.trendBreaks(s));
  assert.equal(shaped.segments.length, 2);
  assert.match(shaped.breaks[0].why, /a new generation of the seat began \(handover\)/);
});

test("a long silence breaks the line, by a stated rule", async () => {
  const page = await loadPage();
  const pts = [sample(60, 10), sample(55, 11), sample(50, 12), sample(45, 13), sample(10, 14), sample(5, 15)].map((p) => ({ sampledAt: p.sampledAt, capturedAt: p.capturedAt, usedPercentage: p.usedPercentage }));
  const shaped = page.trendSegments(pts, []);
  assert.equal(shaped.segments.length, 2);
  assert.equal(shaped.breaks[0].why, "no samples for longer than twice the usual spacing");
});

test("generation history from an earlier boot's cursor reads 'unverified', never as complete", async () => {
  const page = await loadPage();
  const { s } = await fleetAndSeat({ routes: { tenures: () => [200, { schemaVersion: 1, stream: "tenures", observedAt: at(0), source: { bootEpoch: "boot-2" }, rows: [], page: { hasMore: false, nextCursor: null, restartCursor: null }, coverage: { status: "unavailable", historyCompleteness: "unknown", gaps: [{ code: "boot_boundary_history_unverified" }], gapCount: 1 } }] } }, "box-a/alpha/dev.impl", { seat: { tenureCursor: "old-boot-cursor" } });
  assert.equal(s.generations.status, "history-unverified");
  assert.equal(s.generations.rows, null);
  assert.deepEqual(s.generations.coverage.gaps, ["boot_boundary_history_unverified"]);
  const out = text(page.renderSeat(s, NOW));
  assert.match(out, /Generation history: history unverified across a daemon restart/);
  assert.doesNotMatch(out, /No generations reported/);
});

test("ordinary generation history shows its coverage and drops the native session id", async () => {
  const page = await loadPage();
  const { s } = await fleetAndSeat({});
  assert.equal(s.generations.status, "ok");
  assert.deepEqual(s.generations.rows.map((g) => g.ordinal), ["2", "1"]);
  assert.ok(!JSON.stringify(s.generations).includes("native-invented"));
  assert.match(text(page.renderSeat(s, NOW)), /Generations, newest first, from the daemon's bounded telemetry \(at most 20 per page\): coverage retained_window, completeness unknown/);
});

test("a daemon without the series route reads 'not available'; money never passes through", async () => {
  const page = await loadPage();
  const absent = await fleetAndSeat({ routes: { "/api/telemetry/usage/series": () => [404, { error: "not found" }] } });
  assert.equal(absent.s.trend.status, "absent");
  assert.match(text(page.renderSeat(absent.s, NOW)), /Context trend: not available ?\. this daemon's OpenRig version has no usage series route/);
  const priced = await fleetAndSeat({ seriesRows: [sample(10, 30, { clientCostEstimateUsd: 4.2, totalInputTokens: 1 })] });
  assert.ok(!JSON.stringify(priced.s).includes("4.2") && !JSON.stringify(priced.s).includes("clientCostEstimateUsd"));
});

test("a full trend page says the newest samples may be missing", async () => {
  const page = await loadPage();
  const { s } = await fleetAndSeat({ seriesRows: [sample(30, 1), sample(20, 2)] }, "box-a/alpha/dev.impl", { seat: { trendLimit: 2 } });
  assert.equal(s.trend.coverage.possiblyTruncated, true);
  assert.match(text(page.renderSeat(s, NOW)), /the list is full and oldest first, so the newest samples may be missing/);
});

test("the seat's queue rows come from the bounded list, labelled as such", async () => {
  const page = await loadPage();
  const { s } = await fleetAndSeat({ queue: [qitem(1, { destinationSession: "dev-impl@alpha" }), qitem(2, { sourceSession: "x@y", destinationSession: "other@alpha" })] });
  assert.deepEqual(s.queue.rows.map((r) => r.id), ["q-1"]);
  assert.match(text(page.renderSeat(s, NOW)), /rows to or from this seat within the machine's filtered, bounded queue list; not all of this seat's work: 1 row/);
  assert.match(text(page.renderSeat(s, NOW)), /Not connected here: transcript, generation record \(needs a token\), compaction/);
});

test("the seat verb reads one seat per call, shares the fleet read, and keeps its own short cache", async () => {
  const a = await daemon({ selfHostId: "box-a" });
  let clock = NOW;
  const server = createObservatoryServer({ daemon: a.url, ttlMs: 15_000, now: () => clock });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const tenureCalls = () => a.calls.filter((c) => c.path.includes("/tenures")).length;
  try {
    assert.equal((await fetch(`${base}/api/observatory/seat`)).status, 400, "a key is required");
    assert.equal((await fetch(`${base}/api/observatory/seat?key=alpha/dev.impl`)).status, 404, "a bare name is refused");
    const first = await (await fetch(`${base}/api/observatory/seat?key=${encodeURIComponent("box-a/alpha/dev.impl")}`)).json();
    assert.equal(first.status, "ok");
    await fetch(`${base}/api/observatory/hosts`);
    assert.equal(a.calls.filter((c) => c.path === "/healthz").length, 1, "the seat and the fleet verbs share one fleet read");
    clock += 5_000;
    const again = await (await fetch(`${base}/api/observatory/seat?key=${encodeURIComponent("box-a/alpha/dev.impl")}`)).json();
    assert.equal(again.served.fromCache, true);
    assert.equal(tenureCalls(), 1);
    clock += 6_000;
    await fetch(`${base}/api/observatory/seat?key=${encodeURIComponent("box-a/alpha/dev.impl")}`);
    assert.equal(tenureCalls(), 2, "after its own keep time the seat is read again");
  } finally {
    await new Promise((r) => { server.closeAllConnections?.(); server.close(r); });
  }
});

test("a kept seat never outlives its machine's status in the fleet read", async () => {
  const b = await daemon({ selfHostId: "box-b" });
  const a = await daemon({ selfHostId: "box-a", hosts: [{ id: "second", transport: "http", url: b.url }] });
  let clock = NOW;
  // The fleet read is kept 2 s and the seat read 10 s: the seat must still follow the fleet.
  const server = createObservatoryServer({ daemon: a.url, ttlMs: 2_000, now: () => clock });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const key = encodeURIComponent("box-b/alpha/dev.impl");
  try {
    assert.equal((await (await fetch(`${base}/api/observatory/seat?key=${key}`)).json()).status, "ok");
    await b.close(); started.splice(started.indexOf(b), 1);
    clock += 3_000; // past the fleet keep time, well inside the seat keep time
    // The first answer after the keep time comes from the kept read, and says it is stale...
    const first = await (await fetch(`${base}/api/observatory/seat?key=${key}`)).json();
    assert.equal(first.fleetServed.stale, true);
    await server.fleet.pending();
    // ...and once the refresh lands, the stopped machine's seat is not served from the older read.
    const body = await (await fetch(`${base}/api/observatory/seat?key=${key}`)).json();
    assert.notEqual(body.status, "ok", "a stopped machine's seat is not served from an older read");
    assert.equal(body.status, "seat_host_not_read");
    assert.match(body.error, /seats on the machine last seen as box-b were not read: unreachable/);
  } finally {
    await new Promise((r) => { server.closeAllConnections?.(); server.close(r); });
  }
});

test("a generation start stored as SQLite UTC text is read as UTC, not local time", async () => {
  const { s } = await fleetAndSeat({ tenureRows: [{ generationOrdinal: "1", generationUuid: "g1", kind: "initial", originalTimestamp: "2030-01-02 09:00:00" }] });
  assert.equal(s.generations.rows[0].startedAt, "2030-01-02T09:00:00Z");
  assert.equal(s.generations.rows[0].startedAtAsStored, "2030-01-02 09:00:00");
  assert.equal(Date.parse(s.generations.rows[0].startedAt), Date.UTC(2030, 0, 2, 9, 0, 0));
});

// --- older generations --------------------------------------------------------------------------

const gen = (ordinal) => ({ ordinal: String(ordinal), kind: ordinal === 1 ? "initial" : "fresh", generation: `g${ordinal}`, startedAt: at(1000 - ordinal) });
const genPage = (ordinals, { hasMore = false, nextCursor = null, status = "ok" } = {}) => ({ status, rows: status === "ok" ? ordinals.map(gen) : null, coverage: { status: status === "ok" ? "retained_window" : "unavailable", historyCompleteness: "unknown", gaps: [], gapCount: 0, hasMore, nextCursor } });

test("the older-generations control appears only when the daemon says older ones exist", async () => {
  const page = await loadPage();
  const { s } = await fleetAndSeat({});
  s.generations = genPage([3, 2]);
  assert.doesNotMatch(page.renderSeat(s, NOW), /Load older generations/);
  s.generations = genPage([3, 2], { hasMore: true, nextCursor: "cur-older" });
  const html = page.renderSeat(s, NOW);
  assert.match(html, /data-older-cursor="cur-older"/);
  assert.match(text(html), /older generations exist/);
});

test("an older page adds only rows not already shown, newest first, and carries the next cursor", async () => {
  const page = await loadPage();
  const merged = page.mergeGenerationPages(genPage([5, 4, 3], { hasMore: true, nextCursor: "c1" }), [genPage([3, 2, 1], { hasMore: false })]);
  assert.deepEqual(merged.rows.map((r) => r.ordinal), ["5", "4", "3", "2", "1"]);
  assert.equal(merged.pages, 2);
  assert.equal(merged.hasMore, false);
  assert.equal(merged.nextCursor, null);
});

test("an older page that comes back unverified stops the history and is never shown as more of it", async () => {
  const page = await loadPage();
  const { s } = await fleetAndSeat({});
  s.generations = genPage([5, 4], { hasMore: true, nextCursor: "c1" });
  const older = [genPage([], { status: "history-unverified" })];
  const merged = page.mergeGenerationPages(s.generations, older);
  assert.equal(merged.unverified, true);
  assert.deepEqual(merged.rows.map((r) => r.ordinal), ["5", "4"]);
  const out = text(page.renderSeat(s, NOW, older));
  assert.match(out, /Older generations: history unverified across a daemon restart/);
  assert.doesNotMatch(out, /Load older generations/);
});

test("the seat verb passes the route's own cursor through to the daemon", async () => {
  const a = await daemon({ selfHostId: "box-a" });
  const server = createObservatoryServer({ daemon: a.url, ttlMs: 15_000, now: () => NOW });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const key = encodeURIComponent("box-a/alpha/dev.impl");
    await fetch(`http://127.0.0.1:${server.address().port}/api/observatory/seat?key=${key}&cursor=cur-older`);
    assert.ok(a.calls.some((c) => c.path.endsWith("/tenures") && /cursor=cur-older/.test(c.query)));
  } finally {
    await new Promise((r) => { server.closeAllConnections?.(); server.close(r); });
  }
});

test("a seat's detail that answers after the person moved to another seat is dropped, errors and older pages included", async () => {
  const page = await loadPage();
  const a = await daemon({ selfHostId: "box-a" });
  const fleet = await readFleet({ daemonUrl: a.url, now, reads: ["seats"] });
  const impl = await readSeat({ fleet, key: "box-a/alpha/dev.impl", now });
  const qa = await readSeat({ fleet, key: "box-a/alpha/dev.qa", now });
  const pending = new Map(); // url -> { resolve, reject }
  const fetchJson = (url) => new Promise((resolve, reject) => pending.set(url, { resolve, reject }));
  const shown = [];
  const loader = page.makeSeatLoader({ fetchJson, show: (html) => shown.push(text(html)), now });
  const seatUrl = (key) => `/api/observatory/seat?key=${encodeURIComponent(key)}`;
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  // Ask for dev.impl, move to dev.qa before it answers: only dev.qa's detail is shown.
  const first = loader.open("box-a/alpha/dev.impl");
  const second = loader.open("box-a/alpha/dev.qa");
  pending.get(seatUrl("box-a/alpha/dev.qa")).resolve(qa);
  await second;
  pending.get(seatUrl("box-a/alpha/dev.impl")).resolve(impl);
  await first;
  assert.equal(shown.length, 1);
  assert.match(shown[0], /dev\.qa/);
  assert.doesNotMatch(shown[0], /dev\.impl/);

  // An older page asked for dev.qa that answers after moving to dev.impl isn't appended under dev.impl; nor is a late error.
  const older = loader.older("c-1");
  await settle();
  const third = loader.open("box-a/alpha/dev.impl");
  pending.get(seatUrl("box-a/alpha/dev.impl")).resolve(impl);
  await third;
  pending.get(`${seatUrl("box-a/alpha/dev.qa")}&cursor=c-1`).resolve({ generations: { status: "ok", rows: [] } });
  await older;
  const late = loader.open("box-a/alpha/dev.qa");
  loader.open(null); // closed the detail
  pending.get(seatUrl("box-a/alpha/dev.qa")).reject(new Error("timed out"));
  await late;
  assert.equal(shown.length, 3); // dev.qa, dev.impl, then cleared
  assert.match(shown[1], /dev\.impl/);
  assert.equal(shown[2], "");
});
