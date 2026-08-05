#!/usr/bin/env node
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const PORT = Number(arg("--port", 8798));
const ROOT = path.resolve(arg("--root", "./artifacts"));
fs.mkdirSync(ROOT, { recursive: true });

const json = (res, code, value) => {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
};
const readBody = (req) => new Promise((resolve, reject) => {
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
    if (body.length > 8_000_000) reject(new Error("request body is too large"));
  });
  req.on("end", () => resolve(body));
  req.on("error", reject);
});
const safeId = (value) => {
  const id = String(value || "").trim();
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(id) ? id : null;
};
const artifactDir = (id) => path.join(ROOT, id);
const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
};
const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
const metaFor = (id) => readJson(path.join(artifactDir(id), "meta.json"), null);
const list = () => fs.readdirSync(ROOT, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && safeId(entry.name))
  .map((entry) => metaFor(entry.name))
  .filter(Boolean)
  .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
const annotationsFor = (id) => readJson(path.join(artifactDir(id), "annotations.json"), []);
const normaliseAnnotation = (input, existing = {}) => ({
  id: String(input.id || existing.id || crypto.randomUUID()),
  shape: ["circle", "rect", "free"].includes(input.shape) ? input.shape : (existing.shape || "circle"),
  note: String(input.note ?? existing.note ?? "").trim(),
  source: input.source === "agent" ? "agent" : (existing.source || "human"),
  selector: input.selector == null ? (existing.selector || null) : String(input.selector || "").trim() || null,
  tag: input.tag == null ? (existing.tag || null) : String(input.tag || "").toLowerCase() || null,
  text: input.text == null ? (existing.text || null) : String(input.text || "").trim().slice(0, 240) || null,
  anchor: input.anchor && ["x", "y", "width", "height"].every((k) => Number.isFinite(Number(input.anchor[k])))
    ? Object.fromEntries(["x", "y", "width", "height"].map((k) => [k, Number(input.anchor[k])]))
    : (existing.anchor || null),
  points: Array.isArray(input.points) ? input.points.slice(0, 240).map((p) => [Number(p[0]), Number(p[1])]) : (existing.points || null),
  status: input.status === "missing" ? "missing" : (input.status === "anchored" ? "anchored" : (existing.status || (input.selector ? "missing" : "spatial"))),
  createdAt: existing.createdAt || new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://artifacts.local");
  try {
    if (url.pathname === "/") return json(res, 200, { ok: true, provider: "@openrig/studio-artifacts", root: ROOT });

    if (url.pathname === "/api/artifacts" && req.method === "GET") {
      return json(res, 200, { ok: true, artifacts: list() });
    }
    if (url.pathname === "/api/artifacts" && req.method === "POST") {
      const input = JSON.parse((await readBody(req)) || "{}");
      const id = safeId(input.id);
      if (!id) return json(res, 400, { ok: false, error: "id must use lowercase letters, numbers and hyphens" });
      const dir = artifactDir(id);
      if (fs.existsSync(dir)) return json(res, 409, { ok: false, error: `artifact ${id} already exists` });
      fs.mkdirSync(dir, { recursive: true });
      const now = new Date().toISOString();
      const meta = { id, name: String(input.name || id).trim().slice(0, 120), createdAt: now, updatedAt: now };
      fs.writeFileSync(path.join(dir, "artifact.html"), String(input.html || ""));
      writeJson(path.join(dir, "meta.json"), meta);
      writeJson(path.join(dir, "annotations.json"), []);
      return json(res, 201, { ok: true, artifact: meta });
    }

    if (url.pathname === "/api/artifacts/item") {
      const id = safeId(url.searchParams.get("id"));
      if (!id || !metaFor(id)) return json(res, 404, { ok: false, error: "artifact not found" });
      if (req.method === "GET") return json(res, 200, {
        ok: true,
        artifact: metaFor(id),
        html: fs.readFileSync(path.join(artifactDir(id), "artifact.html"), "utf8"),
      });
      if (req.method === "POST") {
        const input = JSON.parse((await readBody(req)) || "{}");
        if (typeof input.html !== "string") return json(res, 400, { ok: false, error: "html is required" });
        fs.writeFileSync(path.join(artifactDir(id), "artifact.html"), input.html);
        const meta = { ...metaFor(id), name: String(input.name || metaFor(id).name).trim().slice(0, 120), updatedAt: new Date().toISOString() };
        writeJson(path.join(artifactDir(id), "meta.json"), meta);
        return json(res, 200, { ok: true, artifact: meta });
      }
    }

    if (url.pathname === "/api/artifacts/annotations") {
      const id = safeId(url.searchParams.get("artifact"));
      if (!id || !metaFor(id)) return json(res, 404, { ok: false, error: "artifact not found" });
      if (req.method === "GET") return json(res, 200, { ok: true, artifact: id, annotations: annotationsFor(id) });
      if (req.method === "POST") {
        const input = JSON.parse((await readBody(req)) || "{}");
        const annotations = annotationsFor(id);
        const at = annotations.findIndex((item) => item.id === input.id);
        const annotation = normaliseAnnotation(input, at >= 0 ? annotations[at] : {});
        if (at >= 0) annotations[at] = annotation; else annotations.push(annotation);
        writeJson(path.join(artifactDir(id), "annotations.json"), annotations);
        return json(res, at >= 0 ? 200 : 201, { ok: true, annotation });
      }
    }

    if (url.pathname === "/api/artifacts/screenshot") {
      const id = safeId(url.searchParams.get("artifact"));
      if (!id || !metaFor(id)) return json(res, 404, { ok: false, error: "artifact not found" });
      const file = path.join(artifactDir(id), "screenshot.svg");
      if (req.method === "POST") {
        const input = JSON.parse((await readBody(req)) || "{}");
        if (!String(input.svg || "").startsWith("<svg")) return json(res, 400, { ok: false, error: "svg screenshot is required" });
        fs.writeFileSync(file, input.svg);
        return json(res, 200, { ok: true, path: `/api/artifacts/screenshot?artifact=${id}` });
      }
      if (!fs.existsSync(file)) return json(res, 404, { ok: false, error: "no rendered screenshot yet" });
      res.writeHead(200, { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "no-store" });
      return fs.createReadStream(file).pipe(res);
    }

    if (url.pathname.startsWith("/artifacts/")) {
      const match = url.pathname.match(/^\/artifacts\/([a-z0-9][a-z0-9-]{0,63})\/artifact\.html$/);
      if (!match || !metaFor(match[1])) { res.writeHead(404); return res.end("artifact not found"); }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return fs.createReadStream(path.join(artifactDir(match[1]), "artifact.html")).pipe(res);
    }
    res.writeHead(404); res.end();
  } catch (error) {
    json(res, 500, { ok: false, error: String(error.message || error) });
  }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`studio-artifacts: http://127.0.0.1:${PORT}/ root=${ROOT}`);
});
