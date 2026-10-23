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
//
// The table is only as good as the OpenRig source it was checked against. Those commits travel with
// every reading, and a daemon built from another commit is told apart, so a newer daemon that has
// since wired a source is never silently labelled as having none.
export const DETECTOR_TABLE_CHECKED_AGAINST = ["6f2751a1", "379f0a0d"];
export const CEREMONY_DETECTORS = {
  "process.ceremony-amplification": { sources: ["passive-ceremony", "health-checkpoints"], note: "coordination transitions against the outcomes they lead to" },
  "process.review-carousel": { sources: [], note: "review returns are not counted in the OpenRig source this table was checked against" },
  "process.redundant-wake-storm": { sources: [], note: "wake lineage is not recorded in the OpenRig source this table was checked against" },
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
    const daemonCommit = host.healthz?.commit ?? null;
    return {
      detector: id, state, method: d.note, sources: d.sources,
      sourceTable: {
        checkedAgainst: DETECTOR_TABLE_CHECKED_AGAINST,
        daemonCommit,
        // null when the daemon doesn't report its commit: then nobody knows, and the page says so.
        matchesDaemon: daemonCommit ? DETECTOR_TABLE_CHECKED_AGAINST.some((c) => daemonCommit.startsWith(c)) : null,
      },
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

export function restartSignal(before, now, previousPolledAt, polledAt) {
  if (!now.boot) return { status: "unknown", detail: "this read could not reach the daemon" };
  if (!before) return { status: "first-read" };
  if (!before.boot) return { status: "unknown", detail: "the previous read could not reach the daemon" };
  const byEpoch = before.boot.bootEpoch && now.boot.bootEpoch;
  const changed = byEpoch ? before.boot.bootEpoch !== now.boot.bootEpoch : before.boot.pid !== now.boot.pid;
  return { status: changed ? "restarted" : "same", method: byEpoch ? "boot epoch" : "pid", between: [previousPolledAt, polledAt] };
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
  if (r.status === "http-error" && r.httpStatus === 404) {
    return { route, status: "absent", httpStatus: 404, detail: "this daemon's OpenRig version has no usage-across-machines route", polledAt, observedAt: null, data: null, moves, coverage: null };
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
    // differsFrom is the daemon's: the OTHER seats whose sampled usage windows differ from this one's, which it qualifies
    // only as possibly a different login (its note says so). It says nothing about the configured account.
    observed: s.observed ? { kind: "observed", lastSampledAt: s.observed.lastSampledAt ?? null, windowsSampled: s.observed.windowsSampled ?? null,
      differsFrom: Array.isArray(s.observed.differsFrom) ? s.observed.differsFrom : [], withheld: s.observed.withheld === true, note: s.observed.note ?? null } : null,
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
  previous = null,
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

  // Restart signal. /healthz has a pid but no boot identity; the telemetry route stamps every page
  // with the daemon's boot epoch, a fresh id per start. Compare with the previous read of the same
  // host: a new boot epoch (or, without one, a new pid) means the daemon restarted in between, which
  // is also when its telemetry cursors reset.
  await mapLimit(hosts.filter((h) => h.status === "ok"), concurrency, async (host) => {
    const t = await getJson(fetchImpl, host.url, "/api/telemetry/v1/events?limit=1", timeoutMs);
    host.boot = { pid: host.healthz?.pid ?? null, bootEpoch: t.status === "ok" ? t.body?.source?.bootEpoch ?? null : null, route: "/healthz + /api/telemetry/v1/events?limit=1", bootEpochStatus: t.status };
  });
  for (const host of hosts) {
    const before = previous?.hosts?.find((h) => h.key === host.key);
    host.restart = restartSignal(before, host, previous?.polledAt ?? null, polledAt);
    // A machine that stops answering can no longer say who it is. If an earlier read under the same
    // label knew, keep that as "last seen as", labelled, without treating it as this read's identity.
    if (!host.hostId) {
      const known = previous?.hosts?.find((h) => h.hostId && h.labels.some((l) => host.labels.includes(l)));
      if (known) host.lastSeenAs = { hostId: known.hostId, at: previous.polledAt };
    }
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

// --- one seat ------------------------------------------------------------------------------------
//
// The drill-down for one seat, named by its host-qualified key (`<host>/<rig>/<seat>`). A key without
// its machine is refused: the same rig and seat names can exist on several machines, and resolving a
// bare name would merge them. Reads are bounded to this one seat on its own daemon.

const DEFAULT_TREND_HOURS = 6;

// OpenRig stores some times as SQLite datetime('now'): "YYYY-MM-DD HH:MM:SS", in UTC but without saying
// so. A browser reads that form as local time, so it is made explicit here. The daemon's own string is
// kept beside it.
export function sqliteUtc(v) {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(v) ? `${v.replace(" ", "T")}Z` : v ?? null;
}
const DEFAULT_TREND_LIMIT = 500;
const TENURE_LIMIT = 20;

export function findSeat(fleet, key) {
  if (typeof key !== "string" || !key) return { error: "a seat key is required", code: "seat_key_required" };
  // A machine that has stopped answering is found by the name it was last seen under, so its seat
  // reads as "not read" with the reason, rather than as unknown.
  const host = (fleet.hosts ?? []).find((h) => key.startsWith(`${h.key}/`)) ?? (fleet.hosts ?? []).find((h) => h.lastSeenAs?.hostId && key.startsWith(`${h.lastSeenAs.hostId}/`));
  if (!host) return { error: `no machine in this fleet matches the start of "${key}"; a seat key must name its machine (machine/rig/seat)`, code: "seat_host_unknown" };
  const seats = host.reads?.seats?.data;
  if (!Array.isArray(seats)) return { host, seat: null, error: `seats on ${host.hostId ?? (host.lastSeenAs ? `the machine last seen as ${host.lastSeenAs.hostId}` : host.key)} were not read: ${host.reads?.seats?.status ?? host.status}${host.detail ? ` (${host.detail})` : ""}`, code: "seat_host_not_read" };
  const seat = seats.find((s) => s.key === key);
  if (!seat) return { host, seat: null, error: `no seat ${key} on ${host.key}`, code: "seat_not_found" };
  return { host, seat };
}

export async function readSeat({ fleet, key, fetch: fetchImpl = globalThis.fetch, now = () => Date.now(), timeoutMs = DEFAULT_TIMEOUT_MS, trendHours = DEFAULT_TREND_HOURS, trendLimit = DEFAULT_TREND_LIMIT, tenureCursor = null } = {}) {
  const found = findSeat(fleet, key);
  if (!found.seat) return { schema: "openrig.observatory.seat/v1", key, status: found.code, error: found.error, host: found.host ? { key: found.host.key, status: found.host.status } : null };
  const { host, seat } = found;
  const polledAt = new Date(now()).toISOString();
  const since = new Date(now() - trendHours * 3600 * 1000).toISOString();
  const seriesRoute = `/api/telemetry/usage/series?lane=context&seat=${encodeURIComponent(seat.session ?? "")}&since=${encodeURIComponent(since)}&limit=${trendLimit}`;
  const tenureRoute = seat.nodeId ? `/api/telemetry/v1/nodes/${encodeURIComponent(seat.nodeId)}/tenures?limit=${TENURE_LIMIT}${tenureCursor ? `&cursor=${encodeURIComponent(tenureCursor)}` : ""}` : null;
  const [series, tenures] = await Promise.all([
    seat.session ? getJson(fetchImpl, host.url, seriesRoute, timeoutMs) : Promise.resolve({ status: "http-error", route: seriesRoute, detail: "the seat has no session name to ask for" }),
    tenureRoute ? getJson(fetchImpl, host.url, tenureRoute, timeoutMs) : Promise.resolve({ status: "http-error", route: null, detail: "the seat has no node id" }),
  ]);

  // Context trend: the daemon's own samples, oldest first, each with its own time. No point is made
  // up: a missing value stays missing and a silence between samples stays a silence.
  let trend;
  if (series.status === "http-error" && series.httpStatus === 404) trend = { route: seriesRoute, status: "absent", detail: "this daemon's OpenRig version has no usage series route", polledAt, points: null };
  else if (series.status !== "ok") trend = { route: seriesRoute, status: series.status, httpStatus: series.httpStatus ?? null, detail: series.detail ?? null, polledAt, points: null };
  else {
    const rows = Array.isArray(series.body?.rows) ? series.body.rows : [];
    const points = rows.filter((r) => r.lane === "context").map((r) => ({
      // When the harness measured it, and when the daemon recorded it. Never the poll time.
      sampledAt: r.sampledAt ?? null, capturedAt: r.capturedAt ?? null,
      usedPercentage: typeof r.usedPercentage === "number" ? r.usedPercentage : null,
      source: r.source ?? null,
    }));
    trend = {
      route: seriesRoute, status: "ok", polledAt, points,
      window: { since, hours: trendHours, boundOn: "the daemon's capture time" },
      coverage: { limit: trendLimit, returned: rows.length, possiblyTruncated: rows.length >= trendLimit, order: "oldest first", note: rows.length >= trendLimit ? "the list is full and oldest first, so the newest samples may be missing" : null },
      advisories: Array.isArray(series.body?.advisories) ? series.body.advisories : [],
    };
  }

  // Generation history, newest first, as the daemon's bounded telemetry reports it. A cursor from an
  // earlier daemon boot comes back unavailable: that is said, never shown as the whole history.
  let generations;
  if (tenures.status !== "ok") generations = { route: tenureRoute, status: tenures.status, httpStatus: tenures.httpStatus ?? null, detail: tenures.detail ?? null, polledAt, rows: null };
  else {
    const b = tenures.body ?? {};
    const cov = b.coverage ?? {};
    const unverified = cov.status === "unavailable";
    generations = {
      route: tenureRoute, status: unverified ? "history-unverified" : "ok", polledAt, observedAt: b.observedAt ?? null,
      bootEpoch: b.source?.bootEpoch ?? null,
      rows: unverified ? null : (Array.isArray(b.rows) ? b.rows : []).map((t) => ({ ordinal: t.generationOrdinal ?? null, kind: t.kind ?? null, generation: t.generationUuid ?? null, startedAt: sqliteUtc(t.originalTimestamp), startedAtAsStored: t.originalTimestamp ?? null })),
      coverage: {
        status: cov.status ?? null, historyCompleteness: cov.historyCompleteness ?? "unknown",
        gaps: Array.isArray(cov.gaps) ? cov.gaps.map((g) => g.code) : [], gapCount: cov.gapCount ?? 0,
        hasMore: b.page?.hasMore === true, nextCursor: b.page?.nextCursor ?? null,
        note: unverified ? "history unverified across a daemon restart: this cursor came from an earlier boot" : null,
      },
    };
  }

  const queue = host.reads?.queues;
  const own = Array.isArray(queue?.data) ? queue.data.filter((q) => q.to === seat.session || q.from === seat.session) : null;
  return {
    schema: "openrig.observatory.seat/v1", key, status: "ok", polledAt,
    host: { key: host.key, hostId: host.hostId, labels: host.labels, restart: host.restart ?? null },
    current: seat,
    trend,
    generations,
    queue: own === null
      ? { status: queue?.status ?? host.status, rows: null, note: "the machine's queue was not read" }
      : { status: "ok", rows: own, note: "rows to or from this seat within the machine's filtered, bounded queue list; not all of this seat's work", coverage: queue.coverage },
    notConnected: ["transcript", "generation record (needs a token)", "compaction"],
  };
}
