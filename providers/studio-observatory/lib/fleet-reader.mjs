// Reads a fleet of OpenRig daemons over their existing HTTP GET routes.
//
// One daemon is configured (the one on this machine, by default). Its own /healthz
// says who it is, and its GET /api/hosts lists the OTHER machines it knows about.
// That list can be empty, and it never includes the configured daemon itself, so
// the configured daemon is always read explicitly and then joined with the list.
//
// Identity is what each daemon says about itself (selfHostId on /healthz), never a
// label from the list and never the word "local". Two entries that turn out to be
// the same daemon are one host with two labels, so nothing is counted twice.
//
// Every reading keeps two times apart:
//   polledAt   - when this reader asked
//   observedAt - when the source says it measured, where the route reports one
// A sample measured an hour ago and fetched now is an hour old, not new.
//
// A host that can't be read is a status, never a zero: unreachable, guarded (the
// route wants a token, and this reader holds none), unsupported-transport (it is
// only reachable over ssh), or http-error. Its data stays null.

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_QUEUE_STATES = ["pending", "in-progress", "blocked"];
const DEFAULT_QUEUE_LIMIT = 200;
const HEALTH_LIMIT = 200;
const DEFAULT_UNDELIVERED_LIMIT = 200;

export const READS = ["seats", "queues", "health", "messaging", "ceremony", "bindings"];

// OpenRig's process detectors and what feeds them. No route reports which observation sources a
// daemon has, so this table is kept here, from OpenRig's own source, and a detector without a live
// source is shown as having none rather than as reading zero. A finding from a detector listed here
// as sourceless still shows: the finding wins over the table.
export const CEREMONY_DETECTORS = {
  "process.ceremony-amplification": { sources: ["passive-ceremony", "health-checkpoints"], note: "coordination transitions against the outcomes they lead to" },
  "process.review-carousel": { sources: [], note: "no live source in current OpenRig: review returns are not yet counted" },
  "process.redundant-wake-storm": { sources: [], note: "no live source in current OpenRig: wake lineage is not yet recorded" },
};

async function getJson(fetchImpl, base, route, timeoutMs) {
  const url = new URL(route, base.endsWith("/") ? base : base + "/").toString();
  try {
    const res = await fetchImpl(url, { method: "GET", headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    if (res.status === 401 || res.status === 403) return { status: "guarded", httpStatus: res.status, route };
    if (!res.ok) return { status: "http-error", httpStatus: res.status, route, detail: errorText(text) };
    try { return { status: "ok", httpStatus: res.status, route, body: JSON.parse(text) }; }
    catch { return { status: "http-error", httpStatus: res.status, route, detail: "the response was not JSON" }; }
  } catch (err) {
    const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
    return { status: "unreachable", route, detail: timedOut ? `no answer within ${timeoutMs} ms` : String(err?.cause?.code ?? err?.message ?? err) };
  }
}

function errorText(text) {
  try { const j = JSON.parse(text); return String(j.error ?? j.code ?? text).slice(0, 200); } catch { return String(text).slice(0, 200); }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function sameUrl(a, b) {
  try {
    const x = new URL(a), y = new URL(b);
    return x.protocol === y.protocol && x.hostname === y.hostname && (x.port || defaultPort(x)) === (y.port || defaultPort(y));
  } catch { return false; }
}
const defaultPort = (u) => (u.protocol === "https:" ? "443" : "80");

function reading(r, polledAt, extra = {}) {
  return { route: r.route, status: r.status, httpStatus: r.httpStatus ?? null, detail: r.detail ?? null, polledAt, observedAt: null, data: null, coverage: null, ...extra };
}

// --- per-host reads -----------------------------------------------------------------------------

async function readSeats(ctx, host) {
  const { fetchImpl, timeoutMs, now } = ctx;
  const polledAt = new Date(now()).toISOString();
  const ps = await getJson(fetchImpl, host.url, "/api/ps", timeoutMs);
  if (ps.status !== "ok") return reading(ps, polledAt);
  if (!Array.isArray(ps.body)) return reading({ ...ps, status: "http-error", detail: "/api/ps did not return a list" }, polledAt);
  const rigs = ps.body.filter((r) => r && typeof r.rigId === "string");
  const failed = [];
  const seats = [];
  const perRig = await mapLimit(rigs, ctx.concurrency, async (rig) => {
    const route = `/api/rigs/${encodeURIComponent(rig.rigId)}/nodes`;
    return { rig, r: await getJson(fetchImpl, host.url, route, timeoutMs) };
  });
  for (const { rig, r } of perRig) {
    if (r.status !== "ok" || !Array.isArray(r.body)) { failed.push({ rigId: rig.rigId, rigName: rig.name ?? null, route: r.route, status: r.status === "ok" ? "http-error" : r.status, httpStatus: r.httpStatus ?? null }); continue; }
    for (const n of r.body) seats.push(seatRow(host, rig, n));
  }
  return {
    route: "/api/ps + /api/rigs/:rigId/nodes", status: failed.length === 0 ? "ok" : failed.length < rigs.length ? "partial" : failed[0].status,
    httpStatus: null, detail: null, polledAt,
    // Seats carry their own observedAt (the activity sample time); the read as a whole has none.
    observedAt: null,
    data: seats,
    coverage: { rigsListed: rigs.length, rigsRead: rigs.length - failed.length, rigsFailed: failed, archivedRigs: "excluded (the route's default)", complete: failed.length === 0 },
  };
}

function seatRow(host, rig, n) {
  const a = n.agentActivity ?? null;
  const c = n.contextUsage ?? null;
  const rigName = n.rigName ?? rig.name ?? null;
  return {
    key: `${host.key}/${rigName}/${n.logicalId}`,
    hostId: host.hostId,
    // What the row itself says about where it lives. If it ever disagrees with the host's
    // identity, both stay visible rather than one silently winning.
    rowHostId: n.hostSelfId ?? null,
    rigId: n.rigId ?? rig.rigId, rigName, logicalId: n.logicalId ?? null, session: n.canonicalSessionName ?? null,
    nodeId: n.nodeId ?? null, runtime: n.runtime ?? null, sessionStatus: n.sessionStatus ?? null, lifecycleState: n.lifecycleState ?? null,
    activity: a ? { state: a.state ?? "unknown", reason: a.reason ?? null, method: a.evidenceSource ?? null, observedAt: a.sampledAt ?? null, stale: a.stale === true } : { state: "unknown", reason: "the daemon reported no activity sample", method: null, observedAt: null, stale: false },
    context: c ? { availability: c.availability ?? "unknown", usedPercentage: c.usedPercentage ?? null, windowSize: c.contextWindowSize ?? null, method: c.source ?? null, observedAt: c.sampledAt ?? null, fresh: c.fresh === true } : null,
    work: { assigned: n.assignedWorkCount ?? null, inProgress: n.inProgressWorkCount ?? null, blocked: n.blockedWorkCount ?? null },
  };
}

async function readQueues(ctx, host) {
  const { fetchImpl, timeoutMs, now } = ctx;
  const polledAt = new Date(now()).toISOString();
  const states = ctx.queueStates, limit = ctx.queueLimit;
  const route = `/api/queue/list?state=${states.join(",")}&limit=${limit}&compact=1`;
  const r = await getJson(fetchImpl, host.url, route, timeoutMs);
  if (r.status !== "ok") return reading(r, polledAt);
  if (!Array.isArray(r.body)) return reading({ ...r, status: "http-error", detail: "/api/queue/list did not return a list" }, polledAt);
  const rows = r.body.map((q) => ({
    key: `${host.key}/${q.qitemId}`, hostId: host.hostId, id: q.qitemId ?? null, state: q.state ?? null, priority: q.priority ?? null,
    from: q.sourceSession ?? null, to: q.destinationSession ?? null, createdAt: q.tsCreated ?? null, updatedAt: q.tsUpdated ?? null,
    blockedOn: q.blockedOn ?? null, delivery: q.deliveryOutcome ?? null, summary: q.summary ?? null,
  }));
  const byState = {};
  for (const q of rows) byState[q.state] = (byState[q.state] ?? 0) + 1;
  return {
    route, status: "ok", httpStatus: r.httpStatus, detail: null, polledAt,
    // The rows' own timestamps are their history; the list has no measurement time of its own.
    observedAt: null,
    data: rows,
    coverage: {
      kind: "filtered-bounded",
      filter: { state: states }, limit, returned: rows.length,
      // The route reports no total. A full page may have more behind it.
      possiblyTruncated: rows.length >= limit,
      total: null,
      note: "a filtered, bounded list from this daemon; counts are of the rows returned, not totals",
      countsOfReturnedRows: byState,
    },
  };
}

async function readHealth(ctx, host) {
  const { fetchImpl, timeoutMs, now } = ctx;
  const polledAt = new Date(now()).toISOString();
  const routes = { nodes: "/api/health-summary/nodes", context: "/api/health-summary/context", gateway: "/api/health-summary/gateway", findings: `/api/health?limit=${HEALTH_LIMIT}` };
  const keys = Object.keys(routes);
  const got = await mapLimit(keys, ctx.concurrency, (k) => getJson(fetchImpl, host.url, routes[k], timeoutMs));
  const parts = {};
  keys.forEach((k, i) => {
    const r = got[i];
    if (r.status !== "ok") { parts[k] = reading(r, polledAt); return; }
    if (k === "findings") {
      const b = r.body ?? {};
      parts[k] = {
        route: r.route, status: "ok", httpStatus: r.httpStatus, detail: null, polledAt,
        observedAt: b.evaluatedAt ?? null,
        data: Array.isArray(b.records) ? b.records.map((f) => ({ id: f.id, detector: f.detector, category: f.category ?? null, severity: f.severity ?? null, status: f.status ?? null, scope: f.scope ?? null, summary: f.summary ?? null, lastObservedAt: f.lastObservedAt ?? null, freshness: f.freshness?.state ?? null })) : null,
        coverage: { total: b.total ?? null, limit: b.limit ?? HEALTH_LIMIT, truncated: b.truncated === true, sources: Array.isArray(b.coverage) ? b.coverage : null },
      };
      return;
    }
    // The summary routes report no measurement time, so observedAt stays null rather than
    // borrowing this poll's time.
    parts[k] = { route: r.route, status: "ok", httpStatus: r.httpStatus, detail: null, polledAt, observedAt: null, data: r.body, coverage: null };
  });
  const statuses = keys.map((k) => parts[k].status);
  return {
    route: "/api/health-summary/* + /api/health", polledAt, observedAt: null,
    status: statuses.every((s) => s === "ok") ? "ok" : statuses.some((s) => s === "ok") ? "partial" : statuses[0],
    httpStatus: null, detail: null, data: parts, coverage: null,
  };
}

// Messages that did not reach their destination: one daemon's undelivered queue rows. The route has
// no default bound, so the reader sends one and reports when the page is full.
async function readMessaging(ctx, host) {
  const { fetchImpl, timeoutMs, now } = ctx;
  const polledAt = new Date(now()).toISOString();
  const limit = ctx.undeliveredLimit;
  const route = `/api/queue/undelivered?limit=${limit}&compact=1`;
  const r = await getJson(fetchImpl, host.url, route, timeoutMs);
  if (r.status !== "ok") return reading(r, polledAt);
  if (!Array.isArray(r.body)) return reading({ ...r, status: "http-error", detail: "/api/queue/undelivered did not return a list" }, polledAt);
  const rows = r.body.map((q) => ({
    key: `${host.key}/${q.qitemId}`, hostId: host.hostId, id: q.qitemId ?? null, state: q.state ?? null,
    from: q.sourceSession ?? null, to: q.destinationSession ?? null, createdAt: q.tsCreated ?? null, updatedAt: q.tsUpdated ?? null,
    outcome: q.deliveryOutcome ?? null, failureClass: q.deliveryFailureClass ?? null, lastAttempt: q.lastNudgeAttempt ?? null,
    lastResult: q.lastNudgeWireResult ?? q.lastNudgeResult ?? null, summary: q.summary ?? null,
  }));
  return {
    route, status: "ok", httpStatus: r.httpStatus, detail: null, polledAt, observedAt: null, data: rows,
    coverage: {
      kind: "filtered-bounded", filter: { undelivered: true }, limit, returned: rows.length,
      possiblyTruncated: rows.length >= limit, total: null,
      note: "open rows this daemon could not deliver, oldest first; a bounded list, not a total. Held messages are per seat and not read here.",
    },
  };
}

// Ceremony as OpenRig's own detectors see it, with their method, limits and freshness. Nothing here
// computes a ceremony number.
async function readCeremony(ctx, host) {
  const { fetchImpl, timeoutMs, now } = ctx;
  const polledAt = new Date(now()).toISOString();
  const [findings, policy] = await Promise.all([
    getJson(fetchImpl, host.url, `/api/health?limit=${HEALTH_LIMIT}`, timeoutMs),
    getJson(fetchImpl, host.url, "/api/health-diagnosis/policy", timeoutMs),
  ]);
  if (findings.status !== "ok") return reading(findings, polledAt);
  const b = findings.body ?? {};
  const records = Array.isArray(b.records) ? b.records : [];
  const disabled = policy.status === "ok" && Array.isArray(policy.body?.policy?.disabledDetectors) ? policy.body.policy.disabledDetectors : null;
  const sourceCoverage = Array.isArray(b.coverage) ? b.coverage : [];
  const detectors = Object.entries(CEREMONY_DETECTORS).map(([id, d]) => {
    const own = records.filter((f) => f.detector === id).map((f) => ({
      id: f.id, severity: f.severity ?? null, status: f.status ?? null, scope: f.scope ?? null, summary: f.summary ?? null,
      threshold: f.threshold ?? null, window: f.window ?? null, freshness: f.freshness ?? null, lastObservedAt: f.lastObservedAt ?? null,
      stage: f.ceremony?.stage ?? null, missingFacts: f.ceremony?.missingFacts ?? null,
    }));
    const isDisabled = disabled ? disabled.includes(id) : null;
    const state = isDisabled ? "disabled" : own.length ? "findings" : d.sources.length === 0 ? "no-source" : "no-active-finding";
    return {
      detector: id, state, method: d.note, sources: d.sources,
      sourceCoverage: sourceCoverage.filter((c) => d.sources.includes(c.source)),
      enabled: isDisabled === null ? null : !isDisabled,
      findings: own,
    };
  });
  return {
    route: `/api/health?limit=${HEALTH_LIMIT} + /api/health-diagnosis/policy`, status: "ok", httpStatus: findings.httpStatus, detail: null, polledAt,
    observedAt: b.evaluatedAt ?? null,
    data: {
      detectors,
      policy: policy.status === "ok" ? { status: "ok", thresholds: policy.body?.policy?.thresholds ?? null, windowSeconds: policy.body?.policy?.observationWindowSeconds ?? null, freshnessSeconds: policy.body?.policy?.freshnessSeconds ?? null } : { status: policy.status, httpStatus: policy.httpStatus ?? null, detail: policy.detail ?? null },
      oversight: { status: "not-connected", note: "the oversight team's weekly readings are not connected yet" },
    },
    coverage: { total: b.total ?? null, limit: b.limit ?? HEALTH_LIMIT, truncated: b.truncated === true },
  };
}

// The subscription link each seat is CONFIGURED with on this daemon. This is configuration, not a
// reading of which account a seat is using now.
async function readBindings(ctx, host) {
  const { fetchImpl, timeoutMs, now } = ctx;
  const polledAt = new Date(now()).toISOString();
  const [bindings, accounts] = await Promise.all([
    getJson(fetchImpl, host.url, "/api/provider/bindings", timeoutMs),
    getJson(fetchImpl, host.url, "/api/provider/accounts", timeoutMs),
  ]);
  if (bindings.status !== "ok") return reading(bindings, polledAt);
  const byId = new Map((accounts.status === "ok" && Array.isArray(accounts.body?.accounts) ? accounts.body.accounts : []).map((a) => [a.accountId, a]));
  const rows = (Array.isArray(bindings.body?.bindings) ? bindings.body.bindings : []).map((x) => ({
    key: `${host.key}/${x.seatSession}`, hostId: host.hostId, seat: x.seatSession ?? null, rigName: x.rigName ?? null,
    kind: "configured",
    account: x.accountId ? { id: x.accountId, label: byId.get(x.accountId)?.label ?? null, provider: byId.get(x.accountId)?.provider ?? null, authState: byId.get(x.accountId)?.authState ?? null } : null,
    since: x.boundAt ?? null, source: x.bindingSource ?? null,
    anomalies: Array.isArray(x.anomalies) ? x.anomalies.map((a) => a.kind) : [],
  }));
  return {
    route: "/api/provider/bindings + /api/provider/accounts", status: "ok", httpStatus: bindings.httpStatus, detail: null, polledAt, observedAt: null, data: rows,
    coverage: { accounts: accounts.status, note: "configured links only; which account a seat is using now is a separate observation" },
  };
}

const READERS = { seats: readSeats, queues: readQueues, health: readHealth, messaging: readMessaging, ceremony: readCeremony, bindings: readBindings };

// Subscription usage across machines, as the configured daemon already combines it. That route keeps
// each machine's reading separate and never sums them; this reader keeps it that way and only maps the
// route's host labels onto the hosts it knows.
async function readSubscriptions(ctx, daemonUrl, hosts) {
  const { fetchImpl, timeoutMs, now } = ctx;
  const polledAt = new Date(now()).toISOString();
  const route = "/api/provider/usage/hosts";
  const r = await getJson(fetchImpl, daemonUrl, route, timeoutMs);
  const moves = { status: "no-record", note: "subscription moves are not recorded yet" };
  if (r.status === "http-error" && r.httpStatus === 409) {
    return { route, status: "not-set-up", httpStatus: 409, detail: r.detail, polledAt, observedAt: null, data: null, moves, coverage: { note: "usage windows are off on the configured daemon (provider.usage_windows)" } };
  }
  if (r.status !== "ok") return { ...reading(r, polledAt), moves };
  const b = r.body ?? {};
  const hostFor = (label) => (label === "local" ? hosts[0] : hosts.find((h) => h.labels.includes(label))) ?? null;
  const keyFor = (label) => hostFor(label)?.key ?? `unmatched:${label}`;
  const window = (w) => ({ window: w.window ?? null, usedPercent: w.usedPercent ?? null, resetsAt: w.resetsAt ?? null, observedAt: w.observedAt ?? null, freshness: w.freshness ?? null, level: w.level ?? null });
  const allowances = (Array.isArray(b.items) ? b.items : []).map((g) => ({
    provider: g.provider ?? null, key: g.key ?? null, linkage: g.linkage ?? "unknown", notes: Array.isArray(g.notes) ? g.notes : [],
    // One entry per machine that read this allowance, as that machine read it. Never added up.
    observations: (Array.isArray(g.observations) ? g.observations : []).map((o) => ({
      host: keyFor(o.hostId), hostLabel: o.hostId, readAt: o.readAt ?? null,
      plan: o.row?.identity?.planType ?? o.row?.identity?.subscriptionType ?? null,
      observedAt: o.row?.observedAt ?? null, availability: o.row?.currentAvailability ?? "unknown",
      windows: Array.isArray(o.row?.windows) ? o.row.windows.map(window) : [],
    })),
  }));
  const seatAccounts = (Array.isArray(b.seatAccounts) ? b.seatAccounts : []).flatMap((h) => (Array.isArray(h.seats) ? h.seats : []).map((s) => ({
    host: keyFor(h.hostId), seat: s.seatSession ?? null, rigName: s.rigName ?? null,
    configured: s.configured ? { kind: "configured", source: s.configured.source ?? "unknown", profile: s.configured.profileRef ?? null, recordedAt: s.configured.recordedAt ?? null, reason: s.configured.reason ?? null } : null,
    observed: s.observed ? { kind: "observed", lastSampledAt: s.observed.lastSampledAt ?? null, differsFromConfigured: s.observed.differsFrom ?? null, note: s.observed.note ?? s.observed.withheld ?? null } : null,
  })));
  return {
    route, status: "ok", httpStatus: r.httpStatus, detail: null, polledAt, observedAt: b.asOf ?? null,
    data: { allowances, seatAccounts },
    moves,
    coverage: {
      hosts: (Array.isArray(b.hosts) ? b.hosts : []).map((h) => ({ host: keyFor(h.hostId), hostLabel: h.hostId, status: h.status ?? null, usage: h.usage ?? null, readAt: h.readAt ?? null, reason: h.usageReason ?? h.error ?? null })),
      skipped: Array.isArray(b.skipped) ? b.skipped : [],
      note: "each machine's reading is kept separate; allowances are never added up across machines",
    },
  };
}

// --- the fleet ----------------------------------------------------------------------------------

export async function readFleet({
  daemonUrl = "http://127.0.0.1:7433",
  reads = READS,
  fetch: fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  concurrency = DEFAULT_CONCURRENCY,
  queueStates = DEFAULT_QUEUE_STATES,
  queueLimit = DEFAULT_QUEUE_LIMIT,
  undeliveredLimit = DEFAULT_UNDELIVERED_LIMIT,
} = {}) {
  const ctx = { fetchImpl, now, timeoutMs, concurrency, queueStates, queueLimit, undeliveredLimit };
  const polledAt = new Date(now()).toISOString();

  const [localHealth, registry] = await Promise.all([
    getJson(fetchImpl, daemonUrl, "/healthz", timeoutMs),
    getJson(fetchImpl, daemonUrl, "/api/hosts", timeoutMs),
  ]);

  const candidates = [{ label: "configured daemon", via: "configured", transport: "http", url: daemonUrl, declaredHostId: null, health: localHealth }];
  const registryCoverage = { route: "/api/hosts", status: registry.status, httpStatus: registry.httpStatus ?? null, detail: registry.detail ?? null, listed: 0, note: "lists the other machines this daemon knows; never itself" };
  if (registry.status === "ok") {
    const entries = Array.isArray(registry.body?.hosts) ? registry.body.hosts : [];
    registryCoverage.listed = entries.length;
    const remote = entries.map((h) => ({ label: h.id ?? null, via: "registry", transport: h.transport ?? null, url: h.transport === "http" ? h.url ?? null : null, declaredHostId: h.hostId ?? null, health: null }));
    await mapLimit(remote, concurrency, async (c) => {
      if (c.transport === "http" && c.url) c.health = await getJson(fetchImpl, c.url, "/healthz", timeoutMs);
    });
    candidates.push(...remote);
  }

  // Join: one host per self-reported identity (or per declared identity for a host this reader
  // can't ask). A registry entry that points back at the configured daemon is the same host.
  const hosts = [];
  const byKey = new Map();
  for (const c of candidates) {
    const self = c.health?.status === "ok" && typeof c.health.body?.selfHostId === "string" ? c.health.body.selfHostId : null;
    const hostId = self ?? c.declaredHostId ?? null;
    const identitySource = self ? "self-reported" : c.declaredHostId ? "declared" : "unknown";
    let host = hostId ? byKey.get(hostId) : null;
    if (!host && c.via === "registry" && c.url && sameUrl(c.url, daemonUrl)) host = hosts[0];
    if (host) {
      host.labels.push(c.label);
      host.via.push(c.via);
      if (c.declaredHostId && self && c.declaredHostId !== self) host.identityConflicts.push({ label: c.label, declared: c.declaredHostId, selfReported: self });
      continue;
    }
    const status = c.transport !== "http" ? "unsupported-transport" : !c.url ? "http-error" : c.health.status;
    host = {
      key: hostId ?? `unidentified:${c.label}`,
      hostId, identitySource, labels: [c.label], via: [c.via], transport: c.transport, url: c.url,
      status,
      detail: status === "unsupported-transport" ? `this reader uses HTTP only; ${c.transport ?? "this"} hosts are not read` : c.health?.detail ?? null,
      healthz: c.health?.status === "ok" ? { route: "/healthz", polledAt, pid: c.health.body.pid ?? null, version: c.health.body.semver ?? null, commit: c.health.body.commit ?? null, identitySource: c.health.body.selfHostIdSource ?? null } : null,
      identityConflicts: c.declaredHostId && self && c.declaredHostId !== self ? [{ label: c.label, declared: c.declaredHostId, selfReported: self }] : [],
      reads: {},
    };
    if (hostId) byKey.set(hostId, host);
    hosts.push(host);
  }

  await mapLimit(hosts, concurrency, async (host) => {
    for (const name of reads) {
      if (!READERS[name]) continue;
      host.reads[name] = host.status === "ok" ? await READERS[name](ctx, host) : { route: null, status: host.status, httpStatus: null, detail: host.detail, polledAt, observedAt: null, data: null, coverage: null };
    }
  });

  const subscriptions = reads.includes("subscriptions")
    ? (hosts[0]?.status === "ok" ? await readSubscriptions(ctx, daemonUrl, hosts) : { route: "/api/provider/usage/hosts", status: hosts[0]?.status ?? "unreachable", httpStatus: null, detail: hosts[0]?.detail ?? null, polledAt, observedAt: null, data: null, moves: { status: "no-record", note: "subscription moves are not recorded yet" }, coverage: null })
    : undefined;

  const notRead = hosts.filter((h) => h.status !== "ok").map((h) => ({ key: h.key, labels: h.labels, status: h.status }));
  return {
    ...(subscriptions ? { subscriptions } : {}),
    schema: "openrig.observatory.fleet/v1",
    polledAt,
    configuredDaemon: daemonUrl,
    registry: registryCoverage,
    hosts,
    coverage: { hostsKnown: hosts.length, hostsRead: hosts.length - notRead.length, notRead, complete: notRead.length === 0 && registry.status === "ok" },
  };
}
