// The Machine app's routes, shared by the provider and the openrig-system command. Copyright 2026 mvschwarz. Licensed under the
// Apache License, Version 2.0.
//   GET  /api/system/status          storage, memory, CPU, uptime, why it's slow, and the safe fixes with what each frees
//   GET  /api/system/big-folders     the largest folders in this user's home (bounded; partial when cut short)
//   POST /api/system/big-folders     the same, looked at again now
//   POST /api/system/clean {id}      run one safe fix; answers the measured space freed
// The fix list (which starts npm, pip and podman and sizes their caches) is kept for 10 minutes, and refreshed after a cleanup or with
// ?fixes=refresh, so a page polling status every 15 s doesn't add the load it reports.
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import path from "node:path";
import { readSystem, findings, WORDS, MAC_LINE } from "./lib/read.mjs";
import { bigFolders, listFixes, clean, oomSeen } from "./lib/fixes.mjs";

let bigCache = null,
  fixCache = null;
const BIG_TTL_MS = 10 * 60 * 1000,
  FIX_TTL_MS = 10 * 60 * 1000;
const CGROUP_FILE = (dir) => path.join(dir, ".runtime", "system-cgroup.json");

async function writeJson(f, v) {
  try {
    await mkdir(path.dirname(f), { recursive: true });
    const t = `${f}.${process.pid}.tmp`;
    await writeFile(t, JSON.stringify(v), { mode: 0o600 });
    await rename(t, f);
  } catch {}
}

export function stepsFrom(env = process.env) {
  const named = new Set(
    String(env.OPENRIG_SYSTEM_STEPS || "")
      .split(",")
      .map((x) => x.trim()),
  );
  return { lead: named.has("lead") };
}

/** opts.readOnly (the command): writes nothing, and reads the cgroup the provider recorded, so both show the same numbers. */
export async function status(env = process.env, opts = {}) {
  const studioDir = env.OPENRIG_STUDIO_DIR;
  let cgroupPath = opts.cgroupPath;
  // The provider's own unit when it runs in one (its limit binds too), else its workspace cgroup.
  if (!cgroupPath && opts.readOnly && studioDir) {
    try {
      const r = JSON.parse(await readFile(CGROUP_FILE(studioDir), "utf8"));
      cgroupPath = r.unit || r.path;
    } catch {}
  }
  const s = await readSystem({ ...opts, cgroupPath });
  // Steps this deployment's people can actually take, so the page never shows one they can't: OPENRIG_SYSTEM_STEPS lists them
  // (comma-separated). "lead": there's a lead to ask what can go. Unset, no such step is shown.
  s.steps = stepsFrom(env);
  if (!opts.readOnly && studioDir && s.cgroup)
    await writeJson(CGROUP_FILE(studioDir), {
      path: s.cgroup,
      ...(s.cgroupUnit ? { unit: s.cgroupUnit } : {}),
      at: s.at,
    });
  if (s.oom)
    s.oom.seenAt = await oomSeen(studioDir, s.oom.kills, undefined, { readOnly: !!opts.readOnly });
  s.words = {
    storage: WORDS.storage[s.storage.state],
    memory: s.memory.useOnly ? "In use" : WORDS.memory[s.memory.state],
    cpu: WORDS.cpu[s.cpu.state],
  };
  s.findings = findings(s);
  if (s.platform === "darwin") s.platformNote = MAC_LINE;
  if (opts.fixes === false) s.fixes = [];
  else {
    if (opts.refreshFixes || !fixCache || Date.now() - fixCache.t > FIX_TTL_MS)
      fixCache = { t: Date.now(), v: await listFixes({ env, ...(opts.fixOpts || {}) }) };
    s.fixes = fixCache.v;
    s.fixesAt = new Date(fixCache.t).toISOString();
  }
  return s;
}

async function lookAgain(env, opts) {
  const v = {
    at: new Date().toISOString(),
    ...(await bigFolders({ env, ...(opts.bigOpts || {}) })),
  };
  bigCache = { t: Date.now(), v };
  return v;
}

export async function route(
  url,
  { method = "GET", body = null, env = process.env, opts = {} } = {},
) {
  const p = url.pathname.replace(/\/+$/, "");
  if (method === "GET" || method === "HEAD") {
    if (p === "/api/system/status")
      return [
        200,
        {
          ok: true,
          ...(await status(env, {
            ...opts,
            refreshFixes: url.searchParams.get("fixes") === "refresh",
          })),
        },
      ];
    if (p === "/api/system/big-folders") {
      if (bigCache && Date.now() - bigCache.t < BIG_TTL_MS)
        return [200, { ok: true, ...bigCache.v }];
      return [200, { ok: true, ...(await lookAgain(env, opts)) }];
    }
    return [404, { ok: false, error: "not found" }];
  }
  // A fresh look walks the home folder, so it's a change, not a read: a POST, which only this Studio's own pages may send.
  if (method === "POST" && p === "/api/system/big-folders")
    return [200, { ok: true, ...(await lookAgain(env, opts)) }];
  if (method === "POST" && p === "/api/system/clean") {
    const id = body && typeof body.id === "string" ? body.id : "";
    const r = await clean(id, { env, ...(opts.cleanOpts || {}) });
    if (r.freedBytes != null || r.ok) {
      bigCache = null;
      fixCache = null;
    }
    return [r.ok ? 200 : r.why === "not one of the safe fixes" ? 400 : 409, r];
  }
  return [405, { ok: false, error: "not allowed" }];
}
