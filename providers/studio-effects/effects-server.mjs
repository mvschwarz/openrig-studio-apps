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
import { TILE_FAMILIES, PALETTES } from "./engine/tile.mjs";
import { ANALOG_FRAGMENT, ANALOG_VERTEX } from "./engine/analog.mjs";
import { CODEC_FRAGMENT, CODEC_VERTEX } from "./engine/codec.mjs";
import { evalCurves, pulses, ramp, EASING_NAMES } from "./engine/curves.mjs";
import { pcm, envelope, onsets, envelopeTrack, onsetTrack } from "./engine/listen.mjs";
import { cuts, lockLossTrack, frames, smooth } from "./engine/watch.mjs";

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

// THE REVERSE CHANNEL. Every other route here answers a question the surface
// asked. This is the only state where the initiative runs the other way: an agent
// posts what it wants to see, and an ALREADY-OPEN page follows.
//
// That is the difference between an agent that can describe a look and one you can
// watch make it. It was the last missing piece of "agent-drivable" and the only
// genuinely new part of this tier rather than a port.
//
// A GENERATION COUNTER, deliberately, rather than a queue of instructions: the
// surface asks "is there anything newer than what I have?" and applies the latest
// intent. A queue lets a slow page fall behind and then replay stale instructions
// — the same stale-state-with-a-current-label failure the render fence exists to
// prevent, one layer up.
let driveGen = 0, driveOp = null;

// A NEW ID EVERY TIME THIS PROCESS STARTS. The surface watches it and reloads
// itself when it changes, which is what makes a code change visible without the
// person watching having to do anything.
//
// This is the honest signal available here: the studio COPIES surfaces into its
// runtime directory at boot, so edited source only reaches the browser after a
// restart. Watching the file would announce changes the page cannot yet see;
// watching the restart announces exactly the moment new code became servable.
const BOOT = Math.random().toString(36).slice(2, 10);

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

    // See the note on driveGen above. POST to drive an open surface; GET is what
    // the surface polls. Kept tiny on purpose — it carries INTENT, and the surface
    // decides how to realise it, so this never becomes a second renderer.
    if (url.pathname === "/api/effects/drive") {
      if (req.method === "POST") {
        const b = JSON.parse((await readBody(req)) || "{}");
        driveGen += 1;
        driveOp = { gen: driveGen, at: Date.now(), ...b };
        return json(res, 200, { ok: true, gen: driveGen });
      }
      return json(res, 200, { ok: true, gen: driveGen, op: driveOp, boot: BOOT });
    }

    // A CURVE DERIVED FROM THE CLIP'S OWN AUDIO. Everything else here turns an
    // author's intent into keyframes; this turns the material into them.
    //
    // It returns KEYFRAMES, deliberately, rather than a "reactive mode" the
    // renderer would evaluate live. Three reasons, and they are the same reasons
    // the curve engine was keyframes-only from the start: there stays exactly ONE
    // evaluation path, so a derived curve animates identically to a hand-written
    // one; the result is INSPECTABLE, so a person can see what the track heard
    // before committing to a render; and it is EDITABLE, so an agent can generate
    // one and then move a single keyframe rather than arguing with a black box.
    //
    // Reactivity that only exists inside the renderer is reactivity you cannot
    // audit, and this tier has already paid for one handle that reported what the
    // code intended rather than what it did.
    if (url.pathname === "/api/effects/curve/from-audio" && req.method === "POST") {
      const b = JSON.parse((await readBody(req)) || "{}");
      const file = insideMedia(b.source || "");
      if (!file) return json(res, 400, { ok: false, error: `no such source in the media root: ${b.source}` });
      const fam = FAMILIES[b.family || "analog"];
      const spec = fam?.params?.[b.param];
      if (!spec) return json(res, 400, { ok: false, error: `no parameter ${b.param} on family ${b.family}` });

      const a = pcm(file);
      // A source with no audio is a NORMAL answer, not a failure of the feature —
      // said plainly so nobody debugs ffmpeg over it.
      if (!a.ok) return json(res, 200, { ok: false, error: a.error, hasAudio: false });

      const env = envelope(a.samples, a.rate, Number(b.hz) || 30);
      const min = b.min !== undefined ? Number(b.min) : (spec.min ?? 0);
      const max = b.max !== undefined ? Number(b.max) : (spec.max ?? 1);
      const mode = b.mode === "onsets" ? "onsets" : "envelope";
      const hits = onsets(env, { sensitivity: Number(b.sensitivity) || 1.6, minGap: Number(b.minGap) || 0.12 });
      const track = mode === "onsets"
        ? onsetTrack(hits, { min, max, decay: Number(b.decay) || 0.22, dynamics: b.dynamics === undefined ? 1 : Number(b.dynamics), floor: b.floor === undefined ? 0.3 : Number(b.floor), gamma: b.hitGamma === undefined ? 0.6 : Number(b.hitGamma) })
        : envelopeTrack(env, { min, max, gamma: Number(b.gamma) || 1 });

      const gaps = hits.slice(1).map((h, i) => h.t - hits[i].t).sort((x, y) => x - y);
      const median = gaps.length ? gaps[Math.floor(gaps.length / 2)] : null;
      return json(res, 200, {
        ok: true, hasAudio: true, mode, seconds: +a.seconds.toFixed(2),
        onsets: hits.length, medianGap: median ? +median.toFixed(3) : null,
        perMinute: median ? +(60 / median).toFixed(1) : null,
        keyframes: track.length,
        spec: { unit: "seconds", tracks: { [b.param]: track } },
      });
    }

    // A CURVE DERIVED FROM THE EDIT. The companion to from-audio: that one listens
    // to the track, this one watches the picture.
    //
    // Takes SEVERAL tracks in one request on purpose. Losing lock is not one
    // parameter — a receiver dropping sync tears the geometry, unlocks the colour
    // and lifts the noise floor together, and asking the caller to make three
    // requests and keep them in phase would be handing them a job the server can
    // do correctly once.
    if (url.pathname === "/api/effects/curve/from-video" && req.method === "POST") {
      const b = JSON.parse((await readBody(req)) || "{}");
      const file = insideMedia(b.source || "");
      if (!file) return json(res, 400, { ok: false, error: `no such source in the media root: ${b.source}` });
      const fam = FAMILIES[b.family || "analog"];
      if (!fam) return json(res, 400, { ok: false, error: `no family ${b.family}` });

      const mode = ["motion", "brightness"].includes(b.mode) ? b.mode : "cuts";
      const wanted = Array.isArray(b.tracks) ? b.tracks : [];
      const tracks = {};
      const notes = [];
      let found = { cuts: [], threshold: null };

      // MOTION AND BRIGHTNESS ARE CONTINUOUS; CUTS ARE EVENTS. Different shapes,
      // so different track builders — but the SAME percentile normalisation the
      // audio envelope uses, because "map a measured series into a parameter's
      // range without one outlier defining the top" is one problem, not three.
      let series = null;
      if (mode !== "cuts") {
        const f = frames(file, { fps: Number(b.fps) || 15 });
        if (!f.ok) return json(res, 200, { ok: false, error: f.error });
        series = smooth(f.frames, mode, Number(b.smooth) || (mode === "motion" ? 5 : 3));
      } else {
        found = cuts(file, { threshold: b.threshold === undefined ? 0.3 : Number(b.threshold) });
      }

      for (const t of wanted) {
        const spec = fam.params?.[t.param];
        if (!spec) { notes.push(`no parameter ${t.param} on family ${b.family || "analog"}`); continue; }
        const min = t.rest === undefined ? (spec.default ?? spec.min ?? 0) : Number(t.rest);
        const max = t.peak === undefined ? (spec.max ?? 1) : Number(t.peak);
        tracks[t.param] = mode === "cuts"
          ? lockLossTrack(found.cuts, { rest: min, peak: max, recover: t.recover === undefined ? 0.45 : Number(t.recover) })
          : envelopeTrack(series, { min, max, gamma: t.gamma === undefined ? 1 : Number(t.gamma) });
      }
      // A continuous shot is a legitimate thing to point this at, so no cuts is an
      // answer rather than an error — but it is SAID, because a silent empty curve
      // is indistinguishable from a broken one.
      return json(res, 200, {
        ok: true, mode,
        cuts: found.cuts.length, at: found.cuts.map((t) => +t.toFixed(2)), threshold: found.threshold,
        samples: series ? series.length : null, notes,
        note: mode === "cuts" && !found.cuts.length
          ? "no cuts found at this threshold — a continuous shot, or lower the threshold" : null,
        spec: { unit: "seconds", tracks },
      });
    }

    // The shader, served rather than duplicated into the surface. One definition,
    // two consumers.
    if (url.pathname === "/api/effects/shader") {
      const family = url.searchParams.get("family") || "scan";
      const SHADERS = {
        scan:   { vertex: SCAN_VERTEX,   fragment: SCAN_FRAGMENT },
        analog: { vertex: ANALOG_VERTEX, fragment: ANALOG_FRAGMENT },
        codec:  { vertex: CODEC_VERTEX,  fragment: CODEC_FRAGMENT },
      };
      if (!SHADERS[family]) return json(res, 404, { ok: false, error: `no shader for family: ${family}` });
      return json(res, 200, { ok: true, family, ...SHADERS[family] });
    }

    // The engine modules, served so the surface IMPORTS them rather than carrying a
    // copy. Same rule as the shader: one definition, two consumers. The tile maths
    // — linear-light averaging, the quadtree, luminance matching — has to be
    // identical in the interactive preview and in any headless render, and the only
    // way to guarantee that is for there to be one file.
    if (url.pathname.startsWith("/api/effects/engine/")) {
      const name = path.basename(url.pathname);
      if (!/^[a-z-]+\.mjs$/.test(name)) { res.writeHead(400); return res.end("bad module name"); }
      const file = path.join(HERE, "engine", name);
      if (!fs.existsSync(file)) { res.writeHead(404); return res.end("no such module"); }
      res.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-cache" });
      return fs.createReadStream(file).pipe(res);
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

    // A PARAMETER AS A FUNCTION OF TIME, resolved here for the same reason a
    // preset is: so a curve means the same thing to the surface, to an agent, and
    // to a headless render. Evaluating it in the surface would put the definition
    // of "what this look does at 2.5 seconds" in the one place that cannot render
    // the final output.
    //
    // Returns the patch for ONE instant, so the caller layers it over whatever it
    // already has rather than being handed a whole parameter set it did not ask
    // for.
    if (url.pathname === "/api/effects/curve" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const family = body.family || "scan";
      if (!FAMILIES[family]) return json(res, 400, { ok: false, error: `no such effect family: ${family}` });
      const r = evalCurves(body.curves || {}, FAMILIES[family], Number(body.time) || 0, Number(body.duration) || 0);
      return json(res, 200, { ok: true, family, ...r });
    }

    // Generators, served rather than reimplemented by every caller. They emit
    // KEYFRAMES, so what comes back is an ordinary track — there is no second
    // kind of curve that only one consumer understands.
    if (url.pathname === "/api/effects/curve/build" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const kind = body.kind || "pulses";
      try {
        if (kind === "pulses" || kind === "beats") {
          const times = Array.isArray(body.times) ? body.times.map(Number).filter(Number.isFinite) : [];
          if (!times.length) return json(res, 400, { ok: false, error: "times must be a non-empty list of numbers" });
          return json(res, 200, { ok: true, kind, track: pulses(times, body.options || {}) });
        }
        if (kind === "ramp") {
          return json(res, 200, { ok: true, kind, track: ramp(Number(body.from) || 0, Number(body.to) || 0, body.options || {}) });
        }
        return json(res, 400, { ok: false, error: `no such generator: ${kind}`, available: ["pulses", "beats", "ramp"] });
      } catch (e) { return json(res, 400, { ok: false, error: String(e.message || e) }); }
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
          else if (/\.(png|jpe?g|webp|gif|mp4|mov|webm|m4v)$/i.test(e.name)) out.push(path.relative(MEDIA, full));
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
      const TYPES = { ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif",
                      ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
                      ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm" };
      const type = TYPES[ext] || "application/octet-stream";
      const size = fs.statSync(real).size;

      // RANGE REQUESTS, because video needs them. A browser will not scrub — often
      // will not even start — a video served as one opaque blob, and the failure
      // looks like a broken file rather than a missing header.
      const range = req.headers.range;
      if (range && /^bytes=\d*-\d*$/.test(range)) {
        const [s0, s1] = range.replace("bytes=", "").split("-");
        const start = s0 ? Number(s0) : 0;
        const end = s1 ? Math.min(Number(s1), size - 1) : size - 1;
        if (start >= size || start > end) {
          res.writeHead(416, { "content-range": `bytes */${size}` }); return res.end();
        }
        res.writeHead(206, {
          "content-type": type, "content-length": end - start + 1,
          "content-range": `bytes ${start}-${end}/${size}`, "accept-ranges": "bytes",
        });
        return fs.createReadStream(real, { start, end }).pipe(res);
      }
      res.writeHead(200, { "content-type": type, "content-length": size,
                           "accept-ranges": "bytes", "cache-control": "no-cache" });
      return fs.createReadStream(real).pipe(res);
    }

    res.writeHead(404); res.end();
  } catch (e) { json(res, 500, { ok: false, error: String(e.message || e) }); }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`studio-effects: http://127.0.0.1:${PORT}/  families=${Object.keys(FAMILIES).join(",")}${MEDIA ? ` media=${MEDIA}` : " (no media root)"}`);
});
