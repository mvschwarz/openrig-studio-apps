// A stand-in OpenRig daemon for the observatory tests: an HTTP server on a loopback port that
// answers the GET routes the fleet reader uses, with invented data shaped like the real
// responses. Every route can be overridden to fail, hang or return something else.
import http from "node:http";

export function seat(logicalId, extra = {}) {
  return {
    nodeId: `node-${logicalId}`, logicalId, canonicalSessionName: `${logicalId.replace(".", "-")}@alpha`,
    runtime: "claude-code", sessionStatus: "running", lifecycleState: "running",
    agentActivity: { state: "running", reason: "turn in progress", evidenceSource: "runtime_hook", sampledAt: "2030-01-01T00:00:00.000Z", evidence: null },
    contextUsage: { availability: "known", usedPercentage: 41, contextWindowSize: 200000, source: "claude_statusline_json", sampledAt: "2030-01-01T00:00:00.000Z", fresh: true },
    assignedWorkCount: 1, inProgressWorkCount: 1, blockedWorkCount: 0,
    ...extra,
  };
}

export function qitem(n, extra = {}) {
  return { qitemId: `q-${n}`, state: "pending", priority: "routine", sourceSession: "a-lead@alpha", destinationSession: "a-impl@alpha", tsCreated: "2030-01-01T00:00:00.000Z", tsUpdated: "2030-01-01T00:00:00.000Z", blockedOn: null, deliveryOutcome: "posted", summary: `item ${n}`, ...extra };
}

// opts: { selfHostId, hosts, rigs: { [rigId]: { name, nodes } }, queue, routes: { [path]: handler } }
export async function startFakeDaemon(opts = {}) {
  const calls = [];
  const rigs = opts.rigs ?? { "rig-1": { name: "alpha", nodes: [seat("dev.impl"), seat("dev.qa")] } };
  const defaults = {
    "/healthz": () => [200, { status: "ok", pid: opts.pid ?? 4242, semver: "0.0.0-test", commit: "abc", ...(opts.selfHostId ? { selfHostId: opts.selfHostId, selfHostIdSource: "named" } : {}) }],
    "/api/hosts": () => [200, { ownName: "test", selected: "local", hosts: opts.hosts ?? [] }],
    "/api/ps": () => [200, Object.entries(rigs).map(([rigId, r]) => ({ rigId, name: r.name, rigName: r.name, nodeCount: r.nodes.length, status: r.status ?? "running", lifecycleState: r.status === "stopped" ? "stopped" : "running" }))],
    "/api/queue/list": () => [200, opts.queue ?? [qitem(1), qitem(2, { state: "blocked", blockedOn: "external:x" })]],
    "/api/health-summary/nodes": () => [200, { total: 2, bySessionStatus: { running: 2 }, byLifecycle: { running: 2 }, attentionRequired: 0 }],
    "/api/health-summary/context": () => [200, { total: 2, byUrgency: { critical: 0, warning: 0, low: 2, unknown: 0 }, byFreshness: { fresh: 2, stale: 0, none: 0 }, critical: 0, warning: 0, stale: 0 }],
    "/api/health-summary/gateway": () => [200, { state: "inactive" }],
    "/api/telemetry/v1/events": () => [200, { schemaVersion: 1, stream: "events", source: { hostId: opts.selfHostId ?? null, bootEpoch: opts.bootEpoch ?? "boot-1", sequenceSpaceId: null }, items: [] }],
    "/api/telemetry/usage/series": () => [200, { rows: opts.seriesRows ?? [] }],
    "/api/queue/undelivered": () => [200, opts.undelivered ?? [qitem(9, { deliveryOutcome: "transport-failed", deliveryFailureClass: "transport-failed", lastNudgeAttempt: "2030-01-01T00:00:00.000Z" })]],
    "/api/health-diagnosis/policy": () => [200, { version: 1, policy: { disabledDetectors: opts.disabledDetectors ?? [], thresholds: { ceremonyTransitions: 20, ceremonyRatio: 12, reviewReturns: 4, redundantWakes: 4 }, observationWindowSeconds: 86400, freshnessSeconds: 600 } }],
    "/api/provider/bindings": () => [200, { bindings: opts.bindings ?? [{ accountId: "acct-1", seatSession: "dev-impl@alpha", rigName: "alpha", boundAt: "2030-01-01T00:00:00.000Z", bindingSource: "codex_auth_seat_registry", anomalies: [] }] }],
    "/api/provider/accounts": () => [200, { accounts: opts.accounts ?? [{ accountId: "acct-1", label: "team plan A", provider: "codex", authState: "active", profileRef: null, asOf: "2030-01-01T00:00:00.000Z" }] }],
    "/api/provider/usage/hosts": () => (opts.usageHosts ? [200, opts.usageHosts] : [409, { error: "usage_windows_disabled", message: "Usage across hosts needs usage windows on this daemon." }]),
    "/api/health": () => [200, { schema: "openrig.health-list/v0alpha1", evaluatedAt: "2030-01-01T00:00:00.000Z", total: 1, limit: 200, truncated: false, records: [{ id: "f1", detector: "process.ceremony-amplification", category: "process", severity: "warning", status: "active", scope: { type: "rig", rigId: "rig-1" }, summary: "invented finding", lastObservedAt: "2030-01-01T00:00:00.000Z", freshness: { state: "fresh" } }] }],
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    calls.push({ method: req.method, path: url.pathname, query: url.search, headers: req.headers });
    const nodes = url.pathname.match(/^\/api\/rigs\/([^/]+)\/nodes$/);
    const tenures = url.pathname.match(/^\/api\/telemetry\/v1\/nodes\/([^/]+)\/tenures$/);
    if (tenures && !opts.routes?.tenures) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ schemaVersion: 1, stream: "tenures", observedAt: "2030-01-02T12:00:00.000Z", source: { hostId: opts.selfHostId ?? null, bootEpoch: opts.bootEpoch ?? "boot-1" }, rows: opts.tenureRows ?? [{ generationOrdinal: "2", nodeId: decodeURIComponent(tenures[1]), generationUuid: "gen-0002-invented", kind: "fresh", nativeSessionIdAtBoot: "native-invented", originalTimestamp: "2030-01-02T09:00:00.000Z" }, { generationOrdinal: "1", nodeId: decodeURIComponent(tenures[1]), generationUuid: "gen-0001-invented", kind: "initial", nativeSessionIdAtBoot: null, originalTimestamp: "2030-01-01T09:00:00.000Z" }], page: { hasMore: false, nextCursor: null, restartCursor: null }, coverage: { status: "retained_window", historyCompleteness: "unknown", gaps: [], gapCount: 0 } }));
    }
    const handler = opts.routes?.[url.pathname]
      ?? (tenures ? opts.routes.tenures : nodes ? (opts.routes?.nodes ?? (() => (rigs[decodeURIComponent(nodes[1])] ? [200, rigs[decodeURIComponent(nodes[1])].nodes.map((n) => ({ ...n, rigId: nodes[1], rigName: rigs[decodeURIComponent(nodes[1])].name, hostSelfId: opts.selfHostId ?? null }))] : [404, { error: "rig not found" }])))
      : defaults[url.pathname]);
    if (!handler) { res.writeHead(404, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: "not found" })); }
    const out = handler(url, req);
    if (out === "hang") return; // never answer
    const [status, body] = out;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`, port, calls,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
  };
}

// A loopback port with nothing listening on it.
export async function closedPortUrl() {
  const s = http.createServer();
  await new Promise((resolve) => s.listen(0, "127.0.0.1", resolve));
  const { port } = s.address();
  await new Promise((resolve) => s.close(resolve));
  return `http://127.0.0.1:${port}`;
}
