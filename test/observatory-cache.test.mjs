// One read of the fleet per refresh, an honest age on a kept read, a restart cue, and a detector
// table that says which OpenRig it was checked against. Stand-in daemons, invented data.
import test from "node:test";
import assert from "node:assert/strict";
import { readFleet } from "../providers/studio-observatory/lib/fleet-reader.mjs";
import { createFleetCache, createObservatoryServer, FLEET_VERBS as VERBS } from "../providers/studio-observatory/observatory-server.mjs";
import { startFakeDaemon } from "./observatory-fake-daemon.mjs";
import { loadPage } from "./observatory-page.mjs";

const started = [];
async function daemon(opts) { const d = await startFakeDaemon(opts); started.push(d); return d; }
test.afterEach(async () => { await Promise.all(started.splice(0).map((d) => d.close())); });
const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/\s+/g, " ");
const healthzCalls = (d) => d.calls.filter((c) => c.path === "/healthz").length;

test("all seven verbs inside the keep time cost one read of the daemon", async () => {
  const a = await daemon({ selfHostId: "box-a" });
  let clock = Date.parse("2030-01-02T12:00:00.000Z");
  const server = createObservatoryServer({ daemon: a.url, ttlMs: 15_000, now: () => clock });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const first = await (await fetch(base + VERBS[0])).json();
    assert.equal(first.served.fromCache, false);
    clock += 5_000;
    const rest = await Promise.all(VERBS.slice(1).map(async (v) => (await fetch(base + v)).json()));
    assert.equal(healthzCalls(a), 1, "one read set for seven verbs");
    for (const r of rest) {
      assert.equal(r.served.fromCache, true);
      assert.equal(r.served.cacheAgeSeconds, 5, "a kept read says how old it is");
      assert.equal(r.served.polledAt, first.polledAt, "and when it was made");
    }
    clock += 11_000; // past the keep time
    const later = await (await fetch(base + VERBS[1])).json();
    assert.equal(later.served.fromCache, false);
    assert.equal(healthzCalls(a), 2, "a new read after the keep time");
  } finally {
    await new Promise((r) => { server.closeAllConnections?.(); server.close(r); });
  }
});

test("concurrent requests share one read in flight", async () => {
  let reads = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const read = async () => { reads++; await gate; return { polledAt: "2030-01-02T12:00:00.000Z", hosts: [{ key: "box-a", status: "ok" }] }; };
  const get = createFleetCache({ daemon: "http://x", read, ttlMs: 15_000, now: () => 0 });
  const pending = Promise.all(Array.from({ length: 7 }, () => get()));
  release();
  const got = await pending;
  assert.equal(reads, 1);
  assert.equal(got.length, 7);
});

test("a read that could not reach the configured daemon is not kept", async () => {
  let reads = 0;
  const read = async () => { reads++; return { polledAt: "2030-01-02T12:00:00.000Z", hosts: [{ key: "unidentified:configured daemon", status: "unreachable" }] }; };
  const get = createFleetCache({ daemon: "http://x", read, ttlMs: 15_000, now: () => 0 });
  await get();
  await get();
  assert.equal(reads, 2, "the next request tries again");
});

test("a read that throws is not kept either", async () => {
  let reads = 0;
  const read = async () => { reads++; if (reads === 1) throw new Error("boom"); return { polledAt: "t", hosts: [{ key: "box-a", status: "ok" }] }; };
  const get = createFleetCache({ daemon: "http://x", read, ttlMs: 15_000, now: () => 0 });
  await assert.rejects(get(), /boom/);
  const second = await get();
  assert.equal(second.served.fromCache, false);
  assert.equal(reads, 2);
});

test("the page shows a kept read's age, never as fresh", async () => {
  const page = await loadPage();
  const now = Date.parse("2030-01-02T12:00:10.000Z");
  const fleet = { polledAt: "2030-01-02T12:00:00.000Z", hosts: [], coverage: { hostsRead: 0, hostsKnown: 0, complete: true }, registry: { status: "ok", listed: 0 },
    served: { servedAt: "2030-01-02T12:00:10.000Z", polledAt: "2030-01-02T12:00:00.000Z", cacheAgeSeconds: 10, keptForSeconds: 15, fromCache: true } };
  const out = text(page.renderHosts(fleet, now));
  assert.match(out, /read by the provider 10 s ago \(a kept read, 10 s old; reads are kept up to 15 s\)/);
  assert.doesNotMatch(out, /just now|\b0 s ago/);
});

test("a daemon restart between reads is flagged, by boot epoch where the daemon gives one", async () => {
  const page = await loadPage();
  const opts = { selfHostId: "box-a", bootEpoch: "boot-1", pid: 100 };
  const a = await daemon(opts);
  const first = await readFleet({ daemonUrl: a.url, reads: [], now: () => Date.parse("2030-01-02T12:00:00.000Z") });
  assert.equal(first.hosts[0].restart.status, "first-read");
  const same = await readFleet({ daemonUrl: a.url, reads: [], previous: first, now: () => Date.parse("2030-01-02T12:00:30.000Z") });
  assert.equal(same.hosts[0].restart.status, "same");
  opts.bootEpoch = "boot-2"; // same pid, new boot: only the epoch can tell
  const after = await readFleet({ daemonUrl: a.url, reads: [], previous: same, now: () => Date.parse("2030-01-02T12:01:00.000Z") });
  assert.deepEqual(after.hosts[0].restart, { status: "restarted", method: "boot epoch", between: ["2030-01-02T12:00:30.000Z", "2030-01-02T12:01:00.000Z"] });
  assert.match(text(page.renderHosts(after, Date.parse("2030-01-02T12:01:00.000Z"))), /daemon restarted since the last read \(between 2030-01-02T12:00:30\.000Z and 2030-01-02T12:01:00\.000Z, by boot epoch\); history from before it may not continue/);
});

test("without a boot epoch the restart signal falls back to the pid, and says so", async () => {
  const opts = { selfHostId: "box-a", pid: 100, routes: { "/api/telemetry/v1/events": () => [404, { error: "not found" }] } };
  const a = await daemon(opts);
  const first = await readFleet({ daemonUrl: a.url, reads: [] });
  opts.pid = 101;
  const after = await readFleet({ daemonUrl: a.url, reads: [], previous: first });
  assert.equal(after.hosts[0].restart.status, "restarted");
  assert.equal(after.hosts[0].restart.method, "pid");
  assert.equal(after.hosts[0].boot.bootEpochStatus, "http-error");
});

test("the detector table says which OpenRig it was checked against, and whether this daemon is one", async () => {
  const page = await loadPage();
  const now = Date.parse("2030-01-02T12:00:00.000Z");
  const matching = await daemon({ selfHostId: "box-a", routes: { "/healthz": () => [200, { status: "ok", pid: 1, commit: "379f0a0d106e65164c615818927267c2082ebcb4", selfHostId: "box-a" }] } });
  const m = await readFleet({ daemonUrl: matching.url, reads: ["ceremony"], now: () => now });
  const mc = m.hosts[0].reads.ceremony.data.detectors.find((d) => d.detector === "process.review-carousel");
  assert.equal(mc.sourceTable.matchesDaemon, true);
  assert.doesNotMatch(text(page.renderCeremony(m, now)), /not checked against this daemon/);

  const silent = await daemon({ selfHostId: "box-b", routes: { "/healthz": () => [200, { status: "ok", pid: 1, selfHostId: "box-b" }] } });
  const s = await readFleet({ daemonUrl: silent.url, reads: ["ceremony"], now: () => now });
  assert.equal(s.hosts[0].reads.ceremony.data.detectors[1].sourceTable.matchesDaemon, null);
  assert.match(text(page.renderCeremony(s, now)), /no source in OpenRig as of 6f2751a1, 379f0a0d this daemon does not report its version/);
});

test("a daemon without the usage-across-machines route reads 'not available', not an error or zero", async () => {
  const page = await loadPage();
  const a = await daemon({ selfHostId: "box-a", routes: { "/api/provider/usage/hosts": () => [404, { error: "not found" }] } });
  const fleet = await readFleet({ daemonUrl: a.url, reads: ["bindings", "subscriptions"] });
  assert.equal(fleet.subscriptions.status, "absent");
  const out = text(page.renderSubscriptions(fleet, Date.now()));
  assert.match(out, /Usage across machines: not available ?\. this daemon's OpenRig version has no usage-across-machines route, so there is no reading, not a zero\./);
  assert.match(out, /observed: not available on this version/);
  assert.doesNotMatch(out, /\b0%/);
});

test("a machine that stops answering keeps its last known name, labelled as such", async () => {
  const page = await loadPage();
  const b = await daemon({ selfHostId: "box-b" });
  const a = await daemon({ selfHostId: "box-a", hosts: [{ id: "second", transport: "http", url: b.url }] });
  const first = await readFleet({ daemonUrl: a.url, reads: ["seats"] });
  await b.close(); started.splice(started.indexOf(b), 1);
  const after = await readFleet({ daemonUrl: a.url, reads: ["seats"], previous: first });
  const gone = after.hosts.find((h) => h.labels.includes("second"));
  assert.equal(gone.status, "unreachable");
  assert.equal(gone.hostId, null, "this read does not know who it is");
  assert.equal(gone.lastSeenAs.hostId, "box-b");
  assert.match(text(page.renderSeats(after, Date.now())), /identity not reported \(last seen as box-b\) : seats not read: unreachable/);
});

test("the host list is counted as entries, since one may be this daemon again", async () => {
  const page = await loadPage();
  const out = text(page.renderHosts({ polledAt: "t", hosts: [], coverage: { hostsRead: 1, hostsKnown: 1, complete: true }, registry: { status: "ok", listed: 2 } }, Date.now()));
  assert.match(out, /the host list has 2 entries/);
  assert.doesNotMatch(out, /other machines/);
});
