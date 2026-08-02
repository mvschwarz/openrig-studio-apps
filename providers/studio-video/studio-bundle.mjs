#!/usr/bin/env node
// The Studio Workspace Contract : ONE bundle spec shared by the
// scaffolder (video-new) and the checker (bundle-check), so the convention
// and its enforcement can never disagree. 
// star ().
import fs from "node:fs";
import path from "node:path";
import { mediaKind } from "./timeline-export-core.mjs";

// dirs created by video-new; `what` lines become PLACEMENT.md verbatim
export const BUNDLE_DIRS = [
  { dir: "intake", what: "UNSURE WHERE A FILE GOES? Put it here. bundle-check --file moves intake items to their canonical homes and indexes them. Wrong-but-in-intake beats confidently-misplaced." },
  { dir: "media/renders", what: "installed visual renders in (or heading into) the timeline. installed visual renders land here (or stay external and get indexed)." },
  { dir: "media/captures", what: "demo/terminal/browser captures, normalized. Raw capture trees may stay external; what the cut uses lives or is proxied here." },
  { dir: "media/audio", what: "loose audio files in timeline use (beds, sfx). Narration master PACKAGES go to audio/packages/." },
  { dir: "media/images", what: "stills and image cards used by the timeline." },
  { dir: "audio/packages", what: "narration master packages: one dir per master (wav/mp3 + words json + vtt + srt + loudness). The re-conform wizard consumes these." },
  { dir: "recordings", what: "your VO takes, raw. The audio pipeline turns these into packages." },
  { dir: "_CANON/slides", what: "approved slide renders. Approval is what moves a file here - never park candidates in canon." },
  { dir: "_CANON/clips", what: "approved demo clips." },
  { dir: "_CANON/audio", what: "approved audio selects." },
  { dir: "_CANON/stills", what: "approved stills." },
  { dir: "review", what: "generated review surfaces (proxy boards, comparisons). Generated - safe to regenerate." },
  { dir: "exports", what: "export output dirs (review/smoke/final). Heavy exports may live external; current-export.json always points at the latest." },
  { dir: "reports/notes", what: "review notes (durable-first) + receivers.json. Written by the mini-NLE note flow." },
  { dir: "reports/annotations", what: "annotated frames (PNG) attached to review notes." },
  { dir: "reports/reconform", what: "re-conform movement reports + A/B listening pages." },
  { dir: "reports/preflight", what: "media preflight results (preflight.mjs)." },
  { dir: "reports/validation", what: "validator output kept for the record." },
  { dir: "doctrine", what: "current-rules.md - the live rule card (privacy, approval gates, source-of-truth ownership). Rendered in the mini-NLE Info panel. UPDATE THIS when rules change; stale rules leak back." },
  { dir: "archive", what: "retired surfaces (old boards, superseded docs). EXCLUDED from active indexes and bundle-check. Move things here instead of deleting or letting them haunt the root." },
  { dir: "timeline-backups", what: "automatic pre-apply backups + applied patch archive. Written by the patch layer." },
];

// files allowed at the bundle ROOT; everything else at root is a stray
export const ROOT_ALLOW = new Set([
  "README.md", "PLACEMENT.md", "brief.md", "script.md", "aesthetic-direction.md",
  "timeline.json", "timeline-edits.patch.json", "timeline-history.jsonl",
  "timeline-slots.json", "timeline-board-proposal.json", "timeline-patched-preview.json",
  "project-assets.json", "current-audio.json",
  "current-export.json", "templates.json", "manifest.json", "mutation-owner.json",
  ".DS_Store",
]);

// the seat<->surface duality table (north star). The UI's lanes,
// the seeded receivers, and the ownership default are projections of the
// same topology. Static by design - the topology lives in the RigSpec; sync
// from a live roster only if the roster starts churning.
export const SEAT_LANES = {
  audio: "",
  visual: "",
  capture: "",
  assembly: "",
  review: "",
};

export function seededReceivers() {
  // review/producer first: it stays the note form's fallback default
  return [SEAT_LANES.review, SEAT_LANES.audio, SEAT_LANES.visual, SEAT_LANES.capture, SEAT_LANES.assembly];
}

export function mutationOwnerSeed() {
  return {
    _note: "Session that owns the NEXT canonical timeline apply (one-writer rule, soft-enforced: mismatched actors WARN and are recorded, never blocked - graduation to a hard gate is a doctrine decision). Move ownership by editing this file; reference the handoff in handoff_ref.",
    owner: SEAT_LANES.assembly,
    set_by: "video-new",
    set_at: new Date().toISOString(),
    handoff_ref: null,
  };
}

// dirs whose CONTENTS are never classified (external-ish or self-managed)
const SKIP_DIRS = new Set(["archive", "timeline-backups", "exports", "node_modules", ".git", "tools"]);

// template registry. Bundle-local templates.json wins; the
// canonical copy beside the tools is the fallback, so every bundle speaks
// the vocabulary without carrying it.
const CANONICAL_TEMPLATES = path.join(path.dirname(new URL(import.meta.url).pathname), "templates.json");

export function loadTemplates(root) {
  for (const candidate of [root && path.join(root, "templates.json"), CANONICAL_TEMPLATES]) {
    if (!candidate || !fs.existsSync(candidate)) continue;
    try { return JSON.parse(fs.readFileSync(candidate, "utf8")).templates || []; } catch { /* fall through */ }
  }
  return [];
}

// Resolve a card.template value (semantic id OR legacy free text like
// "rig send T1") to a registry entry; null when nothing matches.
export function resolveTemplate(templates, value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const exact = templates.find((entry) => entry.id === text);
  if (exact) return exact;
  const aliasHit = templates.find((entry) =>
    new RegExp(`(^|[^0-9A-Za-z])${entry.legacy_alias}([^0-9A-Za-z]|$)`).test(text));
  return aliasHit || null;
}

export function templatesSeedPath() {
  return CANONICAL_TEMPLATES;
}

export function proposeDestination(fileName) {
  const kind = mediaKind(fileName);
  if (kind === "video") return "media/renders/";
  if (kind === "image") return "media/images/";
  if (kind === "audio") return "media/audio/";
  if (/\.(vtt|srt)$/i.test(fileName)) return "media/audio/";
  if (/words.*\.json$/i.test(fileName)) return "media/audio/";
  if (/\.md$/i.test(fileName)) return "reports/";
  return "intake/";
}

// walk the bundle and classify: returns { strays, intakeItems, scanned }
export function checkBundle(root) {
  const strays = [];
  const intakeItems = [];
  let scanned = 0;
  const knownDirs = new Set(BUNDLE_DIRS.map((entry) => entry.dir.split("/")[0]));

  function walk(dir, relBase) {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const rel = relBase ? `${relBase}/${name}` : name;
      const top = rel.split("/")[0];
      let stat;
      try { stat = fs.statSync(full); } catch { continue; }
      if (stat.isDirectory()) {
        if (SKIP_DIRS.has(top) || name.startsWith(".")) continue;
        walk(full, rel);
        continue;
      }
      scanned++;
      // outline/board variants (timeline-*.json) are tool outputs
      if (relBase === "" && !ROOT_ALLOW.has(name) && !/^timeline-.*\.json$/.test(name)) {
        strays.push({ path: rel, proposed: proposeDestination(name), reason: "unexpected file at bundle root" });
        continue;
      }
      if (top === "intake") {
        intakeItems.push({ path: rel, proposed: proposeDestination(name) });
        continue;
      }
      // media-typed files inside non-media dirs (reports/doctrine) are strays
      if ((top === "reports" || top === "doctrine") && mediaKind(name) !== "unknown" && !/annotations|preflight/.test(rel)) {
        strays.push({ path: rel, proposed: proposeDestination(name), reason: `media file inside ${top}/` });
      }
      if (relBase !== "" && !knownDirs.has(top) && !name.startsWith(".")) {
        strays.push({ path: rel, proposed: proposeDestination(name), reason: `unknown top-level dir ${top}/` });
      }
    }
  }
  walk(root, "");
  return { strays, intakeItems, scanned };
}

export function fileIntake(root) {
  const { intakeItems } = checkBundle(root);
  const moved = [];
  for (const item of intakeItems) {
    const destDir = path.join(root, item.proposed);
    if (item.proposed === "intake/") continue; // no better home known; stays for a human
    fs.mkdirSync(destDir, { recursive: true });
    const target = path.join(destDir, path.basename(item.path));
    if (fs.existsSync(target)) {
      moved.push({ ...item, skipped: "destination exists" });
      continue;
    }
    fs.renameSync(path.join(root, item.path), target);
    moved.push({ ...item, to: path.relative(root, target) });
  }
  return moved;
}

export function placementText() {
  return [
    "# PLACEMENT - the filing map (written for agents)",
    "",
    "One rule: every file you create has exactly one home below. If you cannot",
    "decide, put it in intake/ - never invent a location. Run",
    "",
    "`--file` moves intake items home. The mini-NLE Info panel shows the stray",
    "count continuously - misplaced files are VISIBLE.",
    "",
    "Root files: " + [...ROOT_ALLOW].filter((name) => name !== ".DS_Store").join(", "),
    "",
    ...BUNDLE_DIRS.map((entry) => `- \`${entry.dir}/\` - ${entry.what}`),
    "",
    "Heavy source trees (render render roots, raw capture trees,",
    "~/openrig-videos) may stay external - but everything the cut USES must be",
    "indexed in project-assets.json so it is findable from the tool.",
    "",
  ].join("\n");
}

export function doctrineSeed() {
  return [
    "# Current rules (live card - rendered in the mini-NLE Info panel)",
    "",
    "UPDATE THIS FILE when a rule changes. Stale rules leaking back after",
    "resets was a named failure mode of the first production.",
    "",
    "- SOURCE OF TRUTH: timeline.json is canonical; ONLY the patch layer",
    "  mutates it (validate -> backup -> apply -> history). Derived indexes",
    "  (slots, assets, pointers) are rebuildable, never authored.",
    "- ONE WRITER: the assembly/timeline tool applies patches; other seats",
    "  publish candidates and notes, never freehand JSON edits.",
    "- APPROVAL: approval events live in the slot ledger. Only",
    "  approved/installed assets should reach final assembly (final-mode",
    "  validation WARNS on unapproved cards; hard gate is a doctrine decision).",
    "- CANON: _CANON/ holds approved selects only.",
    "- EXPORTS: review exports may carry placeholders; FINAL must not. Final",
    "  output comes from FFmpeg + manifests, never browser recording.",
    "- FILING: see PLACEMENT.md. Unsure -> intake/.",
    "",
  ].join("\n");
}

export function timelineSkeleton(name) {
  return {
    _note: `${name}: fresh Studio bundle. Add the first audio master package (audio/packages/) and re-conform, or seed placeholders from a locked script. sequence[] is the source of truth.`,
    audio_master: "",
    captions_vtt: "",
    words_json: "",
    total_duration_s: 0,
    schema_version: "timeline-sequence-v1",
    sequence: [],
    cards: [],
    audio_beds: [],
  };
}
