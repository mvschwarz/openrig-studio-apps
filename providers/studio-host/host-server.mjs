#!/usr/bin/env node
// HOST CAPABILITIES as an ordinary provider.
//
// /api/files/* and /api/seats/* used to be special: declared as
// `requires.host_capabilities` and served by a private box. FILES and AGENTS
// therefore installed onto a public studio and rendered EMPTY PANES — the app
// was there, the verbs were not, and nothing said so.
//
// They are a provider now. Same declaration, same install, same routing as any
// other backend. One mechanism instead of two, and no special case for the
// next app to trip over.
//
// The seat verbs are what make an app AGENT-MANAGED rather than merely
// installed: the roster is read from the live rig, and a surface can say
// something to a seat and read its pane back.
//
// Usage: node host-server.mjs --port <n> [--root <dir> ...]
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import {
  resolveInsideRoots, filesTree, filesRead, filesWrite, filesRaw, filesSearch,
  filesTags, gotoGet, gotoSet, rootsMutate, listSeats, sendSeat, captureSeat, fileRoots,
} from "./host-backend.mjs";

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i > -1 && argv[i + 1] ? argv[i + 1] : d; };
const PORT = Number(arg("--port", 8797));
const ROOTS = argv.reduce((a, v, i) => (v === "--root" && argv[i + 1] ? [...a, argv[i + 1]] : a), []);
const roots = () => (ROOTS.length ? fileRoots({ filesRoots: ROOTS }) : fileRoots({}));

const json = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
const body = (req) => new Promise((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => r(b)); });

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  const R = roots();
  try {
    if (p === "/" ) return json(res, 200, { ok: true, provider: "@openrig/studio-host", roots: R });

    if (p === "/api/files/roots" && req.method === "GET") return json(res, 200, { ok: true, roots: R });
    if (p === "/api/files/roots" && req.method === "POST") {
      const r = rootsMutate(JSON.parse((await body(req)) || "{}"));
      return json(res, r.ok ? 200 : 400, r.ok ? { ok: true, roots: roots() } : r);
    }
    if (p === "/api/files/tree") {
      const t = filesTree(url.searchParams.get("dir"), R);
      return t ? json(res, 200, { ok: true, ...t }) : json(res, 400, { ok: false, error: "path outside the pinned roots" });
    }
    if (p === "/api/files/read") {
      const f = filesRead(url.searchParams.get("path") || "", R);
      return f ? json(res, 200, { ok: true, ...f }) : json(res, 400, { ok: false, error: "path outside the pinned roots" });
    }
    if (p === "/api/files/write" && req.method === "POST") {
      const { path: fp, content, baseMtime } = JSON.parse((await body(req)) || "{}");
      try { return json(res, 200, { ok: true, mtime: filesWrite(fp, content ?? "", baseMtime, R) }); }
      catch (e) { return e.conflict ? json(res, 409, { ok: false, conflict: true, ...e.current }) : json(res, 400, { ok: false, error: String(e.message) }); }
    }
    // Range matters: without 206 an mp4 will not play in a browser at all.
    if (p === "/api/files/raw") {
      const f = filesRaw(url.searchParams.get("path") || "", R);
      if (!f) { res.writeHead(404); return res.end(); }
      const m = (req.headers.range || "").match(/bytes=(\d*)-(\d*)/);
      if (m && (m[1] || m[2])) {
        const start = m[1] ? parseInt(m[1]) : Math.max(0, f.size - parseInt(m[2]));
        const end = m[1] && m[2] ? Math.min(parseInt(m[2]), f.size - 1) : f.size - 1;
        if (start >= f.size) { res.writeHead(416, { "content-range": `bytes */${f.size}` }); return res.end(); }
        res.writeHead(206, { "content-type": f.mime, "accept-ranges": "bytes", "content-range": `bytes ${start}-${end}/${f.size}`, "content-length": end - start + 1 });
        return fs.createReadStream(f.path, { start, end }).pipe(res);
      }
      res.writeHead(200, { "content-type": f.mime, "accept-ranges": "bytes", "content-length": f.size });
      return fs.createReadStream(f.path).pipe(res);
    }
    if (p === "/api/files/search") {
      const q = (url.searchParams.get("q") || "").trim();
      return json(res, 200, { ok: true, hits: q.length < 2 ? [] : filesSearch(q, R) });
    }
    if (p === "/api/files/tags") {
      const t = filesTags(url.searchParams.get("root") || "", R);
      return t ? json(res, 200, { ok: true, ...t }) : json(res, 400, { ok: false, error: "root outside pins" });
    }
    if (p === "/api/files/goto" && req.method === "GET") return json(res, 200, { ok: true, goto: gotoGet() });
    if (p === "/api/files/goto" && req.method === "POST") {
      const { path: gp } = JSON.parse((await body(req)) || "{}");
      return gotoSet(gp || "", R) ? json(res, 200, { ok: true }) : json(res, 400, { ok: false, error: "not found or outside roots" });
    }

    // The agent-managed half.
    if (p === "/api/seats") return json(res, 200, await listSeats());
    if (p === "/api/seats/send" && req.method === "POST") {
      const { seat, text } = JSON.parse((await body(req)) || "{}");
      const r = await sendSeat(seat, text);
      return json(res, r.ok ? 200 : 400, r);
    }
    if (p === "/api/seats/capture") {
      const r = await captureSeat(url.searchParams.get("seat") || "", url.searchParams.get("lines"));
      return json(res, r.ok ? 200 : 400, r);
    }
    res.writeHead(404); res.end();
  } catch (e) { json(res, 500, { ok: false, error: String(e.message || e) }); }
}).listen(PORT, "127.0.0.1", () => console.log(`studio-host: http://127.0.0.1:${PORT}/ roots=${roots().length}`));
