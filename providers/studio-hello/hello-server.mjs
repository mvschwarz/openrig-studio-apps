#!/usr/bin/env node
// The smallest Studio provider: one route, GET /api/hello?name=<name>, answered as JSON. The Studio starts it with the port in
// provider.json and routes the verbs it declares there to it, on the Studio's own origin.
// Copyright 2026 mvschwarz. Licensed under the Apache License, Version 2.0.
//
// Usage: node hello-server.mjs --port <n>
import http from "node:http";
import { checked } from "../lib/admit.mjs";
import { refuse } from "../lib/owner-check.mjs";

const i = process.argv.indexOf("--port");
const port = Number(i > -1 ? process.argv[i + 1] : 0);

const send = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};

const server = http.createServer(async (req, res) => {
  // Every provider answers only this machine's own Studio (see ../lib/owner-check.mjs).
  const owner = await checked(req);
  if (!owner.ok) return refuse(res, owner.why);
  // A target the URL parser rejects is a 400, never a thrown rejection that ends the process.
  let url;
  try {
    url = new URL(req.url, "http://x");
  } catch {
    res.writeHead(400);
    return res.end();
  }
  if (url.pathname !== "/api/hello") return send(res, 404, { ok: false, error: "unknown verb" });
  if (req.method !== "GET") return send(res, 405, { ok: false, error: "GET only" });
  const name = (url.searchParams.get("name") || "").trim().slice(0, 80) || "there";
  send(res, 200, { ok: true, message: `Hello, ${name}.` });
});
server.listen(port, "127.0.0.1", () =>
  console.log(`studio-hello: http://127.0.0.1:${server.address().port}/api/hello`),
);
