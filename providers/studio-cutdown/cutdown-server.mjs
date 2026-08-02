#!/usr/bin/env node
// CUTDOWN server — the punch-in/out review surface's backend.
// Serves proxies with Range support, persists attributed markers (JSONL,
// durable-first), lists clips. Attribution: Cf-Access-Authenticated-User-Email
// (the Access gateway injects it) -> "<user>-ui"; falls back to "local-ui".
// Usage: node cutdown-server.mjs [--port 8795] [--footage ~/studio/footage]
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf("--" + k); return i > -1 ? process.argv[i + 1] : d; };
const PORT = Number(arg("port", 8795));
// DE-BESPOKED (rig-studio port): point this at ANY folder of video files.
// --footage is the input; everything else derives from it so the tool is
// self-contained on any project.
const FOOTAGE = arg("footage", path.join(os.homedir(), "openrig-videos", "footage")).replace(/^~/, os.homedir());
const PROXIES = path.join(FOOTAGE, "proxies");
const MARKERS = path.join(FOOTAGE, "markers.jsonl");
// was: a single hardcoded project — the single project this was built for.
// Renders now land beside the footage being cut unless a bundle is named.
const BUNDLE = arg("bundle", FOOTAGE);
const RENDERS = path.join(BUNDLE, "media", "renders");
const STABJOBS = path.join(FOOTAGE, "stab-jobs.jsonl");
const PICKS = path.join(FOOTAGE, "picks.jsonl");

const send = (res, code, body, type = "application/json") => {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
};

function attribution(req) {
  const email = req.headers["cf-access-authenticated-user-email"];
  return email ? `${String(email).split("@")[0].replace(/[^a-z0-9.]/gi, "")}-ui` : "local-ui";
}

function readMarkers() {
  if (!fs.existsSync(MARKERS)) return [];
  return fs.readFileSync(MARKERS, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const p = u.pathname;

  // THE PROVIDER NO LONGER SERVES THE SURFACE, AND MUST NOT CRASH SAYING SO.
  //
  // In studio-box this file sat next to cutdown.html and served it. After the
  // split the surface lives in the APP (apps/cutdown/app/cutdown.html) and the
  // studio shell serves it; this path was left reaching for a sibling that is
  // no longer there. A synchronous readFileSync on a missing file inside the
  // request handler threw an UNCAUGHT ENOENT, which killed the listener and
  // exited the process — so ONE GET to the provider's own landing route took
  // the whole cutdown backend down. Reproduced twice.
  //
  // Answering honestly is the fix; a try/catch that returned 500 would leave a
  // route pretending it still serves an app it does not own.
  if (p === "/" || p === "/cutdown.html") {
    return send(res, 200, {
      ok: true,
      provider: "@openrig/studio-cutdown",
      note: "This is the cutdown PROVIDER, not the surface. The studio shell serves the surface; this process serves /api/*, /media/, /cutprev/ and /cuts/.",
      footage: FOOTAGE,
    });
  }

  if (p === "/api/clips") {
    // DE-BESPOKED: clips used to come ONLY from <footage>/proxies, which
    // assumed the proxy-generation workflow the original project had. Point
    // --footage at any folder of video and it works; a proxies/ dir is still
    // preferred when present, so existing setups behave exactly as before.
    let names = [];
    const readDir = (d) => {
      try { return fs.readdirSync(d).filter((f) => /\.(mp4|MP4|mov|MOV|webm)$/.test(f)).sort(); }
      catch { return []; }
    };
    names = readDir(PROXIES);
    if (!names.length) names = readDir(FOOTAGE);
    const marks = readMarkers();
    const perClip = {};
    for (const m of marks) if (!m.deleted) perClip[m.clip] = (perClip[m.clip] || 0) + 1;
    const deleted = new Set(marks.filter((m) => m.deleted).map((m) => m.ref));
    for (const d of deleted) { const m = marks.find((x) => x.id === d); if (m) perClip[m.clip] = Math.max(0, (perClip[m.clip] || 1) - 1); }
    return send(res, 200, { clips: names.map((n) => ({ name: n, markers: perClip[n] || 0 })) });
  }

  if (p === "/api/markers" && req.method === "GET") {
    const all = readMarkers();
    const deleted = new Set(all.filter((m) => m.deleted).map((m) => m.ref));
    // note_edit records overlay the referenced marker's note (append-only rails)
    const notes = {};
    for (const m of all) if (m.note_edit && m.ref) notes[m.ref] = m.note;
    return send(res, 200, { markers: all.filter((m) => !m.deleted && !m.note_edit && !deleted.has(m.id))
      .map((m) => notes[m.id] != null ? { ...m, note: notes[m.id] } : m) });
  }

  if (p === "/api/markers" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const m = JSON.parse(body);
        // guard: a live marker needs a real range; only deletion records skip it
        if (!m.deleted && (m.in_s == null || m.out_s == null || Number(m.out_s) <= Number(m.in_s))) {
          return send(res, 400, { ok: false, error: "marker needs in_s < out_s" });
        }
        const rec = {
          id: `mk-${Date.now()}-${Math.floor(Math.random() * 1e4)}`,
          ts: new Date().toISOString(),
          by: attribution(req),
          clip: String(m.clip || ""),
          in_s: m.in_s == null ? null : Number(m.in_s),
          out_s: m.out_s == null ? null : Number(m.out_s),
          note: String(m.note || "").slice(0, 2000),
          deleted: m.deleted ? true : undefined,
          ref: m.ref || undefined,   // for deletion records: id being deleted
        };
        fs.appendFileSync(MARKERS, JSON.stringify(rec) + "\n");
        send(res, 200, { ok: true, marker: rec });
      } catch (e) { send(res, 400, { ok: false, error: String(e) }); }
    });
    return;
  }

  if (p === "/api/cuts") {
    // The version model (the curation design language): each cut has
    // up to N VERSIONS living side by side on disk — ORIGINAL plus one per
    // smoothing level (-stab-<level>.mp4; bare -stab.mp4 = legacy single-
    // version era). Three separate concepts the UI renders per cut:
    // which versions EXIST, which one is WATCHED, which one is LOCKED (the
    // curation pick — picks.jsonl, latest wins).
    let allFiles = [];
    try { allFiles = fs.readdirSync(RENDERS).filter((f) => /^cut-.*\.mp4$/.test(f)); } catch {}
    const files = allFiles.filter((f) => !/-stab(-\w+)?\.mp4$/.test(f));
    const jobs = fs.existsSync(STABJOBS) ? fs.readFileSync(STABJOBS, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
    const picks = fs.existsSync(PICKS) ? fs.readFileSync(PICKS, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
    const pickFor = {};
    for (const pk of picks) pickFor[pk.clip] = pk.choice === "stabilized" ? "smoothed" : pk.choice;
    const readMeta = (fname) => {
      try { return JSON.parse(fs.readFileSync(path.join(RENDERS, fname.replace(/\.mp4$/, ".json")), "utf8")); } catch { return null; }
    };
    const _all = readMarkers();
    const _dead = new Set(_all.filter((m) => m.deleted).map((m) => m.ref));
    const marks = _all.filter((m) => !m.deleted && !_dead.has(m.id) && m.out_s != null);
    // ONE note source: the marker log with note_edits applied — the cut
    // sidecar's copy is fallback only (copies drift; the log doesn't)
    const noteOf = {};
    for (const m of marks) noteOf[m.id] = m.note || "";
    for (const m of _all) if (m.note_edit && m.ref) noteOf[m.ref] = m.note || "";
    const cutTags = new Set(files.map((f) => f));
    const LEVEL_KEYS = ["light", "medium", "strong", "locked"];
    const cuts = files.sort().map((f) => {
      let side = {};
      try { side = JSON.parse(fs.readFileSync(path.join(RENDERS, f.replace(/\.mp4$/, ".marker.json")), "utf8")); } catch {}
      const base = f.replace(/\.mp4$/, "");
      const versions = [{ key: "original", file: f }];
      let latestStabAt = null;
      const legacy = `${base}-stab.mp4`;
      if (allFiles.includes(legacy)) {
        const meta = readMeta(legacy);
        let at = null;
        try { at = fs.statSync(path.join(RENDERS, legacy)).mtime.toISOString(); } catch {}
        versions.push({ key: "smoothed", file: legacy, meta, at });
        latestStabAt = at;
      }
      for (const lvl of LEVEL_KEYS) {
        const vf = `${base}-stab-${lvl}.mp4`;
        if (allFiles.includes(vf)) {
          let at = null;
          try { at = fs.statSync(path.join(RENDERS, vf)).mtime.toISOString(); } catch {}
          versions.push({ key: lvl, file: vf, meta: readMeta(vf), at });
          if (at && (!latestStabAt || at > latestStabAt)) latestStabAt = at;
        } else {
          // queued/in-flight for this level? (latest job per clip+level)
          const queued = jobs.filter((j) => j.clip === f && (j.level || "medium") === lvl).pop();
          if (queued) {
            let prog = null;
            try { prog = Number(fs.readFileSync(path.join(RENDERS, `${base}.stabprogress-${lvl}`), "utf8").trim()); } catch {}
            if (prog != null && !Number.isNaN(prog)) versions.push({ key: lvl, queued: true, progress: prog });
            else if (Date.now() - Date.parse(queued.ts || 0) < 30 * 60 * 1000) versions.push({ key: lvl, queued: true, progress: null });
          }
        }
      }
      return { file: f, note: (side.marker && noteOf[side.marker] != null ? noteOf[side.marker] : side.note) || "",
        by: side.by || "", src: side.src || "",
        in_s: side.in_s, out_s: side.out_s, cut_at: side.cut_at || null,
        versions, stab_at: latestStabAt,
        stabilized: versions.length > 1, pick: pickFor[f] || null };
    });
    // markers whose cut hasn't landed yet = cutting, unless the lane marked
    // them FAILED (.cutfail.json sidecar) or a UI deletion retired them
    // (cut-deletions.jsonl newer than the marker — mirrors cut-clips.mjs)
    let cutDels = [];
    try { cutDels = fs.readFileSync(path.join(FOOTAGE, "cut-deletions.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch {}
    const latestDel = {};
    for (const d of cutDels) if (!latestDel[d.clip] || d.ts > latestDel[d.clip]) latestDel[d.clip] = d.ts;
    const cutting = [], failedCuts = [];
    for (const m of marks) {
      const base = m.clip.replace(/\.(mp4|MP4)$/, "");
      const tag = `${base}-${Number(m.in_s).toFixed(1)}-${Number(m.out_s).toFixed(1)}`.replace(/\./g, "_");
      if (cutTags.has(`cut-${tag}.mp4`)) continue;
      const delTs = latestDel[`cut-${tag}.mp4`];
      if (delTs && delTs > (m.ts || "")) continue;   // retired by deletion
      let fail = null;
      try { fail = JSON.parse(fs.readFileSync(path.join(RENDERS, `cut-${tag}.cutfail.json`), "utf8")); } catch {}
      const item = { marker: m.id, clip: m.clip, in_s: m.in_s, out_s: m.out_s, by: m.by };
      if (fail && fail.attempts >= 3) failedCuts.push({ ...item, tag, attempts: fail.attempts, error: fail.last_error || "" });
      else cutting.push(item);
    }
    return send(res, 200, { cuts, cutting, failed: failedCuts });
  }

  if (p === "/api/stabilize" && req.method === "POST") {
    // level -> the user-facing smoothing dial (the user experiments, we don't
    // fine-tune): light/medium/strong = trajectory window; locked = tripod.
    // redo:true archives the existing smooth so the watcher regenerates it
    // at the new level.
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const j = JSON.parse(body);
        const clip = path.basename(String(j.clip));
        const LEVELS = { light: { smoothing: 6 }, medium: { smoothing: 12 },
                         strong: { smoothing: 24 }, locked: { smoothing: 12, tripod: true } };
        const level = LEVELS[j.level] ? String(j.level) : "medium";
        const s = LEVELS[level];
        // versions live side by side; re-running an existing level archives
        // just that level's files and regenerates it
        const verName = clip.replace(/\.mp4$/, `-stab-${level}.mp4`);
        if (fs.existsSync(path.join(RENDERS, verName))) {
          const trash = path.join(BUNDLE, "archive", "cuts");
          fs.mkdirSync(trash, { recursive: true });
          const stamp = new Date().toISOString().replace(/[:.]/g, "-");
          for (const [dir, name] of [[RENDERS, verName],
                                     [path.join(RENDERS, "previews"), verName],
                                     [RENDERS, verName.replace(/\.mp4$/, ".json")]]) {
            const f = path.join(dir, name);
            if (fs.existsSync(f)) fs.renameSync(f, path.join(trash, `${stamp}-${path.basename(dir) === "previews" ? "preview-" : ""}${name}`));
          }
        }
        fs.appendFileSync(STABJOBS, JSON.stringify({ clip, level, smoothing: s.smoothing,
          tripod: !!s.tripod, ts: new Date().toISOString(), by: attribution(req) }) + "\n");
        send(res, 200, { ok: true, level });
      } catch (e) { send(res, 400, { ok: false, error: String(e) }); }
    });
    return;
  }

  if (p === "/api/pick" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const j = JSON.parse(body);
        // choice = version key: original | light | medium | strong | locked |
        // smoothed (legacy) — the 🔒 lock act of curation
        const OK = new Set(["original", "light", "medium", "strong", "locked", "smoothed", "stabilized"]);
        const choice = OK.has(j.choice) ? (j.choice === "stabilized" ? "smoothed" : j.choice) : "original";
        fs.appendFileSync(PICKS, JSON.stringify({ clip: path.basename(String(j.clip)), choice, ts: new Date().toISOString(), by: attribution(req) }) + "\n");
        send(res, 200, { ok: true });
      } catch (e) { send(res, 400, { ok: false, error: String(e) }); }
    });
    return;
  }

  if (p === "/api/cut-note" && req.method === "POST") {
    // edit/add a note AFTER the cut exists (the primary flow: punch fast,
    // name on review). Updates the cut's sidecar (display source) and
    // appends an attributed note_edit record to markers.jsonl (durable
    // provenance; also nudges the watcher to refresh the asset index).
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const j = JSON.parse(body);
        const clip = path.basename(String(j.clip));
        const note = String(j.note || "").slice(0, 2000);
        const sidePath = path.join(RENDERS, clip.replace(/\.mp4$/, ".marker.json"));
        let side = {};
        try { side = JSON.parse(fs.readFileSync(sidePath, "utf8")); } catch {}
        side.note = note;
        fs.writeFileSync(sidePath, JSON.stringify(side, null, 1));
        fs.appendFileSync(MARKERS, JSON.stringify({
          id: `mk-${Date.now()}-${Math.floor(Math.random() * 1e4)}`,
          ts: new Date().toISOString(), by: attribution(req),
          note_edit: true, ref: side.marker || null, clip: side.src || null,
          in_s: null, out_s: null, note,
        }) + "\n");
        send(res, 200, { ok: true });
      } catch (e) { send(res, 400, { ok: false, error: String(e) }); }
    });
    return;
  }

  if (p === "/api/cut-retry" && req.method === "POST") {
    // clear a FAILED cut's sidecar so the watcher's next sweep retries it
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const j = JSON.parse(body);
        const tag = path.basename(String(j.tag)).replace(/[^A-Za-z0-9_\-]/g, "");
        fs.rmSync(path.join(RENDERS, `cut-${tag}.cutfail.json`), { force: true });
        send(res, 200, { ok: true });
      } catch (e) { send(res, 400, { ok: false, error: String(e) }); }
    });
    return;
  }

  if (p === "/api/cut-delete" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const j = JSON.parse(body);
        const name = path.basename(String(j.clip));
        const trash = path.join(BUNDLE, "archive", "cuts");
        fs.mkdirSync(trash, { recursive: true });
        let moved = [];
        for (const suffix of [".mp4", "-stab.mp4", "-stab.json", ".marker.json", ".stabprogress"]) {
          const f = path.join(RENDERS, name.replace(/\.mp4$/, "") + suffix);
          if (fs.existsSync(f)) { fs.renameSync(f, path.join(trash, path.basename(f))); moved.push(path.basename(f)); }
        }
        fs.appendFileSync(path.join(FOOTAGE, "cut-deletions.jsonl"),
          JSON.stringify({ clip: name, moved, ts: new Date().toISOString(), by: attribution(req) }) + "\n");
        send(res, 200, { ok: true, moved });
      } catch (e) { send(res, 400, { ok: false, error: String(e) }); }
    });
    return;
  }

  if (p.startsWith("/master/")) {
    // deliberate master movement (doctrine: masters move on purpose, never
    // by default) — full-res download of a cut for external editors
    const name = path.basename(decodeURIComponent(p.slice(8)));
    if (!/^cut-[\w\-]+\.mp4$/.test(name)) return send(res, 400, { error: "bad name" });
    const f = path.join(RENDERS, name);
    if (!fs.existsSync(f)) return send(res, 404, { error: "no such master" });
    res.writeHead(200, { "content-type": "video/mp4",
      "content-length": fs.statSync(f).size,
      "content-disposition": `attachment; filename="${name}"` });
    fs.createReadStream(f).pipe(res);
    return;
  }

  if (p.startsWith("/cutprev/")) {
    const name = path.basename(decodeURIComponent(p.slice(9)));
    const prev = path.join(RENDERS, "previews", name);
    const file = fs.existsSync(prev) ? prev : path.join(RENDERS, name);  // fallback: full file
    if (!file.startsWith(RENDERS) || !fs.existsSync(file)) return send(res, 404, { error: "not found" });
    if (u.searchParams.get("dl")) {
      // lightweight download lane (the compressed sibling of /master/)
      res.writeHead(200, { "content-type": "video/mp4", "content-length": fs.statSync(file).size,
        "content-disposition": `attachment; filename="${name.replace(/\.mp4$/, "-preview.mp4")}"` });
      fs.createReadStream(file).pipe(res);
      return;
    }
    const stat = fs.statSync(file);
    const range = req.headers.range;
    if (range) {
      const m2 = range.match(/bytes=(\d+)-(\d*)/);
      const start = Number(m2[1]);
      const end = m2[2] ? Number(m2[2]) : Math.min(start + 4 * 1024 * 1024, stat.size - 1);
      res.writeHead(206, { "content-range": `bytes ${start}-${end}/${stat.size}`, "accept-ranges": "bytes",
        "content-length": end - start + 1, "content-type": "video/mp4" });
      fs.createReadStream(file, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { "content-length": stat.size, "content-type": "video/mp4", "accept-ranges": "bytes" });
      fs.createReadStream(file).pipe(res);
    }
    return;
  }

  if (p.startsWith("/cuts/")) {
    const name = path.basename(decodeURIComponent(p.slice(6)));
    const file = path.join(RENDERS, name);
    if (!file.startsWith(RENDERS) || !fs.existsSync(file)) return send(res, 404, { error: "not found" });
    const stat = fs.statSync(file);
    const range = req.headers.range;
    if (range) {
      const m2 = range.match(/bytes=(\d+)-(\d*)/);
      const start = Number(m2[1]);
      const end = m2[2] ? Number(m2[2]) : Math.min(start + 4 * 1024 * 1024, stat.size - 1);
      res.writeHead(206, { "content-range": `bytes ${start}-${end}/${stat.size}`, "accept-ranges": "bytes",
        "content-length": end - start + 1, "content-type": "video/mp4" });
      fs.createReadStream(file, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { "content-length": stat.size, "content-type": "video/mp4", "accept-ranges": "bytes" });
      fs.createReadStream(file).pipe(res);
    }
    return;
  }

  if (p.startsWith("/media/")) {
    const name = path.basename(decodeURIComponent(p.slice(7)));
    // DE-BESPOKED: served ONLY from <footage>/proxies, so footage sitting
    // directly in the root was LISTED by /api/clips (which was de-bespoked
    // earlier) and then 404'd on playback — listed and unplayable. Same
    // proxies-only assumption, one layer down, and it survived the first pass
    // because the two halves were fixed in different files.
    const candidates = [path.join(PROXIES, name), path.join(FOOTAGE, name)];
    const file = candidates.find((c) =>
      (c.startsWith(PROXIES) || c.startsWith(FOOTAGE)) && fs.existsSync(c));
    if (!file) return send(res, 404, { error: "not found" });
    const stat = fs.statSync(file);
    const range = req.headers.range;
    if (range) {
      const m = range.match(/bytes=(\d+)-(\d*)/);
      const start = Number(m[1]);
      const end = m[2] ? Number(m[2]) : Math.min(start + 4 * 1024 * 1024, stat.size - 1);
      res.writeHead(206, {
        "content-range": `bytes ${start}-${end}/${stat.size}`,
        "accept-ranges": "bytes",
        "content-length": end - start + 1,
        "content-type": "video/mp4",
      });
      fs.createReadStream(file, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { "content-length": stat.size, "content-type": "video/mp4", "accept-ranges": "bytes" });
      fs.createReadStream(file).pipe(res);
    }
    return;
  }

  send(res, 404, { error: "not found" });
}).listen(PORT, "127.0.0.1", () => console.log(`cutdown: http://127.0.0.1:${PORT}/ footage=${FOOTAGE}`));
