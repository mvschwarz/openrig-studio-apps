#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { materializeCards, mediaKind as mediaKindOf, planExport, readTimelineFile, resolveRefPath } from "./timeline-export-core.mjs";
import { resolveSystemBin, validatePlanWithProbes } from "./timeline-export-probe.mjs";
import { staticResponseHeaders } from "./timeline-export-static.mjs";
import {
  analyzeTimelineAudio,
  maybeReadText,
  readJsonFile,
} from "./timeline-audio-validation.mjs";
import { applyPatch, validatePatch } from "./timeline-patch.mjs";
import { appendEvents, bootstrapHistory, cardSnapshot, defaultPaths as historyPaths, eventTimestamp, makeEventId, readHistory, rebuildSlots, slotUidFor } from "./timeline-history.mjs";
import os from "node:os";
import { defaultAssetPaths, generateProjectAssets, isAllowlisted, loadAllowlist, resolveRoots } from "./project-assets.mjs";
import { runReconform } from "./timeline-reconform.mjs";
import { checkBundle, loadTemplates, REVIEW_LANES } from "./studio-bundle.mjs";
import { computeHealth } from "./health.mjs";
import { applyCanvas, readCanvas } from "./canvas-rails.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SLICE_ROOT = path.resolve(__dirname, "../..");
const jobs = new Map();

function parseArgs(argv) {
  const args = {
    port: 8792,
    host: "127.0.0.1",
    sliceRoot: DEFAULT_SLICE_ROOT,
    timeline: path.join(DEFAULT_SLICE_ROOT, "timeline.json"),
    mediaRoots: [],
    canvasRoot: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--port") args.port = Number(argv[++i]);
    else if (arg === "--host") args.host = argv[++i];
    else if (arg === "--slice-root") args.sliceRoot = argv[++i];
    else if (arg === "--canvas-root") args.canvasRoot = argv[++i];
    else if (arg === "--timeline") { args.timeline = argv[++i]; args.timelineExplicit = true; }
    else if (arg === "--media-root") args.mediaRoots.push(argv[++i]);
    else if (arg === "-h" || arg === "--help") {
      console.log("Usage: node export-server.mjs [--port 8792] [--slice-root <slice>] [--canvas-root <dir>] [--timeline <timeline.json>] [--media-root <dir>]...");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!args.mediaRoots.length) {
    args.mediaRoots = [path.join(os.homedir(), "openrig-videos")];
  }
  // footgun fix: --slice-root without --timeline serves the
  // slice root's OWN timeline, not the tools-home one
  if (!args.timelineExplicit) args.timeline = path.join(args.sliceRoot, "timeline.json");
  // canvases live BESIDE the projects (product note: the canvas is a general tool,
  // not a per-project one) — workspace/canvases on a box
  if (!args.canvasRoot) args.canvasRoot = path.resolve(args.sliceRoot, "..", "canvases");
  return args;
}

const args = parseArgs(process.argv.slice(2));

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
  });
  res.end(body);
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".js" || ext === ".mjs") return "text/javascript; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".mp4") return "video/mp4";
  if (ext === ".mp3") return "audio/mpeg";
  if (ext === ".m4a") return "audio/mp4";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "application/octet-stream";
}

const APP_SHELLS = new Set(["mini-nle.html", "timeline-viewer.html", "media-manager.html", "canvas.html"]);

function safeStaticPath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const rel = decoded === "/" ? "timeline-viewer.html" : decoded.replace(/^\/+/, "");
  const target = path.resolve(args.sliceRoot, rel);
  if (!target.startsWith(path.resolve(args.sliceRoot) + path.sep) && target !== path.resolve(args.sliceRoot)) {
    return null;
  }
  // vendor/ rides the same shells fallback: pinned prebuilt bundles (tldraw)
  // live with the tools, never inside data-only scaffolded bundles
  if (!fs.existsSync(target) && (APP_SHELLS.has(rel) || rel.startsWith("vendor/"))) {
    // Scaffolded bundles carry data only; the app shells live with the tools.
    // Fallback covers just the two shells so a bundle server never exposes
    // the source slice's media.
    const fallback = path.resolve(DEFAULT_SLICE_ROOT, rel);
    if (fs.existsSync(fallback)) return fallback;
  }
  return target;
}

function validate(mode = "review") {
  const timeline = readTimelineFile(args.timeline);
  const plan = validatePlanWithProbes(planExport(timeline, {
    sliceRoot: args.sliceRoot,
    mode,
    checkFiles: true,
  }), {
    ffprobe: resolveSystemBin("ffprobe"),
    mode,
  });
  return {
    ok: plan.validation.ok,
    mode,
    cardCount: plan.validation.cardCount,
    totalDurationS: plan.totalDurationS,
    placeholders: plan.validation.placeholders,
    errors: plan.validation.errors,
    warnings: plan.validation.warnings,
    audioBeds: plan.audioBeds.map((bed) => ({
      id: bed.id,
      asset: bed.asset,
      assetPath: bed.assetPath,
      exists: bed.assetExists,
      start_s: bed.start_s,
      duration_s: bed.duration_s,
    })),
  };
}

function loadTimelineAudioInputs(timeline) {
  const wordsPayload = timeline.words_json
    ? readJsonFile(resolveRefPath(timeline.words_json, { sliceRoot: args.sliceRoot }))
    : null;
  const captionsText = timeline.captions_vtt
    ? maybeReadText(resolveRefPath(timeline.captions_vtt, { sliceRoot: args.sliceRoot }))
    : "";
  return { wordsPayload, captionsText };
}

function validateAudio(mode = "review") {
  const timeline = readTimelineFile(args.timeline);
  const plan = validatePlanWithProbes(planExport(timeline, {
    sliceRoot: args.sliceRoot,
    mode,
    checkFiles: true,
  }), {
    ffprobe: resolveSystemBin("ffprobe"),
    mode,
  });
  const { wordsPayload, captionsText } = loadTimelineAudioInputs(timeline);
  return analyzeTimelineAudio(timeline, {
    wordsPayload,
    captionsText,
    sliceRoot: args.sliceRoot,
    segments: plan.segments,
  });
}

function compactAudioReport(report) {
  const relevantAnomalies = report.anomalies
    .filter((anomaly) => anomaly.severity !== "info")
    .slice(0, 20);
  const relevantCards = report.cards
    .filter((card) => (card.anomalies || []).some((anomaly) => anomaly.severity !== "info"))
    .slice(0, 20)
    .map((card) => ({
      id: card.id,
      title: card.title,
      start_s: card.start_s,
      end_s: card.end_s,
      wordRange_s: card.wordRange_s,
      captionRange_s: card.captionRange_s,
      beats: card.beats,
      media: card.media,
      anomalies: card.anomalies.filter((anomaly) => anomaly.severity !== "info"),
      fixHint: card.fixHint,
    }));
  return {
    ok: report.ok,
    timeline: report.timeline,
    versionCoherence: report.versionCoherence,
    counts: report.counts,
    summaryText: report.summaryText,
    anomalies: relevantAnomalies,
    cards: relevantCards,
    detail: "summary",
  };
}

function startExport(mode) {
  const jobId = `export-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const job = {
    id: jobId,
    mode,
    state: "running",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    stdout: "",
    stderr: "",
    result: null,
    error: null,
  };
  jobs.set(jobId, job);

  const child = spawn(process.execPath, [
    path.join(__dirname, "assemble-timeline.mjs"),
    "--timeline", args.timeline,
    "--slice-root", args.sliceRoot,
    "--mode", mode,
    "--json",
  ], {
    cwd: args.sliceRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", (chunk) => {
    job.stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    job.stderr += chunk.toString();
  });
  child.on("close", (code) => {
    job.finishedAt = new Date().toISOString();
    if (code === 0) {
      job.state = "done";
      try {
        job.result = JSON.parse(job.stdout);
      } catch {
        job.result = { ok: true, stdout: job.stdout };
      }
    } else {
      job.state = "failed";
      job.error = job.stderr || job.stdout || `export exited ${code}`;
      try {
        const parsed = JSON.parse(job.stdout);
        if (parsed?.error) job.error = parsed.error;
      } catch {}
    }
  });

  return job;
}

// ---- mini-NLE additive routes (patch / history / assets / reveal) ----

function patchDraftPath() {
  return path.join(args.sliceRoot, "timeline-edits.patch.json");
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 24 * 1024 * 1024) reject(new Error("body too large")); // annotation PNGs ride as base64
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

// allowlist memo keyed by project-assets.json mtime; media streaming makes
// many range requests and reparsing the index per request is waste
let allowlistCache = { mtimeMs: 0, allowlist: new Set() };
function currentAllowlist() {
  const assetsPath = defaultAssetPaths(args.sliceRoot).assetsPath;
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(assetsPath).mtimeMs;
  } catch {
    return new Set();
  }
  if (mtimeMs !== allowlistCache.mtimeMs) {
    allowlistCache = { mtimeMs, allowlist: loadAllowlist(assetsPath) };
  }
  return allowlistCache.allowlist;
}

// timeline picker: list timeline-shaped JSON files in the slice root and let
// the UI switch the server's current timeline. Every endpoint reads
// args.timeline, so mutating it here re-points patch/validate/export at once.
// Deferred: history/slots/assets indexes are per-PROJECT (slice root), shared
// across timeline variants in the same folder.
function listTimelines() {
  const entries = [];
  for (const name of fs.readdirSync(args.sliceRoot)) {
    if (!name.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(args.sliceRoot, name), "utf8"));
      if (!parsed || typeof parsed !== "object") continue;
      // key-presence, not truthiness: placeholder boards are playable BEFORE
      // any audio exists  and must be pickable
      if (!("audio_master" in parsed) || !(Array.isArray(parsed.sequence) || Array.isArray(parsed.cards))) continue;
      entries.push({
        name,
        path: path.join(args.sliceRoot, name),
        cardCount: Array.isArray(parsed.sequence)
          ? parsed.sequence.filter((item) => (item?.type || "card") === "card").length
          : parsed.cards.length,
        note: String(parsed._note || "").slice(0, 140),
        current: path.resolve(path.join(args.sliceRoot, name)) === path.resolve(args.timeline),
      });
    } catch {}
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

// ---- review notes (durable-first) + annotation + approve ----
// A note is a FILE before it is a message: reports/notes/ lands first, then
// rig queue create; if the daemon is down the dispatch flushes on the next
// opportunity (server start or the next note). The note md is queue-body
// shaped so the producer can forward it verbatim.

const DEFAULT_RECEIVER = process.env.STUDIO_NOTE_RECEIVER || "review";
// Provenance (product decision 2026-07-03): actions raised through the browser
// UI attribute to the person at the surface, not to whichever seat happens to run the
// server - "if it ever comes down to who asked for this change, the record
// should show I asked for it." Agents act via CLI/queue under their own
// session names; API callers may pass an explicit source to claim identity.
const LEGACY_UI_ACTOR = "founder-ui@openrig-studio";
const NOTE_SOURCE = LEGACY_UI_ACTOR;

function notesDir() {
  const dir = path.join(args.sliceRoot, "reports", "notes");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function annotationsDir() {
  const dir = path.join(args.sliceRoot, "reports", "annotations");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function receiversPath() {
  return path.join(notesDir(), "receivers.json");
}

function loadReceivers() {
  try {
    const list = JSON.parse(fs.readFileSync(receiversPath(), "utf8"));
    if (Array.isArray(list) && list.length) return list;
  } catch {}
  return [DEFAULT_RECEIVER];
}

function saveReceiver(receiver) {
  const list = loadReceivers();
  if (!list.includes(receiver)) {
    list.push(receiver);
    fs.writeFileSync(receiversPath(), JSON.stringify(list, null, 2));
  }
}

function sanitizeQueueBody(text) {
  return String(text || "").replaceAll("`", "'");
}

function timestampLabel(timestampS) {
  const value = Number(timestampS) || 0;
  return `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, "0")}.${String(Math.floor((value % 1) * 1000)).padStart(3, "0")}`;
}

function noteRelativePath(noteId) {
  return path.join("reports", "notes", `${noteId}.md`);
}

function noteBody(note) {
  const status = note.status || (note.dispatched ? "dispatched" : "pending-dispatch");
  const dispatchLine = status === "draft"
    ? "draft"
    : note.dispatched ? `dispatched ${note.qitemId || ""}` : "pending-dispatch";
  return [
    `# NLE review note - ${note.kind} - slot ${note.slot || "(none)"} @ ${note.timestamp_label}`,
    ``,
    `- note_id: ${note.id}`,
    `- created: ${note.created}`,
    `- timeline: ${note.timeline}`,
    `- slot: ${note.slot || "(none)"}`,
    `- timestamp_s: ${note.timestamp_s}`,
    `- kind: ${note.kind}`,
    `- receiver: ${note.receiver}`,
    `- annotation: ${note.annotation || "(none)"}`,
    `- status: ${status}`,
    `- dispatch: ${dispatchLine}`,
    ``,
    sanitizeQueueBody(note.text),
    ``,
  ].join("\n");
}

function writeNoteFile(note) {
  fs.writeFileSync(path.join(notesDir(), `${note.id}.md`), noteBody(note));
}

function readNoteRecord(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split(/\r?\n/);
  const meta = {};
  let lastMetaLine = -1;
  for (let index = 0; index < lines.length; index++) {
    const match = /^- ([a-z_]+):\s*(.*)$/.exec(lines[index]);
    if (!match) continue;
    meta[match[1]] = match[2];
    lastMetaLine = index;
  }
  let textStart = lastMetaLine + 1;
  while (textStart < lines.length && lines[textStart].trim() === "") textStart++;
  let textEnd = lines.findIndex((line, index) => index >= textStart && line.startsWith("Generated by "));
  if (textEnd === -1) textEnd = lines.length;
  const noteId = meta.note_id || path.basename(filePath, ".md");
  const timestampS = Number(meta.timestamp_s) || 0;
  return {
    id: noteId,
    created: meta.created || "",
    timeline: meta.timeline || "",
    slot: meta.slot === "(none)" ? "" : String(meta.slot || ""),
    timestamp_s: timestampS,
    timestamp_label: timestampLabel(timestampS),
    kind: meta.kind || "general",
    receiver: meta.receiver || DEFAULT_RECEIVER,
    annotation: meta.annotation === "(none)" ? "" : String(meta.annotation || ""),
    status: meta.status || (String(meta.dispatch || "").startsWith("dispatched") ? "dispatched" : "pending-dispatch"),
    dispatched: String(meta.status || "").startsWith("dispatched") || String(meta.dispatch || "").startsWith("dispatched"),
    qitemId: (String(meta.dispatch || "").match(/qitem-[A-Za-z0-9-]+/) || [])[0] || null,
    text: lines.slice(textStart, textEnd).join("\n").trim(),
    path: filePath,
    relative: noteRelativePath(noteId),
  };
}

function listNoteRecords({ status } = {}) {
  const dir = notesDir();
  return fs.readdirSync(dir)
    .filter((name) => name.startsWith("note-") && name.endsWith(".md"))
    .map((name) => {
      try { return readNoteRecord(path.join(dir, name)); } catch { return null; }
    })
    .filter(Boolean)
    .filter((note) => !status || note.status === status)
    .sort((a, b) => String(a.created).localeCompare(String(b.created)));
}

function dispatchNote(note) {
  return new Promise((resolve) => {
    execFile("rig", [
      "queue", "create",
      "--source", NOTE_SOURCE,
      "--destination", note.receiver,
      "--priority", "high",
      "--tags", `mini-nle,review-note,slot:${note.slot || "none"},kind:${note.kind},note:${note.id}`,
      "--summary", sanitizeQueueBody(`NLE review note (${note.kind}) slot ${note.slot || "-"} @ ${note.timestamp_label}: ${String(note.text).slice(0, 80)}`),
      "--body", noteBody(note),
      "--json",
    ], { timeout: 15000 }, (error, stdout) => {
      if (error) return resolve({ ok: false, error: error.message });
      try {
        resolve({ ok: true, qitemId: JSON.parse(stdout).qitemId });
      } catch {
        resolve({ ok: true, qitemId: null });
      }
    });
  });
}

function dispatchBatchFeedback({ drafts, receiver }) {
  return new Promise((resolve) => {
    const noteLines = drafts.map((note) =>
      `- slot ${note.slot || "(none)"}: ${note.relative}`);
    const body = [
      "# Mini-NLE batch feedback pass",
      "",
      `- source: ${NOTE_SOURCE}`,
      `- created: ${new Date().toISOString()}`,
      `- timeline: ${path.basename(args.timeline)}`,
      `- draft_count: ${drafts.length}`,
      "",
      "## Note Index",
      ...noteLines,
      "",
      "Open the note files for full text and annotations.",
      "",
    ].join("\n");
    execFile("rig", [
      "queue", "create",
      "--source", NOTE_SOURCE,
      "--destination", receiver,
      "--priority", "high",
      "--tags", "mini-nle,batch-feedback,user feedback,storyboard-pass",
      "--summary", sanitizeQueueBody(`Mini-NLE batch feedback pass: ${drafts.length} draft note(s) ready for producer review`),
      "--body", sanitizeQueueBody(body),
      "--json",
    ], { timeout: 15000 }, (error, stdout) => {
      if (error) return resolve({ ok: false, error: error.message });
      try {
        resolve({ ok: true, qitemId: JSON.parse(stdout).qitemId, body });
      } catch {
        resolve({ ok: true, qitemId: null, body });
      }
    });
  });
}

// retry any pending-dispatch notes (daemon may have been down when they landed).
// excludeName: the note currently being dispatched by /api/note - its durable
// file already exists as pending-dispatch, so without the exclusion the flush
// would dispatch it a first time and the normal path a second (live-caught by
// the producer on 2026-07-03: two qitems, one note_id).
async function flushPendingNotes(excludeName = "") {
  const flushed = [];
  for (const name of fs.readdirSync(notesDir())) {
    if (!name.startsWith("note-") || !name.endsWith(".md")) continue;
    if (name === excludeName) continue;
    const filePath = path.join(notesDir(), name);
    const content = fs.readFileSync(filePath, "utf8");
    if (!content.includes("- dispatch: pending-dispatch")) continue;
    const receiver = (content.match(/- receiver: (.+)/) || [])[1]?.trim();
    const summary = (content.split("\n")[0] || "").replace(/^# /, "");
    if (!receiver) continue;
    const result = await new Promise((resolve) => {
      execFile("rig", [
        "queue", "create",
        "--source", NOTE_SOURCE,
        "--destination", receiver,
        "--priority", "high",
        "--tags", `mini-nle,review-note,flushed,note:${name.replace(/\.md$/, "")}`,
        "--summary", sanitizeQueueBody(summary),
        // the qitem body must not carry the stale pending-dispatch line
        // 
        "--body", sanitizeQueueBody(content.replace("- dispatch: pending-dispatch", "- dispatch: flushed after a failed live dispatch (see note file for the qitem id)")),
        "--json",
      ], { timeout: 15000 }, (error, stdout) => {
        if (error) return resolve(null);
        try { resolve(JSON.parse(stdout).qitemId); } catch { resolve("unknown"); }
      });
    });
    if (result) {
      fs.writeFileSync(filePath, content.replace("- dispatch: pending-dispatch", `- dispatch: dispatched ${result} (flushed)`));
      flushed.push(name);
    }
  }
  return flushed;
}

const NLE_ROUTES = new Set([
  "/api/shell-mtime",
  "/api/project-info",
  "/api/receivers",
  "/api/templates",
  "/api/health",
  "/api/library",
  "/api/library/media",
  "/api/library/route",
  "/api/note",
  "/api/note/done",
  "/api/note/reconciled",
  "/api/note/flush",
  "/api/history-since",
  "/api/annotation",
  "/api/approve",
  "/api/reconform",
  "/api/timelines",
  "/api/timeline/select",
  "/api/timeline/doc",
  "/api/patch",
  "/api/patch/validate",
  "/api/patch/apply",
  "/api/patch/discard",
  "/api/slot-history",
  "/api/project-assets",
  "/api/project-assets/rebuild",
  "/api/reveal-file",
  "/api/media",
  "/api/thumb",
  "/api/probe-duration",
  "/api/canvas",
  "/api/canvas/apply",
  "/api/canvases",
  "/canvas-license.json",
]);

// ---- multi-canvas home : canvases are a GENERAL
// tool, not per-project. Each canvas = its own dir under the canvases home
// (canvas.json + canvas-backups/ + canvas-history.jsonl — same rails, root
// swapped). The legacy per-bundle <slice>/canvas.json is ADOPTED once,
// non-destructively, under the bundle's name.
function canvasSlug(name) {
  return String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}
function canvasDirFor(slug) {
  return path.join(args.canvasRoot, slug);
}
function adoptLegacyCanvas() {
  const legacy = path.join(args.sliceRoot, "canvas.json");
  if (!fs.existsSync(legacy)) return;
  const slug = canvasSlug(path.basename(args.sliceRoot)) || "adopted";
  const dir = canvasDirFor(slug);
  if (!fs.existsSync(path.join(dir, "canvas.json"))) {
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(legacy, path.join(dir, "canvas.json"));
    for (const sibling of ["canvas-backups", "canvas-history.jsonl"]) {
      const src = path.join(args.sliceRoot, sibling);
      if (fs.existsSync(src)) fs.cpSync(src, path.join(dir, sibling), { recursive: true });
    }
  }
  // never destroy: the original stays beside its adoption marker
  fs.renameSync(legacy, `${legacy}.adopted`);
}
function listCanvases() {
  adoptLegacyCanvas();
  fs.mkdirSync(args.canvasRoot, { recursive: true });
  const rows = [];
  for (const name of fs.readdirSync(args.canvasRoot)) {
    const dir = path.join(args.canvasRoot, name);
    try { if (!fs.statSync(dir).isDirectory()) continue; } catch { continue; }
    const current = readCanvas(dir);
    rows.push({ slug: name, rev: current.rev, updated_at: current.updated_at, updated_by: current.updated_by });
  }
  if (!rows.length) {
    fs.mkdirSync(canvasDirFor("main"), { recursive: true });
    rows.push({ slug: "main", rev: 0, updated_at: null, updated_by: null });
  }
  return rows.sort((a, b) => a.slug.localeCompare(b.slug));
}
function resolveCanvasDir(url) {
  const requested = canvasSlug(url.searchParams.get("canvas") || "");
  const canvases = listCanvases();
  const slug = requested || canvases[0].slug; // bare verbs = first canvas (legacy agent curls keep working)
  if (!canvases.some((c) => c.slug === slug)) return { error: `no such canvas: ${slug} — create it via POST /api/canvases` };
  return { slug, dir: canvasDirFor(slug) };
}

// canvas media-src gate: same trust surface as /api/media and
// /api/library/media, applied at WRITE time so a doc never lands with an
// unservable reference (canvas-rails validateSrc calls back into this)
function canvasSrcAllowed(wanted, rail) {
  const roots = resolveRoots(args.mediaRoots);
  if (rail === "library/media" || rail === "thumb") {
    let resolved;
    try { resolved = fs.realpathSync(path.resolve(wanted)); } catch { resolved = path.resolve(wanted); }
    return roots.some((root) => resolved === root || resolved.startsWith(root + path.sep));
  }
  const previewAlias = wanted.replace(/\/previews\//, "/");
  const inAssembly = path.resolve(wanted).startsWith(path.resolve(args.sliceRoot, "assembly") + path.sep);
  return inAssembly
    || isAllowlisted(wanted, currentAllowlist(), [args.sliceRoot, ...args.mediaRoots])
    || (wanted.includes("/previews/") && isAllowlisted(previewAlias, currentAllowlist(), [args.sliceRoot, ...args.mediaRoots]));
}

async function handleNleApi(req, res, url) {
  if (url.pathname === "/canvas-license.json" && req.method === "GET") {
    // tldraw licenseKey (runtime prop). The box carries the key as a file
    // (bundle root or app dir, same fallback order as the shells); absent
    // file answers {} so the UI's optional fetch never 404s (the
    // canvas-probe console gate treats 404 as an error).
    for (const root of [args.sliceRoot, DEFAULT_SLICE_ROOT]) {
      try {
        return sendJson(res, 200, JSON.parse(fs.readFileSync(path.join(root, "canvas-license.json"), "utf8")));
      } catch {}
    }
    return sendJson(res, 200, {});
  }
  if (url.pathname === "/api/canvases" && req.method === "GET") {
    return sendJson(res, 200, { ok: true, canvasRoot: args.canvasRoot, canvases: listCanvases() });
  }
  if (url.pathname === "/api/canvases" && req.method === "POST") {
    const { name } = JSON.parse(await readBody(req) || "{}");
    const slug = canvasSlug(name);
    if (!slug) return sendJson(res, 400, { ok: false, error: "name is required (letters/numbers; becomes the slug)" });
    fs.mkdirSync(canvasDirFor(slug), { recursive: true });
    return sendJson(res, 200, { ok: true, slug, canvases: listCanvases() });
  }
  if (url.pathname === "/api/canvas" && req.method === "GET") {
    // ?canvas=<slug> selects the board (bare = first canvas); ?since=<rev>
    // is the UI's cheap quiet-poll (media-manager pattern); bare GET returns
    // the whole doc for load/merge/agent-read
    const resolved = resolveCanvasDir(url);
    if (resolved.error) return sendJson(res, 404, { ok: false, error: resolved.error });
    const current = readCanvas(resolved.dir);
    const since = url.searchParams.get("since");
    if (since !== null) return sendJson(res, 200, { ok: true, canvas: resolved.slug, changed: Number(since) !== current.rev, rev: current.rev });
    return sendJson(res, 200, { ok: true, canvas: resolved.slug, ...current });
  }
  if (url.pathname === "/api/canvas/apply" && req.method === "POST") {
    // validate → coalesced backup → atomic apply → coarse history.
    // Provenance: UI writes attribute to the person at the surface; agents/API
    // callers claim identity via an explicit actor.
    const resolved = resolveCanvasDir(url);
    if (resolved.error) return sendJson(res, 404, { ok: false, error: resolved.error });
    const { baseRev, document, actor, reason } = JSON.parse(await readBody(req));
    const email = req.headers["cf-access-authenticated-user-email"];
    const uiActor = email ? `${String(email).split("@")[0].replace(/[^a-z0-9.]/gi, "")}-ui` : LEGACY_UI_ACTOR;
    const result = applyCanvas({
      sliceRoot: resolved.dir,
      baseRev,
      document,
      actor: String(actor || "").trim() || uiActor,
      reason,
      isAllowed: canvasSrcAllowed,
    });
    return sendJson(res, result.ok ? 200 : result.status, { canvas: resolved.slug, ...result });
  }
  if (url.pathname === "/api/project-info" && req.method === "GET") {
    const readJson = (name) => {
      try { return JSON.parse(fs.readFileSync(path.join(args.sliceRoot, name), "utf8")); } catch { return null; }
    };
    const readText = (rel) => {
      try { return fs.readFileSync(path.join(args.sliceRoot, rel), "utf8"); } catch { return null; }
    };
    const isContractBundle = fs.existsSync(path.join(args.sliceRoot, "PLACEMENT.md"));
    let filing = null;
    if (isContractBundle) {
      try {
        const { strays, intakeItems, scanned } = checkBundle(args.sliceRoot);
        filing = { scanned, strayCount: strays.length, straySample: strays.slice(0, 5), intakeCount: intakeItems.length };
      } catch {}
    }
    return sendJson(res, 200, {
      ok: true,
      contractBundle: isContractBundle,
      doctrine: readText("doctrine/current-rules.md"),
      currentExport: readJson("current-export.json"),
      currentAudio: readJson("current-audio.json"),
      filing,
    });
  }
  // ---- media manager (sibling surface). License/attribution is
  // INFORMATIONAL ONLY - displayed when known, never a gate. Enforcement is
  // the operator's call, not this server's.
  if (url.pathname === "/api/library" && req.method === "GET") {
    const roots = resolveRoots(args.mediaRoots);
    const assets = [];
    const walk = (dir, rootLabel, depth) => {
      if (depth > 4 || !fs.existsSync(dir)) return;
      for (const name of fs.readdirSync(dir)) {
        if (name.startsWith(".") || name === "node_modules") continue;
        const full = path.join(dir, name);
        let stat;
        try { stat = fs.statSync(full); } catch { continue; }
        if (stat.isDirectory()) { walk(full, rootLabel, depth + 1); continue; }
        const kind = mediaKindOf(name);
        if (kind === "unknown") continue;
        let meta = null;
        try {
          if (fs.existsSync(`${full}.meta.json`)) meta = JSON.parse(fs.readFileSync(`${full}.meta.json`, "utf8"));
        } catch {}
        assets.push({ name, path: full, root: rootLabel, kind, size: stat.size, mtime: stat.mtimeMs, meta });
      }
    };
    for (const root of roots) walk(root, path.basename(root), 0);
    return sendJson(res, 200, { ok: true, assets, roots, note: "configured media roots are scanned directly; <file>.meta.json sidecars are informational (license/credit/source) - never gates" });
  }
  if (url.pathname === "/api/library/media" && req.method === "GET") {
    // roots-only gate for library previews (library files are not in the
    // project index by design)
    const wanted = url.searchParams.get("path") || "";
    let resolved;
    try { resolved = fs.realpathSync(path.resolve(wanted)); } catch { resolved = path.resolve(wanted); }
    const roots = resolveRoots(args.mediaRoots);
    const underRoot = roots.some((root) => resolved === root || resolved.startsWith(root + path.sep));
    if (!underRoot || mediaKindOf(resolved) === "unknown") {
      return sendJson(res, 403, { ok: false, error: "library media must live under a configured media root" });
    }
    const stats = fs.statSync(resolved);
    const response = staticResponseHeaders({ fileSize: stats.size, rangeHeader: req.headers.range, contentType: contentType(resolved) });
    res.writeHead(response.status, response.headers);
    if (req.method === "HEAD" || response.status === 416) return res.end();
    const streamOptions = response.range ? { start: response.range.start, end: response.range.end } : undefined;
    fs.createReadStream(resolved, streamOptions).pipe(res);
    return;
  }
  if (url.pathname === "/api/library/route" && req.method === "POST") {
    // route a library asset into THIS project as a slot take candidate
    const { path: assetPath, slot } = JSON.parse(await readBody(req));
    let resolved;
    try { resolved = fs.realpathSync(path.resolve(String(assetPath || ""))); } catch { resolved = path.resolve(String(assetPath || "")); }
    const roots = resolveRoots(args.mediaRoots);
    if (!roots.some((root) => resolved.startsWith(root + path.sep))) {
      return sendJson(res, 403, { ok: false, error: "asset must live under a configured media root" });
    }
    const kind = mediaKindOf(resolved);
    const destDir = kind === "image" ? "media/images" : kind === "audio" ? "media/audio" : "media/captures";
    const baseName = path.basename(resolved).replace(/[^A-Za-z0-9._-]+/g, "-");
    const destName = slot ? `${String(slot)}-lib-${baseName}` : `lib-${baseName}`;
    const dest = path.join(args.sliceRoot, destDir, destName);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(resolved, dest);
    if (fs.existsSync(`${resolved}.meta.json`)) fs.copyFileSync(`${resolved}.meta.json`, `${dest}.meta.json`);
    const assetPaths = defaultAssetPaths(args.sliceRoot);
    generateProjectAssets({ sliceRoot: args.sliceRoot, ...assetPaths, probe: false });
    return sendJson(res, 200, { ok: true, dest: path.relative(args.sliceRoot, dest), registered_as_take: Boolean(slot) });
  }
  if (url.pathname === "/api/shell-mtime" && req.method === "GET") {
    // the malleable-UI rail: shells poll this and self-reload when an agent
    // edits them. Restricted to APP_SHELLS so it can't probe arbitrary files.
    const f = path.basename(String(url.searchParams.get("f") || ""));
    if (!APP_SHELLS.has(f)) return sendJson(res, 400, { ok: false, error: "not a shell" });
    const p = safeStaticPath(`/${f}`);
    if (!p || !fs.existsSync(p)) return sendJson(res, 404, { ok: false, error: "missing" });
    return sendJson(res, 200, { ok: true, file: f, mtimeMs: fs.statSync(p).mtimeMs });
  }
  if (url.pathname === "/api/health" && req.method === "GET") {
    // cheap by contract (fs only, no probes) - safe on load/apply/manual
    try {
      return sendJson(res, 200, computeHealth({ sliceRoot: args.sliceRoot, timelinePath: args.timeline }));
    } catch (error) {
      return sendJson(res, 500, { ok: false, error: String(error?.message || error) });
    }
  }
  if (url.pathname === "/api/templates" && req.method === "GET") {
    return sendJson(res, 200, { ok: true, templates: loadTemplates(args.sliceRoot) });
  }
  if (url.pathname === "/api/receivers" && req.method === "GET") {
    // lanes: seat<->surface duality  - the note form's geography
    return sendJson(res, 200, { ok: true, receivers: loadReceivers(), default: loadReceivers()[0], lanes: REVIEW_LANES });
  }
  if (url.pathname === "/api/history-since" && req.method === "GET") {
    // catch-up queue feed (drift-proof tier): everything that happened
    // after `since`, straight from the append-only history the rails
    // write — no agent diligence involved. reconciledAt rides along for
    // the discipline tier's freshness label.
    const sinceMs = Date.parse(String(url.searchParams.get("since") || "")) || 0;
    const events = readHistory(historyPaths(args.sliceRoot).historyPath)
      // review events are the HUMAN's own locks/unlocks and bootstrap
      // snapshots are plumbing — neither is "what the agent did"
      .filter((event) => event.source !== "review" && event.source !== "bootstrap-current-timeline")
      .filter((event) => (Date.parse(event.changed_at || "") || 0) > sinceMs)
      .map((event) => ({
        event_id: event.event_id,
        changed_at: event.changed_at,
        actor: event.actor,
        source: event.source,
        reason: event.reason || "",
        slot: event.slot?.dot_id_after || event.slot?.dot_id_before || "",
      }));
    let reconciledAt = null;
    try { reconciledAt = JSON.parse(fs.readFileSync(path.join(notesDir(), ".reconciled.json"), "utf8")).at || null; } catch {}
    return sendJson(res, 200, { ok: true, count: events.length, events, reconciledAt });
  }
  if (url.pathname === "/api/note/reconciled" && req.method === "POST") {
    // the agent's end-of-burst sweep stamps this (seat contract): ledger
    // reconciled against the recent conversation — drift squashed at the
    // moment the human comes back to look
    fs.writeFileSync(path.join(notesDir(), ".reconciled.json"), JSON.stringify({ at: new Date().toISOString() }));
    return sendJson(res, 200, { ok: true });
  }
  if (url.pathname === "/api/note" && req.method === "GET") {
    // ?all=1 lists every status (the per-slot notes LEDGER); ?slot= filters.
    // Default stays drafts-only for the existing badge/flush consumers.
    const all = url.searchParams.get("all") === "1";
    const slot = String(url.searchParams.get("slot") || "");
    let records = listNoteRecords(all ? {} : { status: "draft" });
    if (slot) records = records.filter((note) => String(note.slot) === slot);
    return sendJson(res, 200, { ok: true, drafts: records, count: records.length });
  }
  if (url.pathname === "/api/note/done" && req.method === "POST") {
    // the ledger's TODO verb: open (draft) <-> done, same rail for humans
    // and agents (seat contract: work the note, then mark it done)
    const { id, done = true } = JSON.parse(await readBody(req) || "{}");
    const record = listNoteRecords({}).find((note) => note.id === String(id || ""));
    if (!record) return sendJson(res, 404, { ok: false, error: "no such note" });
    writeNoteFile({ ...record, status: done ? "done" : "draft" });
    return sendJson(res, 200, { ok: true, id: record.id, status: done ? "done" : "draft" });
  }
  if (url.pathname === "/api/note/flush" && req.method === "POST") {
    const { receiver } = JSON.parse(await readBody(req) || "{}");
    const useReceiver = String(receiver || "").trim() || DEFAULT_RECEIVER;
    const drafts = listNoteRecords({ status: "draft" });
    if (!drafts.length) return sendJson(res, 400, { ok: false, error: "no draft feedback notes to send" });
    saveReceiver(useReceiver);
    const dispatch = await dispatchBatchFeedback({ drafts, receiver: useReceiver });
    if (!dispatch.ok) return sendJson(res, 500, { ok: false, error: dispatch.error, draftCount: drafts.length });
    for (const draft of drafts) {
      writeNoteFile({
        ...draft,
        receiver: useReceiver,
        status: "dispatched",
        dispatched: true,
        qitemId: dispatch.qitemId,
      });
    }
    return sendJson(res, 200, {
      ok: true,
      draftCount: drafts.length,
      qitemId: dispatch.qitemId,
      receiver: useReceiver,
      notes: drafts.map((note) => ({ id: note.id, slot: note.slot, path: note.path, relative: note.relative })),
      body: dispatch.body,
    });
  }
  if (url.pathname === "/api/note" && req.method === "POST") {
    const { slot, timestamp, kind, text, receiver, annotation, status } = JSON.parse(await readBody(req));
    if (!String(text || "").trim()) return sendJson(res, 400, { ok: false, error: "note text is required" });
    const useReceiver = String(receiver || "").trim() || DEFAULT_RECEIVER;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const timestampS = Number(timestamp) || 0;
    const note = {
      id: `note-${stamp}-${String(slot || "general").replace(/[^a-zA-Z0-9.]+/g, "-")}`,
      created: new Date().toISOString(),
      timeline: path.basename(args.timeline),
      slot: String(slot || ""),
      timestamp_s: timestampS,
      timestamp_label: timestampLabel(timestampS),
      kind: String(kind || "general"),
      receiver: useReceiver,
      annotation: annotation ? String(annotation) : "",
      text: String(text),
      status: status === "draft" ? "draft" : "pending-dispatch",
      dispatched: false,
      qitemId: null,
    };
    writeNoteFile(note); // DURABLE-FIRST: the file exists before any dispatch attempt
    saveReceiver(useReceiver);
    if (note.status === "draft") {
      return sendJson(res, 200, {
        ok: true,
        noteId: note.id,
        notePath: path.join(notesDir(), `${note.id}.md`),
        relative: note.relative || noteRelativePath(note.id),
        status: "draft",
        dispatched: false,
        draftCount: listNoteRecords({ status: "draft" }).length,
      });
    }
    await flushPendingNotes(`${note.id}.md`); // older stragglers only - never the note in flight
    const dispatch = await dispatchNote(note);
    if (dispatch.ok) {
      note.dispatched = true;
      note.qitemId = dispatch.qitemId;
      writeNoteFile(note);
    }
    return sendJson(res, 200, {
      ok: true,
      noteId: note.id,
      notePath: path.join(notesDir(), `${note.id}.md`),
      dispatched: dispatch.ok,
      qitemId: note.qitemId,
      dispatchError: dispatch.ok ? null : dispatch.error,
    });
  }
  if (url.pathname === "/api/annotation" && req.method === "POST") {
    const { dataUrl, slot } = JSON.parse(await readBody(req));
    const match = /^data:image\/png;base64,(.+)$/.exec(String(dataUrl || ""));
    if (!match) return sendJson(res, 400, { ok: false, error: "dataUrl must be a base64 PNG" });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filePath = path.join(annotationsDir(), `annot-${stamp}-${String(slot || "frame").replace(/[^a-zA-Z0-9.]+/g, "-")}.png`);
    fs.writeFileSync(filePath, Buffer.from(match[1], "base64"));
    return sendJson(res, 200, { ok: true, path: filePath, relative: path.relative(args.sliceRoot, filePath) });
  }
  if (url.pathname === "/api/approve" && req.method === "POST") {
    // lock IS approval; unlock is a review event that clears it
    const { slot, unlock } = JSON.parse(await readBody(req));
    const action = unlock ? "unlock" : "approve";
    const timeline = readTimelineFile(args.timeline);
    const card = materializeCards(timeline).find((item) => String(item.id) === String(slot));
    if (!card) return sendJson(res, 404, { ok: false, error: `slot not found: ${slot}` });
    const paths = historyPaths(args.sliceRoot);
    bootstrapHistory(paths);
    const now = new Date();
    appendEvents(paths.historyPath, [{
      event_id: makeEventId(card.id, action, now),
      changed_at: eventTimestamp(now),
      actor: NOTE_SOURCE,
      source: "review",
      action,
      patch_id: null,
      slot: { slot_uid: slotUidFor(card.id), dot_id_before: String(card.id), dot_id_after: String(card.id), section: String(card.section || "") },
      before: null,
      after: cardSnapshot(card),
      reason: unlock ? "Unlocked from the mini-NLE storyboard." : "Locked (approved) from the mini-NLE.",
      validation: null,
    }]);
    rebuildSlots(paths);
    return sendJson(res, 200, { ok: true, slot: String(card.id), action });
  }
  if (url.pathname === "/api/reconform" && req.method === "POST") {
    const { package: packagePath, note } = JSON.parse(await readBody(req));
    if (!packagePath || typeof packagePath !== "string") {
      return sendJson(res, 400, { ok: false, error: "package (directory path) is required" });
    }
    const resolved = path.resolve(packagePath);
    const roots = resolveRoots([args.sliceRoot, ...args.mediaRoots]);
    if (!roots.some((root) => resolved === root || resolved.startsWith(root + path.sep))) {
      return sendJson(res, 403, { ok: false, error: "package must live under the slice root or a configured media root" });
    }
    let result;
    try {
      result = runReconform({
        sliceRoot: args.sliceRoot,
        timelinePath: args.timeline,
        packagePath: resolved,
        actorNote: String(note || ""),
      });
    } catch (error) {
      // package/validation refusals are client errors, not server faults
      // 
      return sendJson(res, 400, { ok: false, error: String(error?.message || error) });
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const reportDir = path.join(args.sliceRoot, "reports", "reconform");
    fs.mkdirSync(reportDir, { recursive: true });
    const reportPath = path.join(reportDir, `reconform-${stamp}.md`);
    const abPath = path.join(reportDir, `ab-${stamp}.html`);
    fs.writeFileSync(reportPath, result.report);
    fs.writeFileSync(abPath, result.ab);
    const draftPath = patchDraftPath();
    const replacedDraft = fs.existsSync(draftPath);
    fs.writeFileSync(draftPath, JSON.stringify({
      patch_id: `patch_reconform_${Date.now().toString(36)}`,
      created_at: new Date().toISOString(),
      actor: "mini-nle-reconform",
      reason: `reconform to ${path.basename(result.pkg.master)}${note ? ` - ${note}` : ""}`,
      base_timeline: path.basename(args.timeline),
      ops: result.ops,
    }, null, 2));
    return sendJson(res, 200, {
      ok: true,
      opCount: result.ops.length,
      failed: result.failed,
      pending: result.pkg.pending,
      matchCount: result.matchCount,
      report: result.report,
      reportPath,
      abRelative: path.relative(args.sliceRoot, abPath),
      replacedDraft,
    });
  }
  if (url.pathname === "/api/timelines" && req.method === "GET") {
    return sendJson(res, 200, { ok: true, sliceRoot: args.sliceRoot, current: path.resolve(args.timeline), timelines: listTimelines() });
  }
  // READ THE SELECTED TIMELINE DOCUMENT.
  //
  // WHY THIS VERB HAS TO EXIST. This server also serves the slice root
  // statically, so a surface served FROM THE BUNDLE could just fetch
  // `timeline.json` as a sibling file — which is exactly what mini-nle did,
  // because in studio-box this server served the app itself (see APP_SHELLS).
  // Under the SDK studio the shell serves surfaces from an overlay and the
  // studio front owns the origin, routing only /api/* here. So that sibling
  // fetch 404s and the app fell back to its embedded sample — silently. It
  // rendered as an empty board, which is indistinguishable from an empty
  // PROJECT, so the app looked honestly-empty while it was in fact never
  // loading the project at all.
  //
  // The document is the provider's own; reading it through some other
  // backend's file verbs would work here only because this box happens to
  // have the project inside that backend's roots.
  //
  // Safe by construction: no caller input. The path is `args.timeline`,
  // server-selected via /api/timeline/select, which already constrains the
  // name to a bare filename in the slice root.
  if (url.pathname === "/api/timeline/doc" && req.method === "GET") {
    const resolved = path.resolve(args.timeline);
    if (!fs.existsSync(resolved)) {
      return sendJson(res, 404, { ok: false, error: `no timeline at ${resolved}`, timelinePath: resolved });
    }
    try {
      return sendJson(res, 200, {
        ok: true,
        timelinePath: resolved,
        name: path.basename(resolved),
        timeline: JSON.parse(fs.readFileSync(resolved, "utf8")),
      });
    } catch (error) {
      // A malformed timeline is a NAMED failure, never an empty board.
      return sendJson(res, 500, { ok: false, error: `${path.basename(resolved)} is not valid JSON: ${error.message}`, timelinePath: resolved });
    }
  }
  if (url.pathname === "/api/timeline/select" && req.method === "POST") {
    const { name } = JSON.parse(await readBody(req));
    if (!name || typeof name !== "string" || name.includes("/") || name.includes("..")) {
      return sendJson(res, 400, { ok: false, error: "name must be a bare filename in the slice root" });
    }
    if (!listTimelines().some((entry) => entry.name === name)) {
      return sendJson(res, 404, { ok: false, error: `${name} is not a timeline-shaped JSON file in the slice root` });
    }
    args.timeline = path.join(args.sliceRoot, name);
    const warnings = [];
    if (fs.existsSync(patchDraftPath())) {
      warnings.push("a draft patch exists in this project; its ops were staged against the previously selected timeline - validate before applying, or discard");
    }
    return sendJson(res, 200, { ok: true, timelinePath: path.resolve(args.timeline), warnings });
  }
  if (url.pathname === "/api/patch" && req.method === "GET") {
    const draftPath = patchDraftPath();
    const base = { ok: true, timelinePath: path.resolve(args.timeline) };
    if (!fs.existsSync(draftPath)) return sendJson(res, 200, { ...base, patch: null });
    return sendJson(res, 200, { ...base, patch: JSON.parse(fs.readFileSync(draftPath, "utf8")), path: draftPath });
  }
  if (url.pathname === "/api/patch" && req.method === "POST") {
    const patch = JSON.parse(await readBody(req));
    if (!patch || !Array.isArray(patch.ops)) return sendJson(res, 400, { ok: false, error: "patch.ops[] is required" });
    fs.writeFileSync(patchDraftPath(), JSON.stringify(patch, null, 2));
    return sendJson(res, 200, { ok: true, path: patchDraftPath(), opCount: patch.ops.length });
  }
  if (url.pathname === "/api/patch/validate" && req.method === "POST") {
    const body = await readBody(req);
    const patch = body ? JSON.parse(body) : JSON.parse(fs.readFileSync(patchDraftPath(), "utf8"));
    const { validation, touchedIds } = validatePatch({ timelinePath: args.timeline, patch, sliceRoot: args.sliceRoot, probe: true });
    return sendJson(res, 200, { ok: validation.ok, touchedIds, ...validation });
  }
  if (url.pathname === "/api/patch/apply" && req.method === "POST") {
    const body = await readBody(req);
    const options = body ? JSON.parse(body) : {};
    const draftPath = patchDraftPath();
    if (!fs.existsSync(draftPath)) return sendJson(res, 400, { ok: false, error: "no draft patch to apply" });
    const result = applyPatch({
      sliceRoot: args.sliceRoot,
      timelinePath: args.timeline,
      patchPath: draftPath,
      target: options.target === "copy" ? path.join(args.sliceRoot, "timeline-patched-preview.json") : "canonical",
      actor: String(options.actor || "mini-nle-ui"),
      probe: true,
    });
    return sendJson(res, result.ok ? 200 : 409, result);
  }
  if (url.pathname === "/api/patch/discard" && req.method === "POST") {
    const draftPath = patchDraftPath();
    if (fs.existsSync(draftPath)) fs.rmSync(draftPath);
    return sendJson(res, 200, { ok: true });
  }
  if (url.pathname === "/api/slot-history" && req.method === "GET") {
    const slot = url.searchParams.get("slot") || "";
    const paths = historyPaths(args.sliceRoot);
    if (!fs.existsSync(paths.historyPath)) bootstrapHistory(paths);
    if (!fs.existsSync(paths.slotsPath)) rebuildSlots(paths);
    const slots = JSON.parse(fs.readFileSync(paths.slotsPath, "utf8"));
    if (!slot) return sendJson(res, 200, { ok: true, slots: slots.slots });
    const entry = slots.slots.find((item) => item.dot_id === slot || item.slot_uid === slot);
    if (!entry) return sendJson(res, 404, { ok: false, error: `slot not found: ${slot}` });
    const eventIds = new Set(entry.event_ids);
    const events = readHistory(paths.historyPath).filter((event) => eventIds.has(event.event_id));
    return sendJson(res, 200, { ok: true, slot: entry, events });
  }
  if (url.pathname === "/api/project-assets" && req.method === "GET") {
    const assetPaths = defaultAssetPaths(args.sliceRoot);
    if (!fs.existsSync(assetPaths.assetsPath)) {
      generateProjectAssets({ sliceRoot: args.sliceRoot, ...assetPaths, probe: false });
    }
    return sendJson(res, 200, JSON.parse(fs.readFileSync(assetPaths.assetsPath, "utf8")));
  }
  if (url.pathname === "/api/project-assets/rebuild" && req.method === "POST") {
    const assetPaths = defaultAssetPaths(args.sliceRoot);
    const payload = generateProjectAssets({ sliceRoot: args.sliceRoot, ...assetPaths, probe: true });
    return sendJson(res, 200, { ok: true, assetCount: payload.asset_count, assetsPath: assetPaths.assetsPath });
  }
  if (url.pathname === "/api/reveal-file" && req.method === "POST") {
    const { path: requested } = JSON.parse(await readBody(req));
    if (!isAllowlisted(requested, currentAllowlist(), [args.sliceRoot, ...args.mediaRoots])) {
      return sendJson(res, 403, { ok: false, error: "path is not an indexed project asset; rebuild the asset index if it should be" });
    }
    execFile("open", ["-R", requested], (error) => {
      if (error) console.error(`reveal-file failed: ${error.message}`);
    });
    return sendJson(res, 200, { ok: true, revealed: requested });
  }
  if (url.pathname === "/api/probe-duration" && req.method === "GET") {
    // deterministic media length (the asset index is often unprobed;
    // swapped clips inherit their own real duration)
    const srcParam = url.searchParams.get("src") || "";
    const source = safeStaticPath(`/${srcParam.replace(/^\/+/, "")}`);
    if (!source || !fs.existsSync(source) || !fs.statSync(source).isFile()) {
      return sendJson(res, 404, { ok: false, error: "no such media under the served bundle" });
    }
    execFile(resolveSystemBin("ffprobe"), ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", source], (error, stdout) => {
      const duration = Number(String(stdout).trim());
      if (error || !Number.isFinite(duration)) return sendJson(res, 500, { ok: false, error: error ? error.message : "no duration in probe" });
      sendJson(res, 200, { ok: true, duration_s: duration });
    });
    return true;
  }
  if (url.pathname === "/api/thumb" && req.method === "GET") {
    // storyboard poster frames: a tile must never cost a video fetch (nine
    // preview streams over one tunnel starved the words fetch AND the
    // thumbs — probe-observed). Resolves through the same slice-root
    // sandbox as the static route, prefers the previews/ sibling for cheap
    // decode, caches jpegs under <slice-root>/.thumbs keyed by mtime.
    const srcParam = url.searchParams.get("src") || "";
    const absParam = url.searchParams.get("abs") || "";
    const t = Math.max(0, Number(url.searchParams.get("t")) || 0);
    let source;
    if (absParam) {
      // library posters: absolute paths gated to the configured media
      // roots (same contract as /api/library/media)
      try { source = fs.realpathSync(path.resolve(absParam)); } catch { source = path.resolve(absParam); }
      const roots = resolveRoots(args.mediaRoots);
      if (!roots.some((root) => source === root || source.startsWith(root + path.sep))) {
        return sendJson(res, 403, { ok: false, error: "abs thumbs must live under a configured media root" });
      }
    } else {
      source = safeStaticPath(`/${srcParam.replace(/^\/+/, "")}`);
    }
    if (!source || !fs.existsSync(source) || !fs.statSync(source).isFile()) {
      return sendJson(res, 404, { ok: false, error: "no such media under the served bundle" });
    }
    if (/\/media\/renders\/[^/]+\.mp4$/.test(source)) {
      const prev = source.replace(/\/renders\//, "/renders/previews/");
      if (fs.existsSync(prev)) source = prev;
    }
    const stats = fs.statSync(source);
    const thumbsDir = path.join(args.sliceRoot, ".thumbs");
    fs.mkdirSync(thumbsDir, { recursive: true });
    const key = `${path.basename(source, path.extname(source))}-${t.toFixed(2)}-${Math.floor(stats.mtimeMs)}.jpg`;
    const thumbPath = path.join(thumbsDir, key);
    const serve = () => {
      const st = fs.statSync(thumbPath);
      res.writeHead(200, { "content-type": "image/jpeg", "content-length": st.size, "cache-control": "public, max-age=86400" });
      fs.createReadStream(thumbPath).pipe(res);
    };
    if (fs.existsSync(thumbPath)) { serve(); return true; }
    const isImage = /\.(png|jpe?g|webp)$/i.test(source);
    const tmp = `${thumbPath}.${process.pid}.${Date.now()}.part.jpg`;
    execFile(resolveSystemBin("ffmpeg"), [
      "-hide_banner", "-loglevel", "error", "-y",
      ...(isImage ? [] : ["-ss", String(t)]),
      "-i", source, "-frames:v", "1", "-vf", "scale=320:-2", tmp,
    ], (error) => {
      try {
        if (error || !fs.existsSync(tmp)) throw (error || new Error("no frame produced"));
        fs.renameSync(tmp, thumbPath);
        serve();
      } catch (failure) {
        try { fs.unlinkSync(tmp); } catch {}
        sendJson(res, 500, { ok: false, error: `thumbnail: ${failure.message}` });
      }
    });
    return true;
  }
  if (url.pathname === "/api/media" && req.method === "GET") {
    const requested = url.searchParams.get("path") || "";
    // Timeline refs are bundle-relative by design (media/captures/foo.mp4).
    // Resolve them against the configured project before applying the same
    // index + root boundary as absolute asset-index paths. Otherwise the API
    // only works for callers that already know this box's filesystem layout.
    const mediaPath = resolveRefPath(requested, { sliceRoot: args.sliceRoot });
    // a render's previews/ sibling rides its master's allowlist entry
    // (preview proxies are derived files, never indexed themselves);
    // exports under <bundle>/assembly/ are servable by construction
    const previewAlias = mediaPath.replace(/\/previews\//, "/");
    const inAssembly = path.resolve(mediaPath).startsWith(path.resolve(args.sliceRoot, "assembly") + path.sep);
    const allowed = inAssembly
      || isAllowlisted(mediaPath, currentAllowlist(), [args.sliceRoot, ...args.mediaRoots])
      || (mediaPath.includes("/previews/") && isAllowlisted(previewAlias, currentAllowlist(), [args.sliceRoot, ...args.mediaRoots]));
    if (!allowed) {
      return sendJson(res, 403, { ok: false, error: "path is not an indexed project asset" });
    }
    const stats = fs.statSync(mediaPath);
    const response = staticResponseHeaders({
      fileSize: stats.size,
      rangeHeader: req.headers.range,
      contentType: contentType(mediaPath),
    });
    if (url.searchParams.get("dl")) {
      // deliberate download lane (media manager bulk export): same-origin,
      // so masters move without cross-host auth seams
      response.headers["content-disposition"] = `attachment; filename="${path.basename(mediaPath)}"`;
    }
    res.writeHead(response.status, response.headers);
    if (req.method === "HEAD" || response.status === 416) return res.end();
    const streamOptions = response.range ? { start: response.range.start, end: response.range.end } : undefined;
    fs.createReadStream(mediaPath, streamOptions).pipe(res);
    return true;
  }
  return false;
}

const server = http.createServer((req, res) => {
  try {
    if (req.method === "OPTIONS") return sendJson(res, 200, { ok: true });
    const url = new URL(req.url || "/", `http://${args.host}:${args.port}`);
    if (NLE_ROUTES.has(url.pathname)) {
      handleNleApi(req, res, url).catch((error) => sendJson(res, 500, { ok: false, error: error.message }));
      return;
    }
    if (url.pathname === "/api/exports" && req.method === "GET") {
      // the exports shelf: every export lands in <bundle>/assembly/<ver>/;
      // this lists them newest-first so humans never hunt a Linux filesystem
      // for a video an agent just made .
      const root = path.join(args.sliceRoot, "assembly");
      const found = [];
      const walk = (dir, depth) => {
        if (depth > 3) return;
        let entries = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) walk(p, depth + 1);
          else if (/\.(mp4|mov|webm)$/i.test(e.name) && !/^(visual-only|xfade-)/.test(e.name) && !p.includes("/clips/") && !p.includes("/work/")) {
            try {
              const st = fs.statSync(p);
              found.push({ name: e.name, path: p, rel: path.relative(root, p), size: st.size, mtime: st.mtime.toISOString() });
            } catch {}
          }
        }
      };
      walk(root, 0);
      found.sort((a, b) => b.mtime.localeCompare(a.mtime));
      return sendJson(res, 200, { ok: true, exports: found });
    }
    if (url.pathname === "/api/tags" && req.method === "GET") {
      // derived tag state from the append-only tags.jsonl (bundle rails:
      // the UI and agents write the SAME log). Records: {op:add|remove,
      // tag, asset(basename)} and {op:bind, tag, spine} (scene binding —
      // a convention agents honor, never a gate).
      const tagsPath = path.join(args.sliceRoot, "tags.jsonl");
      const tags = {}; const byAsset = {};
      try {
        for (const line of fs.readFileSync(tagsPath, "utf8").trim().split("\n")) {
          if (!line) continue;
          let r; try { r = JSON.parse(line); } catch { continue; }
          const t = String(r.tag || "").trim(); if (!t) continue;
          tags[t] = tags[t] || { assets: new Set(), spine: null };
          if (r.op === "bind") tags[t].spine = r.spine == null ? null : String(r.spine);
          else if (r.op === "add" && r.asset) tags[t].assets.add(String(r.asset));
          else if (r.op === "remove" && r.asset) tags[t].assets.delete(String(r.asset));
        }
      } catch {}
      const out = {};
      for (const [t, v] of Object.entries(tags)) {
        out[t] = { count: v.assets.size, spine: v.spine, assets: [...v.assets] };
        for (const a of v.assets) (byAsset[a] = byAsset[a] || []).push(t);
      }
      return sendJson(res, 200, { ok: true, tags: out, byAsset });
    }
    if ((url.pathname === "/api/tags" || url.pathname === "/api/selections") && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          const j = JSON.parse(body);
          const email = req.headers["cf-access-authenticated-user-email"];
          const by = email ? `${String(email).split("@")[0].replace(/[^a-z0-9.]/gi, "")}-ui` : "local-ui";
          const ts = new Date().toISOString();
          if (url.pathname === "/api/tags") {
            const ops = (Array.isArray(j.ops) ? j.ops : []).slice(0, 500);
            const lines = ops.filter((o) => ["add", "remove", "bind"].includes(o.op) && o.tag)
              .map((o) => JSON.stringify({ op: o.op, tag: String(o.tag).slice(0, 80),
                asset: o.asset ? path.basename(String(o.asset)) : undefined,
                spine: o.spine != null ? String(o.spine).slice(0, 20) : undefined, ts, by }));
            if (lines.length) fs.appendFileSync(path.join(args.sliceRoot, "tags.jsonl"), lines.join("\n") + "\n");
            return sendJson(res, 200, { ok: true, appended: lines.length });
          }
          // /api/selections: a PIN — a durable named selection for the agent
          const rec = { name: String(j.name || "").slice(0, 120) || null,
            assets: (Array.isArray(j.assets) ? j.assets : []).slice(0, 300).map((a) => path.basename(String(a))),
            surface: String(j.surface || "media-manager").slice(0, 60), ts, by };
          fs.appendFileSync(path.join(args.sliceRoot, "selections.jsonl"), JSON.stringify(rec) + "\n");
          const focus = { surface: rec.surface, selection: rec.assets, view: "", note: rec.name || "",
            pinned: true, ts, by };
          fs.writeFileSync(path.join(args.sliceRoot, "focus.json"), JSON.stringify(focus, null, 1));
          return sendJson(res, 200, { ok: true });
        } catch (error) { sendJson(res, 400, { ok: false, error: error.message }); }
      });
      return;
    }
    if (url.pathname === "/api/focus" && req.method === "POST") {
      // the human-attention bridge : surfaces report what the
      // human has selected/pinned; seats read <bundle>/focus.json when the
      // human says "these". Attributed + durable, like every UI gesture.
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          const j = JSON.parse(body);
          const email = req.headers["cf-access-authenticated-user-email"];
          const by = email ? `${String(email).split("@")[0].replace(/[^a-z0-9.]/gi, "")}-ui` : "local-ui";
          const focus = {
            surface: String(j.surface || "unknown").slice(0, 60),
            selection: (Array.isArray(j.selection) ? j.selection : []).slice(0, 200).map(String),
            view: String(j.view || "").slice(0, 40),
            note: String(j.note || "").slice(0, 2000),
            ts: new Date().toISOString(), by,
          };
          fs.writeFileSync(path.join(args.sliceRoot, "focus.json"), JSON.stringify(focus, null, 1));
          sendJson(res, 200, { ok: true });
        } catch (error) { sendJson(res, 400, { ok: false, error: error.message }); }
      });
      return;
    }
    if (url.pathname === "/api/curation" && req.method === "GET") {
      // server-to-server proxy to the CUTDOWN surface's cut/version/lock
      // state (same box, no CORS/auth seams). Absent cutdown -> graceful
      // empty so the media manager degrades to a plain grid.
      const upstream = process.env.CUTDOWN_API || "http://127.0.0.1:8795";
      const preq = http.get(`${upstream}/api/cuts`, { timeout: 2500 }, (pres) => {
        let body = "";
        pres.on("data", (c) => (body += c));
        pres.on("end", () => {
          try { sendJson(res, 200, { ok: true, ...JSON.parse(body) }); }
          catch { sendJson(res, 200, { ok: false, cuts: [] }); }
        });
      });
      preq.on("timeout", () => { preq.destroy(); sendJson(res, 200, { ok: false, cuts: [] }); });
      preq.on("error", () => sendJson(res, 200, { ok: false, cuts: [] }));
      return;
    }
    if (url.pathname === "/api/validate-export") {
      return sendJson(res, 200, validate(url.searchParams.get("mode") || "review"));
    }
    if (url.pathname === "/api/validate-audio") {
      const report = validateAudio(url.searchParams.get("mode") || "review");
      const payload = url.searchParams.get("detail") === "full" ? report : compactAudioReport(report);
      return sendJson(res, 200, payload);
    }
    if (url.pathname === "/api/export-review" && req.method === "POST") {
      const job = startExport("review");
      return sendJson(res, 202, { ok: true, jobId: job.id, state: job.state });
    }
    if (url.pathname === "/api/export-final" && req.method === "POST") {
      const finalValidation = validate("final");
      if (!finalValidation.ok) return sendJson(res, 409, finalValidation);
      const job = startExport("final");
      return sendJson(res, 202, { ok: true, jobId: job.id, state: job.state });
    }
    if (url.pathname.startsWith("/api/export-status/")) {
      const jobId = url.pathname.split("/").pop();
      const job = jobs.get(jobId);
      if (!job) return sendJson(res, 404, { ok: false, error: "job not found" });
      return sendJson(res, 200, job);
    }

    let staticPath = safeStaticPath(url.pathname);
    if (!staticPath || !fs.existsSync(staticPath) || !fs.statSync(staticPath).isFile()) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      return res.end("not found");
    }
    // proxy-edit doctrine: BROWSER PLAYBACK of render masters swaps to the
    // lightweight previews/ sibling when one exists (the stage player,
    // takes strip). Masters still move deliberately via /api/media dl
    // lanes and the export pipeline, which never touch this route.
    if (/\/media\/renders\/[^/]+\.mp4$/.test(staticPath)) {
      const prev = staticPath.replace(/\/renders\//, "/renders/previews/");
      if (fs.existsSync(prev)) staticPath = prev;
    }
    const stats = fs.statSync(staticPath);
    // the malleable-UI rail: app shells self-reload when an agent edits them.
    // Injected at serve time (mini-nle.html is GENERATED — never hand-edit it),
    // with the served file's mtime baked in as the baseline.
    if (APP_SHELLS.has(path.basename(staticPath)) && req.method !== "HEAD" && !req.headers.range) {
      const html = fs.readFileSync(staticPath, "utf8");
      const watcher = `\n<script>(()=>{const f=${JSON.stringify(path.basename(staticPath))};let m=${stats.mtimeMs};setInterval(async()=>{try{const r=await fetch("/api/shell-mtime?f="+encodeURIComponent(f));const j=await r.json();if(j.ok&&j.mtimeMs!==m)location.reload();}catch(e){}},2500);})();</script>`;
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "access-control-allow-origin": "*",
        "cache-control": "no-store",
      });
      return res.end(html.includes("</body>") ? html.replace("</body>", `${watcher}\n</body>`) : html + watcher);
    }
    const response = staticResponseHeaders({
      fileSize: stats.size,
      rangeHeader: req.headers.range,
      contentType: contentType(staticPath),
    });
    // surfaces + registries must never be stale (Safari heuristically
    // caches responses with NO cache headers — this produced stale UI after
    // deploys); media stays revalidatable
    if (/\.(html|json|jsonl)$/.test(staticPath)) response.headers["cache-control"] = "no-store";
    else response.headers["cache-control"] = "no-cache";
    res.writeHead(response.status, response.headers);
    if (req.method === "HEAD" || response.status === 416) return res.end();
    const streamOptions = response.range ? { start: response.range.start, end: response.range.end } : undefined;
    fs.createReadStream(staticPath, streamOptions).pipe(res);
  } catch (error) {
    sendJson(res, 500, { ok: false, error: error.message });
  }
});

server.listen(args.port, args.host, () => {
  console.log(`timeline export server: http://${args.host}:${args.port}/timeline-viewer.html`);
  // notes written while the daemon was down get a fresh chance
  flushPendingNotes().then((flushed) => {
    if (flushed.length) console.log(`flushed ${flushed.length} pending review note(s): ${flushed.join(", ")}`);
  }).catch(() => {});
});
