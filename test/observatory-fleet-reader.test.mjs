// The fleet reader is only useful if it is believable about which machine a reading came from,
// when it was measured, and what it could not see. Each test below pins one way it could be
// wrong while still producing plausible-looking output.
//
// All daemons here are stand-ins on loopback ports with invented data.
import test from "node:test";
import assert from "node:assert/strict";
import { readFleet } from "../providers/shared/fleet-reader.mjs";
import { createObservatoryServer } from "../providers/studio-observatory/observatory-server.mjs";
import { startFakeDaemon, closedPortUrl, seat, qitem } from "./observatory-fake-daemon.mjs";

const NOW = Date.parse("2030-01-02T12:00:00.000Z");
const now = () => NOW;
const started = [];
async function daemon(opts) { const d = await startFakeDaemon(opts); started.push(d); return d; }
test.afterEach(async () => { await Promise.all(started.splice(0).map((d) => d.close())); });

const host = (fleet, key) => fleet.hosts.find((h) => h.key === key);

test("an empty host list still reads the configured daemon, under its own identity", async () => {
  // GET /api/hosts lists the OTHER machines. An empty list must not mean an empty fleet.
  const a = await daemon({ selfHostId: "box-a", hosts: [] });
  const fleet = await readFleet({ daemonUrl: a.url, reads: ["seats"], now });
  assert.equal(fleet.registry.status, "ok");
  assert.equal(fleet.registry.listed, 0);
  assert.equal(fleet.hosts.length, 1);
  const h = fleet.hosts[0];
  assert.equal(h.hostId, "box-a");
  assert.equal(h.identitySource, "self-reported");
  assert.equal(h.status, "ok");
  assert.equal(h.reads.seats.data.length, 2);
  assert.ok(!fleet.hosts.some((x) => x.key === "local" || x.hostId === "local"), "'local' is a position, not an identity");
  assert.equal(fleet.coverage.complete, true);
});

test("two machines with identical rig and seat names stay two sets of seats", async () => {
  const sameRigs = { "rig-1": { name: "alpha", nodes: [seat("dev.impl")] } };
  const b = await daemon({ selfHostId: "box-b", rigs: sameRigs });
  const a = await daemon({ selfHostId: "box-a", rigs: sameRigs, hosts: [{ id: "second", transport: "http", url: b.url }] });
  const fleet = await readFleet({ daemonUrl: a.url, reads: ["seats"], now });
  const seats = fleet.hosts.flatMap((h) => h.reads.seats.data);
  assert.equal(seats.length, 2);
  assert.deepEqual(seats.map((s) => s.key).sort(), ["box-a/alpha/dev.impl", "box-b/alpha/dev.impl"]);
  assert.deepEqual(seats.map((s) => s.hostId).sort(), ["box-a", "box-b"]);
  // The remote's identity comes from the remote itself, not from the label it was listed under.
  assert.deepEqual(host(fleet, "box-b").labels, ["second"]);
});

test("an unreachable machine is listed as unreachable, and the others stay read", async () => {
  const gone = await closedPortUrl();
  const a = await daemon({ selfHostId: "box-a", hosts: [{ id: "gone", transport: "http", url: gone }] });
  const fleet = await readFleet({ daemonUrl: a.url, reads: ["seats", "queues"], now });
  assert.equal(fleet.hosts.length, 2);
  const g = host(fleet, "unidentified:gone");
  assert.equal(g.status, "unreachable");
  assert.equal(g.hostId, null);
  assert.equal(g.reads.seats.data, null, "no seats must not read as zero seats");
  assert.equal(g.reads.queues.data, null);
  assert.equal(host(fleet, "box-a").reads.seats.status, "ok");
  assert.equal(fleet.coverage.complete, false);
  assert.deepEqual(fleet.coverage.notRead.map((n) => n.status), ["unreachable"]);
});

test("a machine that never answers is unreachable after the deadline, not waited on forever", async () => {
  const hung = await daemon({ routes: { "/healthz": () => "hang" } });
  const a = await daemon({ selfHostId: "box-a", hosts: [{ id: "slow", transport: "http", url: hung.url }] });
  const fleet = await readFleet({ daemonUrl: a.url, reads: [], now, timeoutMs: 200 });
  const s = host(fleet, "unidentified:slow");
  assert.equal(s.status, "unreachable");
  assert.match(s.detail, /no answer within 200 ms/);
});

test("an ssh-only machine is shown as unsupported, never dropped", async () => {
  const a = await daemon({ selfHostId: "box-a", hosts: [{ id: "shell-only", hostId: "box-s", transport: "ssh", target: "box-s.example" }] });
  const fleet = await readFleet({ daemonUrl: a.url, reads: ["seats"], now });
  const s = host(fleet, "box-s");
  assert.ok(s, "the ssh host must appear");
  assert.equal(s.status, "unsupported-transport");
  assert.equal(s.identitySource, "declared");
  assert.equal(s.reads.seats.data, null);
  assert.equal(fleet.coverage.complete, false);
});

test("a 503 is an error with no data, never zero or healthy", async () => {
  const unavailable = () => [503, { error: "health_summary_unavailable" }];
  const a = await daemon({
    selfHostId: "box-a",
    routes: { "/api/ps": unavailable, "/api/health-summary/nodes": unavailable, "/api/health-summary/context": unavailable, "/api/health-summary/gateway": unavailable, "/api/health": unavailable },
  });
  const fleet = await readFleet({ daemonUrl: a.url, reads: ["seats", "health"], now });
  const h = host(fleet, "box-a");
  assert.equal(h.reads.seats.status, "http-error");
  assert.equal(h.reads.seats.httpStatus, 503);
  assert.equal(h.reads.seats.data, null);
  assert.notEqual(h.reads.health.status, "ok");
  for (const part of Object.values(h.reads.health.data)) {
    assert.equal(part.status, "http-error");
    assert.equal(part.data, null, `${part.route} must carry no numbers`);
  }
});

test("a route that wants a token is reported as guarded; the reader sends none", async () => {
  const a = await daemon({ selfHostId: "box-a", routes: { "/api/queue/list": () => [401, { error: "unauthorized" }] } });
  const fleet = await readFleet({ daemonUrl: a.url, reads: ["queues"], now });
  assert.equal(host(fleet, "box-a").reads.queues.status, "guarded");
  assert.equal(host(fleet, "box-a").reads.queues.data, null);
  assert.ok(a.calls.every((c) => !("authorization" in c.headers)), "no request carries an authorization header");
});

test("an old sample fetched now keeps its own time", async () => {
  // The daemon measured this seat a day and a half before the poll. Showing the poll time
  // would make a stale reading look current.
  const old = "2030-01-01T00:00:00.000Z";
  const a = await daemon({ selfHostId: "box-a", rigs: { "rig-1": { name: "alpha", nodes: [seat("dev.impl", { agentActivity: { state: "idle", reason: "no turn", evidenceSource: "pane_heuristic", sampledAt: old, evidence: null } })] } } });
  const fleet = await readFleet({ daemonUrl: a.url, reads: ["seats", "health"], now });
  const s = host(fleet, "box-a").reads.seats;
  assert.equal(s.polledAt, new Date(NOW).toISOString());
  assert.equal(s.data[0].activity.observedAt, old);
  assert.notEqual(s.data[0].activity.observedAt, s.polledAt);
  assert.equal(s.data[0].activity.method, "pane_heuristic");
  // A route that reports no measurement time gets none, rather than borrowing the poll's.
  assert.equal(host(fleet, "box-a").reads.health.data.nodes.observedAt, null);
  assert.equal(host(fleet, "box-a").reads.health.data.findings.observedAt, "2030-01-01T00:00:00.000Z");
});

test("a full page of queue rows is reported as possibly truncated, never as a total", async () => {
  const full = await daemon({ selfHostId: "box-a", queue: [qitem(1), qitem(2), qitem(3)] });
  const fleet = await readFleet({ daemonUrl: full.url, reads: ["queues"], now, queueLimit: 3 });
  const q = host(fleet, "box-a").reads.queues;
  assert.equal(q.coverage.kind, "filtered-bounded");
  assert.equal(q.coverage.limit, 3);
  assert.equal(q.coverage.returned, 3);
  assert.equal(q.coverage.possiblyTruncated, true);
  assert.equal(q.coverage.total, null);
  assert.deepEqual(q.coverage.filter.state, ["pending", "in-progress", "blocked"]);
  assert.ok(full.calls.some((c) => c.path === "/api/queue/list" && /limit=3/.test(c.query) && /state=pending%2Cin-progress%2Cblocked|state=pending,in-progress,blocked/.test(c.query)), "the bound and the filter are sent to the daemon");

  const short = await daemon({ selfHostId: "box-b", queue: [qitem(1)] });
  const fleet2 = await readFleet({ daemonUrl: short.url, reads: ["queues"], now, queueLimit: 3 });
  assert.equal(host(fleet2, "box-b").reads.queues.coverage.possiblyTruncated, false);
});

test("a host list that names this daemon too yields one host, read once", async () => {
  // The configured daemon is listed again under another label and another spelling of its
  // address, so only its self-reported identity can tell they are the same machine.
  const aOpts = { selfHostId: "box-a" };
  const a = await daemon(aOpts);
  const b = await daemon({ selfHostId: "box-b", rigs: { "rig-9": { name: "beta", nodes: [seat("ops.watch")] } } });
  // The fake reads its host list on each request, so it can name its own address after starting.
  aOpts.hosts = [{ id: "me-again", transport: "http", url: a.url.replace("127.0.0.1", "localhost") }, { id: "other", transport: "http", url: b.url }];
  const fleet = await readFleet({ daemonUrl: a.url, reads: ["seats"], now });
  assert.deepEqual(fleet.hosts.map((h) => h.key).sort(), ["box-a", "box-b"]);
  const me = host(fleet, "box-a");
  assert.deepEqual(me.labels, ["configured daemon", "me-again"]);
  const seats = fleet.hosts.flatMap((h) => h.reads.seats.data);
  assert.equal(seats.filter((s) => s.hostId === "box-a").length, 2, "the configured daemon's seats are counted once");
  assert.equal(fleet.registry.listed, 2);
  assert.equal(a.calls.filter((c) => c.path === "/api/ps").length, 1, "and its seats are fetched once");
});

test("a listed host whose declared identity disagrees with what it reports keeps both visible", async () => {
  const b = await daemon({ selfHostId: "box-b" });
  const a = await daemon({ selfHostId: "box-a", hosts: [{ id: "second", hostId: "box-old", transport: "http", url: b.url }] });
  const fleet = await readFleet({ daemonUrl: a.url, reads: [], now });
  const h = host(fleet, "box-b");
  assert.equal(h.identitySource, "self-reported");
  assert.deepEqual(h.identityConflicts, [{ label: "second", declared: "box-old", selfReported: "box-b" }]);
});

test("a configured daemon that reports no identity is not given one", async () => {
  const a = await daemon({});
  const fleet = await readFleet({ daemonUrl: a.url, reads: [], now });
  assert.equal(fleet.hosts[0].hostId, null);
  assert.equal(fleet.hosts[0].identitySource, "unknown");
  assert.equal(fleet.hosts[0].key, "unidentified:configured daemon");
});

test("one rig failing leaves the read partial, with the failed rig named", async () => {
  const a = await daemon({
    selfHostId: "box-a",
    rigs: { "rig-1": { name: "alpha", nodes: [seat("dev.impl")] }, "rig-2": { name: "beta", nodes: [seat("dev.qa")] } },
    routes: { nodes: (url) => (url.pathname.includes("rig-2") ? [500, { error: "boom" }] : [200, [{ ...seat("dev.impl"), rigId: "rig-1", rigName: "alpha", hostSelfId: "box-a" }]]) },
  });
  const fleet = await readFleet({ daemonUrl: a.url, reads: ["seats"], now });
  const s = host(fleet, "box-a").reads.seats;
  assert.equal(s.status, "partial");
  assert.equal(s.data.length, 1);
  assert.equal(s.coverage.complete, false);
  assert.deepEqual(s.coverage.rigsFailed.map((r) => r.rigId), ["rig-2"]);
});

test("the provider's verbs are read only and return the reader's result", async () => {
  const a = await daemon({ selfHostId: "box-a" });
  const server = createObservatoryServer({ daemon: a.url });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const got = await (await fetch(`${base}/api/observatory/seats`)).json();
    assert.equal(got.schema, "openrig.observatory.fleet/v1");
    assert.equal(got.hosts[0].reads.seats.data.length, 2);
    assert.equal((await fetch(`${base}/api/observatory/seats`, { method: "POST" })).status, 405);
    assert.equal((await fetch(`${base}/api/observatory/nothing`)).status, 404);
    assert.ok(a.calls.every((c) => c.method === "GET"), "the daemon only ever sees GETs");
  } finally {
    await new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });
  }
});
