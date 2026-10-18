#!/usr/bin/env node
// Read-only fleet views for the Observatory, built from OpenRig daemons' existing GET routes.
//
// One read of the whole fleet serves every verb: the configured daemon, plus every machine its
// host list names. A read is kept for a short time (OBSERVATORY_CACHE_SECONDS, default 15) so a page
// refresh, which asks for every verb at once, costs one read rather than one per verb. Concurrent
// requests share the read in flight. Every response says when that read was made and how old it is,
// so a kept read is never presented as a fresh one. A read that could not reach the configured daemon
// is not kept.
//
// One seat's drill-down (/api/observatory/seat?key=<machine>/<rig>/<seat>) reads that one seat on
// its own daemon. Those reads are kept for a shorter time of their own, and only a bounded number of
// seats are remembered at once.
//
// Nothing here writes to a daemon, starts anything on one, or holds a token.
import http from "node:http";
import { pathToFileURL } from "node:url";
import { readFleet, readSeat, READS } from "./lib/fleet-reader.mjs";

function arg(name, fallback = "") {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const port = Number(arg("--port", "9431"));
const daemonUrl = arg("--daemon", process.env.OBSERVATORY_DAEMON_URL || "http://127.0.0.1:7433");
const cacheSeconds = Number(process.env.OBSERVATORY_CACHE_SECONDS ?? 15);

export const VERBS = [
  "/api/observatory/hosts",
  "/api/observatory/seats",
  "/api/observatory/queues",
  "/api/observatory/health",
  "/api/observatory/messaging",
  "/api/observatory/ceremony",
  "/api/observatory/subscriptions",
  "/api/observatory/seat",
];
export const FLEET_VERBS = VERBS.filter((v) => v !== "/api/observatory/seat");
const SEAT_KEEP_MS = 10_000;
const SEATS_REMEMBERED = 64;
const ALL_READS = [...READS, "subscriptions"];

function json(res, status, value) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}

export function createFleetCache({ daemon, read = readFleet, ttlMs = cacheSeconds * 1000, now = Date.now } = {}) {
  let kept = null;      // { fleet, at }
  let inFlight = null;  // Promise<{ fleet, at }>
  let previous = null;  // the last read that reached the configured daemon, for the restart signal
  async function fresh() {
    const fleet = await read({ daemonUrl: daemon, reads: ALL_READS, previous });
    const at = now();
    if (fleet?.hosts?.[0]?.status === "ok") { kept = { fleet, at }; previous = fleet; }
    return { fleet, at };
  }
  return async function get() {
    const t = now();
    let entry, fromCache;
    if (kept && t - kept.at < ttlMs) { entry = kept; fromCache = true; }
    else {
      fromCache = false;
      inFlight ??= fresh().finally(() => { inFlight = null; });
      entry = await inFlight;
    }
    const servedAt = now();
    return {
      ...entry.fleet,
      served: { servedAt: new Date(servedAt).toISOString(), polledAt: entry.fleet.polledAt, cacheAgeSeconds: Math.max(0, Math.round((servedAt - entry.at) / 1000)), keptForSeconds: Math.round(ttlMs / 1000), fromCache },
    };
  };
}

export function createSeatCache({ fleet, readOne = readSeat, ttlMs = SEAT_KEEP_MS, max = SEATS_REMEMBERED, now = Date.now } = {}) {
  const kept = new Map(); // key -> { value, at }, oldest first
  return async function seat(key, tenureCursor = null) {
    const id = `${key}\u0000${tenureCursor ?? ""}`;
    // The fleet read comes first, and a kept seat is used only while it belongs to that same fleet
    // read. Otherwise a seat could still read as fine after its machine has stopped answering.
    const f = await fleet();
    const hit = kept.get(id);
    if (hit && now() - hit.at < ttlMs && hit.value.fleetServed?.polledAt === f.polledAt) return { ...hit.value, served: { fromCache: true, cacheAgeSeconds: Math.round((now() - hit.at) / 1000), keptForSeconds: Math.round(ttlMs / 1000) } };
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

export function createObservatoryServer({ daemon = daemonUrl, read = readFleet, ttlMs = cacheSeconds * 1000, now = Date.now, readOne = readSeat } = {}) {
  const fleet = createFleetCache({ daemon, read, ttlMs, now });
  const seat = createSeatCache({ fleet, readOne, now });
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (!VERBS.includes(url.pathname)) return json(res, 404, { error: `no observatory route ${url.pathname}` });
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.setHeader("allow", "GET, HEAD");
      return json(res, 405, { error: "read only: GET" });
    }
    try {
      if (url.pathname === "/api/observatory/seat") {
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
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createObservatoryServer().listen(port, "127.0.0.1", () => {
    console.log(`studio-observatory on 127.0.0.1:${port} · daemon ${daemonUrl} · reads kept ${cacheSeconds} s`);
  });
}
