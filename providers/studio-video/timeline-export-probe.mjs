import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const TRUSTED_BIN_DIRS = new Set(["/usr/bin", "/usr/local/bin", "/opt/homebrew/bin", "/opt/local/bin"]);

// PREFER THE BINARY WE SHIPPED, then fall back to the host's.
//
// ffmpeg and ffprobe used to be pure SYSTEM dependencies: the box either had
// them on PATH or the video verbs died at the moment of use. That is the worst
// shape a dependency can have — invisible at install, fatal in use, and
// different on every target. A fresh Linux VPS typically has node and git and NEITHER of
// these, which is exactly the case this resolves.
//
// `ffmpeg-static` and `ffprobe-static` ship prebuilt binaries for macOS, Linux
// and Windows as ordinary npm packages, so `npm ci` installs them and there is
// nothing platform-specific left to provision. Verified before adopting:
// ffmpeg-static 5.3.0 is ffmpeg 6.0 and carries drawtext, scale, xfade and
// concat — including the text filters some system ffmpeg builds lack, which is
// what forced the macOS-only `qlmanage` slate fallback in the assembler.
//
// PATH is kept as the fallback rather than removed: a box that has a real
// ffmpeg (codecs a static build may omit, hardware encoders) should be able to
// use it, and an operator override stays possible.
const PACKAGED = {
  ffmpeg: () => createRequire(import.meta.url)("ffmpeg-static"),
  ffprobe: () => createRequire(import.meta.url)("ffprobe-static").path,
};

export function resolveSystemBin(name) {
  const packaged = PACKAGED[name];
  if (packaged) {
    try {
      const bin = packaged();
      if (bin) { fs.accessSync(bin, fs.constants.X_OK); return bin; }
    } catch { /* not installed, or not executable — fall through to PATH */ }
  }

  const pathEntries = String(process.env.PATH || "").split(path.delimiter);
  for (const dir of pathEntries) {
    if (!TRUSTED_BIN_DIRS.has(dir)) continue;
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }
  throw new Error(
    `${name} not found. It ships with this provider — run \`npm ci\` in its directory. ` +
    `Failing that, install it on PATH under /opt/homebrew/bin, /usr/local/bin, or /usr/bin.`,
  );
}

export function probeMedia(ffprobe, mediaPath) {
  const result = spawnSync(ffprobe, [
    "-hide_banner",
    "-loglevel", "error",
    "-show_entries", "format=duration:stream=index,codec_type,codec_name,width,height,duration",
    "-of", "json",
    mediaPath,
  ], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    timeout: 30 * 1000,
  });
  if (result.status !== 0) {
    throw new Error(`ffprobe failed for ${mediaPath}: ${result.stderr || result.stdout || `status ${result.status}`}`);
  }
  const payload = JSON.parse(result.stdout || "{}");
  const duration = Number(payload?.format?.duration);
  const streamDuration = Math.max(0, ...(payload?.streams || []).map((stream) => Number(stream.duration) || 0));
  return {
    path: mediaPath,
    duration_s: Number.isFinite(duration) && duration > 0 ? duration : streamDuration,
    streams: payload?.streams || [],
  };
}

export function hasIntentionalHoldPolicy(segment) {
  const text = [
    segment?.hold_policy,
    segment?.holdPolicy,
    segment?.note,
    segment?.status,
  ].filter(Boolean).join(" ").toLowerCase();
  return /\b(hold|last-frame|freeze|pad|tail|loop|repeat|seamless)\b/.test(text);
}

function pushByMode({ mode, errors, warnings }, message) {
  if (mode === "final") errors.push(message);
  else warnings.push(message);
}

export function evaluateSegmentProbe(segment, probe, {
  mode = "review",
  frameDurationS = 1 / 30,
  toleranceS = 0.02,
} = {}) {
  const errors = [];
  const warnings = [];
  const duration = Number(probe?.duration_s);
  const sourceIn = Math.max(0, Number(segment?.source_in_s) || 0);
  const explicitSourceOut = Boolean(segment?.sourceOutExplicit);
  const requestedSourceOut = Number(segment?.source_out_s);
  const sourceOut = explicitSourceOut && Number.isFinite(requestedSourceOut) && requestedSourceOut > sourceIn
    ? requestedSourceOut
    : duration;
  const speed = Number.isFinite(Number(segment?.speed_factor)) && Number(segment.speed_factor) > 0
    ? Number(segment.speed_factor)
    : 1;

  if (!Number.isFinite(duration) || duration <= 0) {
    pushByMode({ mode, errors, warnings }, `${segment.id}: could not probe media duration`);
    return { errors, warnings, sourceIn, sourceOut, activeDurationS: 0, padDurationS: 0 };
  }

  if (sourceIn > duration + toleranceS) {
    pushByMode({ mode, errors, warnings }, `${segment.id}: source_in_s ${sourceIn} exceeds probed media duration ${duration}`);
  }
  if (explicitSourceOut && sourceOut > duration + toleranceS) {
    pushByMode({ mode, errors, warnings }, `${segment.id}: source_out_s ${sourceOut} exceeds probed media duration ${duration}`);
  }
  if (explicitSourceOut && sourceOut <= sourceIn + toleranceS) {
    pushByMode({ mode, errors, warnings }, `${segment.id}: source_out_s ${sourceOut} must be greater than source_in_s ${sourceIn}`);
  }

  const clampedSourceOut = Math.min(sourceOut, duration);
  const sourceSpan = Math.max(0, clampedSourceOut - Math.min(sourceIn, duration));
  const activeDurationS = sourceSpan / speed;
  const padDurationS = Math.max(0, Number(segment?.duration_s || 0) - activeDurationS);
  if (padDurationS > frameDurationS && !hasIntentionalHoldPolicy(segment)) {
    warnings.push(`${segment.id}: active source span ${activeDurationS.toFixed(3)}s is shorter than slot ${Number(segment.duration_s).toFixed(3)}s; exporter will hold last frame unless final policy changes`);
  }

  return {
    errors,
    warnings,
    sourceIn,
    sourceOut,
    clampedSourceOut,
    speed,
    activeDurationS,
    padDurationS,
  };
}

export function validatePlanWithProbes(plan, {
  ffprobe = resolveSystemBin("ffprobe"),
  mode = plan?.mode || "review",
  frameDurationS = 1 / Number(plan?.fps || 30),
} = {}) {
  const errors = [...(plan.validation?.errors || [])];
  const warnings = [...(plan.validation?.warnings || [])];
  const segments = plan.segments.map((segment) => {
    if (segment.placeholder || segment.assetKind !== "video" || !segment.assetExists) return segment;
    const probe = probeMedia(ffprobe, segment.assetPath);
    const probeValidation = evaluateSegmentProbe(segment, probe, { mode, frameDurationS });
    errors.push(...probeValidation.errors);
    warnings.push(...probeValidation.warnings);
    return {
      ...segment,
      probe,
      probeValidation,
    };
  });

  return {
    ...plan,
    validation: {
      ...plan.validation,
      errors,
      warnings,
      ok: errors.length === 0,
    },
    segments,
  };
}
