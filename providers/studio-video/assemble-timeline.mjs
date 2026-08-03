#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  buildAudioMuxArgs,
  DEFAULT_EXPORT,
  planExport,
  readTimelineFile,
  roundSeconds,
  videoFadeFilters,
  writeCurrentExport,
} from "./timeline-export-core.mjs";
import {
  resolveSystemBin,
  validatePlanWithProbes,
} from "./timeline-export-probe.mjs";

const DEFAULT_SLICE_ROOT = path.resolve(new URL("../../", import.meta.url).pathname);
// DE-BESPOKED (rig-studio port): this used to be an absolute path to one
// project's assembly directory on one particular machine, from when this was a
// bespoke tool.
// Exports belong IN the bundle so they travel with it, which the code below
// already did for every project EXCEPT the original one. Removing the special
// case makes that the rule instead of the exception.
const DEFAULT_SLUG = "timeline-export";

function parseArgs(argv) {
  const args = {
    timeline: path.join(DEFAULT_SLICE_ROOT, "timeline.json"),
    sliceRoot: DEFAULT_SLICE_ROOT,
    mode: "review",
    outDir: "",
    assemblyRoot: "",   // resolved after flag parsing: explicit > <slice-root>/assembly > legacy default
    slug: DEFAULT_SLUG,
    width: DEFAULT_EXPORT.width,
    height: DEFAULT_EXPORT.height,
    fps: DEFAULT_EXPORT.fps,
    maxCards: 0,
    limitSeconds: 0,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--timeline") args.timeline = argv[++i];
    else if (arg === "--slice-root") args.sliceRoot = argv[++i];
    else if (arg === "--mode") args.mode = argv[++i];
    else if (arg === "--out-dir") args.outDir = argv[++i];
    else if (arg === "--assembly-root") args.assemblyRoot = argv[++i];
    else if (arg === "--slug") args.slug = argv[++i];
    else if (arg === "--width") args.width = Number(argv[++i]);
    else if (arg === "--height") args.height = Number(argv[++i]);
    else if (arg === "--fps") args.fps = Number(argv[++i]);
    else if (arg === "--max-cards") args.maxCards = Number(argv[++i]);
    else if (arg === "--limit-seconds") args.limitSeconds = Number(argv[++i]);
    else if (arg === "--json") args.json = true;
    else if (arg === "-h" || arg === "--help") {
      console.log("Usage: node assemble-timeline.mjs [--timeline timeline.json] [--mode review|final] [--out-dir dir] [--assembly-root dir] [--slug name] [--max-cards n] [--limit-seconds s] [--json]");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!args.assemblyRoot) {
    // Exports live IN the bundle so they travel with it. No legacy branch: the
    // project this tool was born for is not special any more.
    args.assemblyRoot = path.join(path.resolve(args.sliceRoot), "assembly");
  }
  if (args.slug === DEFAULT_SLUG) {
    args.slug = path.basename(path.resolve(args.sliceRoot)) || DEFAULT_SLUG;
  }
  return args;
}

function safeName(value, fallback = "segment") {
  const cleaned = String(value || fallback).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return cleaned || fallback;
}

function nextVersionDir(baseDir, slug, mode) {
  fs.mkdirSync(baseDir, { recursive: true });
  for (let i = 1; i < 1000; i++) {
    const candidate = path.join(baseDir, `${safeName(slug, "timeline-export")}-v${String(i).padStart(3, "0")}-${mode}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`Could not allocate version directory in ${baseDir}`);
}

function run(bin, args, { cwd, logFile, label, timeoutMs = 20 * 60 * 1000 }) {
  fs.appendFileSync(logFile, `\n\n# ${label}\n${bin} ${args.join(" ")}\n`);
  const result = spawnSync(bin, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    timeout: timeoutMs,
  });
  fs.appendFileSync(logFile, `\n## stdout\n${result.stdout || ""}\n## stderr\n${result.stderr || ""}\n## status\n${result.status}\n`);
  if (result.status !== 0) {
    throw new Error(`${label} failed with status ${result.status}. See ${logFile}`);
  }
  return result.stdout;
}

function vfScale({ width, height, fps }) {
  return [
    `scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=lanczos`,
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black`,
    "setsar=1",
    `fps=${fps}`,
    "format=yuv420p",
  ].join(",");
}

function hasLoopHoldPolicy(segment) {
  const text = [
    segment?.hold_policy,
    segment?.holdPolicy,
    segment?.note,
    segment?.status,
  ].filter(Boolean).join(" ").toLowerCase();
  return /\b(loop|repeat|seamless)\b/.test(text);
}

function renderVideoSegment({ ffmpeg, segment, outPath, logFile, width, height, fps }) {
  const duration = Number(segment.duration_s);
  const sourceIn = Number.isFinite(segment.source_in_s) ? Math.max(0, segment.source_in_s) : 0;
  const sourceOut = Number.isFinite(segment.source_out_s) && segment.source_out_s > sourceIn ? segment.source_out_s : 0;
  const shouldLoop = hasLoopHoldPolicy(segment);
  const trimPart = !shouldLoop && sourceOut > sourceIn ? `trim=start=${sourceIn}:end=${sourceOut}` : `trim=start=${sourceIn}`;
  const speed = Number.isFinite(Number(segment.speed_factor)) && Number(segment.speed_factor) > 0 ? Number(segment.speed_factor) : 1;
  const filter = [
    trimPart,
    `setpts=(PTS-STARTPTS)/${speed}`,
    vfScale({ width, height, fps }),
    `tpad=stop_mode=clone:stop_duration=${duration}`,
    `trim=duration=${duration}`,
    "setpts=PTS-STARTPTS",
    ...videoFadeFilters(segment),
  ].join(",");
  run(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y",
    ...(shouldLoop ? ["-stream_loop", "-1"] : []),
    "-i", segment.assetPath,
    "-an", "-sn", "-dn",
    "-vf", filter,
    "-t", String(duration),
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "18",
    "-pix_fmt", "yuv420p",
    "-r", String(fps),
    "-movflags", "+faststart",
    outPath,
  ], { logFile, label: `render ${segment.id}` });
}

function renderImageSegment({ ffmpeg, segment, outPath, logFile, width, height, fps }) {
  const duration = Number(segment.duration_s);
  run(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-loop", "1",
    "-framerate", String(fps),
    "-t", String(duration),
    "-i", segment.assetPath,
    "-vf", [vfScale({ width, height, fps }), ...videoFadeFilters(segment)].join(","),
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "18",
    "-pix_fmt", "yuv420p",
    "-r", String(fps),
    "-movflags", "+faststart",
    outPath,
  ], { logFile, label: `render image ${segment.id}` });
}

function drawTextFilter(text, y, size = 52, color = "white") {
  const safe = String(text || "")
    .replace(/[\\:']/g, " ")
    .replace(/\s+/g, " ")
    .slice(0, 96);
  return `drawtext=text='${safe}':x=(w-text_w)/2:y=${y}:fontsize=${size}:fontcolor=${color}:box=1:boxcolor=black@0.35:boxborderw=18`;
}

// Some system ffmpeg builds have no text filters (drawtext/subtitles absent - same
// gap make-video-contact-sheet works around). Labeled slates come from Cocoa
// text drawing via osascript JXA (slate-png.jxa, pure macOS - retina hosts
// return an exact 2x image, which vfScale normalizes); drawtext is attempted
// first so text-capable ffmpeg builds skip the detour.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

let ffmpegHasDrawtext = null;

// Beats whose slate rendered WITHOUT its label, so the export can report the
// degradation instead of the user discovering a blank card in the cut.
const degradedSlates = [];

function renderSlatePng({ segment, outDir, width, height, logFile }) {
  const pngPath = path.join(outDir, `slate-${safeName(String(segment.id), "slot")}.png`);
  const spec = {
    out: pngPath,
    width,
    height,
    background: "#17140f",
    lines: [
      { text: "EMPTY SLOT", size: 58, fill: "#b9822f", dy: -120 },
      { text: String(segment.id), size: 42, fill: "#ffffff", dy: -35 },
      { text: String(segment.title || "Placeholder").slice(0, 96), size: 36, fill: "#ffffff", dy: 35 },
      ...(segment.template ? [{ text: String(segment.template).slice(0, 96), size: 28, fill: "#8f8676", dy: 95 }] : []),
    ],
  };
  const result = spawnSync("/usr/bin/osascript",
    ["-l", "JavaScript", path.join(__dirname, "slate-png.jxa"), JSON.stringify(spec)], { encoding: "utf8" });
  if (result.status !== 0 || !fs.existsSync(pngPath)) {
    fs.appendFileSync(logFile, `\n## slate-png ${segment.id} failed\n${result.stderr || ""}\n`);
    return null;
  }
  return pngPath;
}

function renderPlaceholderSegment(opts) {
  const { ffmpeg, segment, outPath, logFile, width, height, fps } = opts;
  const duration = Number(segment.duration_s);
  if (ffmpegHasDrawtext !== false) {
    const filter = [
      drawTextFilter("EMPTY SLOT", "(h/2)-120", 58, "0xb9822f"),
      drawTextFilter(segment.id, "(h/2)-35", 42, "white"),
      drawTextFilter(segment.title || "Placeholder", "(h/2)+35", 36, "white"),
      ...videoFadeFilters(segment),
    ].join(",");
    const attempt = spawnSync(ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi",
      "-i", `color=c=0x17140f:s=${width}x${height}:r=${fps}:d=${duration}`,
      "-vf", filter,
      "-t", String(duration),
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "18",
      "-pix_fmt", "yuv420p",
      "-r", String(fps),
      "-movflags", "+faststart",
      outPath,
    ], { encoding: "utf8" });
    if (attempt.status === 0) { ffmpegHasDrawtext = true; return; }
    if (!/No such filter: 'drawtext'|Filter not found/i.test(attempt.stderr || "")) {
      fs.appendFileSync(logFile, `\n## render placeholder ${segment.id}\n${attempt.stderr || ""}\n`);
      throw new Error(`render placeholder ${segment.id} failed with status ${attempt.status}. See ${logFile}`);
    }
    ffmpegHasDrawtext = false;
    fs.appendFileSync(logFile, `\n## drawtext unavailable; using JXA slates for placeholders\n`);
  }
  const slatePng = renderSlatePng({ segment, outDir: path.dirname(outPath), width, height, logFile });
  if (slatePng) {
    renderImageSegment({ ...opts, segment: { ...segment, assetPath: slatePng } });
    return;
  }

  // THIRD TIER: AN UNLABELLED SLATE. A missing text filter must not fail an
  // export.
  //
  // Both labelled paths are platform-bound and neither is available
  // everywhere: `drawtext` is absent from the LINUX ffmpeg-static build (7.0.2)
  // though present in the macOS one (6.0), and the JXA fallback is macOS-only.
  // So on a Linux box with no system ffmpeg there was no way to label a slate,
  // and the assembler THREW — losing the whole export over a caption on a shot
  // that has not been filmed yet.
  //
  // The beat still occupies its exact duration, so the cut's timing, ordering
  // and every real shot around it are unaffected. What is lost is the words on
  // the card. That is a degraded label, not a broken render, and it is recorded
  // as a warning that reaches the UI rather than swallowed here — the point is
  // that the user is TOLD, not that it quietly looks fine.
  fs.appendFileSync(logFile,
    `\n## ${segment.id}: no text filter and no JXA slate — rendering an UNLABELLED slate\n`);
  degradedSlates.push(String(segment.id));

  const plain = spawnSync(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi",
    "-i", `color=c=0x17140f:s=${width}x${height}:r=${fps}:d=${duration}`,
    ...(videoFadeFilters(segment).length ? ["-vf", videoFadeFilters(segment).join(",")] : []),
    "-t", String(duration),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
    "-pix_fmt", "yuv420p", "-r", String(fps), "-movflags", "+faststart",
    outPath,
  ], { encoding: "utf8" });

  if (plain.status !== 0) {
    fs.appendFileSync(logFile, `\n## unlabelled slate ${segment.id} failed\n${plain.stderr || ""}\n`);
    throw new Error(`placeholder ${segment.id}: even an unlabelled slate failed. See ${logFile}`);
  }
}

function renderSegment(opts) {
  const { segment } = opts;
  if (segment.placeholder) return renderPlaceholderSegment(opts);
  if (segment.assetKind === "image") return renderImageSegment(opts);
  return renderVideoSegment(opts);
}

function concatSegments({ ffmpeg, segmentPaths, outPath, listPath, logFile }) {
  fs.writeFileSync(listPath, segmentPaths.map((file) => `file '${file.replaceAll("'", "'\\''")}'`).join("\n"));
  run(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "concat",
    "-safe", "0",
    "-i", listPath,
    "-c", "copy",
    outPath,
  ], { logFile, label: "concat normalized segments" });
}

function mixAudio({ ffmpeg, silentVideoPath, audioMasterPath, audioBeds, syncSegments, outPath, totalDuration, audioLoudnessTarget, logFile, fps }) {
  const args = buildAudioMuxArgs({
    silentVideoPath,
    audioMasterPath,
    audioBeds,
    syncSegments,
    outPath,
    totalDuration,
    audioLoudnessTarget,
    fps,
  });
  run(ffmpeg, args, { logFile, label: "mux final audio/video" });
}

function makeContactSheet({ ffmpeg, videoPath, outPath, logFile }) {
  run(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-i", videoPath,
    "-vf", "select='not(mod(n\\,900))',scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2:black,tile=5x4,format=yuvj420p",
    "-frames:v", "1",
    "-update", "1",
    outPath,
  ], { logFile, label: "make contact sheet", timeoutMs: 5 * 60 * 1000 });
  if (!fs.existsSync(outPath)) {
    throw new Error(`contact sheet was not written: ${outPath}`);
  }
}

function filteredPlan(plan, { maxCards, limitSeconds }) {
  if (!maxCards && !limitSeconds) return plan;
  const segments = [];
  let consumed = 0;
  for (const segment of plan.segments) {
    if (maxCards && segments.length >= maxCards) break;
    if (limitSeconds && consumed >= limitSeconds) break;
    const next = { ...segment };
    if (limitSeconds && consumed + next.duration_s > limitSeconds) {
      next.duration_s = roundSeconds(limitSeconds - consumed);
    }
    if (next.duration_s > 0) {
      segments.push(next);
      consumed += next.duration_s;
    }
  }
  const totalDurationS = limitSeconds ? Math.min(plan.totalDurationS, consumed) : consumed;
  return {
    ...plan,
    segments,
    audioBeds: plan.audioBeds
      .filter((bed) => Number(bed.start_s) < totalDurationS)
      .map((bed) => ({ ...bed, duration_s: Math.min(Number(bed.duration_s), totalDurationS - Number(bed.start_s)) })),
    totalDurationS: roundSeconds(totalDurationS),
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!["review", "final"].includes(args.mode)) throw new Error("--mode must be review or final");
  const timelinePath = path.resolve(args.timeline);
  const sliceRoot = path.resolve(args.sliceRoot);
  const timeline = readTimelineFile(timelinePath);
  const ffmpeg = resolveSystemBin("ffmpeg");
  const ffprobe = resolveSystemBin("ffprobe");
  const originalPlan = validatePlanWithProbes(planExport(timeline, {
    sliceRoot,
    mode: args.mode,
    checkFiles: true,
    width: args.width,
    height: args.height,
    fps: args.fps,
  }), {
    ffprobe,
    mode: args.mode,
    frameDurationS: 1 / args.fps,
  });
  if (!originalPlan.validation.ok) {
    throw new Error(`Timeline is not exportable:\n${originalPlan.validation.errors.join("\n")}`);
  }

  const plan = filteredPlan(originalPlan, args);
  const baseOut = args.outDir
    ? path.resolve(args.outDir)
    : nextVersionDir(path.resolve(args.assemblyRoot), args.slug, args.mode);
  const workDir = path.join(baseOut, "work");
  const segDir = path.join(baseOut, "clips");
  const logsDir = path.join(baseOut, "logs");
  fs.mkdirSync(segDir, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });
  const logFile = path.join(logsDir, "ffmpeg.log");
  fs.writeFileSync(logFile, `Timeline export started ${new Date().toISOString()}\n`);

  const rendered = [];
  for (const segment of plan.segments) {
    const outPath = path.join(segDir, `${String(segment.index).padStart(3, "0")}-${safeName(segment.id)}.mp4`);
    renderSegment({ ffmpeg, segment, outPath, logFile, width: args.width, height: args.height, fps: args.fps });
    rendered.push({ path: outPath, duration: Number(segment.duration_s), xfadeOut: Math.max(0, Number(segment.xfade_out_s) || 0) });
  }

  // crossfade chains — consecutive segments joined by xfade_out_s
  // merge into ONE file via ffmpeg xfade (segments are already normalized to
  // the same size/fps, so xfade is safe); everything else concats as before.
  const segmentPaths = [];
  let chainIndex = 0;
  for (let i = 0; i < rendered.length; i++) {
    let current = rendered[i];
    while (current.xfadeOut > 0 && i + 1 < rendered.length) {
      const next = rendered[i + 1];
      const fade = Math.min(current.xfadeOut, Math.max(0.05, current.duration - 0.05), Math.max(0.05, next.duration - 0.05));
      const joined = path.join(segDir, `xfade-${String(chainIndex).padStart(3, "0")}-${i}.mp4`);
      run(ffmpeg, [
        "-hide_banner", "-loglevel", "error", "-y",
        "-i", current.path, "-i", next.path,
        "-filter_complex", `[0:v][1:v]xfade=transition=fade:duration=${fade}:offset=${Math.max(0, +(current.duration - fade).toFixed(3))}[v]`,
        "-map", "[v]",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
        "-r", String(args.fps), "-pix_fmt", "yuv420p",
        "-movflags", "+faststart", joined,
      ], { logFile, label: `xfade join ${i}` });
      current = { path: joined, duration: +(current.duration + next.duration - fade).toFixed(3), xfadeOut: next.xfadeOut };
      i += 1;
    }
    segmentPaths.push(current.path);
    chainIndex += 1;
  }

  const visualOnlyPath = path.join(baseOut, "visual-only.mp4");
  const concatListPath = path.join(baseOut, "concat-list.txt");
  concatSegments({ ffmpeg, segmentPaths, outPath: visualOnlyPath, listPath: concatListPath, logFile });

  const outputPath = path.join(baseOut, `${safeName(args.slug, "timeline-export")}-${args.mode}${args.limitSeconds ? "-smoke" : ""}.mp4`);
  // sync-sound clips carry their own audio into the mix
  const syncSegments = plan.segments.filter((segment) =>
    segment.useSourceAudio && !segment.placeholder && segment.assetKind === "video" && segment.assetExists);
  if (plan.audioMaster.path || syncSegments.length) {
    mixAudio({
      ffmpeg,
      silentVideoPath: visualOnlyPath,
      audioMasterPath: plan.audioMaster.path || null,
      audioBeds: plan.audioBeds.filter((bed) => bed.assetExists),
      syncSegments,
      outPath: outputPath,
      totalDuration: plan.totalDurationS,
      audioLoudnessTarget: plan.audioLoudnessTarget,
      logFile,
      fps: args.fps,
    });
  } else {
    // pre-audio board : the visual concat IS the review export
    fs.copyFileSync(visualOnlyPath, outputPath);
  }

  const contactSheetPath = path.join(baseOut, "contact-sheet.jpg");
  makeContactSheet({ ffmpeg, videoPath: outputPath, outPath: contactSheetPath, logFile });

  const manifest = {
    createdAt: new Date().toISOString(),
    mode: args.mode,
    smoke: Boolean(args.maxCards || args.limitSeconds),
    timeline: timelinePath,
    output: outputPath,
    visualOnly: visualOnlyPath,
    contactSheet: contactSheetPath,
    ffmpegLog: logFile,
    concatList: concatListPath,
    width: args.width,
    height: args.height,
    fps: args.fps,
    totalDurationS: plan.totalDurationS,
    validation: plan.validation,
    segments: plan.segments,
    audioMaster: plan.audioMaster,
    audioBeds: plan.audioBeds,
    audioPolicy: `Card source audio is opt-in. The final mix is normalized to ${plan.audioLoudnessTarget} LUFS and limited to -1.5 dBTP.`,
    ...(degradedSlates.length ? { degraded: { unlabelledSlates: [...degradedSlates] } } : {}),
  };
  const manifestPath = path.join(baseOut, "assembly-manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  writeCurrentExport(sliceRoot, args.mode + (args.maxCards || args.limitSeconds ? "-smoke" : ""), {
    output: outputPath,
    manifest: manifestPath,
    contactSheet: contactSheetPath,
    totalDurationS: plan.totalDurationS,
    segmentCount: plan.segments.length,
    timeline: timelinePath,
  });

  const result = {
    ok: true,
    output: outputPath,
    outDir: baseOut,
    manifest: manifestPath,
    visualOnly: visualOnlyPath,
    contactSheet: contactSheetPath,
    ffmpegLog: logFile,
    concatList: concatListPath,
    totalDurationS: plan.totalDurationS,
    segmentCount: plan.segments.length,
    // Reported, not buried in a log. The export SUCCEEDED and some placeholder
    // cards have no words on them, and the person watching the cut is entitled
    // to know which rather than wondering why a card is blank.
    ...(degradedSlates.length ? {
      warnings: [
        `${degradedSlates.length} placeholder slate(s) rendered without labels — this ffmpeg build has no drawtext filter and no macOS text fallback is available: ${degradedSlates.join(", ")}`,
      ],
    } : {}),
  };
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`Export complete: ${outputPath}`);
    console.log(`manifest: ${manifestPath}`);
    console.log(`contact sheet: ${contactSheetPath}`);
  }
}

try {
  main();
} catch (error) {
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ ok: false, error: error.message }, null, 2));
  } else {
    console.error(error.message);
  }
  process.exit(1);
}
