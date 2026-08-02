import fs from "node:fs";
import path from "node:path";

const MEDIA_EXTS = new Set([
  ".mp4",
  ".mov",
  ".m4v",
  ".webm",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".mp3",
  ".m4a",
  ".wav",
  ".aif",
  ".aiff",
]);

const VIDEO_EXTS = new Set([".mp4", ".mov", ".m4v", ".webm"]);
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const AUDIO_EXTS = new Set([".mp3", ".m4a", ".wav", ".aif", ".aiff"]);

export const DEFAULT_EXPORT = {
  width: 1920,
  height: 1080,
  fps: 30,
  audioSampleRate: 48000,
  timelineFile: "timeline.json",
};

export function roundSeconds(value, places = 6) {
  const factor = 10 ** places;
  return Math.round((Number(value) || 0) * factor) / factor;
}

export function fileExists(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export function isUrl(ref) {
  return /^[a-z]+:\/\//i.test(String(ref || ""));
}

export function extensionOf(ref) {
  const pathname = String(ref || "").split("?")[0].split("#")[0];
  return path.extname(pathname).toLowerCase();
}

export function hasMediaExtension(ref) {
  return MEDIA_EXTS.has(extensionOf(ref));
}

export function mediaKind(ref) {
  const ext = extensionOf(ref);
  if (VIDEO_EXTS.has(ext)) return "video";
  if (IMAGE_EXTS.has(ext)) return "image";
  if (AUDIO_EXTS.has(ext)) return "audio";
  return "unknown";
}

export function resolveRefPath(ref, { sliceRoot }) {
  const value = String(ref || "").trim();
  if (!value) return "";
  if (isUrl(value)) return value;
  if (path.isAbsolute(value)) return value;
  return path.resolve(sliceRoot, value);
}

export function chooseCardAsset(card, { sliceRoot }) {
  const candidates = [card?.asset_source, card?.source, card?.asset].filter(Boolean);
  for (const ref of candidates) {
    if (!hasMediaExtension(ref)) continue;
    const resolved = resolveRefPath(ref, { sliceRoot });
    return {
      ref: String(ref),
      path: resolved,
      kind: mediaKind(ref),
      exists: !isUrl(resolved) && fileExists(resolved),
      isUrl: isUrl(resolved),
    };
  }
  const fallback = String(card?.asset || "");
  const resolved = resolveRefPath(fallback, { sliceRoot });
  return {
    ref: fallback,
    path: resolved,
    kind: mediaKind(fallback),
    exists: Boolean(fallback) && !isUrl(resolved) && fileExists(resolved),
    isUrl: isUrl(resolved),
  };
}

export function chooseAudioAsset(ref, { sliceRoot }) {
  const value = String(ref || "").trim();
  const resolved = resolveRefPath(value, { sliceRoot });
  return {
    ref: value,
    path: resolved,
    kind: mediaKind(value),
    exists: Boolean(value) && !isUrl(resolved) && fileExists(resolved),
    isUrl: isUrl(resolved),
  };
}

export function materializeCards(timeline) {
  if (!Array.isArray(timeline?.sequence) || timeline.sequence.length === 0) {
    return [...(Array.isArray(timeline?.cards) ? timeline.cards : [])].map((card) => ({ ...card }));
  }

  const sourceCards = new Map((Array.isArray(timeline?.cards) ? timeline.cards : []).map((card) => [String(card.id), card]));
  const materialized = [];
  let cursor = 0;
  for (const entry of timeline.sequence) {
    const entryType = entry?.type || "card";
    const duration = Number(entry?.duration_s);
    if (entryType === "gap") {
      if (Number.isFinite(duration) && duration > 0) cursor = roundSeconds(cursor + duration);
      continue;
    }

    const id = String(entry?.id || entry?.card?.id || "");
    const source = entry?.card || sourceCards.get(id);
    if (!source) continue;
    const cardDuration = Number.isFinite(duration) && duration > 0 ? duration : Number(source.duration_s);
    const start = cursor;
    const card = {
      ...source,
      id,
      start_s: roundSeconds(start),
      audio_start_s: roundSeconds(start),
      audio_end_s: roundSeconds(start + cardDuration),
      duration_s: roundSeconds(cardDuration),
    };
    if (card.target_clip_length_s == null) card.target_clip_length_s = card.duration_s;
    materialized.push(card);
    cursor = roundSeconds(cursor + card.duration_s);
  }
  return applyCrossfadeOverlaps(materialized);
}

// crossfade_to_next_s becomes REAL — card B starts fade seconds
// before card A ends. Applied here in core so every consumer (preview,
// viewer, export plan, audio graph, health) agrees on the shifted timing.
// Only butt-joined neighbors crossfade (a gap between cards disables it);
// the fade is clamped so neither card is consumed entirely.
function applyCrossfadeOverlaps(cards) {
  let shift = 0;
  for (let i = 0; i < cards.length; i++) {
    const card = cards[i];
    if (shift > 0) {
      card.start_s = roundSeconds(card.start_s - shift);
      card.audio_start_s = roundSeconds(card.audio_start_s - shift);
      card.audio_end_s = roundSeconds(card.audio_end_s - shift);
    }
    const next = cards[i + 1];
    let fade = Math.max(0, Number(card.crossfade_to_next_s) || 0);
    if (fade > 0 && next) {
      const buttJoined = Math.abs((next.start_s) - (card.start_s + card.duration_s)) < 0.01;
      if (!buttJoined) { fade = 0; }
      else {
        fade = roundSeconds(Math.min(fade,
          Math.max(0, card.duration_s - 0.1), Math.max(0, next.duration_s - 0.1)));
      }
      if (fade > 0) {
        card.xfade_out_s = fade;
        next.xfade_in_s = fade;
        shift = roundSeconds(shift + fade);
      }
    }
  }
  return cards;
}

export function normalizedTimeline(timeline) {
  if (!timeline || typeof timeline !== "object") return timeline;
  return {
    ...timeline,
    cards: materializeCards(timeline),
  };
}

export function sortedCards(timeline) {
  return materializeCards(timeline)
    .map((card) => ({ ...card }))
    .sort((a, b) => Number(a.start_s) - Number(b.start_s) || String(a.id).localeCompare(String(b.id)));
}

export function isPlaceholderCard(card) {
  return card?.type === "placeholder" || card?.status === "placeholder" || !String(card?.asset || "").trim();
}

export function cardEnd(card) {
  return roundSeconds(Number(card.start_s) + Number(card.duration_s));
}

export function collectAudioBeds(timeline) {
  return [
    ...(Array.isArray(timeline?.music_beds) ? timeline.music_beds : []),
    ...(Array.isArray(timeline?.audio_beds) ? timeline.audio_beds : []),
  ].map((bed) => ({ ...bed }))
    .filter((bed) => bed.asset || bed.src || bed.source || bed.audio)
    .map((bed, index) => {
      const asset = String(bed.asset || bed.src || bed.source || bed.audio || "");
      const start = Number(bed.start_s ?? bed.timeline_start_s ?? 0);
      const duration = Number(bed.duration_s ?? bed.length_s ?? bed.window_s ?? 0);
      const sourceIn = Number(bed.source_in_s ?? bed.asset_in_s ?? bed.clip_in_s ?? 0);
      return {
        id: String(bed.id || `audio-bed-${index + 1}`),
        title: String(bed.title || bed.label || "Audio bed"),
        asset,
        start_s: start,
        duration_s: duration,
        end_s: start + duration,
        source_in_s: Number.isFinite(sourceIn) ? sourceIn : 0,
        volume: Number.isFinite(Number(bed.volume)) ? Number(bed.volume) : 1,
        fade_in_s: Math.max(0, Number(bed.fade_in_s) || 0),
        fade_out_s: Math.max(0, Number(bed.fade_out_s) || 0),
        status: String(bed.status || ""),
      };
    });
}

// fade in/out filters for a visual segment, relative to its slot duration.
// crossfade_to_next_s is validated metadata only for now.
// Deferred: true cross-dissolve needs xfade + overlapping segment renders,
// which breaks the concat model; build it when a cut actually needs one.
export function videoFadeFilters(segment) {
  const duration = Number(segment?.duration_s) || 0;
  const fadeIn = Math.max(0, Number(segment?.fade_in_s) || 0);
  const fadeOut = Math.max(0, Number(segment?.fade_out_s) || 0);
  const filters = [];
  if (fadeIn > 0) filters.push(`fade=t=in:st=0:d=${roundSeconds(fadeIn)}`);
  if (fadeOut > 0) filters.push(`fade=t=out:st=${roundSeconds(Math.max(0, duration - fadeOut))}:d=${roundSeconds(fadeOut)}`);
  return filters;
}

export function buildAudioMuxArgs({
  silentVideoPath,
  audioMasterPath,
  audioBeds = [],
  syncSegments = [],
  outPath,
  totalDuration,
  audioLoudnessTarget = -16,
}) {
  const duration = roundSeconds(totalDuration);
  const requestedTarget = Number(audioLoudnessTarget);
  const loudnessTarget = Number.isFinite(requestedTarget) && requestedTarget >= -70 && requestedTarget <= -5
    ? requestedTarget
    : -16;
  const finalAudioFilters = `loudnorm=I=${loudnessTarget}:TP=-1.5:LRA=11,alimiter=limit=0.841395:attack=5:release=50:level=false:latency=true`;
  const inputs = ["-i", silentVideoPath];
  if (audioMasterPath) inputs.push("-i", audioMasterPath);
  for (const bed of audioBeds) inputs.push("-i", bed.assetPath);
  for (const segment of syncSegments) inputs.push("-i", segment.assetPath);

  const chains = [];
  const labels = [];
  if (audioMasterPath) {
    chains.push(`[1:a]atrim=0:${duration},asetpts=PTS-STARTPTS,apad=whole_dur=${duration}[a0]`);
    labels.push("[a0]");
  }
  const bedInputBase = audioMasterPath ? 2 : 1;
  // sync-sound clips - trim the SOURCE window, retime for speed,
  // place at the timeline position
  syncSegments.forEach((segment, index) => {
    const inputIndex = bedInputBase + audioBeds.length + index;
    const label = `sync${index}`;
    const speed = Number(segment.speed_factor) > 0 ? Number(segment.speed_factor) : 1;
    const sourceIn = Math.max(0, Number(segment.source_in_s) || 0);
    const sourceSpan = roundSeconds(Number(segment.duration_s) * speed);
    const delayMs = Math.max(0, Math.round(Number(segment.start_s) * 1000));
    const gain = Number.isFinite(Number(segment.sourceAudioGain)) ? Number(segment.sourceAudioGain) : 1;
    const parts = [`atrim=start=${sourceIn}:duration=${sourceSpan}`, "asetpts=PTS-STARTPTS"];
    // atempo supports 0.5-2 per stage; typical demo speedups fit one stage
    if (speed !== 1 && speed >= 0.5 && speed <= 2) parts.push(`atempo=${speed}`);
    // crossfading neighbors overlap — fade this clip's own audio
    // at the shared edges so the mix crossfades with the picture
    const xin = Math.max(0, Number(segment.xfade_in_s) || 0);
    const xout = Math.max(0, Number(segment.xfade_out_s) || 0);
    if (xin > 0) parts.push(`afade=t=in:st=0:d=${roundSeconds(xin)}`);
    if (xout > 0) parts.push(`afade=t=out:st=${roundSeconds(Math.max(0, Number(segment.duration_s) - xout))}:d=${roundSeconds(xout)}`);
    parts.push(`adelay=${delayMs}:all=1`, `volume=${gain}`);
    chains.push(`[${inputIndex}:a]${parts.join(",")}[${label}]`);
    labels.push(`[${label}]`);
  });
  audioBeds.forEach((bed, index) => {
    const inputIndex = bedInputBase + index;
    const label = `a${index + 1}`;
    const delayMs = Math.max(0, Math.round(Number(bed.start_s) * 1000));
    const sourceIn = Math.max(0, Number(bed.source_in_s) || 0);
    const bedDuration = Math.max(0, Number(bed.duration_s) || 0);
    const volume = Number.isFinite(Number(bed.volume)) ? Number(bed.volume) : 1;
    const fadeIn = Math.max(0, Number(bed.fade_in_s) || 0);
    const fadeOut = Math.max(0, Number(bed.fade_out_s) || 0);
    const parts = [`atrim=start=${sourceIn}:duration=${bedDuration}`, "asetpts=PTS-STARTPTS"];
    if (fadeIn > 0) parts.push(`afade=t=in:st=0:d=${roundSeconds(fadeIn)}`);
    if (fadeOut > 0) parts.push(`afade=t=out:st=${roundSeconds(Math.max(0, bedDuration - fadeOut))}:d=${roundSeconds(fadeOut)}`);
    parts.push(`adelay=${delayMs}:all=1`, `volume=${volume}`);
    chains.push(`[${inputIndex}:a]${parts.join(",")}[${label}]`);
    labels.push(`[${label}]`);
  });
  // pad to full duration so the audio stream never ends before the video
  if (labels.length === 1) {
    chains.push(`${labels[0]}apad=whole_dur=${duration},atrim=0:${duration},asetpts=PTS-STARTPTS,${finalAudioFilters}[aout]`);
  } else {
    chains.push(`${labels.join("")}amix=inputs=${labels.length}:duration=longest:normalize=0,apad=whole_dur=${duration},atrim=0:${duration},asetpts=PTS-STARTPTS,${finalAudioFilters}[aout]`);
  }

  return [
    "-hide_banner", "-loglevel", "error", "-y",
    ...inputs,
    "-filter_complex", chains.join(";"),
    "-map", "0:v:0",
    "-map", "[aout]",
    "-t", String(duration),
    "-c:v", "copy",
    "-c:a", "aac",
    "-b:a", "192k",
    "-ar", "48000",
    "-movflags", "+faststart",
    outPath,
  ];
}

export function timelineTotalDuration(timeline) {
  const cardsEnd = sortedCards(timeline).reduce((max, card) => Math.max(max, cardEnd(card)), 0);
  const bedsEnd = collectAudioBeds(timeline).reduce((max, bed) => Math.max(max, Number(bed.end_s) || 0), 0);
  const declared = Number(timeline?.timeline_duration_s);
  const spine = Number(timeline?.total_duration_s);
  const extension = Number(timeline?.post_spine_extension_duration_s);
  return roundSeconds(Math.max(
    Number.isFinite(declared) ? declared : 0,
    Number.isFinite(spine) ? spine : 0,
    Number.isFinite(spine) && Number.isFinite(extension) ? spine + extension : 0,
    cardsEnd,
    bedsEnd,
  ));
}

export function validateTimelineForExport(timeline, {
  sliceRoot,
  mode = "review",
  checkFiles = true,
  toleranceS = 0.04,
} = {}) {
  const errors = [];
  const warnings = [];
  const placeholders = [];
  const assets = [];
  const audioBeds = [];

  if (!timeline || typeof timeline !== "object") {
    return { ok: false, mode, errors: ["timeline must be an object"], warnings, placeholders, assets, audioBeds };
  }

  const effectiveTimeline = normalizedTimeline(timeline);
  const approvalBySlot = new Map();
  if (mode === "final" && sliceRoot) {
    try {
      const slots = JSON.parse(fs.readFileSync(path.join(sliceRoot, "timeline-slots.json"), "utf8"));
      for (const slot of slots.slots || []) approvalBySlot.set(String(slot.dot_id), slot);
    } catch {}
  }

  if (String(effectiveTimeline.audio_master_status || "") === "scratch") {
    // scratch VO is a build tool, never the product
    (mode === "final" ? errors : warnings).push(mode === "final"
      ? "audio master is SCRATCH VO - final export refuses; install the real master via re-conform"
      : "audio master is scratch VO (fine for review; final will refuse)");
  }
  // The guard's real intent is "never ship a SILENT master" — originally written
  // when a narration master was the only audio source. A scored film with music
  // beds + per-card sync audio has no narration master and correctly should not
  // fake one (faking audio_master=score would SUM a 2nd untrimmed unity copy under
  // amix normalize=0 and wreck the mix). So accept audible audio from ANY source.
  const _beds = [...(effectiveTimeline.music_beds || []), ...(effectiveTimeline.audio_beds || [])];
  const _hasAudibleBed = _beds.some((b) => Number(b && b.volume) > 0);
  const _hasSourceAudio = (effectiveTimeline.cards || []).some((c) => c && c.use_source_audio === true)
    || (effectiveTimeline.sequence || []).some((e) => e && e.card && e.card.use_source_audio === true);
  const _hasAudibleAudio = Boolean(effectiveTimeline.audio_master) || _hasAudibleBed || _hasSourceAudio;
  if (!_hasAudibleAudio) {
    // no audio from ANY source (master, bed volume>0, or clip sync) -> genuinely silent
    (mode === "final" ? errors : warnings).push(mode === "final"
      ? "no audible audio: set an audio_master, a music/audio bed (volume>0), or enable card source audio"
      : "audio is empty (pre-audio board): review export will be silent");
  }
  if (!Number.isFinite(Number(effectiveTimeline.total_duration_s))) warnings.push("total_duration_s is not numeric; exporter will use card/music end time");

  const cards = sortedCards(effectiveTimeline);
  if (cards.length === 0) errors.push("cards[] or sequence[] cards are required");
  let expectedStart = null;
  for (const [index, card] of cards.entries()) {
    const prefix = `cards[${index}] ${card.id || "(missing id)"}`;
    for (const field of ["id", "type", "title", "transcript", "status"]) {
      if (!String(card[field] ?? "").trim()) errors.push(`${prefix}: ${field} is required`);
    }
    if (!["slide", "clip", "placeholder"].includes(String(card.type))) {
      errors.push(`${prefix}: type must be slide, clip, or placeholder`);
    }
    if (!Number.isFinite(Number(card.start_s))) errors.push(`${prefix}: start_s must be numeric`);
    if (!Number.isFinite(Number(card.duration_s)) || Number(card.duration_s) <= 0) {
      errors.push(`${prefix}: duration_s must be > 0`);
    }

    const placeholder = isPlaceholderCard(card);
    if (placeholder) placeholders.push({ id: card.id, title: card.title, start_s: card.start_s, duration_s: card.duration_s });
    if (mode === "final" && placeholder) {
      errors.push(`${prefix}: placeholder/missing asset is not allowed in final export`);
    }
    if (mode === "final" && !placeholder) {
      const approval = approvalBySlot.get(String(card.id));
      if (!approval) warnings.push(`${card.id}: installed card has no approval ledger row`);
      else if (approval.approved !== true) warnings.push(`${card.id}: installed card is not approved`);
    }

    const chosen = chooseCardAsset(card, { sliceRoot });
    assets.push({ cardId: card.id, ...chosen });
    if (!placeholder) {
      if (!chosen.ref) errors.push(`${prefix}: asset is required`);
      if (chosen.isUrl) errors.push(`${prefix}: remote URLs are not supported by the local exporter`);
      if (checkFiles && chosen.ref && !chosen.exists) {
        const message = `${prefix}: asset file not found: ${chosen.path}`;
        if (mode === "review") warnings.push(message);
        else errors.push(message);
      }
    }

    const start = Number(card.start_s);
    const duration = Number(card.duration_s);
    if (Number.isFinite(start) && Number.isFinite(duration)) {
      if (expectedStart == null) {
        if (Math.abs(start) > toleranceS) errors.push(`${prefix}: first card starts at ${start}, expected 0`);
      } else {
        const delta = start - expectedStart;
        // a crossfade overlap is INTENTIONAL — the applied
        // xfade_in_s on this card licenses exactly that much overlap
        const licensedOverlap = Math.max(0, Number(card.xfade_in_s) || 0);
        if (delta > toleranceS) errors.push(`${prefix}: timeline gap ${roundSeconds(delta)}s before this card`);
        if (delta < -(licensedOverlap + toleranceS)) errors.push(`${prefix}: timeline overlap ${roundSeconds(-delta)}s before this card (crossfade licenses only ${licensedOverlap}s)`);
      }
      expectedStart = start + duration;
    }
  }

  for (const [index, bed] of collectAudioBeds(effectiveTimeline).entries()) {
    const asset = chooseAudioAsset(bed.asset, { sliceRoot });
    audioBeds.push({ ...bed, assetPath: asset.path, exists: asset.exists });
    if (!Number.isFinite(Number(bed.start_s))) errors.push(`audio_beds[${index}]: start_s must be numeric`);
    if (!Number.isFinite(Number(bed.duration_s)) || Number(bed.duration_s) <= 0) errors.push(`audio_beds[${index}]: duration_s must be > 0`);
    if (!asset.ref) errors.push(`audio_beds[${index}]: asset is required`);
    if (asset.isUrl) errors.push(`audio_beds[${index}]: remote URLs are not supported by the local exporter`);
    if (checkFiles && asset.ref && !asset.exists) {
      const message = `audio_beds[${index}]: file not found: ${asset.path}`;
      if (mode === "review") warnings.push(message);
      else errors.push(message);
    }
  }

  const audioAsset = chooseAudioAsset(effectiveTimeline.audio_master, { sliceRoot });
  if (effectiveTimeline.audio_master && audioAsset.isUrl) errors.push("audio_master remote URLs are not supported by the local exporter");
  if (checkFiles && effectiveTimeline.audio_master && !audioAsset.exists) errors.push(`audio_master file not found: ${audioAsset.path}`);

  return {
    ok: errors.length === 0,
    mode,
    errors,
    warnings,
    placeholders,
    assets,
    audioMaster: audioAsset,
    audioBeds,
    totalDurationS: timelineTotalDuration(effectiveTimeline),
    cardCount: cards.length,
  };
}

export function planExport(timeline, {
  sliceRoot,
  mode = "review",
  checkFiles = true,
  width = DEFAULT_EXPORT.width,
  height = DEFAULT_EXPORT.height,
  fps = DEFAULT_EXPORT.fps,
} = {}) {
  const effectiveTimeline = normalizedTimeline(timeline);
  const validation = validateTimelineForExport(effectiveTimeline, { sliceRoot, mode, checkFiles });
  const segments = sortedCards(effectiveTimeline).map((card, index) => {
    const chosen = chooseCardAsset(card, { sliceRoot });
    const sourceOutRaw = card.source_out_s ?? card.clip_out_s ?? card.asset_out_s;
    const sourceInRaw = card.source_in_s ?? card.clip_in_s ?? card.asset_in_s ?? 0;
    const speedFactor = Number(card.speed_factor ?? card.playback_rate ?? 1);
    return {
      index,
      id: String(card.id),
      type: String(card.type),
      title: String(card.title || card.id || `Card ${index + 1}`),
      transcript: String(card.transcript || ""),
      status: String(card.status || ""),
      start_s: Number(card.start_s),
      duration_s: Number(card.duration_s),
      source_in_s: Number(sourceInRaw),
      source_out_s: Number(sourceOutRaw ?? 0),
      sourceOutExplicit: sourceOutRaw !== undefined && sourceOutRaw !== null && sourceOutRaw !== "",
      speed_factor: Number.isFinite(speedFactor) && speedFactor > 0 ? speedFactor : 1,
      placeholder: isPlaceholderCard(card) || !chosen.exists,
      assetRef: chosen.ref,
      assetPath: chosen.path,
      assetKind: chosen.kind,
      assetExists: chosen.exists,
      note: String(card.note || ""),
      hold_policy: String(card.hold_policy || card.holdPolicy || ""),
      fade_in_s: Math.max(0, Number(card.fade_in_s) || 0),
      fade_out_s: Math.max(0, Number(card.fade_out_s) || 0),
      crossfade_to_next_s: Math.max(0, Number(card.crossfade_to_next_s) || 0),
      // the APPLIED overlap fades (clamped, adjacency-checked in
      // applyCrossfadeOverlaps) — the assembler joins on xfade_out_s
      xfade_in_s: Math.max(0, Number(card.xfade_in_s) || 0),
      xfade_out_s: Math.max(0, Number(card.xfade_out_s) || 0),
      // sync-sound - the clip's OWN audio ships in its window;
      // trims move picture and sound together because they are one file
      useSourceAudio: card.use_source_audio === true,
      sourceAudioGain: Number.isFinite(Number(card.source_audio_gain)) ? Number(card.source_audio_gain) : 1,
    };
  });

  const audioBeds = collectAudioBeds(effectiveTimeline).map((bed) => {
    const asset = chooseAudioAsset(bed.asset, { sliceRoot });
    return { ...bed, assetPath: asset.path, assetExists: asset.exists, assetKind: asset.kind };
  });
  const requestedLoudnessTarget = Number(effectiveTimeline.audio_loudness_target);
  const audioLoudnessTarget = Number.isFinite(requestedLoudnessTarget)
    && requestedLoudnessTarget >= -70
    && requestedLoudnessTarget <= -5
    ? requestedLoudnessTarget
    : -16;

  return {
    mode,
    validation,
    width,
    height,
    fps,
    totalDurationS: timelineTotalDuration(effectiveTimeline),
    audioLoudnessTarget,
    audioMaster: validation.audioMaster,
    audioBeds,
    segments,
  };
}

export function readTimelineFile(timelinePath) {
  return JSON.parse(fs.readFileSync(timelinePath, "utf8"));
}

// "you should never have to ask which cut to watch" -
// every successful export updates the per-mode pointer at the bundle root.
export function writeCurrentExport(sliceRoot, mode, result) {
  const pointerPath = path.join(sliceRoot, "current-export.json");
  let current = {};
  try {
    current = JSON.parse(fs.readFileSync(pointerPath, "utf8"));
  } catch {}
  current._note = "DERIVED pointer to the latest export per mode. Written by assemble-timeline on success.";
  current[mode] = {
    created_at: new Date().toISOString(),
    output: result.output,
    manifest: result.manifest,
    contact_sheet: result.contactSheet,
    total_duration_s: result.totalDurationS,
    segment_count: result.segmentCount,
    timeline: result.timeline || null,
  };
  fs.writeFileSync(pointerPath, JSON.stringify(current, null, 2));
  return pointerPath;
}
