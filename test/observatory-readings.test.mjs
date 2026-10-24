// Messaging, ceremony and subscriptions: the reading classes most easily made to look better or
// bigger than they are. Each test pins one such way, through the reader's output from stand-in
// daemons (invented data, shaped from OpenRig's routes) and the page's own render functions.
import test from "node:test";
import assert from "node:assert/strict";
import { readFleet } from "../providers/shared/fleet-reader.mjs";
import { startFakeDaemon, qitem } from "./observatory-fake-daemon.mjs";
import { loadPage } from "./observatory-page.mjs";

const NOW = Date.parse("2030-01-02T12:00:00.000Z");
const now = () => NOW;
const started = [];
async function daemon(opts) { const d = await startFakeDaemon(opts); started.push(d); return d; }
test.afterEach(async () => { await Promise.all(started.splice(0).map((d) => d.close())); });
const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ");

const usage = (observations, extra = {}) => ({
  items: [{ provider: "codex", key: "acct-1", linkage: "same", notes: [], observations }],
  hosts: [{ hostId: "local", status: "ok", usage: "served", readAt: "2030-01-02T11:59:00.000Z" }, { hostId: "second", status: "ok", usage: "served", readAt: "2030-01-02T11:59:30.000Z" }],
  skipped: [], registry: { state: "read" }, seatAccounts: [], asOf: "2030-01-02T11:59:50.000Z",
  ...extra,
});
const obs = (hostId, usedPercent, observedAt = "2030-01-02T11:30:00.000Z") => ({
  hostId, readAt: "2030-01-02T11:59:00.000Z",
  row: { provider: "codex", identity: { planType: "team" }, observedAt, currentAvailability: "known", windows: [{ window: "weekly", usedPercent, resetsAt: "2030-01-05T00:00:00.000Z", observedAt, freshness: "fresh", level: "ok" }] },
});

// --- seats --------------------------------------------------------------------------------------

test("rigs listed whose seats all failed to read are reported as not read, never as no rigs running", async () => {
  const page = await loadPage();
  const a = await daemon({ selfHostId: "box-a", routes: { nodes: () => [503, { error: "unavailable" }] } });
  const fleet = await readFleet({ daemonUrl: a.url, now, reads: ["seats"] });
  const out = text(page.renderSeats(fleet, NOW));
  assert.match(out, /box-a : seats not read\. It lists 1 rig, and none could be read: alpha \(/);
  assert.doesNotMatch(out, /no rigs running/);
  const empty = await daemon({ selfHostId: "box-b", rigs: {} });
  assert.match(text(page.renderSeats(await readFleet({ daemonUrl: empty.url, now, reads: ["seats"] }), NOW)), /box-b : read, and it reports no rigs running\./);
});

// --- subscriptions ------------------------------------------------------------------------------

test("usage windows turned off read as not set up, never as zero percent", async () => {
  const page = await loadPage();
  const a = await daemon({ selfHostId: "box-a" });
  const fleet = await readFleet({ daemonUrl: a.url, now, reads: ["bindings", "subscriptions"] });
  assert.equal(fleet.subscriptions.status, "not-set-up");
  assert.equal(fleet.subscriptions.data, null);
  const out = text(page.renderSubscriptions(fleet, NOW));
  assert.match(out, /Usage across machines: not set up ?\. Usage windows are off on the configured machine \(provider\.usage_windows\), so there is no reading, not a zero\./);
  assert.doesNotMatch(out, /\b0%/);
  assert.match(out, /observed: not set up/);
});

test("a shared allowance read on two machines is shown twice, never added up", async () => {
  const page = await loadPage();
  const b = await daemon({ selfHostId: "box-b" });
  const a = await daemon({ selfHostId: "box-a", hosts: [{ id: "second", transport: "http", url: b.url }], usageHosts: usage([obs("local", 40), obs("second", 40)]) });
  const fleet = await readFleet({ daemonUrl: a.url, now, reads: ["bindings", "subscriptions"] });
  const g = fleet.subscriptions.data.allowances[0];
  assert.equal(g.observations.length, 2);
  // The route's own labels are mapped onto the hosts the reader knows; "local" is a position.
  assert.deepEqual(g.observations.map((o) => o.host), ["box-a", "box-b"]);
  const out = text(page.renderSubscriptions(fleet, NOW));
  assert.equal(out.match(/weekly: 40% used/g)?.length, 2, "each machine's reading appears on its own");
  assert.doesNotMatch(out, /80%/);
  assert.match(out, /allowances are never added up across machines/);
});

test("a seat's configured link and its observed use stay in separate columns", async () => {
  const page = await loadPage();
  const a = await daemon({
    selfHostId: "box-a",
    usageHosts: usage([obs("local", 10)], { seatAccounts: [{ hostId: "local", seats: [{ seatSession: "dev-impl@alpha", rigName: "alpha", runtime: "codex", configured: { source: "registry", profileRef: "team-a", recordedAt: "2030-01-01T00:00:00.000Z" }, observed: { windowsSampled: true, lastSampledAt: "2030-01-02T11:00:00.000Z", differsFrom: ["dev-review@alpha"], note: "possibly a different login: this seat's status line reports windows that differ from another seat's (a reset more than 60 s apart); not a verdict" } }] }] }),
  });
  const fleet = await readFleet({ daemonUrl: a.url, now, reads: ["bindings", "subscriptions"] });
  const binding = fleet.hosts[0].reads.bindings.data[0];
  assert.equal(binding.kind, "configured");
  assert.ok(!("current" in binding), "no field claims to be the current account");
  const sa = fleet.subscriptions.data.seatAccounts[0];
  assert.equal(sa.configured.kind, "configured");
  assert.equal(sa.observed.kind, "observed");
  const out = text(page.renderSubscriptions(fleet, NOW));
  assert.deepEqual(sa.observed.differsFrom, ["dev-review@alpha"]);
  assert.match(out, /dev-impl@alpha on box-a configured: team plan A active observed: windows differ from dev-review@alpha · sampled 60 min ago possibly a different login: this seat's status line reports windows that differ from another seat's \(a reset more than 60 s apart\); not a verdict/);
  assert.doesNotMatch(out, /differs from configured/);
  assert.doesNotMatch(out, /current account|currently using/i);
});

const seatObserved = async (observed) => {
  const page = await loadPage();
  const a = await daemon({
    selfHostId: "box-a",
    usageHosts: usage([obs("local", 10)], { seatAccounts: [{ hostId: "local", seats: [{ seatSession: "dev-impl@alpha", rigName: "alpha", runtime: "codex", configured: { source: "registry", profileRef: "team-a" }, observed }] }] }),
  });
  return text(page.renderSubscriptions(await readFleet({ daemonUrl: a.url, now, reads: ["bindings", "subscriptions"] }), NOW));
};

test("a seat with no usage windows sampled reads so, never a sample time that doesn't exist", async () => {
  const out = await seatObserved({ windowsSampled: false });
  assert.match(out, /dev-impl@alpha on box-a configured: .* observed: no usage windows sampled/);
  assert.doesNotMatch(out, /sampled time not reported|sampled \d/);
});

test("a seat whose use is withheld reads not attributed, with the daemon's note", async () => {
  const out = await seatObserved({ withheld: true, note: "this seat shares a login with another" });
  assert.match(out, /dev-impl@alpha on box-a configured: .* observed: not attributed this seat shares a login with another/);
  assert.doesNotMatch(out, /sampled time not reported|sampled \d/);
});

test("the Observatory points to Fleet for moves, and nothing is shown in money", async () => {
  const page = await loadPage();
  const a = await daemon({ selfHostId: "box-a", usageHosts: usage([obs("local", 10)]) });
  const fleet = await readFleet({ daemonUrl: a.url, now, reads: ["bindings", "subscriptions"] });
  const out = text(page.renderSubscriptions(fleet, NOW));
  assert.match(out, /Move history is shown in the Fleet page when installed\. Nothing here is in money\./);
  assert.doesNotMatch(out, /\$|USD|dollar/i);
});

test("a guarded or failing subscription route is reported, not read as empty", async () => {
  const page = await loadPage();
  const a = await daemon({ selfHostId: "box-a", routes: { "/api/provider/usage/hosts": () => [401, { error: "unauthorized" }], "/api/provider/bindings": () => [503, { error: "provider_service_unavailable" }] } });
  const fleet = await readFleet({ daemonUrl: a.url, now, reads: ["bindings", "subscriptions"] });
  assert.equal(fleet.subscriptions.status, "guarded");
  assert.equal(fleet.hosts[0].reads.bindings.status, "http-error");
  const out = text(page.renderSubscriptions(fleet, NOW));
  assert.match(out, /Usage across machines not read: needs a token \(not read\) · HTTP 401\. This is a failure to read, not a zero\./);
  assert.match(out, /box-a : configured subscription links not read: error · provider_service_unavailable · HTTP 503/);
});

// --- messaging ----------------------------------------------------------------------------------

test("undelivered messages are a bounded list, never a total, and a full page says so", async () => {
  const page = await loadPage();
  const a = await daemon({ selfHostId: "box-a", undelivered: [qitem(1, { deliveryOutcome: "never-posted", deliveryFailureClass: "never-posted" }), qitem(2, { deliveryOutcome: undefined, lastNudgeWireResult: "failed:pane-gone", deliveryFailureClass: "transient", lastNudgeAttempt: "2030-01-02T11:50:00.000Z" })] });
  const fleet = await readFleet({ daemonUrl: a.url, now, reads: ["messaging"], undeliveredLimit: 2 });
  const m = fleet.hosts[0].reads.messaging;
  assert.equal(m.coverage.total, null);
  assert.equal(m.coverage.possiblyTruncated, true);
  assert.ok(a.calls.some((c) => c.path === "/api/queue/undelivered" && /limit=2/.test(c.query)), "the bound is sent; the route has none of its own");
  const out = text(page.renderMessaging(fleet, NOW));
  assert.match(out, /box-a : undelivered rows, filtered and bounded; not a total\. At most 2 rows, 2 returned\. The page is full, so more rows may exist\. Held messages are per seat and not shown here\./);
  assert.match(out, /q-2 item 2 a-lead@alpha → a-impl@alpha failed:pane-gone transient 10 min ago/);
  assert.doesNotMatch(out, /\btotal\b(?!\.)/i);
});

test("an unreachable machine's messaging is not read, not 'no undelivered rows'", async () => {
  const page = await loadPage();
  const a = await daemon({ selfHostId: "box-a", routes: { "/api/queue/undelivered": () => "hang" } });
  const fleet = await readFleet({ daemonUrl: a.url, now, reads: ["messaging"], timeoutMs: 200 });
  const out = text(page.renderMessaging(fleet, NOW));
  assert.match(out, /box-a : undelivered messages not read: unreachable · no answer within 200 ms/);
  assert.doesNotMatch(out, /reports no undelivered rows/);
});

// --- ceremony -----------------------------------------------------------------------------------

test("a detector with no live source reads 'no source', never zero", async () => {
  const page = await loadPage();
  const a = await daemon({ selfHostId: "box-a" });
  const fleet = await readFleet({ daemonUrl: a.url, now, reads: ["ceremony"] });
  const d = Object.fromEntries(fleet.hosts[0].reads.ceremony.data.detectors.map((x) => [x.detector, x]));
  assert.equal(d["process.review-carousel"].state, "no-source");
  assert.equal(d["process.redundant-wake-storm"].state, "no-source");
  assert.equal(d["process.ceremony-amplification"].state, "findings", "the stand-in reports one amplification finding");
  const out = text(page.renderCeremony(fleet, NOW));
  assert.match(out, /process\.review-carousel no source in OpenRig as of 6f2751a1, 379f0a0d not checked against this daemon's version \(abc\) review returns are not counted in the OpenRig source this table was checked against/);
  assert.match(out, /process\.redundant-wake-storm no source in OpenRig as of 6f2751a1, 379f0a0d/);
  assert.doesNotMatch(out, /review-carousel 0|wake-storm 0|0 findings/);
  assert.match(out, /The oversight team's weekly readings: not connected ?\./);
});

test("ceremony findings carry their method, threshold and freshness, and a turned-off detector says so", async () => {
  const page = await loadPage();
  const a = await daemon({
    selfHostId: "box-a", disabledDetectors: ["process.redundant-wake-storm"],
    routes: { "/api/health": () => [200, { evaluatedAt: "2030-01-02T11:58:00.000Z", total: 1, limit: 200, truncated: false, records: [{ id: "f1", detector: "process.ceremony-amplification", severity: "warning", status: "active", summary: "invented", threshold: "20 transitions and 12x outcomes in 24 h", lastObservedAt: "2030-01-02T11:00:00.000Z", ceremony: { stage: "needs-diagnosis" } }], coverage: [{ status: "available", source: "passive-ceremony", evaluatedAt: "2030-01-02T11:58:00.000Z", unit: "handoff families", limit: 50, total: 80, evaluated: 50, omitted: 30, partial: true }] }] },
  });
  const fleet = await readFleet({ daemonUrl: a.url, now, reads: ["ceremony"] });
  const out = text(page.renderCeremony(fleet, NOW));
  assert.match(out, /box-a : as OpenRig's own detectors see it, evaluated 2 min ago · window 24 h\./);
  assert.match(out, /process\.ceremony-amplification 1 finding warning · invented · 20 transitions and 12x outcomes in 24 h · last seen 60 min ago · needs-diagnosis coordination transitions against the outcomes they lead to passive-ceremony: 50 of 80 evaluated \(partial\)/);
  assert.match(out, /process\.redundant-wake-storm turned off on this machine/);
});

test("a finding from a detector the table calls sourceless still shows", async () => {
  const a = await daemon({ selfHostId: "box-a", routes: { "/api/health": () => [200, { evaluatedAt: "2030-01-02T11:58:00.000Z", total: 1, limit: 200, truncated: false, records: [{ id: "f2", detector: "process.review-carousel", severity: "warning", status: "active", summary: "invented" }] }] } });
  const fleet = await readFleet({ daemonUrl: a.url, now, reads: ["ceremony"] });
  const d = fleet.hosts[0].reads.ceremony.data.detectors.find((x) => x.detector === "process.review-carousel");
  assert.equal(d.state, "findings");
  assert.equal(d.findings.length, 1);
});

test("the provider serves the new verbs and the page asks for them", async () => {
  const page = await loadPage();
  assert.equal(typeof page.renderMessaging, "function");
  const a = await daemon({ selfHostId: "box-a" });
  const fleet = await readFleet({ daemonUrl: a.url, now, reads: ["seats", "queues", "health", "messaging", "ceremony", "bindings", "subscriptions"] });
  const out = text(page.renderPage({ hosts: fleet, seats: fleet, queues: fleet, health: fleet, messaging: fleet, ceremony: fleet, subscriptions: fleet }, NOW));
  for (const h of ["Messaging", "Ceremony", "Subscriptions"]) assert.match(out, new RegExp(`\\b${h}\\b`));
  assert.ok(a.calls.every((c) => c.method === "GET"));
});
