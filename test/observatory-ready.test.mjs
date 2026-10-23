// Readiness: the provider says it is serving without reading anything, and the container's
// healthcheck passes only when the provider (not just the studio) answers. Stand-in daemons and
// stand-in studios on loopback.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createObservatoryServer, READY_MEANING } from "../providers/studio-observatory/observatory-server.mjs";
import { check, LABELS } from "../providers/studio-observatory/healthcheck.mjs";
import { startFakeDaemon, closedPortUrl } from "./observatory-fake-daemon.mjs";

const started = [];
async function listen(server) { await new Promise((r) => server.listen(0, "127.0.0.1", r)); started.push(server); return `http://127.0.0.1:${server.address().port}`; }
test.afterEach(async () => { await Promise.all(started.splice(0).map((s) => (s.close ? new Promise((r) => { s.closeAllConnections?.(); s.close(r); }) : s()))); });
async function daemon(opts) { const d = await startFakeDaemon(opts); started.push(d.close); return d; }

test("the ready verb answers without a single daemon call", async () => {
  const a = await daemon({ selfHostId: "box-a" });
  const base = await listen(createObservatoryServer({ daemon: a.url }));
  const r = await fetch(`${base}/api/observatory/ready`);
  const body = await r.json();
  assert.equal(r.status, 200);
  assert.equal(body.ready, true);
  assert.equal(body.provider, "@openrig/studio-observatory");
  assert.equal(body.meaning, READY_MEANING);
  assert.match(body.meaning, /says nothing about whether any OpenRig daemon can be read/);
  assert.equal(body.lastFleetRead, null, "nothing has been read yet, and ready does not read");
  assert.equal(a.calls.length, 0, "no daemon call at all");
});

test("ready reports the last fleet read as it came out, and a failed one is never ok", async () => {
  const gone = await closedPortUrl();
  const base = await listen(createObservatoryServer({ daemon: gone }));
  await fetch(`${base}/api/observatory/hosts`); // a fleet read that cannot reach the configured daemon
  const body = await (await fetch(`${base}/api/observatory/ready`)).json();
  assert.equal(body.ready, true, "the provider is still serving");
  assert.equal(body.lastFleetRead.ok, false);
  assert.equal(body.lastFleetRead.status, "unreachable");
});

test("a provider that is shutting down is not ready", async () => {
  const a = await daemon({ selfHostId: "box-a" });
  const server = createObservatoryServer({ daemon: a.url });
  const base = await listen(server);
  server.draining = true;
  const r = await fetch(`${base}/api/observatory/ready`);
  assert.equal(r.status, 503);
  assert.equal((await r.json()).ready, false);
});

// Stand-in studios: what the healthcheck sees through the studio's port.
function studio(routes) {
  return http.createServer((req, res) => {
    const h = routes[new URL(req.url, "http://x").pathname];
    if (!h) { res.writeHead(404, { "content-type": "text/html" }); return res.end("<h1>not found</h1>"); }
    const [status, body, type = "application/json"] = h();
    res.writeHead(status, { "content-type": type });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  });
}
const contract = () => [200, { contractVersion: "0.1", runtime: { name: "openrig-studio" } }];

test("the healthcheck passes only when the provider answers ready through the studio", async () => {
  const base = await listen(studio({ "/api/contract": contract, "/api/observatory/ready": () => [200, { ready: true, provider: "@openrig/studio-observatory" }] }));
  assert.deepEqual(await check({ base }), { healthy: true, label: LABELS.ready });
});

test("a studio answering without its provider is 'shell answers; provider not confirmed', and unhealthy", async () => {
  for (const ready of [() => [502, "bad gateway", "text/plain"], () => [200, "<html>studio fallback</html>", "text/html"], () => [200, { ready: false, provider: "@openrig/studio-observatory" }], () => [200, { ready: true, provider: "@someone/else" }]]) {
    const base = await listen(studio({ "/api/contract": contract, "/api/observatory/ready": ready }));
    const r = await check({ base });
    assert.equal(r.healthy, false);
    assert.equal(r.label, LABELS.shellOnly);
    assert.doesNotMatch(r.label, /provider (ready|confirmed)(?! )/);
  }
  // A missing provider route on the studio is the same case.
  const base = await listen(studio({ "/api/contract": contract }));
  assert.equal((await check({ base })).label, LABELS.shellOnly);
});

test("nothing answering is 'studio not answering'", async () => {
  const r = await check({ base: await closedPortUrl(), timeoutMs: 500 });
  assert.equal(r.healthy, false);
  assert.equal(r.label, LABELS.down);
});

test("the fallback label never claims the provider", () => {
  assert.equal(LABELS.shellOnly, "shell answers; provider not confirmed");
  assert.match(LABELS.shellOnly, /not confirmed/);
  assert.doesNotMatch(LABELS.shellOnly, /\bready\b/);
});
