#!/usr/bin/env node
// Read-only fleet views for the Observatory, built from OpenRig daemons' existing GET routes.
// The behaviour (cached readings served at once, refreshed outside the request; the seat drill-down;
// the ready route) is shared with the Fleet provider and described in providers/shared/reader-server.mjs.
// This file names the Observatory's routes.
//
// Nothing here writes to a daemon, starts anything on one, or holds a token.
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { createReaderServer, runReaderServer, createFleetCache, createSeatCache, READY_MEANING, ALL_READS } from "../shared/reader-server.mjs";

export { createFleetCache, createSeatCache, READY_MEANING };

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
  "/api/observatory/ready",
];
export const FLEET_VERBS = VERBS.filter((v) => v !== "/api/observatory/seat" && v !== "/api/observatory/ready");
const PACKAGE = (() => { try { return JSON.parse(fs.readFileSync(new URL("./package.json", import.meta.url), "utf8")); } catch { return {}; } })();

export function createObservatoryServer({ daemon = daemonUrl, read, ttlMs = cacheSeconds * 1000, now = Date.now, readOne } = {}) {
  return createReaderServer({
    name: "observatory", pkg: PACKAGE, daemon, ttlMs, now, reads: ALL_READS,
    ...(read ? { read } : {}), ...(readOne ? { readOne } : {}),
    routes: { fleet: FLEET_VERBS, seat: "/api/observatory/seat", ready: "/api/observatory/ready" },
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runReaderServer(createObservatoryServer(), { port, label: `studio-observatory on 127.0.0.1:${port} · daemon ${daemonUrl} · reads kept ${cacheSeconds} s` });
}
