#!/usr/bin/env node
// The Files provider: browse, read, search, tag and edit the folders this Studio binds, plus the go-to channel an agent uses to
// open a file in the Files page. Copyright 2026 mvschwarz. Licensed under the Apache License, Version 2.0.
//
// Every request passes the local owner check (../lib/owner-check.mjs): a loopback Host, and a browser write must be same-origin
// JSON. Every path a request names goes through the one resolver in host-backend.mjs, so nothing outside the bound folders is
// read or written.
//
// Usage: node host-server.mjs (--port <n> | --socket <path>) [--root <dir> ...]
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import {
  filesTree,
  filesRead,
  filesWrite,
  filesRaw,
  filesSearch,
  filesTags,
  gotoGet,
  gotoSet,
  rootsMutate,
  fileRoots,
  rawGuard,
} from "./host-backend.mjs";
import { checked } from "../lib/admit.mjs";
import { refuse } from "../lib/owner-check.mjs";
import { sendFile } from "../lib/send-file.mjs";

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(n);
  return i > -1 && argv[i + 1] ? argv[i + 1] : d;
};
const PORT = Number(arg("--port", 8797));
const SOCKET = arg("--socket", "");
const ROOTS = argv.reduce(
  (a, v, i) => (v === "--root" && argv[i + 1] ? [...a, argv[i + 1]] : a),
  [],
);
const roots = () => fileRoots({ filesRoots: ROOTS });

const json = (res, code, obj) => {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(obj));
};
const body = (req) =>
  new Promise((r) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => r(b));
  });

const server = http.createServer(async (req, res) => {
  // A request target that isn't a URL (`//x:99999/a`) is refused here; thrown, it would end this provider.
  let url;
  try {
    url = new URL(req.url, "http://x");
  } catch {
    res.writeHead(400);
    return res.end();
  }
  const p = url.pathname;
  const R = roots();
  try {
    const owner = await checked(req);
    if (!owner.ok) return refuse(res, owner.why);
    if (p === "/") return json(res, 200, { ok: true, provider: "@openrig/studio-host", roots: R });

    if (p === "/api/files/roots" && req.method === "GET")
      return json(res, 200, { ok: true, roots: R });
    if (p === "/api/files/roots" && req.method === "POST") {
      const r = rootsMutate(JSON.parse((await body(req)) || "{}"));
      return json(res, r.ok ? 200 : 400, r.ok ? { ok: true, roots: roots() } : r);
    }
    if (p === "/api/files/tree") {
      const t = filesTree(url.searchParams.get("dir"), R);
      // A person reads these. Null means missing or outside the roots, and this route can't say which, so it says both.
      return t
        ? json(res, 200, { ok: true, ...t })
        : json(res, 400, {
            ok: false,
            error: "That folder wasn't found, or this machine can't open it. Check the path.",
          });
    }
    if (p === "/api/files/read") {
      const f = filesRead(url.searchParams.get("path") || "", R);
      return f
        ? json(res, 200, { ok: true, ...f })
        : json(res, 400, {
            ok: false,
            error: "That file wasn't found, or this machine can't open it. Check the path.",
          });
    }
    if (p === "/api/files/write" && req.method === "POST") {
      const { path: fp, content, baseMtime } = JSON.parse((await body(req)) || "{}");
      try {
        return json(res, 200, { ok: true, mtime: filesWrite(fp, content ?? "", baseMtime, R) });
      } catch (e) {
        return e.conflict
          ? json(res, 409, { ok: false, conflict: true, ...e.current })
          : json(res, e.notText ? 415 : 400, { ok: false, error: String(e.message) });
      }
    }
    // Range matters: without 206 an mp4 will not play in a browser at all.
    if (p === "/api/files/raw") {
      const f = filesRaw(url.searchParams.get("path") || "", R);
      if (!f) {
        res.writeHead(404);
        return res.end();
      }
      // The type is the file's own, never sniffed; rawGuard sandboxes anything that could run as this Studio.
      const base = {
        "content-type": f.mime,
        "x-content-type-options": "nosniff",
        ...rawGuard(f.path),
        "accept-ranges": "bytes",
      };
      // An unsatisfiable range is a 416 and an unreadable file a plain refusal; neither ends this provider.
      return sendFile(res, f.path, base, req.headers.range);
    }
    if (p === "/api/files/search") {
      const q = (url.searchParams.get("q") || "").trim();
      return json(res, 200, { ok: true, hits: q.length < 2 ? [] : filesSearch(q, R) });
    }
    if (p === "/api/files/tags") {
      const t = filesTags(url.searchParams.get("root") || "", R);
      return t
        ? json(res, 200, { ok: true, ...t })
        : json(res, 400, { ok: false, error: "root outside pins" });
    }
    if (p === "/api/files/goto" && req.method === "GET")
      return json(res, 200, { ok: true, goto: gotoGet() });
    if (p === "/api/files/goto" && req.method === "POST") {
      const { path: gp } = JSON.parse((await body(req)) || "{}");
      return gotoSet(gp || "", R)
        ? json(res, 200, { ok: true })
        : json(res, 400, { ok: false, error: "not found or outside roots" });
    }
    res.writeHead(404);
    res.end();
  } catch (e) {
    // Headers already sent means the answer is under way; a second writeHead would end this provider.
    if (res.headersSent) return res.destroy();
    json(res, 500, { ok: false, error: String(e.message || e) });
  }
});
// --socket <path>: listen on a unix socket instead of a loopback port. A host that runs this provider for a Studio reached from
// elsewhere keeps it in a private folder, since loopback is no boundary between accounts on one machine. The socket is created
// 0600 (owner only) from the start. Its folder must be this account's and not writable by anyone else (or another account could swap
// the socket). A leftover entry at the path is replaced only if it is a socket nothing answers on (a crashed run's); a socket another
// instance is serving, anything else, or a path that can't be read refuses to start.
if (SOCKET) {
  const stop = (why) => {
    console.error(`studio-host: ${why}`);
    process.exit(1);
  };
  try {
    const parent = fs.statSync(path.dirname(path.resolve(SOCKET)));
    if (typeof process.getuid === "function" && parent.uid !== process.getuid())
      stop(`${path.dirname(SOCKET)} isn't this account's folder`);
    if (parent.mode & 0o022)
      stop(`${path.dirname(SOCKET)} is writable by others; keep the socket in a private folder`);
  } catch (e) {
    stop(`${path.dirname(SOCKET)}: ${e.message}`);
  }
  let leftover = null;
  try {
    leftover = fs.lstatSync(SOCKET);
  } catch (e) {
    if (e?.code !== "ENOENT") stop(`${SOCKET}: ${e.message}`);
  }
  if (leftover && !leftover.isSocket()) stop(`${SOCKET} exists and isn't a socket`);
  if (leftover) {
    const live = await new Promise((resolve) => {
      const c = net.connect(SOCKET, () => {
        c.destroy();
        resolve(true);
      });
      c.on("error", () => resolve(false));
    });
    if (live) stop(`${SOCKET} is in use by another running instance`);
    fs.unlinkSync(SOCKET);
  }
  const mask = process.umask(0o177);
  server.listen(SOCKET, () => {
    fs.chmodSync(SOCKET, 0o600);
    console.log(`studio-host: unix:${SOCKET} roots=${roots().length}`);
  });
  process.umask(mask);
} else
  server.listen(PORT, "127.0.0.1", () =>
    console.log(`studio-host: http://127.0.0.1:${PORT}/ roots=${roots().length}`),
  );
