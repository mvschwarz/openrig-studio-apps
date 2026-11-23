#!/usr/bin/env node
// The Machine app's provider: this machine's storage, memory and CPU, and a few safe fixes.
// Copyright 2026 mvschwarz. Licensed under the Apache License, Version 2.0.
//
// Every request passes the local owner check (../lib/owner-check.mjs). A cleanup is a write: it must be JSON on every request,
// browser or not, so nothing can trigger one with a plain form post. --project names the Studio's project folder, which the
// cleanups never touch and "What's taking space" marks as yours.
//
// Usage: node system-server.mjs --port <n> [--project <dir>]
import { createServer } from "node:http";
import { checked } from "../lib/admit.mjs";
import { refuse } from "../lib/owner-check.mjs";
import { route } from "./system-route.mjs";

const arg = (n, f) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 ? process.argv[i + 1] : f;
};
const PORT = Number(arg("port", 0));
const PROJECT = arg("project", "");
const env = { ...process.env, ...(PROJECT ? { OPENRIG_PROJECT_DIR: PROJECT } : {}) };
const send = (res, code, body) => {
  res.writeHead(code, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(body));
};

const server = createServer(async (req, res) => {
  // A target the URL parser rejects is answered 400 here, as host-server does: thrown inside this async handler it would be an
  // unhandled rejection, and one request would take the provider down.
  let url;
  try {
    url = new URL(req.url, "http://localhost");
  } catch {
    res.writeHead(400);
    return res.end();
  }
  const write = req.method === "POST";
  // Who's asking comes first: anyone else gets the owner refusal, whatever they sent.
  const owner = await checked(req);
  if (!owner.ok) return refuse(res, owner.why);
  if (write && !/^application\/json\b/i.test(req.headers["content-type"] || ""))
    return send(res, 415, { ok: false, error: "JSON only" });
  let body = null;
  if (write) {
    let raw = "";
    for await (const c of req) {
      raw += c;
      if (raw.length > 4096) return send(res, 413, { ok: false, error: "too large" });
    }
    try {
      body = JSON.parse(raw || "{}");
    } catch {
      return send(res, 400, { ok: false, error: "not JSON" });
    }
  }
  try {
    const [code, out] = await route(url, { method: req.method, body, env });
    send(res, code, out);
  } catch {
    send(res, 500, { ok: false, error: "Something failed while reading; nothing was changed." });
  }
});
server.listen(PORT, "127.0.0.1", () =>
  console.log(`system-server on 127.0.0.1:${server.address().port}`),
);
