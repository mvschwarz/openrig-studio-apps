// What this machine looks like: storage, memory, CPU, uptime, pressure and out-of-memory stops, read from plain files (no root,
// no daemon). Copyright 2026 mvschwarz. Licensed under the Apache License, Version 2.0.
//
// Linux (a user session, a service or a rootless container): the process's own cgroup v2 (from /proc/self/cgroup "0::<path>"; for
// a systemd service or scope, its parent slice is the workspace's total), plus /proc/meminfo, /proc/loadavg, /proc/uptime. Inside
// a container /sys/fs/cgroup is the container's own, so the same reads are the container's. macOS: what Node's os module and
// statfs give; the rest is "not known" with why. "Workspace" below means the cgroup this Studio runs in.
// Anything missing is null with a reason, never 0.
import { readFile, statfs } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const WARN = 0.8,
  URGENT = 0.9,
  TIGHT_AVG60 = 10,
  OOM_RECENT_MS = 24 * 3600 * 1000,
  FREE_FLOOR_BYTES = 1e9;

export const stateOf = (fraction) =>
  fraction == null || !Number.isFinite(fraction)
    ? "unknown"
    : fraction > URGENT
      ? "urgent"
      : fraction > WARN
        ? "warn"
        : "ok";

const num = (s) => {
  const n = Number(String(s).trim());
  return Number.isFinite(n) ? n : null;
};

/** Reads a small text file under root, or null. root is "/" in production and a fixture folder in tests. */
function reader(root) {
  return async (p) => {
    try {
      return await readFile(path.join(root, p), "utf8");
    } catch {
      return null;
    }
  };
}

const escapes = (p) => p.split("/").includes("..");
/** Whether this process's cgroup path climbs out of its namespace (see cgroupDir). */
async function outside(read, ownPath) {
  const txt = ownPath ? `0::${ownPath}` : await read("/proc/self/cgroup");
  const line = txt && txt.split("\n").find((l) => l.startsWith("0::"));
  return !!line && escapes(line.slice(3).trim());
}

/** The workspace's cgroup folder (relative to root), or null: the process's own, or its parent slice when it's a service or scope.
 * ownPath (a cgroup path like "/user.slice/x.slice/y.service") replaces /proc/self/cgroup: the command uses the provider's, so both read
 * the same workspace. */
export async function cgroupDir(read, ownPath) {
  let p = ownPath;
  if (!p) {
    const txt = await read("/proc/self/cgroup");
    const line = txt && txt.split("\n").find((l) => l.startsWith("0::"));
    if (!line) return null;
    p = line.slice(3).trim() || "/";
  }
  // A path that climbs ("/../x.service") means this process sits OUTSIDE the root of its cgroup namespace: what's mounted at
  // /sys/fs/cgroup is some other unit (in a container whose services run as siblings, the container's own anchor), so
  // nothing it can see is the workspace. No cgroup, then; readSystem says why.
  if (escapes(p)) return null;
  if (/\.(service|scope)$/.test(p)) p = path.posix.dirname(p);
  const dir = path.posix.join("/sys/fs/cgroup", p).replace(/\/+$/, "");
  return (await read(path.posix.join(dir, "memory.current"))) != null ||
    (await read(path.posix.join(dir, "cpu.stat"))) != null
    ? dir
    : null;
}

/** The process's own service or scope folder (relative to root), when it runs in one, else null. A limit set on that service binds
 * THIS service only, not the workspace's other units (OpenRig itself, the agents), so it's reported on its own and never as the
 * workspace's limit. */
export async function unitDir(read, ownPath) {
  let p = ownPath;
  if (!p) {
    const txt = await read("/proc/self/cgroup");
    const line = txt && txt.split("\n").find((l) => l.startsWith("0::"));
    if (!line) return null;
    p = line.slice(3).trim();
  }
  if (escapes(p) || !/\.(service|scope)$/.test(p)) return null;
  const dir = path.posix.join("/sys/fs/cgroup", p);
  return (await read(path.posix.join(dir, "memory.current"))) != null ||
    (await read(path.posix.join(dir, "cpu.stat"))) != null
    ? dir
    : null;
}

/** The folder and each ancestor up to /sys/fs/cgroup: an effective limit is the smallest one set along the way. */
export function ancestors(dir) {
  const out = [];
  for (let d = dir; d.startsWith("/sys/fs/cgroup"); d = path.posix.dirname(d)) {
    out.push(d);
    if (d === "/sys/fs/cgroup") break;
  }
  return out;
}

/** "some avg10=0.00 avg60=1.23 avg300=0.50 total=…" → { avg10, avg60 } or null. */
export function pressure(txt) {
  const m = txt && txt.match(/^some\s+avg10=([\d.]+)\s+avg60=([\d.]+)/m);
  return m ? { avg10: Number(m[1]), avg60: Number(m[2]), tight: Number(m[2]) > TIGHT_AVG60 } : null;
}

const kv = (txt) =>
  Object.fromEntries(
    (txt || "")
      .split("\n")
      .map((l) => l.trim().split(/\s+/))
      .filter((a) => a.length >= 2)
      .map(([k, v]) => [k.replace(/:$/, ""), v]),
  );

/** Storage of the folder people and agents work in: bytes and inodes, like df. */
export async function storage(dir, fsStatfs = statfs) {
  try {
    const s = await fsStatfs(dir);
    const usedBlocks = s.blocks - s.bfree,
      size = (usedBlocks + s.bavail) * s.bsize;
    const used = usedBlocks * s.bsize,
      free = s.bavail * s.bsize;
    const bytesFraction = size > 0 ? used / size : null;
    const inodes =
      s.files > 0
        ? { total: s.files, free: s.ffree, fraction: (s.files - s.ffree) / s.files }
        : null;
    const rank = { unknown: -1, ok: 0, warn: 1, urgent: 2 };
    // File count speaks only when it sets a WORSE state than the bytes do (then it's the reason the disk is full).
    const tighter =
      inodes &&
      bytesFraction != null &&
      rank[stateOf(inodes.fraction)] > rank[stateOf(bytesFraction)]
        ? "inodes"
        : "bytes";
    const fraction = tighter === "inodes" ? inodes.fraction : bytesFraction;
    // On a small disk a percentage hides how little is left: under 1 GB free is at least "Getting full", whatever the percentage. On a
    // disk of 2 GB or less the floor is half the disk, so an empty small disk isn't called full.
    const lowFree = free < Math.min(FREE_FLOOR_BYTES, size / 2) && stateOf(fraction) === "ok";
    return {
      state: lowFree ? "warn" : stateOf(fraction),
      fraction,
      ...(lowFree ? { lowFree: true } : {}),
      usedBytes: used,
      freeBytes: free,
      totalBytes: size,
      inodes,
      tighter,
      folder: dir,
    };
  } catch {
    return { state: "unknown", why: "couldn't read this folder's disk", folder: dir };
  }
}

/** Everything the panel and the command show, in one read. opts: { root, home, studioDir, platform, sampleMs, statfs, now }. */
export async function readSystem(opts = {}) {
  const root = opts.root || "/",
    read = reader(root),
    platform = opts.platform || process.platform;
  const home = opts.home || os.homedir(),
    now = opts.now || Date.now;
  const out = { at: new Date(now()).toISOString(), platform, notes: [] };
  out.storage = await storage(home, opts.statfs || statfs);

  if (platform === "linux") {
    const cg = await cgroupDir(read, opts.cgroupPath);
    out.cgroup = cg ? cg.replace(/^\/sys\/fs\/cgroup/, "") || "/" : null;
    // The workspace's limits: its folder and every ancestor. The process's own unit is read separately (see unitDir).
    const unit = cg ? await unitDir(read, opts.cgroupPath) : null;
    if (unit) out.cgroupUnit = unit.replace(/^\/sys\/fs\/cgroup/, "");
    const limitWalk = cg ? ancestors(cg) : [];
    const f = (n) => (cg ? read(path.posix.join(cg, n)) : Promise.resolve(null));
    const at = (d, n) => read(path.posix.join(d, n));
    const mi = kv(await read("/proc/meminfo"));
    const memTotal = num(mi.MemTotal) != null ? num(mi.MemTotal) * 1024 : null,
      memAvail = num(mi.MemAvailable) != null ? num(mi.MemAvailable) * 1024 : null;
    // The workspace's effective memory limit: the smallest memory.max on its folder or any ancestor, and the use at THAT level.
    let max = null,
      limitDir = null;
    for (const d of limitWalk) {
      const raw = (await at(d, "memory.max"))?.trim(),
        v = raw && raw !== "max" ? num(raw) : null;
      if (v != null && v > 0 && (max == null || v < max)) {
        max = v;
        limitDir = d;
      }
    }
    // In use = memory.current minus the file cache the kernel can drop at once (inactive_file), so git or a build doesn't read as full.
    const inUse = async (d) => {
      const c = num(await at(d, "memory.current"));
      if (c == null) return null;
      const st = kv(await at(d, "memory.stat"));
      const inactive = num(st.inactive_file);
      return Math.max(0, c - (inactive ?? 0));
    };
    const cur = cg ? await inUse(cg) : null;
    const limited = limitDir ? await inUse(limitDir) : null;
    if (limited != null && max != null) {
      out.memory = {
        state: stateOf(limited / max),
        fraction: limited / max,
        usedBytes: limited,
        limitBytes: max,
        scope: "workspace",
        machineTotalBytes: memTotal,
      };
    } else if (memTotal != null && memAvail != null) {
      const used = memTotal - memAvail;
      out.memory = {
        state: stateOf(used / memTotal),
        fraction: used / memTotal,
        usedBytes: used,
        availableBytes: memAvail,
        totalBytes: memTotal,
        scope: "machine",
        ...(cur != null ? { workspaceUsedBytes: cur } : {}),
      };
    } else out.memory = { state: "unknown", why: "couldn't read memory" };
    const peak = num(await f("memory.peak"));
    if (peak != null && out.memory.state !== "unknown") out.memory.peakBytes = peak;
    const ev = kv(await f("memory.events"));
    out.oom =
      cg && (await f("memory.events")) != null
        ? { kills: num(ev.oom_kill) ?? 0, events: num(ev.oom) ?? 0 }
        : null;

    const cores =
      typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
    // The workspace's effective CPU limit: the smallest quota/period on its folder or any ancestor.
    let limitCores = null;
    for (const d of limitWalk) {
      const m = (await at(d, "cpu.max"))?.trim().split(/\s+/);
      const v = m && m[0] !== "max" && num(m[0]) && num(m[1]) ? num(m[0]) / num(m[1]) : null;
      if (v != null && (limitCores == null || v < limitCores)) limitCores = v;
    }
    if (unit) {
      const um = (await at(unit, "memory.max"))?.trim(),
        uMem = um && um !== "max" ? num(um) : null;
      const uc = (await at(unit, "cpu.max"))?.trim().split(/\s+/),
        uCpu = uc && uc[0] !== "max" && num(uc[0]) && num(uc[1]) ? num(uc[0]) / num(uc[1]) : null;
      if (uMem != null || uCpu != null) {
        out.unitLimits = { memoryBytes: uMem, cores: uCpu };
        const parts = [
          uMem != null
            ? `${uMem >= 1e9 ? `${(uMem / 1e9).toFixed(1)} GB` : `${Math.round(uMem / 1e6)} MB`} of memory`
            : null,
          uCpu != null ? `${+uCpu.toFixed(2)} cores` : null,
        ]
          .filter(Boolean)
          .join(" and ");
        out.notes.push(
          `The Machine app's own service is limited to ${parts}. That limit is the service's, not the whole Studio's.`,
        );
      }
    }
    const load = (await read("/proc/loadavg"))?.trim().split(/\s+/).slice(0, 3).map(Number);
    const usage = async () => num(kv(await f("cpu.stat")).usage_usec);
    // At the root of its own cgroup namespace (a container) with no limit in sight, the container's own use may not be the whole
    // workspace's (other services of the workspace can sit outside it), so CPU is the machine's load, like memory.
    const hidden = out.cgroup === "/" && max == null && limitCores == null;
    let usedCores = null;
    const u1 = hidden ? null : await usage();
    if (u1 != null) {
      const ms = opts.sampleMs ?? 500,
        t1 = Date.now();
      await new Promise((r) => setTimeout(r, ms));
      const u2 = await usage(),
        dt = (Date.now() - t1) * 1000;
      if (u2 != null && dt > 0) usedCores = Math.max(0, (u2 - u1) / dt);
    }
    const capacity = limitCores || cores;
    const busy =
      usedCores != null
        ? usedCores / capacity
        : load && Number.isFinite(load[1])
          ? load[1] / cores
          : null;
    out.cpu = {
      state: stateOf(busy),
      fraction: busy,
      cores,
      limitCores,
      usedCores,
      load: load && load.every(Number.isFinite) ? load : null,
      basis:
        usedCores != null
          ? limitCores
            ? "this machine's use against its CPU limit"
            : "this machine's use against the machine's cores"
          : "machine load (5 min) per core",
    };
    if (busy == null) out.cpu = { state: "unknown", why: "couldn't read CPU use or load", cores };
    out.pressure = cg
      ? {
          memory: pressure(await f("memory.pressure")),
          cpu: pressure(await f("cpu.pressure")),
          io: pressure(await f("io.pressure")),
        }
      : null;
    const up = num((await read("/proc/uptime"))?.split(/\s+/)[0]);
    out.uptimeSeconds = up ?? Math.round(os.uptime());
    const pc = num(await f("pids.current")),
      pm = (await f("pids.max"))?.trim();
    if (pc != null) out.tasks = { current: pc, max: pm && pm !== "max" ? num(pm) : null };
    // Why memory (and CPU) show the whole machine, when they do: no cgroup could be read; or the process sits at the root of its own
    // cgroup namespace (a container), where a limit set above it (the workspace's slice) can't be seen; or the workspace has no limit.
    if (!cg && !(await outside(read, opts.cgroupPath)))
      out.notes.push(
        "This machine's own limits couldn't be read, so memory and CPU show the whole machine.",
      );
    else if (!cg || hidden)
      out.notes.push(
        "Any limits set from outside this machine can't be seen from here, so memory and CPU show the whole machine.",
      );
    else if (out.memory.scope === "machine")
      out.notes.push(
        "This machine has no memory limit of its own, so memory shows the whole machine.",
      );
  } else {
    const total = os.totalmem(),
      free = os.freemem();
    // macOS counts its file cache as used, so there's no honest fullness state: show use only (the Mac line explains).
    out.memory = {
      state: "unknown",
      usedBytes: total - free,
      totalBytes: total,
      scope: "machine",
      useOnly: true,
    };
    const cores =
        typeof os.availableParallelism === "function"
          ? os.availableParallelism()
          : os.cpus().length,
      load = os.loadavg();
    const busy = Number.isFinite(load[1]) && load[1] > 0 ? load[1] / cores : null;
    out.cpu = {
      state: stateOf(busy),
      fraction: busy,
      cores,
      limitCores: null,
      usedCores: null,
      load,
      basis: "machine load (5 min) per core",
    };
    out.pressure = null;
    out.oom = null;
    out.uptimeSeconds = Math.round(os.uptime());
    out.notes.push(
      "On this system there are no per-Studio limits, pressure or out-of-memory records to read.",
    );
  }
  return out;
}

/** Words for each state, per resource. */
export const WORDS = {
  storage: { ok: "OK", warn: "Getting full", urgent: "Almost full", unknown: "Not known" },
  memory: { ok: "OK", warn: "Getting tight", urgent: "Almost out", unknown: "Not known" },
  cpu: { ok: "OK", warn: "Busy", urgent: "Very busy", unknown: "Not known" },
};
export const MAC_LINE =
  "On a Mac, Machine can read storage, memory use and CPU load, but not memory pressure, per-Studio limits or programs stopped for using too much memory, so those aren't shown.";

/** Why it's slow: plain sentences, only for what's present (never "0%"). s.oom.seenAt is when this panel first saw the latest stop. */
export function findings(s) {
  const out = [],
    pctOf = (v) => `${Math.round(v)}%`;
  if (s.pressure?.memory?.tight)
    out.push({
      level: "warn",
      title: "Memory is tight.",
      text: `Programs spent ${pctOf(s.pressure.memory.avg60)} of the last minute waiting for memory.`,
    });
  if (s.pressure?.cpu?.tight)
    out.push({
      level: "warn",
      title: "The processor is busy.",
      text: `Programs spent ${pctOf(s.pressure.cpu.avg60)} of the last minute waiting for their turn.`,
    });
  if (s.pressure?.io?.tight)
    out.push({
      level: "warn",
      title: "The disk is slow to keep up.",
      text: `Programs spent ${pctOf(s.pressure.io.avg60)} of the last minute waiting on it.`,
    });
  // "A program was stopped for using too much memory at 22:42." Only a RECENT stop (first seen in the last 24 hours) is a finding; `at`
  // is ISO, shown in the reader's clock with the date when it isn't today. Older or undated stops are history (oom.kills), not news.
  const seen = s.oom?.seenAt ? Date.parse(s.oom.seenAt) : NaN,
    nowMs = Date.parse(s.at);
  if (s.oom?.kills > 0 && Number.isFinite(seen) && nowMs - seen <= OOM_RECENT_MS)
    out.push({
      level: "urgent",
      title: "A program was stopped for using too much memory",
      at: s.oom.seenAt,
      text: "",
    });
  if (s.tasks?.max && s.tasks.current / s.tasks.max > WARN)
    out.push({
      level: "warn",
      title: "Many programs are running.",
      text: `${s.tasks.current} of this machine's limit of ${s.tasks.max}.`,
    });
  return out;
}
