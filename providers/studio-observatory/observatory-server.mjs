#!/usr/bin/env node
// Read-only fleet views for the Observatory, built from OpenRig daemons' existing GET routes.
//
// Each verb reads the fleet when asked: the configured daemon, plus every machine its host
// list names. Nothing here writes to a daemon, starts anything on one, or holds a token.
import http from "node:http";
import { pathToFileURL } from "node:url";
import { readFleet } from "./lib/fleet-reader.mjs";

function arg(name, fallback = "") {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const port = Number(arg("--port", "9431"));
const daemonUrl = arg("--daemon", process.env.OBSERVATORY_DAEMON_URL || "http://127.0.0.1:7433");

const VERBS = {
  "/api/observatory/hosts": [],
  "/api/observatory/seats": ["seats"],
  "/api/observatory/queues": ["queues"],
  "/api/observatory/health": ["health"],
};

function json(res, status, value) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}

export function createObservatoryServer({ daemon = daemonUrl, read = readFleet } = {}) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const reads = VERBS[url.pathname];
    if (!reads) return json(res, 404, { error: `no observatory route ${url.pathname}` });
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.setHeader("allow", "GET, HEAD");
      return json(res, 405, { error: "read only: GET" });
    }
    try {
      return json(res, 200, await read({ daemonUrl: daemon, reads }));
    } catch (err) {
      return json(res, 500, { error: String(err?.message ?? err) });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createObservatoryServer().listen(port, "127.0.0.1", () => {
    console.log(`studio-observatory on 127.0.0.1:${port} · daemon ${daemonUrl}`);
  });
}
