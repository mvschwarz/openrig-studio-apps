#!/usr/bin/env node
// Patch layer for the mini-NLE: edits land in timeline-edits.patch.json first,
// and timeline.json is only mutated by applyPatch after validation passes.
// Validation reuses the exporter's own planExport + validatePlanWithProbes.
// 
import fs from "node:fs";
import path from "node:path";
import {
  materializeCards,
  mediaKind,
  planExport,
  readTimelineFile,
  roundSeconds,
  timelineTotalDuration,
} from "./timeline-export-core.mjs";
import { resolveSystemBin, validatePlanWithProbes } from "./timeline-export-probe.mjs";
import {
  appendEvents,
  bootstrapHistory,
  cardSnapshot,
  defaultPaths,
  eventTimestamp,
  makeEventId,
  rebuildSlots,
  slotUidFor,
} from "./timeline-history.mjs";
import { defaultAssetPaths, generateProjectAssets } from "./project-assets.mjs";

const MIN_DURATION_S = 0.2;

export function makePatchId(date = new Date()) {
  return `patch_${date.toISOString().replace(/[-:T]/g, "").slice(0, 14)}_${Math.random().toString(16).slice(2, 6)}`;
}

export function emptyPatch({ actor = "mini-nle", reason = "" } = {}) {
  return {
    patch_id: makePatchId(),
    created_at: eventTimestamp(),
    actor,
    reason,
    base_timeline: "timeline.json",
    ops: [],
  };
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function ensureSequenceBackbone(timeline) {
  if (Array.isArray(timeline.sequence) && timeline.sequence.length > 0) {
    // REFERENCED-style entries ({id} with the card in cards[])
    // get their card embedded — agent-authored boards use this style; the
    // patch layer previously refused them ("has no embedded card")
    const byId = new Map((Array.isArray(timeline.cards) ? timeline.cards : []).map((card) => [String(card.id), card]));
    timeline.sequence = timeline.sequence.map((entry) => {
      if ((entry?.type || "card") === "card" && !entry.card) {
        const src = byId.get(String(entry.id));
        if (src) {
          return { ...entry,
            duration_s: entry.duration_s != null ? entry.duration_s : roundSeconds(Number(src.duration_s)),
            card: cloneJson(src) };
        }
      }
      return entry;
    });
    return;
  }
  if (!Array.isArray(timeline.cards) || timeline.cards.length === 0) return;
  timeline.sequence = [...timeline.cards]
    .sort((a, b) => Number(a.start_s) - Number(b.start_s) || String(a.id).localeCompare(String(b.id)))
    .map((card) => ({
      id: String(card.id),
      type: "card",
      duration_s: roundSeconds(Number(card.duration_s)),
      card: cloneJson(card),
    }));
}

function findSequenceEntry(timeline, id) {
  const entry = (timeline.sequence || []).find((item) => String(item.id) === String(id) && (item.type || "card") === "card");
  if (!entry) throw new Error(`op target not found in sequence[]: ${id}`);
  if (!entry.card) throw new Error(`sequence entry ${id} has no embedded card; unsupported by patch layer`);
  return entry;
}

function setEntryDuration(entry, duration) {
  const value = roundSeconds(duration);
  if (!Number.isFinite(value) || value < MIN_DURATION_S) {
    throw new Error(`${entry.id}: duration_s must be >= ${MIN_DURATION_S}, got ${duration}`);
  }
  entry.duration_s = value;
  entry.card.duration_s = value;
  if (entry.card.target_clip_length_s != null) entry.card.target_clip_length_s = value;
}

function sourceSpanOf(card) {
  const sourceIn = Math.max(0, Number(card.source_in_s ?? 0));
  const sourceOut = Number(card.source_out_s);
  if (!Number.isFinite(sourceOut) || sourceOut <= sourceIn) return null;
  return { sourceIn, sourceOut, span: sourceOut - sourceIn };
}

function sectionFromCardId(id) {
  const match = String(id || "").match(/^(\d+)/);
  return match ? match[1] : "outline";
}

// Apply one op to the working timeline (deep-cloned by applyOps). Each op
// returns a change record used for history events.
const OP_HANDLERS = {
  set_duration(timeline, op) {
    const entry = findSequenceEntry(timeline, op.id);
    const before = cloneJson(entry.card);
    setEntryDuration(entry, op.duration_s);
    return { id: String(op.id), action: "retime", before, after: cloneJson(entry.card) };
  },

  trim_source(timeline, op) {
    const entry = findSequenceEntry(timeline, op.id);
    const before = cloneJson(entry.card);
    if (op.source_in_s != null) entry.card.source_in_s = roundSeconds(Math.max(0, Number(op.source_in_s)));
    if (op.source_out_s != null) entry.card.source_out_s = roundSeconds(Number(op.source_out_s));
    if (op.duration_s != null) setEntryDuration(entry, op.duration_s);
    const span = sourceSpanOf(entry.card);
    if (entry.card.source_out_s != null && !span) {
      throw new Error(`${op.id}: source_out_s must be greater than source_in_s`);
    }
    return { id: String(op.id), action: "trim", before, after: cloneJson(entry.card) };
  },

  split_at(timeline, op) {
    const entry = findSequenceEntry(timeline, op.id);
    const before = cloneJson(entry.card);
    const offset = roundSeconds(Number(op.offset_s));
    const total = Number(entry.duration_s ?? entry.card.duration_s);
    if (!Number.isFinite(offset) || offset < MIN_DURATION_S || offset > total - MIN_DURATION_S) {
      throw new Error(`${op.id}: split offset_s ${op.offset_s} must be inside (${MIN_DURATION_S}, ${roundSeconds(total - MIN_DURATION_S)})`);
    }
    const newId = String(op.new_id || `${op.id}b`);
    if ((timeline.sequence || []).some((item) => String(item.id) === newId)) {
      throw new Error(`split new_id already exists in sequence: ${newId}`);
    }
    const speed = Number(entry.card.speed_factor) > 0 ? Number(entry.card.speed_factor) : 1;
    const secondCard = cloneJson(entry.card);
    secondCard.id = newId;
    secondCard.title = `${entry.card.title || op.id} (split)`;
    const sourceIn = Math.max(0, Number(entry.card.source_in_s ?? 0));
    secondCard.source_in_s = roundSeconds(sourceIn + offset * speed);
    const secondEntry = {
      id: newId,
      type: "card",
      duration_s: roundSeconds(total - offset),
      card: secondCard,
    };
    setEntryDuration(entry, offset);
    // first half now ends where the split lands in the source
    if (sourceSpanOf(entry.card) || entry.card.source_out_s == null) {
      entry.card.source_out_s = roundSeconds(sourceIn + offset * speed);
    }
    setEntryDuration(secondEntry, secondEntry.duration_s);
    const index = timeline.sequence.indexOf(entry);
    timeline.sequence.splice(index + 1, 0, secondEntry);
    return [
      { id: String(op.id), action: "split", before, after: cloneJson(entry.card) },
      { id: newId, action: "split-create", before: null, after: cloneJson(secondCard), parentSlotUid: slotUidFor(op.id) },
    ];
  },

  stretch_to(timeline, op) {
    const entry = findSequenceEntry(timeline, op.id);
    const before = cloneJson(entry.card);
    const target = Number(op.duration_s);
    const span = sourceSpanOf(entry.card);
    const previousSpeed = Number(entry.card.speed_factor) > 0 ? Number(entry.card.speed_factor) : 1;
    const activeSpan = span ? span.span : Number(entry.duration_s ?? entry.card.duration_s) * previousSpeed;
    if (!Number.isFinite(target) || target < MIN_DURATION_S) {
      throw new Error(`${op.id}: stretch_to duration_s must be >= ${MIN_DURATION_S}`);
    }
    entry.card.speed_factor = roundSeconds(activeSpan / target);
    setEntryDuration(entry, target);
    return { id: String(op.id), action: "stretch", before, after: cloneJson(entry.card) };
  },

  upsert_bed(timeline, op) {
    const source = { ...(op.bed || op) };
    const id = String(source.id || source.bed_id || "").trim();
    if (!id) throw new Error("upsert_bed requires id");
    const asset = String(source.asset || "").trim();
    if (!asset) throw new Error(`${id}: upsert_bed requires asset`);
    const start = roundSeconds(Math.max(0, Number(source.start_s ?? 0)));
    const duration = roundSeconds(Number(source.duration_s));
    if (!Number.isFinite(duration) || duration <= 0) throw new Error(`${id}: bed duration_s must be > 0`);
    const fadeIn = roundSeconds(Math.max(0, Number(source.fade_in_s || 0)));
    const fadeOut = roundSeconds(Math.max(0, Number(source.fade_out_s || 0)));
    if (fadeIn + fadeOut > duration) throw new Error(`${id}: fade_in_s + fade_out_s exceeds bed duration ${duration}`);
    const volume = Number(source.volume ?? 1);
    if (!Number.isFinite(volume) || volume < 0) throw new Error(`${id}: volume must be >= 0`);
    const collectionName = source.collection === "music_beds" || source.kind === "music" ? "music_beds" : "audio_beds";
    if (!Array.isArray(timeline[collectionName])) timeline[collectionName] = [];
    const index = timeline[collectionName].findIndex((item) => String(item.id) === id);
    const before = index >= 0 ? cloneJson(timeline[collectionName][index]) : null;
    const bed = {
      id,
      title: String(source.title || id),
      asset,
      start_s: start,
      duration_s: duration,
      source_in_s: roundSeconds(Math.max(0, Number(source.source_in_s || 0))),
      volume: roundSeconds(volume),
      fade_in_s: fadeIn,
      fade_out_s: fadeOut,
      ...(source.status ? { status: String(source.status) } : {}),
    };
    if (index >= 0) timeline[collectionName][index] = bed;
    else timeline[collectionName].push(bed);
    return { id, action: index >= 0 ? "bed-upsert" : "bed-create", before, after: cloneJson(bed), isBed: true };
  },

  set_bed_window(timeline, op) {
    const beds = [...(timeline.audio_beds || []), ...(timeline.music_beds || [])];
    const bed = beds.find((item) => String(item.id) === String(op.bed_id));
    if (!bed) throw new Error(`op target bed not found: ${op.bed_id}`);
    const before = cloneJson(bed);
    if (op.start_s != null) bed.start_s = roundSeconds(Math.max(0, Number(op.start_s)));
    if (op.duration_s != null) {
      const value = roundSeconds(Number(op.duration_s));
      if (!Number.isFinite(value) || value <= 0) throw new Error(`${op.bed_id}: bed duration_s must be > 0`);
      bed.duration_s = value;
    }
    for (const field of ["fade_in_s", "fade_out_s"]) {
      if (op[field] === undefined) continue;
      const value = Number(op[field]);
      if (!Number.isFinite(value) || value < 0) throw new Error(`${op.bed_id}: ${field} must be >= 0`);
      bed[field] = roundSeconds(value);
    }
    if (op.volume !== undefined) {
      const value = Number(op.volume);
      if (!Number.isFinite(value) || value < 0) throw new Error(`${op.bed_id}: volume must be >= 0`);
      bed.volume = roundSeconds(value);
    }
    if (Number(bed.fade_in_s || 0) + Number(bed.fade_out_s || 0) > Number(bed.duration_s)) {
      throw new Error(`${op.bed_id}: fade_in_s + fade_out_s exceeds bed duration ${bed.duration_s}`);
    }
    return { id: String(op.bed_id), action: "bed-retime", before, after: cloneJson(bed), isBed: true };
  },

  // fade/crossfade METADATA on cards (). The exporter does not
  // render fades yet in v0; these fields ride the card for the assembler.
  set_fades(timeline, op) {
    const entry = findSequenceEntry(timeline, op.id);
    const before = cloneJson(entry.card);
    for (const field of ["fade_in_s", "fade_out_s", "crossfade_to_next_s"]) {
      if (op[field] === undefined) continue;
      if (op[field] === null) { delete entry.card[field]; continue; }
      const value = Number(op[field]);
      if (!Number.isFinite(value) || value < 0) throw new Error(`${op.id}: ${field} must be >= 0`);
      entry.card[field] = roundSeconds(value);
    }
    const duration = Number(entry.duration_s ?? entry.card.duration_s);
    const fadeIn = Number(entry.card.fade_in_s || 0);
    const fadeOut = Number(entry.card.fade_out_s || 0);
    if (fadeIn + fadeOut > duration) {
      throw new Error(`${op.id}: fade_in_s + fade_out_s (${roundSeconds(fadeIn + fadeOut)}) exceeds card duration ${duration}`);
    }
    const crossfade = Number(entry.card.crossfade_to_next_s || 0);
    if (crossfade > 0) {
      const cardEntries = (timeline.sequence || []).filter((item) => (item.type || "card") === "card");
      const index = cardEntries.indexOf(entry);
      const next = cardEntries[index + 1];
      if (!next) throw new Error(`${op.id}: crossfade_to_next_s set on the last card`);
      const nextDuration = Number(next.duration_s ?? next.card?.duration_s);
      if (crossfade > duration || crossfade > nextDuration) {
        throw new Error(`${op.id}: crossfade_to_next_s ${crossfade} exceeds this card (${duration}s) or the next card (${nextDuration}s)`);
      }
    }
    return { id: String(op.id), action: "fades", before, after: cloneJson(entry.card) };
  },

  // install a new audio master package . Swaps the master triple,
  // preserves the previous triple via the existing *_previous convention, and
  // resets the spoken-spine duration to the new master's probed length.
  set_master(timeline, op) {
    for (const field of ["audio_master", "words_json", "captions_vtt"]) {
      if (!String(op[field] || "").trim()) throw new Error(`set_master: ${field} is required`);
    }
    const total = Number(op.total_duration_s);
    if (!Number.isFinite(total) || total <= 0) throw new Error("set_master: total_duration_s must be > 0");
    const before = {
      audio_master: timeline.audio_master,
      words_json: timeline.words_json,
      captions_vtt: timeline.captions_vtt,
      total_duration_s: timeline.total_duration_s,
    };
    timeline.audio_master_previous = timeline.audio_master;
    timeline.words_json_previous = timeline.words_json;
    timeline.captions_vtt_previous = timeline.captions_vtt;
    timeline.audio_master = String(op.audio_master);
    timeline.words_json = String(op.words_json);
    timeline.captions_vtt = String(op.captions_vtt);
    if (op.srt) timeline.subtitles_srt = String(op.srt);
    if (op.loudness_report) timeline.loudness_report = String(op.loudness_report);
    timeline.audio_master_status = String(op.status || "review-candidate");
    timeline.total_duration_s = roundSeconds(total);
    const after = {
      audio_master: timeline.audio_master,
      words_json: timeline.words_json,
      captions_vtt: timeline.captions_vtt,
      total_duration_s: timeline.total_duration_s,
    };
    return { id: "audio-master", action: "install-master", before, after, isMaster: true };
  },

  restore_occupant(timeline, op) {
    const entry = findSequenceEntry(timeline, op.id);
    const before = cloneJson(entry.card);
    const asset = String(op.asset || "").trim();
    if (!asset) throw new Error(`${op.id}: restore_occupant requires asset`);
    entry.card.asset = asset;
    const kind = mediaKind(asset);
    if (kind === "video") entry.card.type = "clip";
    else if (kind === "image") entry.card.type = "slide";
    if (op.type) entry.card.type = String(op.type);
    entry.card.status = String(op.status || "installed");
    if (op.source_in_s != null) entry.card.source_in_s = roundSeconds(Math.max(0, Number(op.source_in_s)));
    else delete entry.card.source_in_s;
    if (op.source_out_s != null) entry.card.source_out_s = roundSeconds(Number(op.source_out_s));
    else delete entry.card.source_out_s;
    if (op.hold_policy !== undefined || op.holdPolicy !== undefined) {
      const policy = String(op.hold_policy ?? op.holdPolicy ?? "").trim();
      if (policy) entry.card.hold_policy = policy;
      else delete entry.card.hold_policy;
    }
    if (op.duration_s != null) setEntryDuration(entry, op.duration_s);
    return { id: String(op.id), action: "replace-asset", before, after: cloneJson(entry.card) };
  },

  // ---- board ops - the human's sweep and agent suggestions ride
  // the same rails (validate -> backup -> apply -> history) ----

  // toggle a clip's own (sync) audio; gain optional
  set_source_audio(timeline, op) {
    const entry = findSequenceEntry(timeline, op.id);
    const before = cloneJson(entry.card);
    if (op.use_source_audio === true) entry.card.use_source_audio = true;
    else delete entry.card.use_source_audio;
    if (op.gain != null) {
      const gain = Number(op.gain);
      if (!Number.isFinite(gain) || gain < 0) throw new Error(`${op.id}: gain must be >= 0`);
      entry.card.source_audio_gain = roundSeconds(gain);
    }
    return { id: String(op.id), action: "sync-audio", before, after: cloneJson(entry.card) };
  },

  set_audio_loudness(timeline, op) {
    const before = { audio_loudness_target: timeline.audio_loudness_target };
    if (op.target == null) delete timeline.audio_loudness_target;
    else {
      const target = Number(op.target);
      if (!Number.isFinite(target) || target < -70 || target > -5) {
        throw new Error("audio loudness target must be between -70 and -5 LUFS");
      }
      timeline.audio_loudness_target = roundSeconds(target);
    }
    return {
      id: "timeline.audio",
      action: "audio-loudness",
      before,
      after: { audio_loudness_target: timeline.audio_loudness_target },
    };
  },

  set_template(timeline, op) {
    const entry = findSequenceEntry(timeline, op.id);
    const before = cloneJson(entry.card);
    if (!String(op.template || "").trim()) throw new Error(`${op.id}: set_template requires template`);
    entry.card.template = String(op.template);
    if (op.title != null) entry.card.title = String(op.title);
    if (op.note != null) entry.card.note = String(op.note);
    return { id: String(op.id), action: "retemplate", before, after: cloneJson(entry.card) };
  },

  set_section(timeline, op) {
    const entry = findSequenceEntry(timeline, op.id);
    const before = cloneJson(entry.card);
    const section = String(op.section || "").trim();
    if (!section) throw new Error(`${op.id}: set_section requires section`);
    entry.card.section = section;
    return { id: String(op.id), action: "metadata", before, after: cloneJson(entry.card) };
  },

  // basic CRUD (stage editor): rename a beat / edit its note without
  // touching anything else
  set_meta(timeline, op) {
    const entry = findSequenceEntry(timeline, op.id);
    const before = cloneJson(entry.card);
    if (op.title == null && op.note == null) throw new Error(`${op.id}: set_meta requires title and/or note`);
    if (op.title != null) {
      const title = String(op.title).trim();
      if (!title) throw new Error(`${op.id}: title cannot be empty`);
      entry.card.title = title;
    }
    if (op.note != null) {
      const note = String(op.note);
      if (note.trim()) entry.card.note = note;
      else delete entry.card.note;
    }
    return { id: String(op.id), action: "metadata", before, after: cloneJson(entry.card) };
  },

  insert_beat(timeline, op) {
    const newId = String(op.id || "").trim();
    if (!newId) throw new Error("insert_beat requires id");
    if ((timeline.sequence || []).some((item) => String(item.id) === newId)) {
      throw new Error(`insert_beat id already exists in sequence: ${newId}`);
    }
    const duration = op.duration_s != null ? Number(op.duration_s) : 4;
    if (!Number.isFinite(duration) || duration < MIN_DURATION_S) {
      throw new Error(`${newId}: insert_beat duration_s must be >= ${MIN_DURATION_S}`);
    }
    const card = {
      id: newId,
      type: "placeholder",
      status: "placeholder",
      title: String(op.title || newId),
      section: String(op.section || sectionFromCardId(newId)),
      transcript: String(op.transcript || op.title || newId),
      duration_s: roundSeconds(duration),
      ...(op.template ? { template: String(op.template) } : {}),
      ...(op.note ? { note: String(op.note) } : {}),
    };
    const entry = { id: newId, type: "card", duration_s: roundSeconds(duration), card };
    timeline.sequence.splice(sequenceInsertIndex(timeline, op), 0, entry);
    return { id: newId, action: "seat-create", before: null, after: cloneJson(card) };
  },

  remove_beat(timeline, op) {
    const entry = findSequenceEntry(timeline, op.id);
    const before = cloneJson(entry.card);
    timeline.sequence.splice(timeline.sequence.indexOf(entry), 1);
    return { id: String(op.id), action: "seat-retire", before, after: null };
  },

  move_beat(timeline, op) {
    const entry = findSequenceEntry(timeline, op.id);
    const before = cloneJson(entry.card);
    const from = timeline.sequence.indexOf(entry);
    timeline.sequence.splice(from, 1);
    const to = sequenceInsertIndex(timeline, op);
    timeline.sequence.splice(to, 0, entry);
    return { id: String(op.id), action: "reorder", before, after: cloneJson(entry.card), reason: op.reason || `moved from index ${from} to ${to}` };
  },
};

// Where insert_beat/move_beat land: after_id wins, then a numeric position,
// else the end of the sequence.
function sequenceInsertIndex(timeline, op) {
  const sequence = timeline.sequence || [];
  if (op.after_id != null) {
    const anchor = sequence.findIndex((item) => String(item.id) === String(op.after_id));
    if (anchor === -1) throw new Error(`after_id not found in sequence: ${op.after_id}`);
    return anchor + 1;
  }
  if (op.position != null) {
    const position = Number(op.position);
    if (!Number.isInteger(position) || position < 0 || position > sequence.length) {
      throw new Error(`position must be an integer in [0, ${sequence.length}], got ${op.position}`);
    }
    return position;
  }
  return sequence.length;
}

export function applyOps(timeline, ops) {
  const working = cloneJson(timeline);
  ensureSequenceBackbone(working);
  const changes = [];
  for (const [index, op] of (ops || []).entries()) {
    const handler = OP_HANDLERS[op?.op];
    if (!handler) throw new Error(`ops[${index}]: unknown op '${op?.op}'`);
    const result = handler(working, op);
    for (const change of Array.isArray(result) ? result : [result]) {
      changes.push({ ...change, op: cloneJson(op), reason: op.reason || change.reason || "" });
    }
  }
  // recompute derived data from the edited sequence[] (the semantic backbone).
  // Drop the stale declared total first: timelineTotalDuration takes a max
  // that includes it, so shrinking edits would otherwise ratchet upward and
  // exports would carry a silent tail.
  working.cards = materializeCards(working);
  delete working.timeline_duration_s;
  working.timeline_duration_s = timelineTotalDuration(working);
  return { timeline: working, changes };
}

// Warnings that must block an apply when they mention a touched card. Review
// mode downgrades these to warnings, but a patch that introduces them is bad.
const BLOCKING_WARNING_RE = /(exceeds probed media duration|must be greater than source_in_s|asset file not found|could not probe media duration|file not found)/;

export function validatePatchedTimeline(patchedTimeline, { sliceRoot, touchedIds = [], probe = true }) {
  const plan = planExport(patchedTimeline, { sliceRoot, mode: "review", checkFiles: true });
  const validated = probe
    ? validatePlanWithProbes(plan, { ffprobe: resolveSystemBin("ffprobe"), mode: "review" })
    : plan;
  const errors = [...validated.validation.errors];
  const touched = new Set(touchedIds.map(String));
  for (const warning of validated.validation.warnings) {
    if (!BLOCKING_WARNING_RE.test(warning)) continue;
    const mentionsTouched = [...touched].some((id) => warning.startsWith(`${id}:`) || warning.includes(` ${id}:`) || warning.includes(`] ${id}`));
    if (mentionsTouched || touched.size === 0) errors.push(`blocking-warning: ${warning}`);
  }
  return {
    ok: errors.length === 0,
    errors,
    warnings: validated.validation.warnings,
    totalDurationS: validated.totalDurationS,
    cardCount: validated.validation.cardCount,
  };
}

export function validatePatch({ timelinePath, patch, sliceRoot, probe = true }) {
  const timeline = readTimelineFile(timelinePath);
  const { timeline: patched, changes } = applyOps(timeline, patch.ops);
  const touchedIds = changes.map((change) => change.id);
  const validation = validatePatchedTimeline(patched, { sliceRoot, touchedIds, probe });
  return { validation, patched, changes, touchedIds };
}

function backupTimeline(timelinePath, sliceRoot) {
  const backupDir = path.join(sliceRoot, "timeline-backups");
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:]/g, "-");
  const backupPath = path.join(backupDir, `timeline-${stamp}.json`);
  fs.copyFileSync(timelinePath, backupPath);
  return backupPath;
}

// one-writer rule, soft-enforced. Reads mutation-owner.json when
// present; a mismatched actor WARNS and is recorded, never blocked. The
// human UI client always passes (the person at the surface outranks the ledger).
const UI_ACTORS = new Set(["mini-nle-ui", "founder-ui@openrig-studio"]);

export function checkMutationOwner(sliceRoot, actor) {
  const ownerPath = path.join(sliceRoot, "mutation-owner.json");
  if (!fs.existsSync(ownerPath)) return { owner: null, mismatch: false, warning: null };
  let owner = null;
  try { owner = JSON.parse(fs.readFileSync(ownerPath, "utf8")).owner || null; } catch { return { owner: null, mismatch: false, warning: null }; }
  if (!owner || !actor || UI_ACTORS.has(actor) || actor === owner) return { owner, mismatch: false, warning: null };
  return {
    owner,
    mismatch: true,
    warning: `one-writer: ${actor} applied but mutation-owner.json names ${owner}. Applied anyway (soft enforcement); recorded in history. Move ownership via the owner file + a queue handoff.`,
  };
}

// locked (approved) slots warn on edit - soft, like one-writer
export function lockedSlotIds(sliceRoot) {
  try {
    const slots = JSON.parse(fs.readFileSync(path.join(sliceRoot, "timeline-slots.json"), "utf8")).slots || [];
    return new Set(slots.filter((slot) => slot.approved === true).map((slot) => String(slot.dot_id)));
  } catch { return new Set(); }
}

export function historyEventsForChanges(changes, { patchId, actor, reason, ownerMismatch = false, lockedIds = new Set() }) {
  const now = new Date();
  return changes
    .filter((change) => !change.isBed) // Deferred: bed retimes audit via patch archive only; slot ledger tracks cards
    .map((change, index) => change.isMaster ? {
      event_id: makeEventId("audio-master", change.action, now, String(index)),
      changed_at: eventTimestamp(now),
      actor,
      source: "patch-apply",
      ...(ownerMismatch ? { owner_mismatch: true } : {}),
      patch_id: patchId,
      slot: { slot_uid: "audio_master", dot_id_before: "A1", dot_id_after: "A1", section: "audio" },
      before: change.before,
      after: change.after,
      reason: change.reason || reason || "",
      validation: { schema: "pass", media: "pass", contiguity: "pass", export_review: "not-run" },
    } : ({
      event_id: makeEventId(change.id, change.action, now, String(index)),
      changed_at: eventTimestamp(now),
      actor,
      source: "patch-apply",
      ...(ownerMismatch ? { owner_mismatch: true } : {}),
      ...(lockedIds.has(String(change.id)) ? { locked_edit: true } : {}),
      patch_id: patchId,
      slot: {
        slot_uid: slotUidFor(change.id),
        dot_id_before: change.before ? String(change.id) : null,
        dot_id_after: String(change.id),
        section: String(change.after?.section || change.before?.section || ""),
        ...(change.parentSlotUid ? { parent_slot_uid: change.parentSlotUid } : {}),
      },
      before: change.before ? cardSnapshot(change.before) : null,
      after: change.after ? cardSnapshot(change.after) : null,
      reason: change.reason || reason || "",
      validation: { schema: "pass", media: "pass", contiguity: "pass", export_review: "not-run" },
    }));
}

export function applyPatch({
  sliceRoot,
  timelinePath,
  patchPath,
  patch = null,
  target = "canonical",
  actor = "timeline-patch.mjs",
  probe = true,
}) {
  const resolvedPatch = patch || JSON.parse(fs.readFileSync(patchPath, "utf8"));
  if (!Array.isArray(resolvedPatch.ops) || resolvedPatch.ops.length === 0) {
    return { ok: false, errors: ["patch has no ops"] };
  }
  const { validation, patched, changes } = validatePatch({ timelinePath, patch: resolvedPatch, sliceRoot, probe });
  if (!validation.ok) {
    return { ok: false, errors: validation.errors, warnings: validation.warnings };
  }

  const targetPath = target === "canonical" ? timelinePath : path.resolve(target);
  const writingCanonical = path.resolve(targetPath) === path.resolve(timelinePath);
  const ownership = writingCanonical ? checkMutationOwner(sliceRoot, actor) : { mismatch: false, warning: null };
  if (ownership.warning) validation.warnings.push(ownership.warning);
  const lockedIds = writingCanonical ? lockedSlotIds(sliceRoot) : new Set();
  for (const id of new Set(changes.map((change) => String(change.id)))) {
    if (lockedIds.has(id)) validation.warnings.push(`locked slot edited: ${id} is locked; applied anyway (soft enforcement) and recorded in history. Unlock it if this is deliberate rework.`);
  }
  let backupPath = null;
  if (writingCanonical) {
    backupPath = backupTimeline(timelinePath, sliceRoot);
    // bootstrap BEFORE the canonical write so the snapshot records pre-patch state
    bootstrapHistory(defaultPaths(sliceRoot)); // no-op when history already exists
  }
  fs.writeFileSync(targetPath, JSON.stringify(patched, null, 2));

  let historyPath = null;
  let slotsPath = null;
  let assetsPath = null;
  if (writingCanonical) {
    const paths = defaultPaths(sliceRoot);
    historyPath = paths.historyPath;
    slotsPath = paths.slotsPath;
    appendEvents(historyPath, historyEventsForChanges(changes, {
      patchId: resolvedPatch.patch_id,
      actor,
      reason: resolvedPatch.reason,
      ownerMismatch: ownership.mismatch,
      lockedIds,
    }));
    rebuildSlots(paths);
    const assetPaths = defaultAssetPaths(sliceRoot);
    assetsPath = assetPaths.assetsPath;
    generateProjectAssets({ sliceRoot, ...assetPaths, probe: false });

    // master installs update the current-audio pointer - nobody
    // never has to ask which audio plan is live.
    if (changes.some((change) => change.isMaster)) {
      fs.writeFileSync(path.join(sliceRoot, "current-audio.json"), JSON.stringify({
        _note: "DERIVED pointer to the active audio plan. Written on set_master apply.",
        installed_at: new Date().toISOString(),
        active: {
          master: patched.audio_master,
          words: patched.words_json,
          captions: patched.captions_vtt,
          srt: patched.subtitles_srt || null,
          loudness_report: patched.loudness_report || null,
          status: patched.audio_master_status || "review-candidate",
          total_duration_s: patched.total_duration_s,
        },
        previous: {
          master: patched.audio_master_previous || null,
          words: patched.words_json_previous || null,
          captions: patched.captions_vtt_previous || null,
        },
      }, null, 2));
    }

    // archive the consumed draft next to the backups, then clear it
    if (patchPath && fs.existsSync(patchPath)) {
      const archivePath = path.join(sliceRoot, "timeline-backups", `applied-${resolvedPatch.patch_id}.json`);
      fs.copyFileSync(patchPath, archivePath);
      fs.rmSync(patchPath);
    }
  }

  return {
    ok: true,
    target: targetPath,
    canonical: writingCanonical,
    backupPath,
    historyPath,
    slotsPath,
    assetsPath,
    patchId: resolvedPatch.patch_id,
    changeCount: changes.length,
    changedIds: changes.map((change) => change.id),
    totalDurationS: validation.totalDurationS,
    warnings: validation.warnings,
  };
}

function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const options = {
    sliceRoot: path.resolve(new URL("../../", import.meta.url).pathname),
    patchPath: "",
    target: "canonical",
    actor: "timeline-patch-cli",
    json: false,
    probe: true,
  };
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--slice-root") options.sliceRoot = path.resolve(argv[++i]);
    else if (arg === "--patch") options.patchPath = path.resolve(argv[++i]);
    else if (arg === "--target") options.target = argv[++i];
    else if (arg === "--actor") options.actor = argv[++i];
    else if (arg === "--no-probe") options.probe = false;
    else if (arg === "--json") options.json = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  const timelinePath = path.join(options.sliceRoot, "timeline.json");
  const patchPath = options.patchPath || path.join(options.sliceRoot, "timeline-edits.patch.json");

  if (command === "validate") {
    const patch = JSON.parse(fs.readFileSync(patchPath, "utf8"));
    const { validation, touchedIds } = validatePatch({ timelinePath, patch, sliceRoot: options.sliceRoot, probe: options.probe });
    const payload = { ok: validation.ok, touchedIds, ...validation };
    console.log(options.json ? JSON.stringify(payload, null, 2) : `${validation.ok ? "VALID" : "INVALID"}\n${validation.errors.join("\n")}`);
    process.exit(validation.ok ? 0 : 1);
  }
  if (command === "apply") {
    const result = applyPatch({
      sliceRoot: options.sliceRoot,
      timelinePath,
      patchPath,
      target: options.target,
      actor: options.actor,
      probe: options.probe,
    });
    console.log(options.json ? JSON.stringify(result, null, 2) : (result.ok ? `applied ${result.changeCount} change(s) to ${result.target}` : `REJECTED:\n${result.errors.join("\n")}`));
    process.exit(result.ok ? 0 : 1);
  }
  console.log("Usage: node timeline-patch.mjs <validate|apply> [--patch file] [--slice-root dir] [--target canonical|/path/copy.json] [--actor name] [--no-probe] [--json]");
  process.exit(command ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main();
}
