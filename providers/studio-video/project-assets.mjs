#!/usr/bin/env node
// Derived active-asset index (project-assets.json) for the mini-NLE Assets tab
// and the server reveal/stream allowlist. Authority stays with timeline.json,
// timeline-history.jsonl, and _CANON; this index is rebuildable at any time.
// 
import fs from "node:fs";
import path from "node:path";
import {
  fileExists,
  materializeCards,
  mediaKind,
  readTimelineFile,
  resolveRefPath,
} from "./timeline-export-core.mjs";
import { probeMedia, resolveSystemBin } from "./timeline-export-probe.mjs";
import { readHistory } from "./timeline-history.mjs";

const TEXT_ROLES = new Set(["captions", "word-timings", "phrase-timings", "manifest"]);

function assetIdFor(role, ref) {
  const base = String(ref).split("/").filter(Boolean).slice(-2).join("-").replace(/[^a-zA-Z0-9._-]+/g, "-");
  return `${role}:${base}`;
}

function mediaTypeFor(ref, role) {
  if (TEXT_ROLES.has(role)) return "text";
  const kind = mediaKind(ref);
  return kind === "unknown" ? "text" : kind;
}

// a media file whose name LEADS with a slot token registers as a
// take candidate for that slot ("4.3-take2.mp4", "04-3-v2.mp4" -> 4.3).
// Current boards can also use one-part ids ("01-cold-open.png" -> 1), but
// only bind those with timeline context so loose filenames do not overmatch.
// The filename IS the registration - no new storage.
export function slotRefFromFileName(name, validSlotRefs = null) {
  const value = String(name);
  const splitMatch = value.match(/^0?(\d+)[-._]0?(\d+)(?=[-._\s])/);
  const splitRef = splitMatch ? `${Number(splitMatch[1])}.${Number(splitMatch[2])}` : null;
  if (!validSlotRefs) return splitRef;

  const valid = validSlotRefs instanceof Set ? validSlotRefs : new Set([...validSlotRefs].map(String));
  if (splitRef && valid.has(splitRef)) return splitRef;

  const singleMatch = value.match(/^0?(\d+)(?=[-._\s])/);
  const singleRef = singleMatch ? `${Number(singleMatch[1])}` : null;
  if (singleRef && valid.has(singleRef)) return singleRef;

  return splitRef;
}

export function collectAssetEntries(timeline, { sliceRoot, historyPath }) {
  const entries = new Map();
  const cards = materializeCards(timeline);
  const validSlotRefs = new Set(cards.map((card) => String(card.id)));

  function add(ref, { role, slotRef = null, title = "", status = "active", historyEventId = null, note = "" }) {
    const value = String(ref || "").trim();
    if (!value) return;
    const resolved = resolveRefPath(value, { sliceRoot });
    const key = resolved;
    const existing = entries.get(key);
    if (existing) {
      if (slotRef && !existing.slot_refs.includes(slotRef)) existing.slot_refs.push(slotRef);
      if (historyEventId && !existing.history_event_ids.includes(historyEventId)) existing.history_event_ids.push(historyEventId);
      // current-slot-occupant beats historical/canon roles when the same file shows up twice
      if (role === "current-slot-occupant") existing.role = role;
      if (status === "active") existing.status = "active";
      return;
    }
    entries.set(key, {
      asset_id: assetIdFor(role, value),
      role,
      media_type: mediaTypeFor(value, role),
      status,
      slot_refs: slotRef ? [slotRef] : [],
      title,
      ref: value,
      path: resolved,
      exists: fileExists(resolved),
      history_event_ids: historyEventId ? [historyEventId] : [],
      note,
    });
  }

  function addBundleMedia(relDir, { role, titlePrefix }) {
    const dir = path.join(sliceRoot, relDir);
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      const ref = path.join(relDir, name);
      if (mediaKind(ref) === "unknown") continue;
      const resolved = resolveRefPath(ref, { sliceRoot });
      if (entries.has(resolved)) continue;
      const slotRef = slotRefFromFileName(name, validSlotRefs);
      add(ref, { role: slotRef ? "candidate" : role, slotRef, status: "candidate", title: `${titlePrefix}/${name}` });
    }
  }

  add(timeline.audio_master, { role: "audio-master", title: "Narration master" });
  add(timeline.captions_vtt, { role: "captions", title: "Captions VTT" });
  add(timeline.words_json, { role: "word-timings", title: "Word timings" });
  add(timeline.subtitles_srt, { role: "captions", title: "Release subtitles (SRT)" });
  add(timeline.loudness_report, { role: "manifest", title: "Loudness report" });
  add(timeline.audio_master_previous, { role: "audio-master", status: "historical", title: "Previous narration master" });

  // index the active audio plan's package artifacts when present
  const currentAudioPath = path.join(sliceRoot, "current-audio.json");
  if (fs.existsSync(currentAudioPath)) {
    try {
      const plan = JSON.parse(fs.readFileSync(currentAudioPath, "utf8"));
      for (const [key, role] of [["srt", "captions"], ["loudness_report", "manifest"]]) {
        if (plan?.active?.[key]) add(plan.active[key], { role, title: `Audio package ${key}` });
      }
    } catch {}
  }

  for (const bed of [...(timeline.audio_beds || []), ...(timeline.music_beds || [])]) {
    add(bed.asset, { role: "audio-bed", slotRef: String(bed.id || ""), title: String(bed.title || "Audio bed") });
  }

  for (const card of cards) {
    const slotRef = String(card.id);
    add(card.asset, { role: "current-slot-occupant", slotRef, title: String(card.title || "") });
    add(card.asset_source, { role: "source", slotRef, title: `${card.title || slotRef} (source)` });
    add(card.audio_asset, { role: "card-audio-source", slotRef, title: `${slotRef} audio segment` });
    add(card.audio_words_json, { role: "word-timings", slotRef, title: `${slotRef} words` });
    add(card.audio_phrase_timings_json, { role: "phrase-timings", slotRef, title: `${slotRef} phrase timings` });
    add(card.captions_vtt, { role: "captions", slotRef, title: `${slotRef} captions` });
  }

  if (historyPath && fs.existsSync(historyPath)) {
    for (const event of readHistory(historyPath)) {
      const slotRef = String(event?.slot?.dot_id_after || event?.slot?.dot_id_before || "");
      for (const side of ["before", "after"]) {
        const asset = event?.[side]?.asset;
        if (!asset) continue;
        add(asset, {
          role: "historical-occupant",
          slotRef,
          status: "historical",
          historyEventId: event.event_id,
          title: `${slotRef} ${side} (${event.event_id})`,
        });
      }
    }
  }

  for (const spec of [
    ["media/renders", { role: "bundle-media", titlePrefix: "renders" }],
    ["media/captures", { role: "bundle-media", titlePrefix: "captures" }],
    ["media/audio", { role: "bundle-media", titlePrefix: "audio" }],
    ["media/images", { role: "bundle-media", titlePrefix: "images" }],
    ["exports", { role: "distribution-export", titlePrefix: "exports" }],
  ]) {
    addBundleMedia(...spec);
  }

  // _CANON selects: list media files, mark as active when the timeline references them.
  const canonDir = path.join(sliceRoot, "_CANON");
  if (fs.existsSync(canonDir)) {
    for (const group of ["slides", "clips"]) {
      const groupDir = path.join(canonDir, group);
      if (!fs.existsSync(groupDir)) continue;
      for (const name of fs.readdirSync(groupDir)) {
        const ref = path.join("_CANON", group, name);
        if (mediaKind(ref) === "unknown") continue;
        const resolved = resolveRefPath(ref, { sliceRoot });
        if (!entries.has(resolved)) {
          const slotRef = slotRefFromFileName(name);
          add(ref, { role: slotRef ? "candidate" : "canon-select", slotRef, status: "candidate", title: `${group}/${name}` });
        }
      }
    }
  }

  return [...entries.values()];
}

export function probeEntries(entries, { probeLimitRoles = new Set(["current-slot-occupant", "audio-master", "audio-bed", "source", "historical-occupant"]) } = {}) {
  let ffprobe;
  try {
    ffprobe = resolveSystemBin("ffprobe");
  } catch {
    return entries; // no ffprobe available; index still useful without metadata
  }
  return entries.map((entry) => {
    if (!entry.exists || !probeLimitRoles.has(entry.role)) return entry;
    if (entry.media_type !== "video" && entry.media_type !== "audio") return entry;
    try {
      const probe = probeMedia(ffprobe, entry.path);
      const video = (probe.streams || []).find((stream) => stream.codec_type === "video");
      return {
        ...entry,
        duration_s: probe.duration_s,
        width: video?.width,
        height: video?.height,
        codec: video?.codec_name || (probe.streams || [])[0]?.codec_name,
      };
    } catch {
      return entry;
    }
  });
}

export function generateProjectAssets({ sliceRoot, timelinePath, historyPath, assetsPath, probe = true }) {
  const timeline = readTimelineFile(timelinePath);
  let assets = collectAssetEntries(timeline, { sliceRoot, historyPath });
  if (probe) assets = probeEntries(assets);
  const payload = {
    _note: "DERIVED active-asset index for the mini-NLE Assets tab and the reveal/stream allowlist. Rebuild with project-assets.mjs generate. Not a source of truth.",
    generated_at: new Date().toISOString(),
    slice_root: sliceRoot,
    asset_count: assets.length,
    assets,
  };
  fs.writeFileSync(assetsPath, JSON.stringify(payload, null, 2));
  return payload;
}

export function loadAllowlist(assetsPath) {
  const resolvedPaths = new Set();
  if (!fs.existsSync(assetsPath)) return resolvedPaths;
  const payload = JSON.parse(fs.readFileSync(assetsPath, "utf8"));
  for (const asset of payload.assets || []) {
    for (const key of ["path", "source_path", "proxy_path"]) {
      const value = asset[key];
      if (!value) continue;
      try {
        resolvedPaths.add(fs.realpathSync(value));
      } catch {
        resolvedPaths.add(path.resolve(value));
      }
    }
  }
  return resolvedPaths;
}

export function resolveRoots(roots) {
  return (roots || []).map((root) => {
    try {
      return fs.realpathSync(root);
    } catch {
      return path.resolve(root);
    }
  });
}

// Membership in the derived index AND residence under a configured root
// (slice root / media roots). Both gates required ().
export function isAllowlisted(candidatePath, allowlist, roots = null) {
  if (!candidatePath || typeof candidatePath !== "string") return false;
  let resolved;
  try {
    resolved = fs.realpathSync(candidatePath);
  } catch {
    return false; // must exist to be revealed/streamed
  }
  if (!allowlist.has(resolved)) return false;
  if (roots === null) return true;
  return resolveRoots(roots).some((root) => resolved === root || resolved.startsWith(root + path.sep));
}

export function defaultAssetPaths(sliceRoot) {
  return {
    timelinePath: path.join(sliceRoot, "timeline.json"),
    historyPath: path.join(sliceRoot, "timeline-history.jsonl"),
    assetsPath: path.join(sliceRoot, "project-assets.json"),
  };
}

function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const options = { sliceRoot: path.resolve(new URL("../../", import.meta.url).pathname), json: false, probe: true };
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--slice-root") options.sliceRoot = path.resolve(argv[++i]);
    else if (arg === "--no-probe") options.probe = false;
    else if (arg === "--json") options.json = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (command === "generate") {
    const paths = defaultAssetPaths(options.sliceRoot);
    const payload = generateProjectAssets({ sliceRoot: options.sliceRoot, ...paths, probe: options.probe });
    console.log(options.json
      ? JSON.stringify({ ok: true, assetCount: payload.asset_count, assetsPath: paths.assetsPath }, null, 2)
      : `generated ${payload.asset_count} assets at ${paths.assetsPath}`);
    return;
  }
  console.log("Usage: node project-assets.mjs generate [--slice-root dir] [--no-probe] [--json]");
  process.exit(command ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main();
}
