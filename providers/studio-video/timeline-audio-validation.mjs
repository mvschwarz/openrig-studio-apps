import fs from "node:fs";
import path from "node:path";
import {
  chooseCardAsset,
  normalizedTimeline,
  resolveRefPath,
  roundSeconds,
  sortedCards,
} from "./timeline-export-core.mjs";

const VERSION_RE = /\bv(\d{3,})\b/i;

export function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function maybeReadText(filePath) {
  if (!filePath) return "";
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

export function versionToken(ref) {
  const match = String(ref || "").match(VERSION_RE);
  return match ? `v${match[1]}` : "";
}

function timeToSeconds(value) {
  const text = String(value || "").trim();
  const match = text.match(/^(\d{2}):(\d{2}):(\d{2})[.,](\d{3})$/);
  if (!match) return NaN;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000;
}

export function parseVtt(text) {
  const notes = [];
  const cues = [];
  const lines = String(text || "").replace(/\r/g, "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (line.startsWith("NOTE")) {
      const noteLines = [line.replace(/^NOTE\s*/, "").trim()];
      while (i + 1 < lines.length && lines[i + 1].trim()) {
        noteLines.push(lines[++i].trim());
      }
      notes.push(noteLines.join(" ").trim());
      continue;
    }
    const timing = line.match(/^(\d{2}:\d{2}:\d{2}[.,]\d{3})\s+-->\s+(\d{2}:\d{2}:\d{2}[.,]\d{3})/);
    if (!timing) continue;
    const cueLines = [];
    while (i + 1 < lines.length && lines[i + 1].trim()) {
      cueLines.push(lines[++i].trim());
    }
    cues.push({
      start_s: timeToSeconds(timing[1]),
      end_s: timeToSeconds(timing[2]),
      text: cueLines.join(" ").replace(/<[^>]+>/g, "").trim(),
    });
  }
  return { notes, cues };
}

function wordStart(word) {
  return Number(word?.masterStart ?? word?.start ?? word?.start_s ?? word?.timestamp?.start);
}

function wordEnd(word) {
  return Number(word?.masterEnd ?? word?.end ?? word?.end_s ?? word?.timestamp?.end);
}

function wordText(word) {
  return String(word?.text ?? word?.word ?? "").trim();
}

function overlaps(startA, endA, startB, endB, tolerance = 0) {
  return Number(endA) > Number(startB) + tolerance && Number(startA) < Number(endB) - tolerance;
}

function cardEnd(card) {
  return roundSeconds(Number(card.start_s) + Number(card.duration_s));
}

function normalizeBeatNumber(value) {
  const text = String(value || "").trim();
  const match = text.match(/^0*(\d+)(?:\.(\d+))?/);
  if (!match) return NaN;
  const major = Number(match[1]);
  const minor = match[2] == null ? 0 : Number(`0.${match[2]}`);
  return major + minor;
}

function looksOlderBeatAfterSplice(beatReport, cardId, spliceInside) {
  const beat = String(beatReport?.beat || "");
  const cardText = String(cardId || "");
  const beatNum = normalizeBeatNumber(beat);
  const cardNum = normalizeBeatNumber(cardText);
  if (!Number.isFinite(beatNum) || !Number.isFinite(cardNum)) return false;
  if (Math.floor(beatNum) < Math.floor(cardNum)) return true;
  if (/^\d{2,}$/.test(beat) && /^\d+\.\d+/.test(cardText)) {
    return spliceInside.some((point) => beatReport.start_s >= point.end_s - 0.05);
  }
  return false;
}

function groupContiguousWords(words) {
  const groups = [];
  for (const word of words) {
    const beat = String(word.beat || word.section || "unknown");
    const start = wordStart(word);
    const end = wordEnd(word);
    const current = groups[groups.length - 1];
    if (current && current.beat === beat && start - current.end_s < 0.75) {
      current.end_s = Math.max(current.end_s, end);
      current.wordCount += 1;
      if (current.sample.length < 18) current.sample.push(wordText(word));
    } else {
      groups.push({
        beat,
        section: String(word.section || ""),
        start_s: start,
        end_s: end,
        wordCount: 1,
        sample: wordText(word) ? [wordText(word)] : [],
      });
    }
  }
  return groups.map((group) => ({
    ...group,
    start_s: roundSeconds(group.start_s),
    end_s: roundSeconds(group.end_s),
    sampleText: group.sample.join(" "),
  }));
}

function summarizeBeats(words) {
  const byBeat = new Map();
  for (const word of words) {
    const beat = String(word.beat || word.section || "unknown");
    const start = wordStart(word);
    const end = wordEnd(word);
    const existing = byBeat.get(beat) || {
      beat,
      section: String(word.section || ""),
      start_s: start,
      end_s: end,
      wordCount: 0,
      sample: [],
    };
    existing.start_s = Math.min(existing.start_s, start);
    existing.end_s = Math.max(existing.end_s, end);
    existing.wordCount += 1;
    if (existing.sample.length < 14) existing.sample.push(wordText(word));
    byBeat.set(beat, existing);
  }
  return [...byBeat.values()]
    .sort((a, b) => a.start_s - b.start_s)
    .map((beat) => ({
      ...beat,
      start_s: roundSeconds(beat.start_s),
      end_s: roundSeconds(beat.end_s),
      sampleText: beat.sample.join(" "),
    }));
}

function spliceEntries(splice) {
  const entries = [];
  for (const [key, value] of Object.entries(splice || {})) {
    if (!/EndSeconds$/.test(key)) continue;
    if (/SpokenEndSeconds$/.test(key)) continue;
    if (/^old[A-Z]/.test(key)) continue;
    const seconds = Number(value);
    if (!Number.isFinite(seconds)) continue;
    const prefix = key.replace(/EndSeconds$/, "");
    entries.push({
      key,
      prefix,
      end_s: seconds,
      start_s: Number(splice[`${prefix}StartSeconds`]),
      oldStart_s: Number(splice[`old${prefix[0].toUpperCase()}${prefix.slice(1)}StartSeconds`]),
      oldEnd_s: Number(splice[`old${prefix[0].toUpperCase()}${prefix.slice(1)}EndSeconds`]),
    });
  }
  return entries;
}

function findCompositeManifestRefs(timeline, wordsPayload = {}) {
  const refs = new Set();
  for (const card of sortedCards(normalizedTimeline(timeline))) {
    if (card.audio_composite_manifest) refs.add(card.audio_composite_manifest);
  }
  for (const [key, value] of Object.entries(wordsPayload?.splice || {})) {
    if (/CompositeManifestPath$/i.test(key) && value) refs.add(value);
  }
  return [...refs];
}

function maybeReadCompositeManifestTexts(refs, { sliceRoot }) {
  return refs.map((ref) => {
    const filePath = path.isAbsolute(ref) ? ref : resolveRefPath(ref, { sliceRoot });
    return {
      ref,
      path: filePath,
      text: maybeReadText(filePath),
    };
  });
}

function detectVersionCoherence(timeline, wordsPayload, vtt) {
  const audioVersion = versionToken(timeline.audio_master);
  const wordsVersion = versionToken(timeline.words_json);
  const captionsVersion = versionToken(timeline.captions_vtt);
  const notes = [
    String(wordsPayload?.v010Note || ""),
    String(wordsPayload?.v009Note || ""),
    String(wordsPayload?.v008Note || ""),
    ...(vtt?.notes || []),
  ].join("\n").toLowerCase();
  const timingEquivalent = /\btimings unchanged\b|\btiming[- ]equivalent\b|\bno timing shifts\b/.test(notes);
  const warnings = [];
  if (audioVersion && wordsVersion && audioVersion !== wordsVersion && !timingEquivalent) {
    warnings.push(`audio_master ${audioVersion} but words_json ${wordsVersion}; add timing-equivalence note or regenerate words`);
  }
  if (audioVersion && captionsVersion && audioVersion !== captionsVersion && !timingEquivalent) {
    warnings.push(`audio_master ${audioVersion} but captions_vtt ${captionsVersion}; add timing-equivalence note or regenerate captions`);
  }
  return {
    audioVersion,
    wordsVersion,
    captionsVersion,
    timingEquivalent,
    warnings,
  };
}

function segmentForCard(card, segments = []) {
  return segments.find((segment) => String(segment.id) === String(card.id));
}

function mediaSummary(card, segment) {
  if (!segment) return null;
  const streams = segment.probe?.streams || [];
  const hasVideo = streams.some((stream) => stream.codec_type === "video");
  const hasAudio = streams.some((stream) => stream.codec_type === "audio");
  const sourceDuration = Number(segment.probe?.duration_s);
  const slotDuration = Number(card.duration_s);
  const tolerance = 1 / 30 + 0.02;
  let category = "duration-unknown";
  if (Number.isFinite(sourceDuration)) {
    if (sourceDuration < slotDuration - tolerance) category = "source-shorter-than-slot";
    else if (sourceDuration > slotDuration + tolerance) category = "source-longer-than-slot";
    else category = "frame-rounded-match";
  }
  let previewAction = "unknown";
  if (!segment.assetExists) previewAction = "missing asset";
  else if (!hasAudio) previewAction = "video-only; preview/export rely on top-level audio_master";
  else previewAction = "embedded audio ignored; preview/export use top-level audio_master";
  if (category === "source-shorter-than-slot") previewAction += "; exporter holds/pads unless final policy rejects";
  if (category === "source-longer-than-slot") previewAction += "; exporter trims to slot/source window";
  return {
    sourceDuration_s: Number.isFinite(sourceDuration) ? roundSeconds(sourceDuration) : null,
    slotDuration_s: roundSeconds(slotDuration),
    category,
    hasVideo,
    hasAudio,
    streams: streams.map((stream) => ({
      type: stream.codec_type,
      codec: stream.codec_name,
      width: stream.width,
      height: stream.height,
      duration: stream.duration,
    })),
    previewAction,
  };
}

export function analyzeTimelineAudio(timeline, {
  wordsPayload = null,
  captionsText = "",
  sliceRoot = process.cwd(),
  segments = [],
  compositeManifestTexts = null,
  toleranceS = 0.02,
} = {}) {
  const effectiveTimeline = normalizedTimeline(timeline);
  const cards = sortedCards(effectiveTimeline);
  const words = Array.isArray(wordsPayload?.words) ? wordsPayload.words : [];
  const vtt = parseVtt(captionsText);
  const splice = wordsPayload?.splice || {};
  const splicePoints = spliceEntries(splice);
  const manifestTexts = compositeManifestTexts ?? maybeReadCompositeManifestTexts(
    findCompositeManifestRefs(effectiveTimeline, wordsPayload),
    { sliceRoot },
  );
  const manifestCombinedText = manifestTexts.map((entry) => entry.text).join("\n");
  const versionCoherence = detectVersionCoherence(effectiveTimeline, wordsPayload, vtt);
  const topLevelAnomalies = versionCoherence.warnings.map((message) => ({
    code: "version-skew",
    severity: "warn",
    message,
  }));

  const cardReports = cards.map((card) => {
    const start = Number(card.start_s);
    const end = cardEnd(card);
    const windowWords = words
      .filter((word) => Number.isFinite(wordStart(word)) && Number.isFinite(wordEnd(word)))
      .filter((word) => overlaps(wordStart(word), wordEnd(word), start, end, toleranceS))
      .sort((a, b) => wordStart(a) - wordStart(b));
    const windowCues = vtt.cues
      .filter((cue) => overlaps(cue.start_s, cue.end_s, start, end, toleranceS));
    const beats = summarizeBeats(windowWords);
    const contiguousBeats = groupContiguousWords(windowWords);
    const anomalies = [];

    if (windowWords.length === 0) {
      anomalies.push({
        code: "no-words-in-card-window",
        severity: "warn",
        message: `${card.id}: no word-level audio found in ${start}-${end}`,
      });
    }
    if (beats.length > 1) {
      anomalies.push({
        code: "multiple-audio-beats",
        severity: "warn",
        message: `${card.id}: audio window spans beats ${beats.map((beat) => beat.beat).join(", ")}`,
      });
    }

    const spliceInside = splicePoints.filter((point) => point.end_s > start + toleranceS && point.end_s < end - toleranceS);
    const olderBeats = beats.filter((beat) => looksOlderBeatAfterSplice(beat, card.id, spliceInside));
    if (olderBeats.length) {
      anomalies.push({
        code: "older-audio-beat-inside-card",
        severity: "error",
        message: `${card.id}: older audio beat(s) ${olderBeats.map((beat) => beat.beat).join(", ")} present inside visual card`,
        beats: olderBeats.map((beat) => beat.beat),
      });
    }

    for (const point of spliceInside) {
      anomalies.push({
        code: "splice-end-inside-card",
        severity: "error",
        message: `${card.id}: ${point.key}=${point.end_s} lands inside visual window ${start}-${end}; composite audio may resume old source before card ends`,
        spliceKey: point.key,
        spliceEnd_s: point.end_s,
      });
    }

    if (card.audio_asset) {
      const audioAsset = String(card.audio_asset);
      const represented = manifestCombinedText.includes(audioAsset) || manifestCombinedText.includes(path.basename(audioAsset));
      if (!represented) {
        anomalies.push({
          code: "card-audio-asset-not-represented",
          severity: "warn",
          message: `${card.id}: card audio_asset is metadata only unless represented in the active composite manifest/master`,
          audio_asset: audioAsset,
        });
      }
    }

    const segment = segmentForCard(card, segments);
    const media = mediaSummary(card, segment);
    if (media?.hasAudio === false) {
      anomalies.push({
        code: "video-only-card-relies-on-audio-master",
        severity: "info",
        message: `${card.id}: visual media has no embedded audio; preview/export rely on top-level audio_master`,
      });
    }

    return {
      id: String(card.id),
      title: String(card.title || ""),
      start_s: roundSeconds(start),
      end_s: roundSeconds(end),
      duration_s: roundSeconds(Number(card.duration_s)),
      transcript: String(card.transcript || ""),
      wordCount: windowWords.length,
      wordRange_s: windowWords.length
        ? { start_s: roundSeconds(wordStart(windowWords[0])), end_s: roundSeconds(wordEnd(windowWords[windowWords.length - 1])) }
        : null,
      captionCount: windowCues.length,
      captionRange_s: windowCues.length
        ? { start_s: roundSeconds(windowCues[0].start_s), end_s: roundSeconds(windowCues[windowCues.length - 1].end_s) }
        : null,
      beats,
      contiguousBeats,
      media,
      anomalies,
      fixHint: anomalies.some((anomaly) => anomaly.code === "splice-end-inside-card" || anomaly.code === "older-audio-beat-inside-card")
        ? "Rebuild the composite audio/words/captions through this visual card boundary, or shorten/realign the visual window to the active composite splice."
        : "",
    };
  });

  const allAnomalies = [
    ...topLevelAnomalies,
    ...cardReports.flatMap((card) => card.anomalies.map((anomaly) => ({ cardId: card.id, ...anomaly }))),
  ];
  const errorCount = allAnomalies.filter((anomaly) => anomaly.severity === "error").length;
  const warningCount = allAnomalies.filter((anomaly) => anomaly.severity === "warn").length;
  const infoCount = allAnomalies.filter((anomaly) => anomaly.severity === "info").length;
  const summaryLines = [
    `Timeline/audio validation: ${errorCount ? "FAILED" : "OK"} (${errorCount} error, ${warningCount} warn, ${infoCount} info)`,
    `audio_master=${effectiveTimeline.audio_master || "(missing)"}`,
    `words_json=${effectiveTimeline.words_json || "(missing)"}`,
    `captions_vtt=${effectiveTimeline.captions_vtt || "(missing)"}`,
    ...allAnomalies.slice(0, 12).map((anomaly) => {
      const prefix = anomaly.cardId ? `${anomaly.cardId}: ` : "";
      return `${anomaly.severity.toUpperCase()}: ${prefix}${anomaly.message}`;
    }),
    allAnomalies.length > 12 ? `...${allAnomalies.length - 12} more anomaly/anomalies` : "",
  ].filter(Boolean);

  return {
    ok: errorCount === 0,
    timeline: {
      audio_master: effectiveTimeline.audio_master || "",
      words_json: effectiveTimeline.words_json || "",
      captions_vtt: effectiveTimeline.captions_vtt || "",
      totalDuration_s: Number(effectiveTimeline.total_duration_s || 0),
    },
    versionCoherence,
    splice,
    cards: cardReports,
    anomalies: allAnomalies,
    counts: {
      cards: cardReports.length,
      errors: errorCount,
      warnings: warningCount,
      info: infoCount,
    },
    summaryText: summaryLines.join("\n"),
  };
}

export function markdownAudioReport(report) {
  const lines = [
    "# Timeline Audio Validation",
    "",
    "```text",
    report.summaryText,
    "```",
    "",
    "## Cards",
    "",
  ];
  for (const card of report.cards) {
    lines.push(`### ${card.id} — ${card.title}`);
    lines.push("");
    lines.push(`- Window: ${card.start_s} -> ${card.end_s} (${card.duration_s}s)`);
    lines.push(`- Words: ${card.wordCount}${card.wordRange_s ? ` (${card.wordRange_s.start_s} -> ${card.wordRange_s.end_s})` : ""}`);
    lines.push(`- Captions: ${card.captionCount}${card.captionRange_s ? ` (${card.captionRange_s.start_s} -> ${card.captionRange_s.end_s})` : ""}`);
    if (card.media) {
      lines.push(`- Visual source: ${card.media.category}; ${card.media.previewAction}`);
      lines.push(`- Streams: ${card.media.streams.map((stream) => `${stream.type}:${stream.codec}${stream.width ? ` ${stream.width}x${stream.height}` : ""}`).join(", ") || "none"}`);
    }
    if (card.beats.length) {
      lines.push("- Audio beats:");
      for (const beat of card.beats) {
        lines.push(`  - ${beat.beat}: ${beat.start_s} -> ${beat.end_s}, ${beat.wordCount} word(s), "${beat.sampleText}"`);
      }
    }
    if (card.anomalies.length) {
      lines.push("- Anomalies:");
      for (const anomaly of card.anomalies) {
        lines.push(`  - ${anomaly.severity.toUpperCase()} ${anomaly.code}: ${anomaly.message}`);
      }
    }
    if (card.fixHint) lines.push(`- Likely fix: ${card.fixHint}`);
    lines.push("");
  }
  return lines.join("\n");
}
