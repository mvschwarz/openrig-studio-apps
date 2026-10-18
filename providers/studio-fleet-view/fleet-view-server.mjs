#!/usr/bin/env node
// Read-only fleet readings for the Fleet page, from OpenRig daemons' existing GET routes. The behaviour
// (cached readings served at once and refreshed outside the request; the ready route) is shared with the
// Observatory provider and described in providers/shared/reader-server.mjs. This file names Fleet's
// routes and the readings Fleet shows. It needs no Observatory.
//
// Nothing here writes to a daemon, starts anything on one, holds a token, or asks a model provider for
// anything: usage comes only from what OpenRig's daemons already report.
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { createReaderServer, runReaderServer } from "../shared/reader-server.mjs";

function arg(name, fallback = "") {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const port = Number(arg("--port", "9451"));
const daemonUrl = arg("--daemon", process.env.FLEET_DAEMON_URL || "http://127.0.0.1:7433");
const cacheSeconds = Number(process.env.FLEET_CACHE_SECONDS ?? 15);
const PACKAGE = (() => { try { return JSON.parse(fs.readFileSync(new URL("./package.json", import.meta.url), "utf8")); } catch { return {}; } })();

export const FLEET_ROUTE = "/api/fleet-view/fleet";
export const READY_ROUTE = "/api/fleet-view/ready";
// What Fleet shows: machines (with their health summaries), rigs and seats, configured links and usage.
export const FLEET_READS = ["seats", "health", "bindings", "subscriptions"];

export function createFleetViewServer({ daemon = daemonUrl, read, ttlMs = cacheSeconds * 1000, now = Date.now } = {}) {
  return createReaderServer({
    name: "fleet-view", pkg: PACKAGE, daemon, ttlMs, now, reads: FLEET_READS,
    ...(read ? { read } : {}),
    routes: { fleet: [FLEET_ROUTE], seat: null, ready: READY_ROUTE },
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runReaderServer(createFleetViewServer(), { port, label: `studio-fleet-view on 127.0.0.1:${port} · daemon ${daemonUrl} · reads kept ${cacheSeconds} s` });
}
