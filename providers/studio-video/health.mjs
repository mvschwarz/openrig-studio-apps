#!/usr/bin/env node
// the cut health strip's data - one CHEAP aggregation (fs checks
// only, no ffprobe) answering "what does this video need next". Phase is
// DERIVED from counts, never stored . Locked = approved in
// the slots ledger; done = no placeholders + all slots locked + a master.
import fs from "node:fs";
import path from "node:path";
import { isPlaceholderCard, materializeCards, planExport, readTimelineFile, resolveRefPath } from "./timeline-export-core.mjs";
import { analyzeTimelineAudio, maybeReadText, readJsonFile } from "./timeline-audio-validation.mjs";
import { checkBundle } from "./studio-bundle.mjs";

// v1 doctrine thresholds : storyboard while placeholders
// hold at least half the seats; finishing once locks reach half.
export function healthPhase({ cardCount, placeholders, locked, hasMaster, masterIsScratch = false }) {
  if (!cardCount) return "concept";
  // scratch VO caps at finishing: done means the REAL audio spine 
  if (placeholders === 0 && locked >= cardCount && hasMaster && !masterIsScratch) return "done";
  if (locked >= cardCount / 2) return "finishing";
  if (placeholders >= cardCount / 2) return "storyboard";
  return "assembly";
}

export function computeHealth({ sliceRoot, timelinePath }) {
  const timeline = readTimelineFile(timelinePath);
  const cards = materializeCards(timeline);
  const sequence = Array.isArray(timeline.sequence) ? timeline.sequence : [];
  const gaps = sequence.filter((entry) => entry.type === "gap");

  // one cheap plan (fs checks, NO probes - validatePlanWithProbes is never
  // called here) feeds placeholders, missing media, and the audio segments
  const plan = planExport(timeline, { sliceRoot, mode: "review", checkFiles: true });
  const placeholderCards = cards.filter((card) => isPlaceholderCard(card));
  const placeholderIds = new Set(placeholderCards.map((card) => String(card.id)));
  const missing = (plan.assets || []).filter((asset) =>
    asset.exists === false && !placeholderIds.has(String(asset.cardId)));

  // slots ledger: locked = approved ; candidates = takes waiting
  let slots = [];
  try { slots = JSON.parse(fs.readFileSync(path.join(sliceRoot, "timeline-slots.json"), "utf8")).slots || []; } catch {}
  const slotByDot = new Map(slots.map((slot) => [String(slot.dot_id), slot]));
  const lockedCards = cards.filter((card) => slotByDot.get(String(card.id))?.approved === true);
  const firstUnlocked = cards.find((card) => slotByDot.get(String(card.id))?.approved !== true);
  const takesWaiting = cards.filter((card) => Number(slotByDot.get(String(card.id))?.candidate_count) > 0);

  // audio anomalies: cheap words/captions analysis; a pre-audio board is a
  // legitimate state, not a wall of parity errors
  let audioAnomalies = [];
  if (timeline.audio_master) {
    try {
      const wordsPayload = timeline.words_json
        ? readJsonFile(resolveRefPath(timeline.words_json, { sliceRoot }))
        : null;
      const captionsText = timeline.captions_vtt
        ? maybeReadText(resolveRefPath(timeline.captions_vtt, { sliceRoot }))
        : "";
      const report = analyzeTimelineAudio(timeline, { wordsPayload, captionsText, sliceRoot, segments: plan.segments || [] });
      audioAnomalies = (report.anomalies || []).filter((anomaly) => anomaly.severity !== "info");
    } catch (error) {
      audioAnomalies = [{ severity: "error", message: `audio analysis failed: ${error?.message || error}` }];
    }
  }

  // filing: null for grandfathered (no PLACEMENT.md) projects, same contract
  // as /api/project-info
  let strays = null;
  if (fs.existsSync(path.join(sliceRoot, "PLACEMENT.md"))) {
    try { strays = checkBundle(sliceRoot).strays; } catch { strays = null; }
  }

  const counts = {
    cardCount: cards.length,
    placeholders: placeholderCards.length,
    locked: lockedCards.length,
    hasMaster: Boolean(timeline.audio_master),
    masterIsScratch: String(timeline.audio_master_status || "") === "scratch",
  };
  return {
    ok: true,
    computed_at: new Date().toISOString(),
    phase: healthPhase(counts),
    audio_status: timeline.audio_master ? String(timeline.audio_master_status || "unknown") : null,
    slots_total: cards.length,
    locked: lockedCards.length,
    first_unlocked: firstUnlocked ? String(firstUnlocked.id) : null,
    placeholders: placeholderCards.length,
    first_placeholder: placeholderCards.length ? String(placeholderCards[0].id) : null,
    gaps: gaps.length,
    first_gap_at_s: gaps.length ? Number(gaps[0].start_s ?? 0) : null,
    takes_waiting: takesWaiting.length,
    first_takes_slot: takesWaiting.length ? String(takesWaiting[0].id) : null,
    audio_anomalies: audioAnomalies.length,
    first_audio_anomaly: audioAnomalies.length ? (audioAnomalies[0].cardId || audioAnomalies[0].card_id || null) : null,
    missing_media: missing.length,
    first_missing: missing.length ? String(missing[0].cardId) : null,
    strays: strays === null ? null : strays.length,
  };
}
