// What's taking space, and the few cleanups that can't lose work. Copyright 2026 mvschwarz. Licensed under the Apache License,
// Version 2.0.
//
// "What's taking space" is a bounded `du -x -k -d 2` of this user's home: one filesystem, two levels, stopped after a time
// limit (then marked partial). It never scans the whole disk or another user's files. Paths are shown relative to the home.
// The safe fixes run each tool's own cleanup as this user, one at a time, with a time limit. They only remove copies that
// download again when needed: the npm cache, the pip cache, and container images no container uses (`image prune`: dangling,
// unnamed images only). The images are the container engine's, not this user's alone: Docker's one daemon holds every image
// on the machine for everyone who can reach it, and rootless Podman holds this user's own.
// "Freed" is the measured change in free space, never the estimate. Nothing inside the Studio's project folder (OPENRIG_PROJECT_DIR,
// which the provider sets from the Studio's bound project root) is ever removed from here.
import { execFile } from "node:child_process";
import {
  access,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
  statfs,
} from "node:fs/promises";
import { constants, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const DU_MS = 10_000,
  CLEAN_MS = 180_000,
  TOP = 8;
const PROJECT_DIR = (env) =>
  env.OPENRIG_PROJECT_DIR ? path.resolve(env.OPENRIG_PROJECT_DIR) : null;

/** Runs a program (never a shell), resolving { code, stdout, stderr, timedOut }. */
export function run(bin, args, { timeoutMs = 30_000, env = process.env } = {}) {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      {
        timeout: Math.max(1, Math.round(timeoutMs)), // a whole number: execFile throws on a fraction (the fair-share split makes one)
        maxBuffer: 16 * 1024 * 1024,
        env,
        killSignal: "SIGKILL",
      },
      (err, stdout, stderr) => {
        resolve({
          code: err ? (typeof err.code === "number" ? err.code : -1) : 0,
          stdout: String(stdout || ""),
          stderr: String(stderr || ""),
          timedOut: !!err?.killed,
        });
      },
    );
  });
}

/** The absolute path of a program on PATH, or null (no shell, no `which`). */
export async function onPath(name, env = process.env) {
  for (const d of (env.PATH || "").split(path.delimiter).filter(Boolean)) {
    const p = path.join(d, name);
    try {
      await access(p, constants.X_OK);
      return p;
    } catch {}
  }
  return null;
}

/** The largest folders in home, biggest first: each top-level folder is measured on its own against one deadline, then the biggest
 * few one level deeper, so a cut-short read still lists what it finished. { root, partial, folders: [{ path, bytes, depth, inProject }] }. */
export async function bigFolders({
  home = os.homedir(),
  env = process.env,
  runner = run,
  du = "du",
  timeoutMs = DU_MS,
  now = Date.now,
  platform = process.platform,
} = {}) {
  const deadline = now() + timeoutMs,
    project = PROJECT_DIR(env),
    base = path.resolve(home);
  const left = () => deadline - now();
  const row = (abs, bytes) => {
    const rel = path.relative(base, abs);
    return {
      path: rel,
      bytes,
      depth: rel.split(path.sep).length,
      inProject: !!project && (abs === project || abs.startsWith(project + path.sep)),
    };
  };
  let partial = false;
  const measure = async (abs, depth, budget = left()) => {
    if (left() <= 0) {
      partial = true;
      return [{ ...row(abs, null), notTried: true }];
    }
    const r = await runner(du, ["-x", "-k", "-d", String(depth), abs], {
      timeoutMs: Math.max(1, Math.min(budget, left())),
      env,
    });
    // A folder that ran out of time is listed as "too big to count in time": the slow ones are usually the big ones.
    if (r.timedOut) {
      partial = true;
      return depth === 0 ? [{ ...row(abs, null), notCounted: true }] : [];
    }
    const out = [];
    for (const line of r.stdout.split("\n")) {
      const m = line.match(/^(\d+)\t(.+)$/);
      if (!m) continue;
      const a = path.resolve(m[2]);
      if (a === base || !a.startsWith(base + path.sep)) continue;
      out.push(row(a, Number(m[1]) * 1024));
    }
    return out;
  };
  let children;
  // On a Mac, ~/Library is left out: reading it can raise the system's privacy prompts, and it's the system's own folder.
  const skip = new Set(platform === "darwin" ? ["Library"] : []);
  try {
    children = (await readdir(base, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && !d.isSymbolicLink() && !skip.has(d.name))
      .map((d) => path.join(base, d.name));
  } catch {
    return { root: "~", partial: false, failed: true, folders: [] };
  }
  const top = [];
  // Each top-level folder gets a fair share of what's left, so one huge folder can't use the whole budget.
  for (let i = 0; i < children.length; i++)
    top.push(
      ...(await measure(children[i], 0, Math.max(500, (left() / (children.length - i)) * 0.8))),
    );
  const counted = top.filter((t) => !t.notCounted && !t.notTried).sort((a, b) => b.bytes - a.bytes);
  const deeper = [];
  for (const t of counted.slice(0, 3))
    deeper.push(...(await measure(path.join(base, t.path), 1)).filter((r) => r.depth === 2));
  const all = [...counted, ...deeper].sort((a, b) => b.bytes - a.bytes).slice(0, TOP);
  return {
    root: "~",
    partial,
    failed: false,
    folders: all,
    notCounted: top
      .filter((t) => t.notCounted)
      .map((t) => t.path)
      .slice(0, TOP),
    notTried: top
      .filter((t) => t.notTried)
      .map((t) => t.path)
      .slice(0, TOP),
    ...(skip.size ? { skipped: [...skip] } : {}),
  };
}

async function sizeOf(dir, runner, env) {
  try {
    await access(dir);
  } catch {
    return 0;
  }
  const r = await runner("du", ["-x", "-s", "-k", dir], { timeoutMs: DU_MS, env });
  const m = r.stdout.match(/^(\d+)\t/);
  return m ? Number(m[1]) * 1024 : null;
}

/** A cache folder is safe to clear only when it isn't the home itself and isn't inside the project (PIP_CACHE_DIR or the npm cache setting can
 * point anywhere). */
export function safeCacheDir(dir, { env = process.env, home = os.homedir() } = {}) {
  if (!dir || !path.isAbsolute(dir)) return false;
  // Compared as written AND with symlinks resolved, so a cache folder that's a link into the project (or the home) is refused too.
  const real = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  const unsafe = (d, project, h) =>
    d === h ||
    d === path.parse(d).root ||
    (project != null &&
      (d === project || d.startsWith(project + path.sep) || project.startsWith(d + path.sep)));
  const project = PROJECT_DIR(env);
  return (
    !unsafe(path.resolve(dir), project, path.resolve(home)) &&
    !unsafe(real(dir), project && real(project), real(home))
  );
}

/** The npm cache folder: npm_config_cache (any case) when set, else ~/.npm. npm 10 and 11 refuse "npm config get cache" (protected), so
 * it isn't asked; and the cleanup passes --cache=<this folder>, so what's cleaned is exactly the folder that was checked, whatever an
 * .npmrc says. */
async function npmCache(env, runner, home, execPath) {
  const key = Object.keys(env).find((k) => k.toLowerCase() === "npm_config_cache" && env[k]);
  const dir = key ? path.resolve(env[key]) : path.join(home, ".npm");
  const npm = await npmCommand(env, execPath);
  if (npm) return { bin: npm[0], pre: npm[1], dir };
  // No npm here (a standalone Node), but an npm cache left by an earlier npm: "npm cache clean --force" only removes <cache>/_cacache, so
  // that same folder is removed directly. It must be a real folder, not a link. Once it's cleared the row stays while the npm folder does
  // (nothing to clear), so the page can show what the clear freed, as it does where npm is installed.
  try {
    const st = await lstat(path.join(dir, "_cacache"));
    return st.isDirectory()
      ? { bin: null, dir }
      : st.isSymbolicLink()
        ? { bin: null, dir, linked: true }
        : null;
  } catch {
    try {
      return (await lstat(dir)).isDirectory() ? { bin: null, dir } : null;
    } catch {
      return null;
    }
  }
}

/** npm as [program, first args], or null. npm on PATH runs as found, by the name it was found under: a version manager's shim (mise,
 * Volta) picks the tool from that name, and the node beside it matches it. Only when npm isn't on PATH is it looked for beside this Node,
 * then in this Node's lib/node_modules (a Node bundled with its own npm); there, the script npm starts from begins with "env node",
 * which needs node on PATH, so it runs with this Node. */
export async function npmCommand(env = process.env, execPath = process.execPath) {
  const onp = await onPath("npm", env);
  if (onp) return [onp, []];
  const dir = path.dirname(execPath);
  for (const c of [
    path.join(dir, "npm"),
    path.join(dir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ]) {
    let real;
    try {
      real = realpathSync(c);
    } catch {
      continue;
    }
    if (real.endsWith(".js")) return [execPath, [real]];
    try {
      await access(c, constants.X_OK);
      return [c, []];
    } catch {}
  }
  return null;
}
async function pipCache(env, runner) {
  const py = await onPath("python3", env);
  if (!py) return null;
  const r = await runner(py, ["-m", "pip", "cache", "dir"], { timeoutMs: 15_000, env });
  return r.code === 0 && r.stdout.trim() ? { bin: py, dir: r.stdout.trim() } : null;
}
// Shown, with no button, when the npm cache's folder is a link to somewhere else: it's never followed, so it isn't cleared from here.
const LINKED_NOTE = "Its cache folder is a link to somewhere else, so it isn't cleared from here.";
const IMAGE_NOTE =
  "Only unnamed images that no container uses, but across the whole container engine: with Docker, that includes images other people on this machine made. One you built yourself would be built again when needed.";

/** The safe fixes available here, each with what it would free. Only fixes whose tool exists, and whose cache is a safe folder, are listed. */
export async function listFixes({
  env = process.env,
  runner = run,
  home = os.homedir(),
  execPath = process.execPath,
} = {}) {
  const out = [];
  const npm = await npmCache(env, runner, home, execPath);
  if (npm?.linked && safeCacheDir(npm.dir, { env, home }))
    out.push({
      id: "npm",
      label: "Clear the npm cache",
      running: "Clearing…",
      frees: null,
      blocked: true,
      note: LINKED_NOTE,
    });
  else if (npm && safeCacheDir(npm.dir, { env, home }))
    out.push({
      id: "npm",
      label: "Clear the npm cache",
      running: "Clearing…",
      frees: await sizeOf(path.join(npm.dir, "_cacache"), runner, env),
    });
  const pip = await pipCache(env, runner);
  if (pip && safeCacheDir(pip.dir, { env, home }))
    out.push({
      id: "pip",
      label: "Clear the pip cache",
      running: "Clearing…",
      frees: await sizeOf(pip.dir, runner, env),
    });
  const pod = await onPath("podman", env),
    dock = pod ? null : await onPath("docker", env);
  if (pod) {
    const r = await runner(pod, ["images", "--filter", "dangling=true", "--format", "json"], {
      timeoutMs: 30_000,
      env,
    });
    let frees = null;
    try {
      const list = JSON.parse(r.stdout || "[]");
      frees = list.reduce((n, i) => n + (Number(i.Size) || 0), 0);
    } catch {}
    out.push({
      id: "images",
      label: "Remove unused container images",
      running: "Removing…",
      note: IMAGE_NOTE,
      frees: r.code === 0 ? frees : null,
    });
  } else if (dock) {
    // docker reports sizes as text ("1.2GB"), so what it frees is shown after, from the measured change.
    out.push({
      id: "images",
      label: "Remove unused container images",
      running: "Removing…",
      note: IMAGE_NOTE,
      frees: null,
    });
  }
  return out;
}

const UNSAFE = Symbol("unsafe cache folder");
const COMMANDS = {
  // Each cleanup names the folder it checked, so it can't clean another one the tool is configured with.
  npm: async (env, runner, home, execPath) => {
    const c = await npmCache(env, runner, home, execPath);
    if (!c) return null;
    if (!safeCacheDir(c.dir, { env, home })) return UNSAFE;
    if (c.bin)
      return [c.bin, [...c.pre, "cache", "clean", "--force", `--cache=${c.dir}`, "--logs-max=0"]];
    const target = path.join(c.dir, "_cacache");
    return {
      direct: async () => {
        try {
          // Checked again right before removing (the folder could have been swapped for a link since the list was made).
          if (
            !safeCacheDir(c.dir, { env, home }) ||
            !(await lstat(target).then(
              (st) => st.isDirectory(),
              () => true,
            ))
          )
            return {
              code: 1,
              stdout: "",
              stderr: "its cache folder changed",
              timedOut: false,
              removed: "none",
            };
          await rm(target, { recursive: true, force: true });
          return { code: 0, stdout: "", stderr: "", timedOut: false };
        } catch (e) {
          return {
            code: 1,
            stdout: "",
            stderr: String(e?.code || e?.message || e),
            timedOut: false,
          };
        }
      },
    };
  },
  pip: async (env, runner, home) => {
    const c = await pipCache(env, runner);
    return !c
      ? null
      : safeCacheDir(c.dir, { env, home })
        ? [c.bin, ["-m", "pip", "--cache-dir", c.dir, "cache", "purge"]]
        : UNSAFE;
  },
  images: async (env) => {
    const b = (await onPath("podman", env)) || (await onPath("docker", env));
    return b && [b, ["image", "prune", "-f"]];
  },
};

let busy = false;
/** Runs one safe fix. { ok, id, freedBytes, why? }. freedBytes is the measured change in free space on home's disk (never negative). */
export async function clean(
  id,
  {
    env = process.env,
    runner = run,
    home = os.homedir(),
    fsStatfs = statfs,
    studioDir = env.OPENRIG_STUDIO_DIR,
    execPath = process.execPath,
  } = {},
) {
  if (!Object.hasOwn(COMMANDS, id))
    return { ok: false, id, why: "not one of the safe fixes", removed: "none" };
  if (busy)
    return {
      ok: false,
      id,
      why: "another cleanup is running; try again when it finishes",
      removed: "none",
    };
  busy = true;
  try {
    const cmd = await COMMANDS[id](env, runner, home, execPath);
    if (!cmd) return { ok: false, id, why: "this tool isn't installed here", removed: "none" };
    if (cmd === UNSAFE)
      return {
        ok: false,
        id,
        why: "its cache folder is the home or inside the project, so it isn't cleared from here",
        removed: "none",
      };
    const free = async () => {
      try {
        const s = await fsStatfs(home);
        return s.bavail * s.bsize;
      } catch {
        return null;
      }
    };
    const before = await free();
    const r = Array.isArray(cmd)
      ? await runner(cmd[0], cmd[1], { timeoutMs: CLEAN_MS, env })
      : await cmd.direct();
    const after = await free();
    const freedBytes = before != null && after != null ? Math.max(0, after - before) : null;
    await logLine(studioDir, {
      at: new Date().toISOString(),
      id,
      code: r.code,
      timedOut: r.timedOut,
      freedBytes,
    });
    if (r.code !== 0) {
      const reason = (
        r.timedOut
          ? "it took too long and was stopped"
          : r.stderr.trim().split("\n").pop() || `it exited with ${r.code}`
      ).slice(0, 200);
      return {
        ok: false,
        id,
        why: reason,
        freedBytes,
        removed: r.removed === "none" ? "none" : freedBytes ? "some" : "unknown",
      };
    }
    return { ok: true, id, freedBytes };
  } finally {
    busy = false;
  }
}

async function logLine(studioDir, entry) {
  if (!studioDir) return;
  try {
    const dir = path.join(studioDir, ".runtime");
    await mkdir(dir, { recursive: true });
    const f = path.join(dir, "system-cleanups.jsonl");
    let prev = "";
    try {
      prev = await readFile(f, "utf8");
    } catch {}
    const lines = (prev + JSON.stringify(entry) + "\n").split("\n").filter(Boolean).slice(-200);
    const tmp = `${f}.${process.pid}.tmp`;
    await writeFile(tmp, lines.join("\n") + "\n", { mode: 0o600 });
    await rename(tmp, f);
  } catch {}
}

/** Remembers when the latest out-of-memory stop was first seen, so the panel can say "at <time>". Returns seenAt or null. */
export async function oomSeen(studioDir, kills, now = () => new Date(), { readOnly = false } = {}) {
  if (!studioDir || !(kills >= 0)) return null;
  const f = path.join(studioDir, ".runtime", "system-oom.json");
  let s = {};
  try {
    s = JSON.parse(await readFile(f, "utf8"));
  } catch {}
  // The command only reads what the provider recorded: same count, its date; otherwise none (it never dates a stop itself).
  if (readOnly)
    return s.kills === kills && typeof s.seenAt === "string" && !s.firstRead ? s.seenAt : null;
  // A count of 0 is remembered too, so the first stop after the panel's first look is dated (it isn't one from before anyone looked).
  if (kills === 0) {
    if (s.kills !== 0) {
      try {
        await mkdir(path.dirname(f), { recursive: true });
        const tmp = `${f}.${process.pid}.tmp`;
        await writeFile(tmp, JSON.stringify({ kills: 0 }), { mode: 0o600 });
        await rename(tmp, f);
      } catch {}
    }
    return null;
  }
  if (s.kills === kills && typeof s.seenAt === "string") return s.firstRead ? null : s.seenAt;
  // The first read ever only learns the count (those stops happened before anyone looked); a later rise is dated.
  const next = { kills, seenAt: now().toISOString(), firstRead: s.kills === undefined };
  try {
    await mkdir(path.dirname(f), { recursive: true });
    const tmp = `${f}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(next), { mode: 0o600 });
    await rename(tmp, f);
  } catch {}
  return next.firstRead ? null : next.seenAt;
}
