#!/usr/bin/env node
// Slot revision history: append-only timeline-history.jsonl + derived timeline-slots.json.
// 
import fs from "node:fs";
import path from "node:path";
import { materializeCards, readTimelineFile } from "./timeline-export-core.mjs";

// Deferred: slot_uid = normalized dot id (slot_04_03). Split/merge lineage with
// generated uids is deferred until a real renumber/split happens.
export function slotUidFor(dotId) {
  const parts = String(dotId).split(".").map((part) => part.replace(/[^a-zA-Z0-9]+/g, ""));
  return `slot_${parts.map((part) => (/^\d+$/.test(part) ? part.padStart(2, "0") : part)).join("_")}`;
}

export function eventTimestamp(date = new Date()) {
  return date.toISOString();
}

function eventIdStamp(date = new Date()) {
  return date.toISOString().replace(/[-:T]/g, "").slice(0, 15).replace(/^(\d{8})(\d{6}).*$/, "$1_$2");
}

export function makeEventId(dotId, action, date = new Date(), suffix = "") {
  const dotNorm = String(dotId).replace(/[^a-zA-Z0-9]+/g, "_");
  return `tlh_${eventIdStamp(date)}_${dotNorm}_${action}${suffix ? `_${suffix}` : ""}`;
}

export function cardSnapshot(card) {
  if (!card) return null;
  const snapshot = {
    start_s: Number(card.start_s),
    duration_s: Number(card.duration_s),
    asset: String(card.asset || ""),
    source_in_s: card.source_in_s != null ? Number(card.source_in_s) : 0,
    source_out_s: card.source_out_s != null ? Number(card.source_out_s) : null,
    speed_factor: card.speed_factor != null ? Number(card.speed_factor) : 1,
    transcript: String(card.transcript || ""),
  };
  if (card.title) snapshot.title = String(card.title);
  return snapshot;
}

export function readHistory(historyPath) {
  if (!fs.existsSync(historyPath)) return [];
  return fs.readFileSync(historyPath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Error(`timeline-history.jsonl line ${index + 1} is not valid JSON`);
      }
    });
}

export function appendEvents(historyPath, events) {
  if (!events.length) return;
  const lines = events.map((event) => JSON.stringify(event)).join("\n") + "\n";
  fs.appendFileSync(historyPath, lines);
}

export function bootstrapHistory({ timelinePath, historyPath, actor = "timeline-history.mjs" }) {
  if (fs.existsSync(historyPath) && readHistory(historyPath).length > 0) {
    return { bootstrapped: false, events: [] };
  }
  const timeline = readTimelineFile(timelinePath);
  const now = new Date();
  const events = materializeCards(timeline).map((card, index) => ({
    event_id: makeEventId(card.id, "bootstrap", now, String(index)),
    changed_at: eventTimestamp(now),
    actor,
    source: "bootstrap-current-timeline",
    patch_id: null,
    slot: {
      slot_uid: slotUidFor(card.id),
      dot_id_before: null,
      dot_id_after: String(card.id),
      section: String(card.section || ""),
    },
    before: null,
    after: cardSnapshot(card),
    reason: "History tracking enabled; snapshot of current timeline state.",
    validation: null,
  }));
  appendEvents(historyPath, events);
  return { bootstrapped: true, events };
}

export function rebuildSlots({ timelinePath, historyPath, slotsPath, assetsPath = null }) {
  const timeline = readTimelineFile(timelinePath);
  const history = readHistory(historyPath);
  const eventsBySlotUid = new Map();
  for (const event of history) {
    const uid = event?.slot?.slot_uid;
    if (!uid) continue;
    if (!eventsBySlotUid.has(uid)) eventsBySlotUid.set(uid, []);
    eventsBySlotUid.get(uid).push(event);
  }

  // the postmortem's "card ledger" is a DERIVED JOIN over existing
  // authorities - candidates come from the asset index, approval from review
  // events. Never a new source of truth.
  const candidatesBySlot = new Map();
  const resolvedAssets = assetsPath || path.join(path.dirname(timelinePath), "project-assets.json");
  if (fs.existsSync(resolvedAssets)) {
    try {
      for (const asset of JSON.parse(fs.readFileSync(resolvedAssets, "utf8")).assets || []) {
        if (asset.role !== "candidate" && asset.status !== "candidate") continue;
        for (const slotRef of asset.slot_refs || []) {
          if (!candidatesBySlot.has(slotRef)) candidatesBySlot.set(slotRef, []);
          candidatesBySlot.get(slotRef).push(asset.path);
        }
      }
    } catch {}
  }

  const currentCards = materializeCards(timeline);
  const currentUids = new Set();
  const slots = currentCards.map((card) => {
    const uid = slotUidFor(card.id);
    currentUids.add(uid);
    const events = eventsBySlotUid.get(uid) || [];
    const last = events.at(-1) || null;
    // the LAST review event's action decides - unlock clears the
    // lock; events without an action are historical approves (back-compat)
    const lastReview = [...events].reverse().find((event) => event.source === "review");
    const lastContentChange = [...events].reverse().find((event) => event.source === "patch-apply");
    const approvedAt = lastReview && lastReview.action !== "unlock" ? lastReview.changed_at : null;
    const approved = Boolean(approvedAt) &&
      (!lastContentChange || new Date(approvedAt) >= new Date(lastContentChange.changed_at));
    return {
      approved,
      approved_at: approvedAt,
      candidate_count: (candidatesBySlot.get(String(card.id)) || []).length,
      candidates: candidatesBySlot.get(String(card.id)) || [],
      dot_id: String(card.id),
      slot_uid: uid,
      status: "current",
      current: cardSnapshot(card),
      section: String(card.section || ""),
      title: String(card.title || ""),
      type: String(card.type || ""),
      event_count: events.length,
      event_ids: events.map((event) => event.event_id),
      last_event_id: last?.event_id || null,
      last_changed_at: last?.changed_at || null,
      last_source: last?.source || null, // review lens: "review" clears the badge
    };
  });

  for (const [uid, events] of eventsBySlotUid.entries()) {
    if (currentUids.has(uid)) continue;
    const last = events.at(-1);
    slots.push({
      dot_id: String(last?.slot?.dot_id_after || last?.slot?.dot_id_before || uid),
      slot_uid: uid,
      status: "retired",
      current: null,
      event_count: events.length,
      event_ids: events.map((event) => event.event_id),
      last_event_id: last?.event_id || null,
      last_changed_at: last?.changed_at || null,
    });
  }

  const payload = {
    _note: "DERIVED index for the mini-NLE slot history tab. Rebuild with timeline-history.mjs rebuild; timeline-history.jsonl is the audit source of truth.",
    generated_at: eventTimestamp(),
    timeline: path.basename(timelinePath),
    slots,
  };
  fs.writeFileSync(slotsPath, JSON.stringify(payload, null, 2));
  return payload;
}

export function defaultPaths(sliceRoot) {
  return {
    timelinePath: path.join(sliceRoot, "timeline.json"),
    historyPath: path.join(sliceRoot, "timeline-history.jsonl"),
    slotsPath: path.join(sliceRoot, "timeline-slots.json"),
  };
}

function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const options = { sliceRoot: path.resolve(new URL("../../", import.meta.url).pathname), json: false };
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--slice-root") options.sliceRoot = path.resolve(argv[++i]);
    else if (arg === "--json") options.json = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  const paths = defaultPaths(options.sliceRoot);
  if (command === "bootstrap") {
    const result = bootstrapHistory(paths);
    rebuildSlots(paths);
    const summary = { ok: true, bootstrapped: result.bootstrapped, eventCount: result.events.length, historyPath: paths.historyPath, slotsPath: paths.slotsPath };
    console.log(options.json ? JSON.stringify(summary, null, 2) : `bootstrap: ${result.bootstrapped ? `${result.events.length} events written` : "history already exists, skipped"}; slots rebuilt at ${paths.slotsPath}`);
    return;
  }
  if (command === "rebuild") {
    const payload = rebuildSlots(paths);
    console.log(options.json ? JSON.stringify({ ok: true, slotCount: payload.slots.length, slotsPath: paths.slotsPath }, null, 2) : `rebuilt ${payload.slots.length} slots at ${paths.slotsPath}`);
    return;
  }
  console.log("Usage: node timeline-history.mjs <bootstrap|rebuild> [--slice-root dir] [--json]");
  process.exit(command ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main();
}
