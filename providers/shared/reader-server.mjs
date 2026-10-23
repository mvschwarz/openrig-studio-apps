// The HTTP side shared by the read-only providers built on the fleet reader (the Observatory's and
// Fleet's). Each provider names its own routes; the behaviour below is the same for both.
//
// Cached readings, no fan-out in the request path once a reading exists:
// - The first request waits for the first read of the fleet (there is nothing else to show).
// - After that, every request is answered at once from the last good read. Within the keep time it is
//   current; after it, it is served labelled stale, with its age, and ONE refresh starts in the
//   background. Nothing polls on a timer: with nobody asking, nothing is read.
// - A read that could not reach the configured daemon, or that failed, is never kept.
// - Every response says when its read was made, how old it is, and whether it is stale.
//
// One seat's drill-down reads that one seat on its own daemon, kept briefly and only while it belongs
// to the fleet read it was made from. The ready route answers from the provider process alone: no
// daemon call and no fleet read.
//
// Nothing here writes to a daemon, starts anything on one, or holds a token.
import http from "node:http";
import { readFleet, readSeat, READS } from "./fleet-reader.mjs";

export const READY_MEANING = "this provider process is loaded and serving; it says nothing about whether any OpenRig daemon can be read";
const SEAT_KEEP_MS = 10_000;
const SEATS_REMEMBERED = 64;
export const ALL_READS = [...READS, "subscriptions"];

function json(res, status, value) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}

export function createFleetCache({ daemon, read = readFleet, reads = ALL_READS, ttlMs = 15_000, now = Date.now } = {}) {
  let kept = null;      // { fleet, at }: the last read that reached the configured daemon
  let inFlight = null;  // Promise<{ fleet, at }>
  let previous = null;  // the last kept read, for the restart signal
  let last = null;      // how the last fleet read came out, kept or not: what the ready route reports
  async function fresh() {
    let fleet;
    try { fleet = await read({ daemonUrl: daemon, reads, previous }); }
    catch (err) { last = { polledAt: new Date(now()).toISOString(), ok: false, status: "error", detail: String(err?.message ?? err) }; throw err; }
    const at = now();
    const status = fleet?.hosts?.[0]?.status ?? "unknown";
    last = { polledAt: fleet?.polledAt ?? new Date(at).toISOString(), ok: status === "ok", status };
    if (status === "ok") { kept = { fleet, at }; previous = fleet; }
    return { fleet, at };
  }
  function refresh() {
    inFlight ??= fresh().finally(() => { inFlight = null; });
    return inFlight;
  }
  async function get() {
    const t = now();
    let entry, fromCache, stale = false;
    if (kept) {
      entry = kept;
      fromCache = true;
      if (t - kept.at >= ttlMs) {
        stale = true;
        // Refresh outside the request: this answer does not wait for it.
        refresh().catch(() => {});
      }
    } else {
      fromCache = false;
      entry = await refresh();
    }
    const servedAt = now();
    return {
      ...entry.fleet,
      served: {
        servedAt: new Date(servedAt).toISOString(), polledAt: entry.fleet.polledAt,
        cacheAgeSeconds: Math.max(0, Math.round((servedAt - entry.at) / 1000)), keptForSeconds: Math.round(ttlMs / 1000),
        fromCache, stale, refreshing: inFlight !== null,
      },
    };
  }
  get.lastRead = () => last;
  // For tests and shutdown: the refresh currently running, if any.
  get.pending = () => inFlight;
  return get;
}

export function createSeatCache({ fleet, readOne = readSeat, ttlMs = SEAT_KEEP_MS, max = SEATS_REMEMBERED, now = Date.now } = {}) {
  const kept = new Map(); // key -> { value, at }, oldest first
  return async function seat(key, tenureCursor = null) {
    const id = `${key}\u0000${tenureCursor ?? ""}`;
    // The fleet read comes first, and a kept seat is used only while it belongs to that same fleet
    // read. Otherwise a seat could still read as fine after its machine has stopped answering.
    const f = await fleet();
    const hit = kept.get(id);
    if (hit && now() - hit.at < ttlMs && hit.value.fleetServed?.polledAt === f.polledAt) return { ...hit.value, fleetServed: f.served, served: { fromCache: true, cacheAgeSeconds: Math.round((now() - hit.at) / 1000), keptForSeconds: Math.round(ttlMs / 1000) } };
    const value = await readOne({ fleet: f, key, tenureCursor, now });
    value.fleetServed = f.served;
    if (value.status === "ok") {
      kept.delete(id);
      kept.set(id, { value, at: now() });
      while (kept.size > max) kept.delete(kept.keys().next().value);
    }
    return { ...value, served: { fromCache: false, cacheAgeSeconds: 0, keptForSeconds: Math.round(ttlMs / 1000) } };
  };
}

// routes: { fleet: [paths answered with the whole fleet read], seat: path|null, ready: path }
export function createReaderServer({ name, pkg = {}, routes, daemon, read = readFleet, reads = ALL_READS, ttlMs = 15_000, now = Date.now, readOne = readSeat, startedAt = new Date().toISOString() }) {
  const fleet = createFleetCache({ daemon, read, reads, ttlMs, now });
  const seat = routes.seat ? createSeatCache({ fleet, readOne, now }) : null;
  const known = new Set([...routes.fleet, routes.ready, ...(routes.seat ? [routes.seat] : [])]);
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (!known.has(url.pathname)) return json(res, 404, { error: `no ${name} route ${url.pathname}` });
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.setHeader("allow", "GET, HEAD");
      return json(res, 405, { error: "read only: GET" });
    }
    if (url.pathname === routes.ready) {
      const body = {
        schema: `openrig.${name}.ready/v1`,
        ready: !server.draining,
        meaning: READY_MEANING,
        provider: pkg.name ?? null, version: pkg.version ?? null,
        startedAt, servedAt: new Date(now()).toISOString(),
        lastFleetRead: fleet.lastRead(),
        ...(server.draining ? { reason: "the provider is shutting down" } : {}),
      };
      return json(res, server.draining ? 503 : 200, body);
    }
    try {
      if (seat && url.pathname === routes.seat) {
        const key = url.searchParams.get("key");
        if (!key) return json(res, 400, { error: "one seat per call: give key=<machine>/<rig>/<seat>" });
        const out = await seat(key, url.searchParams.get("cursor"));
        return json(res, out.status === "ok" ? 200 : out.status === "seat_host_unknown" || out.status === "seat_not_found" ? 404 : out.status === "seat_key_required" ? 400 : 200, out);
      }
      return json(res, 200, await fleet());
    } catch (err) {
      return json(res, 500, { error: String(err?.message ?? err) });
    }
  });
  server.draining = false;
  server.fleet = fleet;
  return server;
}

export function runReaderServer(server, { port, label }) {
  for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { server.draining = true; server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref(); });
  server.listen(port, "127.0.0.1", () => console.log(label));
}
