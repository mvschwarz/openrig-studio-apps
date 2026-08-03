#!/usr/bin/env node
// EFFECTS BACKEND. Serves the parameter schema, resolves presets, and hands the
// shader source to whoever is rendering.
//
// WHAT THIS DELIBERATELY DOES NOT DO YET: render. Preview happens in the browser,
// where the frame is already on the GPU and a round trip per parameter change
// would make the thing feel dead. Headless export belongs here and is the next
// piece; the shader source is exported from engine/ specifically so that when
// export lands it renders from THE SAME GLSL the preview was approved from.
//
// Two copies of that string is the worst bug an effects tool can have, because it
// shows up only after someone commits to a render.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FAMILIES, coerce, applyPreset } from "./engine/schema.mjs";
import { SCAN_FRAGMENT, SCAN_VERTEX, buildPath } from "./engine/scan.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const PORT = Number(arg("--port", 8899));
const MEDIA = (arg("--media", "") || "").replace(/^~/, process.env.HOME || "~");

const json = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body, null, 2));
};
const readBody = (req) => new Promise((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => r(b)); });

// Only ever inside the declared media root, resolved AFTER the input is
// incorporated rather than validated as a string beforehand. A validated input is
// not a validated path.
function insideMedia(rel) {
  if (!MEDIA) return null;
  const full = path.resolve(MEDIA, String(rel || "").replace(/^\/+/, ""));
  const root = fs.realpathSync(MEDIA);
  let real;
  try { real = fs.realpathSync(full); } catch { return null; }
  return real.startsWith(root + path.sep) || real === root ? real : null;
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (url.pathname === "/") return json(res, 200, { ok: true, provider: "@openrig/studio-effects" });

    // THE AGENT-DRIVABILITY SEAM. Everything an agent needs to drive every effect
    // without reading our source: the knobs, their ranges, what each one means in
    // plain words, the named looks, and the disambiguation notes for vague asks.
    if (url.pathname === "/api/effects/families") {
      return json(res, 200, { ok: true, families: FAMILIES });
    }

    // The shader, served rather than duplicated into the surface. One definition,
    // two consumers.
    if (url.pathname === "/api/effects/shader") {
      const family = url.searchParams.get("family") || "scan";
      if (family !== "scan") return json(res, 404, { ok: false, error: `no shader for family: ${family}` });
      return json(res, 200, { ok: true, family, vertex: SCAN_VERTEX, fragment: SCAN_FRAGMENT });
    }

    // Resolve parameters without rendering anything. This is what an agent calls
    // to find out what a request actually became — including what got clamped,
    // which is how it learns the edges rather than guessing at them.
    if (url.pathname === "/api/effects/resolve" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const family = body.family || "scan";
      const r = body.preset ? applyPreset(family, body.preset) : coerce(family, body.params || {});
      if (r.error) return json(res, 400, { ok: false, ...r });
      return json(res, 200, { ok: true, family, preset: body.preset ?? null, ...r });
    }

    // The displacement path, computed here so the surface and any headless render
    // agree on it exactly. It is data — which is the whole reason an agent, a
    // keyframe track or an audio envelope can supply one.
    if (url.pathname === "/api/effects/path" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const r = coerce("scan", body.params || {});
      if (r.error) return json(res, 400, { ok: false, ...r });
      const len = Math.min(4096, Math.max(2, Number(body.length) || 1024));
      return json(res, 200, { ok: true, length: len, path: Array.from(buildPath(len, r.params)), notes: r.notes });
    }

    // Images the surface may load. Declared root only, and the listing is honest
    // about being empty rather than silently returning nothing.
    if (url.pathname === "/api/effects/sources") {
      if (!MEDIA) return json(res, 200, { ok: true, sources: [], note: "no media root bound on this box" });
      const walk = (dir, depth = 0) => {
        if (depth > 2) return [];
        let out = [];
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          if (e.name.startsWith(".")) continue;
          const full = path.join(dir, e.name);
          if (e.isDirectory()) out = out.concat(walk(full, depth + 1));
          else if (/\.(png|jpe?g|webp|gif)$/i.test(e.name)) out.push(path.relative(MEDIA, full));
        }
        return out;
      };
      try { return json(res, 200, { ok: true, sources: walk(MEDIA).slice(0, 400) }); }
      catch (e) { return json(res, 200, { ok: true, sources: [], note: String(e.message) }); }
    }

    // Byte route for the image itself.
    if (url.pathname.startsWith("/media/")) {
      const real = insideMedia(decodeURIComponent(url.pathname.slice("/media/".length)));
      if (!real || !fs.existsSync(real)) { res.writeHead(404); return res.end("not found"); }
      const ext = path.extname(real).toLowerCase();
      const type = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp"
                 : ext === ".gif" ? "image/gif" : "image/jpeg";
      res.writeHead(200, { "content-type": type, "cache-control": "no-cache" });
      return fs.createReadStream(real).pipe(res);
    }

    res.writeHead(404); res.end();
  } catch (e) { json(res, 500, { ok: false, error: String(e.message || e) }); }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`studio-effects: http://127.0.0.1:${PORT}/  families=${Object.keys(FAMILIES).join(",")}${MEDIA ? ` media=${MEDIA}` : " (no media root)"}`);
});
