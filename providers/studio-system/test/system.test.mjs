// Machine provider: readings from fixture /proc and /sys trees, the states and words, the bounded folder read, the safe fixes (with a
// stand-in runner, so nothing is cleaned for real) and the routes. Copyright 2026 mvschwarz. Licensed under the Apache License, Version 2.0.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readSystem,
  findings,
  stateOf,
  pressure,
  cgroupDir,
  ancestors,
  storage,
  WARN,
} from "../lib/read.mjs";
import { bigFolders, clean, listFixes, npmCommand, oomSeen, safeCacheDir } from "../lib/fixes.mjs";
import { route, stepsFrom } from "../system-route.mjs";

const GB = 1e9;
// A Node with nothing around it, for "npm isn't installed" cases. Not "/nowhere/node": its ../lib is /lib, which on a merged-/usr Linux
// is /usr/lib, where a system npm sits, so those cases found the machine's real npm (they passed only on a Mac).
const LONE_NODE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lone-node-")), "bin", "node");
function tree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sys-"));
  for (const [p, v] of Object.entries(files)) {
    const f = path.join(root, p);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, v);
  }
  return root;
}
const disk =
  (usedFraction, inodeFraction = 0.1) =>
  async () => ({
    bsize: 4096,
    blocks: 1e6,
    bfree: 1e6 * (1 - usedFraction),
    bavail: 1e6 * (1 - usedFraction),
    files: 1e5,
    ffree: 1e5 * (1 - inodeFraction),
  });
const CG = "/user.slice/user-1001.slice/ws.slice/ws-studio-apps.service";
const base = (extra = {}) => ({
  "/proc/self/cgroup": `0::${CG}\n`,
  "/proc/meminfo": "MemTotal:       8000000 kB\nMemFree:  100 kB\nMemAvailable:   2000000 kB\n",
  "/proc/loadavg": "0.50 1.00 1.50 2/300 12345\n",
  "/proc/uptime": "270000.12 1000.00\n",
  "/sys/fs/cgroup/user.slice/user-1001.slice/ws.slice/memory.current": String(7.5 * GB),
  "/sys/fs/cgroup/user.slice/user-1001.slice/ws.slice/memory.max": String(8 * GB),
  "/sys/fs/cgroup/user.slice/user-1001.slice/ws.slice/memory.events":
    "low 0\nhigh 0\nmax 3\noom 2\noom_kill 1\n",
  "/sys/fs/cgroup/user.slice/user-1001.slice/ws.slice/cpu.stat": "usage_usec 1000\nuser_usec 500\n",
  "/sys/fs/cgroup/user.slice/user-1001.slice/ws.slice/cpu.max": "200000 100000\n",
  "/sys/fs/cgroup/user.slice/user-1001.slice/ws.slice/memory.pressure":
    "some avg10=30.00 avg60=23.40 avg300=5.00 total=1\nfull avg10=0 avg60=0 avg300=0 total=0\n",
  "/sys/fs/cgroup/user.slice/user-1001.slice/ws.slice/cpu.pressure":
    "some avg10=1.00 avg60=2.00 avg300=1.00 total=1\n",
  "/sys/fs/cgroup/user.slice/user-1001.slice/ws.slice/io.pressure":
    "some avg10=0.00 avg60=0.00 avg300=0.00 total=0\n",
  "/sys/fs/cgroup/user.slice/user-1001.slice/ws.slice/pids.current": "120\n",
  "/sys/fs/cgroup/user.slice/user-1001.slice/ws.slice/pids.max": "max\n",
  ...extra,
});

test("states follow the thresholds: over 80% warns, over 90% is urgent, no reading is unknown", () => {
  assert.equal(stateOf(0.5), "ok");
  assert.equal(stateOf(0.8), "ok");
  assert.equal(stateOf(0.81), "warn");
  assert.equal(stateOf(0.91), "urgent");
  assert.equal(stateOf(null), "unknown");
  assert.equal(stateOf(NaN), "unknown");
});

test("a service's parent slice is the workspace total; a container's root cgroup is read as is", async () => {
  const r1 = tree(base());
  const read = (p) => fs.promises.readFile(path.join(r1, p), "utf8").catch(() => null);
  assert.equal(await cgroupDir(read), "/sys/fs/cgroup/user.slice/user-1001.slice/ws.slice");
  const r2 = tree({ "/proc/self/cgroup": "0::/\n", "/sys/fs/cgroup/memory.current": "100\n" });
  assert.equal(
    await cgroupDir((p) => fs.promises.readFile(path.join(r2, p), "utf8").catch(() => null)),
    "/sys/fs/cgroup",
  );
  const r3 = tree({ "/proc/self/cgroup": "12:memory:/x\n" }); // cgroup v1 only: not read, never guessed
  assert.equal(
    await cgroupDir((p) => fs.promises.readFile(path.join(r3, p), "utf8").catch(() => null)),
    null,
  );
});

test("Linux: memory against the workspace limit, CPU against its CPU limit, pressure, OOM stops and inodes", async () => {
  const root = tree(base());
  const s = await readSystem({
    root,
    platform: "linux",
    home: "/home/w",
    sampleMs: 5,
    statfs: disk(0.5, 0.95),
  });
  assert.equal(s.memory.scope, "workspace");
  assert.equal(s.memory.state, "urgent");
  assert.equal(s.memory.limitBytes, 8 * GB);
  assert.equal(s.cpu.limitCores, 2);
  assert.match(s.cpu.basis, /CPU limit/);
  assert.equal(s.storage.tighter, "inodes");
  assert.equal(s.storage.state, "urgent");
  assert.deepEqual(s.oom, { kills: 1, events: 2 });
  assert.equal(s.pressure.memory.tight, true);
  assert.equal(s.pressure.io.tight, false);
  assert.equal(s.uptimeSeconds, 270000.12);
  const f = findings(s);
  assert.ok(
    f.some(
      (x) =>
        x.title === "Memory is tight." &&
        x.text === "Programs spent 23% of the last minute waiting for memory.",
    ),
  );
  assert.ok(
    !f.some((x) => /stopped for using too much memory/.test(x.title)),
    "an undated stop (counted before anyone looked) is history, not a finding",
  );
  assert.ok(
    !f.some((x) => /disk is slow/.test(x.title)),
    "a pressure that isn't tight stays silent",
  );
});

test("without a memory limit the machine's MemAvailable is used; without a cgroup the note says so", async () => {
  const root = tree(
    base({ "/sys/fs/cgroup/user.slice/user-1001.slice/ws.slice/memory.max": "max\n" }),
  );
  const s = await readSystem({
    root,
    platform: "linux",
    home: "/h",
    sampleMs: 5,
    statfs: disk(0.2),
  });
  assert.equal(s.memory.scope, "machine");
  assert.equal(s.memory.totalBytes, 8000000 * 1024);
  assert.equal(s.memory.availableBytes, 2000000 * 1024);
  assert.equal(s.memory.state, "ok");
  const bare = tree({
    "/proc/self/cgroup": "0::/nope\n",
    "/proc/meminfo": "MemTotal: 100 kB\nMemAvailable: 50 kB\n",
    "/proc/loadavg": "1 1 1 1/1 1\n",
    "/proc/uptime": "10 1\n",
  });
  const b = await readSystem({
    root: bare,
    platform: "linux",
    home: "/h",
    sampleMs: 5,
    statfs: disk(0.2),
  });
  assert.equal(b.oom, null);
  assert.equal(b.pressure, null);
  assert.match(b.notes.join(" "), /couldn't be read/);
  assert.match(b.cpu.basis, /machine load/);
});

test("a disk that can't be read is unknown with why, never 0 or OK", async () => {
  const s = await readSystem({
    root: tree(base()),
    platform: "linux",
    home: "/h",
    sampleMs: 5,
    statfs: async () => {
      throw new Error("EACCES");
    },
  });
  assert.equal(s.storage.state, "unknown");
  assert.ok(s.storage.why);
  assert.equal(s.storage.usedBytes, undefined);
});

test("macOS: storage, memory use and load only; no pressure, limits or OOM", async () => {
  const s = await readSystem({ platform: "darwin", home: "/Users/x", statfs: disk(0.3) });
  assert.equal(s.memory.useOnly, true);
  assert.equal(s.pressure, null);
  assert.equal(s.oom, null);
  assert.equal(s.storage.state, "ok");
  const [code, body] = await route(new URL("http://x/api/system/status"), {
    opts: { platform: "darwin", home: "/Users/x", statfs: disk(0.3), fixes: false },
  });
  assert.equal(code, 200);
  assert.equal(body.words.memory, "In use");
  assert.match(body.platformNote, /On a Mac/);
});

test("pressure lines parse; a missing file is null", () => {
  assert.deepEqual(pressure("some avg10=1.50 avg60=12.00 avg300=0 total=9\n"), {
    avg10: 1.5,
    avg60: 12,
    tight: true,
  });
  assert.equal(pressure(null), null);
  assert.equal(pressure("garbage"), null);
});

test("what's taking space: biggest first, relative to home, project folders marked, slow folders listed as not counted", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "home-"));
  for (const d of ["a", "big", "slow", "work/project/node_modules"])
    fs.mkdirSync(path.join(home, d), { recursive: true });
  const runner = async (bin, args) => {
    const dir = args[args.length - 1],
      depth = args[args.indexOf("-d") + 1];
    if (dir.endsWith("slow")) return { code: -1, stdout: "", stderr: "", timedOut: true };
    if (dir.endsWith("work") && depth === "1")
      return { code: 0, stdout: `9000000\t${dir}/project\n9000001\t${dir}\n`, timedOut: false };
    const kb = { a: 10, big: 5000000, work: 9000001 }[path.basename(dir)] ?? 1;
    return { code: 0, stdout: `${kb}\t${dir}\n`, timedOut: false };
  };
  const r = await bigFolders({
    home,
    runner,
    env: { OPENRIG_PROJECT_DIR: path.join(home, "work/project") },
  });
  assert.equal(r.partial, true);
  assert.deepEqual(r.notCounted, ["slow"]);
  assert.deepEqual(
    r.folders.map((f) => f.path),
    ["work", path.join("work", "project"), "big", "a"],
  );
  assert.equal(r.folders.find((f) => f.path === path.join("work", "project")).inProject, true);
  assert.equal(r.folders.find((f) => f.path === "work").inProject, false);
});

test("safe fixes: only listed ids run, the freed size is the measured change, failures never claim more", async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "bin-"));
  for (const t of ["npm", "python3", "podman"]) {
    fs.writeFileSync(path.join(bin, t), "#!/bin/sh\n", { mode: 0o755 });
  }
  const env = { PATH: bin },
    calls = [];
  let free = 10 * GB;
  const fsStatfs = async () => ({ bsize: 1, bavail: free });
  const ok = async (b, a) => {
    calls.push([path.basename(b), ...a]);
    free += 2 * GB;
    return { code: 0, stdout: "", stderr: "", timedOut: false };
  };
  assert.deepEqual(await clean("rm -rf /", { env, runner: ok, fsStatfs }), {
    ok: false,
    id: "rm -rf /",
    why: "not one of the safe fixes",
    removed: "none",
  });
  const r = await clean("npm", { env, runner: ok, fsStatfs, home: "/h" });
  assert.deepEqual(r, { ok: true, id: "npm", freedBytes: 2 * GB });
  // npm is asked where its cache is first (a cache inside the project or the home is never cleared), then the cleanup runs.
  const runs = () =>
    calls.filter((c) => !(c[1] === "config" || (c[2] === "cache" && c[3] === "dir")));
  assert.deepEqual(runs()[0], [
    "npm",
    "cache",
    "clean",
    "--force",
    "--cache=/h/.npm",
    "--logs-max=0",
  ]);
  await clean("images", { env, runner: ok, fsStatfs, home: "/h" });
  assert.deepEqual(runs()[1], ["podman", "image", "prune", "-f"]);
  const bad = async (b, a) =>
    a[2] === "cache" && a[3] === "dir"
      ? { code: 0, stdout: "/var/cache/pipw\n", stderr: "", timedOut: false }
      : { code: 1, stdout: "", stderr: "permission denied\n", timedOut: false };
  assert.deepEqual(await clean("pip", { env, runner: bad, fsStatfs, home: "/h" }), {
    ok: false,
    id: "pip",
    why: "permission denied",
    freedBytes: 0,
    removed: "unknown",
  });
  assert.deepEqual(
    await clean("npm", {
      env: { PATH: "/nowhere" },
      runner: ok,
      fsStatfs,
      execPath: LONE_NODE,
      home: fs.mkdtempSync(path.join(os.tmpdir(), "home-")),
    }),
    { ok: false, id: "npm", why: "this tool isn't installed here", removed: "none" },
  );
});

test("fixes are listed only when their tool is installed, with what each frees", async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "bin-"));
  fs.writeFileSync(path.join(bin, "npm"), "#!/bin/sh\n", { mode: 0o755 });
  const runner = async (b, a) =>
    a[0] === "config"
      ? { code: 0, stdout: "/c/npm\n" }
      : a[0] === "-x"
        ? { code: 0, stdout: "2048\t/c/npm/_cacache\n" }
        : { code: 1, stdout: "" };
  const list = await listFixes({ env: { PATH: bin }, runner, home: "/h" });
  assert.equal(list.length, 1);
  assert.equal(list[0].id, "npm");
});

test("an out-of-memory stop already there at the first read isn't dated; a later one is", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-"));
  assert.equal(await oomSeen(dir, 2, () => new Date("2026-11-20T01:00:00Z")), null);
  assert.equal(await oomSeen(dir, 2), null);
  assert.equal(
    await oomSeen(dir, 3, () => new Date("2026-11-20T02:00:00Z")),
    "2026-11-20T02:00:00.000Z",
  );
  assert.equal(await oomSeen(dir, 3), "2026-11-20T02:00:00.000Z");
  assert.equal(await oomSeen(dir, 0), null);
});

test("routes: unknown paths 404, other methods 405, a bad clean id 400", async () => {
  assert.equal((await route(new URL("http://x/api/system/nope")))[0], 404);
  assert.equal((await route(new URL("http://x/api/system/status"), { method: "DELETE" }))[0], 405);
  assert.equal(
    (await route(new URL("http://x/api/system/clean"), { method: "POST", body: { id: "x" } }))[0],
    400,
  );
});

test("a fresh look at what's taking space is a POST; a GET answers from the last look", async () => {
  // A GET any page can trigger, so it must not start a walk of the home folder each time it's asked.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "big-route-"));
  fs.mkdirSync(path.join(home, "a"));
  let walks = 0;
  const runner = async (bin, args) => {
    walks++;
    return { code: 0, stdout: `10\t${args[args.length - 1]}\n`, timedOut: false };
  };
  const opts = { bigOpts: { home, runner } };
  const url = (q = "") => new URL(`http://x/api/system/big-folders${q}`);
  assert.equal((await route(url(), { method: "POST", body: {}, opts }))[0], 200);
  const after = walks;
  assert.ok(after > 0, "the POST looked");
  assert.equal((await route(url(), { opts }))[0], 200);
  assert.equal((await route(url("?refresh=1"), { opts }))[0], 200);
  assert.equal(walks, after, "neither GET walked the folders again");
  await route(url(), { method: "POST", body: {}, opts });
  assert.ok(walks > after, "a second POST looks again");
});

test("what's taking space runs the real du with a share of the time that isn't a whole number", async () => {
  // The fair-share split gives each folder a fraction of a millisecond budget; execFile refuses a fraction.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "big-"));
  for (const d of ["a", "b", "c"]) {
    fs.mkdirSync(path.join(home, d));
    fs.writeFileSync(path.join(home, d, "f"), "x".repeat(4096));
  }
  const r = await bigFolders({
    home,
    env: { ...process.env, OPENRIG_PROJECT_DIR: path.join(home, "a") },
    timeoutMs: 3001,
  });
  assert.equal(r.failed, false);
  assert.ok(r.folders.length >= 3, JSON.stringify(r));
  assert.ok(r.folders.some((f) => f.inProject));
});

test("the first stop after the panel's first look is dated: a count of 0 is remembered", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oom0-"));
  assert.equal(await oomSeen(dir, 0), null);
  assert.equal(
    await oomSeen(dir, 1, () => new Date("2026-11-20T03:00:00Z")),
    "2026-11-20T03:00:00.000Z",
  );
});

test("a stop's time is the reader's to format: the finding carries it as `at`, not inside the words", () => {
  const f = findings({
    at: "2026-11-20T04:00:00.000Z",
    oom: { kills: 1, events: 1, seenAt: "2026-11-20T03:00:00.000Z" },
  });
  assert.equal(f[0].at, "2026-11-20T03:00:00.000Z");
  assert.doesNotMatch(f[0].text, /2026/);
});

// Review fixes (S2-S7 and lows).
test("memory in use leaves out the droppable file cache; the effective limit is the smallest on the workspace or an ancestor", async () => {
  const W = "/sys/fs/cgroup/user.slice/user-1001.slice/ws.slice";
  const root = tree(
    base({
      [`${W}/memory.stat`]: `anon 1000\ninactive_file ${4 * GB}\nactive_file 10\n`,
      [`${W}/memory.max`]: "max\n",
      "/sys/fs/cgroup/user.slice/user-1001.slice/memory.max": String(6 * GB),
      "/sys/fs/cgroup/user.slice/user-1001.slice/memory.current": String(7.5 * GB),
      "/sys/fs/cgroup/user.slice/user-1001.slice/memory.stat": `inactive_file ${4 * GB}\n`,
      "/sys/fs/cgroup/user.slice/memory.max": String(16 * GB),
      "/sys/fs/cgroup/user.slice/user-1001.slice/cpu.max": "100000 100000\n",
    }),
  );
  const s = await readSystem({
    root,
    platform: "linux",
    home: "/h",
    sampleMs: 5,
    statfs: disk(0.2),
  });
  assert.equal(s.memory.scope, "workspace");
  assert.equal(s.memory.limitBytes, 6 * GB, "the parent's 6 GB, not the grandparent's 16 GB");
  assert.equal(s.memory.usedBytes, 3.5 * GB, "7.5 GB current minus 4 GB inactive file cache");
  assert.equal(s.memory.state, "ok");
  assert.equal(s.cpu.limitCores, 1, "the smaller CPU limit up the tree");
  assert.deepEqual(ancestors(W), [
    W,
    "/sys/fs/cgroup/user.slice/user-1001.slice",
    "/sys/fs/cgroup/user.slice",
    "/sys/fs/cgroup",
  ]);
});

test("file count speaks only when it sets a worse state than bytes", async () => {
  const s1 = await readSystem({ platform: "darwin", home: "/x", statfs: disk(0.5, 0.6) });
  assert.equal(s1.storage.tighter, "bytes");
  const s2 = await readSystem({ platform: "darwin", home: "/x", statfs: disk(0.5, 0.95) });
  assert.equal(s2.storage.tighter, "inodes");
  assert.equal(s2.storage.state, "urgent");
});

test("an out-of-memory stop is a finding only for a day after it was first seen, and carries its full time", () => {
  const at = "2026-11-20T10:00:00.000Z";
  const base2 = { at: "2026-11-20T12:00:00.000Z", oom: { kills: 2, seenAt: at } };
  assert.equal(findings(base2)[0].at, at);
  assert.equal(
    findings({ ...base2, at: "2026-11-21T10:00:01.000Z" }).length,
    0,
    "older than a day: history",
  );
  assert.equal(
    findings({ ...base2, oom: { kills: 2, seenAt: null } }).length,
    0,
    "undated: history",
  );
});

test("the command reads the provider's record and never writes it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-"));
  assert.equal(await oomSeen(dir, 1, undefined, { readOnly: true }), null);
  assert.equal(
    fs.existsSync(path.join(dir, ".runtime", "system-oom.json")),
    false,
    "read-only writes nothing",
  );
  await oomSeen(dir, 0);
  await oomSeen(dir, 1, () => new Date("2026-11-20T09:00:00Z"));
  assert.equal(await oomSeen(dir, 1, undefined, { readOnly: true }), "2026-11-20T09:00:00.000Z");
  assert.equal(
    await oomSeen(dir, 2, undefined, { readOnly: true }),
    null,
    "a count the provider hasn't seen isn't dated by the command",
  );
});

test("a refused fix always says nothing was removed; a cache folder in the project or the home is never cleared", async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "bin-"));
  fs.writeFileSync(path.join(bin, "python3"), "#!/bin/sh\n", { mode: 0o755 });
  const home = "/home/w",
    env = { PATH: bin, OPENRIG_PROJECT_DIR: "/home/w/work/project" };
  assert.equal(safeCacheDir("/home/w/.cache/pip", { env, home }), true);
  for (const bad of [
    "/home/w",
    "/home/w/work/project",
    "/home/w/work/project/.pip",
    "/home/w/work",
    "relative",
    "/",
  ])
    assert.equal(safeCacheDir(bad, { env, home }), false, bad);
  const intoProject = async (b, a) =>
    a[2] === "cache" && a[3] === "dir"
      ? { code: 0, stdout: "/home/w/work/project/.pip\n" }
      : { code: 0, stdout: "" };
  assert.deepEqual(
    await listFixes({ env, runner: intoProject, home, execPath: LONE_NODE }),
    [],
    "pip into the project isn't offered",
  );
  const r = await clean("pip", {
    env,
    runner: intoProject,
    home,
    fsStatfs: async () => ({ bsize: 1, bavail: 1 }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.removed, "none");
});

test("folders never tried before the deadline say so; ~/Library is left out on a Mac", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "home-"));
  for (const d of ["Library", "a", "b"]) fs.mkdirSync(path.join(home, d));
  let t = 0;
  const now = () => t;
  const runner = async (bin, args) => {
    t += 6000;
    return { code: 0, stdout: `10\t${args[args.length - 1]}\n`, timedOut: false };
  };
  const r = await bigFolders({ home, runner, now, timeoutMs: 5000, platform: "darwin", env: {} });
  assert.deepEqual(r.skipped, ["Library"]);
  assert.ok(!r.folders.some((f) => f.path === "Library"));
  assert.equal(r.partial, true);
  assert.ok(r.notTried.length >= 1, JSON.stringify(r));
});

test("the fix list is kept between status calls and refreshed on request", async () => {
  const { status } = await import("../system-route.mjs");
  let calls = 0;
  const runner = async () => {
    calls++;
    return { code: 1, stdout: "" };
  };
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "bin-"));
  fs.writeFileSync(path.join(bin, "python3"), "#!/bin/sh\n", { mode: 0o755 });
  const opts = {
    platform: "darwin",
    home: "/x",
    statfs: disk(0.2),
    fixOpts: { runner, env: { PATH: bin } },
  };
  await status({}, { ...opts, refreshFixes: true });
  const n = calls;
  await status({}, opts);
  assert.equal(calls, n, "a second status reuses the list");
  await status({}, { ...opts, refreshFixes: true });
  assert.ok(calls > n, "refresh re-reads");
});

test("a limit on the app's own unit (MemoryMax= on its service) is reported on its own, never as the workspace's; the command reads the same unit", async () => {
  const U = `/sys/fs/cgroup${CG}`;
  const files = base({
    [`${U}/memory.max`]: String(3 * GB),
    [`${U}/memory.current`]: String(2 * GB),
    [`${U}/memory.stat`]: `inactive_file ${0.5 * GB}\n`,
    [`${U}/cpu.max`]: "50000 100000\n",
    [`${U}/cpu.stat`]: "usage_usec 10\n",
  });
  const s = await readSystem({
    root: tree(files),
    platform: "linux",
    home: "/h",
    sampleMs: 5,
    statfs: disk(0.2),
  });
  // The provider runs in its own service: a cap there binds that service, not OpenRig or the agents.
  assert.equal(
    s.memory.limitBytes,
    8 * GB,
    "the workspace's limit is the slice's 8 GB, not the service's 3 GB",
  );
  assert.equal(s.cpu.limitCores, 2, "the slice's CPU limit");
  assert.deepEqual(s.unitLimits, { memoryBytes: 3 * GB, cores: 0.5 });
  assert.ok(
    s.notes.some((n) => /own service is limited to 3\.0 GB of memory and 0\.5 cores/.test(n)),
    JSON.stringify(s.notes),
  );
  assert.equal(s.cgroupUnit, CG);
  assert.equal(
    s.cgroup,
    "/user.slice/user-1001.slice/ws.slice",
    "the workspace folder is still the slice",
  );
  // The provider records its unit; the command, run from another cgroup, reads that unit, so both show the same limit.
  const { status } = await import("../system-route.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-")),
    env = { OPENRIG_STUDIO_DIR: dir };
  const opts = { platform: "linux", home: "/h", sampleMs: 5, statfs: disk(0.2), fixes: false };
  await status(env, { ...opts, root: tree(files) });
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(dir, ".runtime", "system-cgroup.json"), "utf8")).unit,
    CG,
  );
  const elsewhere = tree({
    ...files,
    "/proc/self/cgroup": "0::/user.slice/user-1001.slice/session-3.scope\n",
  });
  const c = await status(env, { ...opts, root: elsewhere, readOnly: true });
  assert.equal(c.memory.limitBytes, 8 * GB);
  assert.equal(c.cgroupUnit, CG);
  assert.deepEqual(c.unitLimits, { memoryBytes: 3 * GB, cores: 0.5 });
});

test("the app's own service cap reads in MB under 1 GB", async () => {
  const U = `/sys/fs/cgroup${CG}`;
  const s = await readSystem({
    root: tree(base({ [`${U}/memory.max`]: String(300 * 1e6), [`${U}/memory.current`]: "1000" })),
    platform: "linux",
    home: "/h",
    sampleMs: 5,
    statfs: disk(0.2),
  });
  assert.ok(
    s.notes.some((n) => /limited to 300 MB of memory\./.test(n)),
    JSON.stringify(s.notes),
  );
});

test("a cache folder that's a symlink into the project is refused", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ws-")),
    project = path.join(root, "project"),
    home = path.join(root, "home");
  fs.mkdirSync(path.join(project, "pipcache"), { recursive: true });
  fs.mkdirSync(home);
  fs.symlinkSync(path.join(project, "pipcache"), path.join(home, "cachelink"));
  fs.mkdirSync(path.join(home, "realcache"));
  const env = { OPENRIG_PROJECT_DIR: project };
  assert.equal(
    safeCacheDir(path.join(home, "cachelink"), { env, home }),
    false,
    "a link into the project",
  );
  assert.equal(safeCacheDir(path.join(home, "realcache"), { env, home }), true);
});

test("npm: the folder checked is the folder cleaned (npm_config_cache in any case, else ~/.npm), never one inside the project", async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "bin-"));
  fs.writeFileSync(path.join(bin, "npm"), "#!/bin/sh\n", { mode: 0o755 });
  const calls = [],
    runner = async (b, a) => {
      calls.push(a);
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    };
  const fsStatfs = async () => ({ bsize: 1, bavail: 1 });
  await clean("npm", {
    env: { PATH: bin, NPM_CONFIG_CACHE: "/srv/npmc" },
    runner,
    home: "/home/w",
    fsStatfs,
  });
  assert.deepEqual(calls.at(-1), [
    "cache",
    "clean",
    "--force",
    "--cache=/srv/npmc",
    "--logs-max=0",
  ]);
  assert.ok(
    !calls.some((a) => a[0] === "config"),
    "npm isn't asked for its (protected) cache option",
  );
  const env = {
    PATH: bin,
    npm_config_cache: "/home/w/work/project/.npmc",
    OPENRIG_PROJECT_DIR: "/home/w/work/project",
  };
  const r = await clean("npm", { env, runner, home: "/home/w", fsStatfs });
  assert.equal(r.ok, false);
  assert.equal(r.removed, "none");
  assert.equal(calls.length, 1, "a cache inside the project is never cleaned");
  assert.deepEqual(await listFixes({ env, runner, home: "/home/w" }), [], "nor offered");
});

test("npm runs with this Node when it isn't on PATH: a bundled Node's npm sits beside it, and npm's script needs node on PATH", async () => {
  // A bundled Node: <root>/bin/node and <root>/bin/npm -> ../lib/node_modules/npm/bin/npm-cli.js; PATH has neither.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "node-")),
    cli = path.join(root, "lib", "node_modules", "npm", "bin", "npm-cli.js");
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  fs.writeFileSync(cli, "// npm\n");
  fs.mkdirSync(path.join(root, "bin"));
  fs.writeFileSync(path.join(root, "bin", "node"), "", { mode: 0o755 });
  fs.symlinkSync("../lib/node_modules/npm/bin/npm-cli.js", path.join(root, "bin", "npm"));
  const execPath = path.join(root, "bin", "node"),
    real = fs.realpathSync(cli);
  assert.deepEqual(await npmCommand({ PATH: "/nowhere" }, execPath), [execPath, [real]]);
  fs.unlinkSync(path.join(root, "bin", "npm")); // only lib/node_modules: still found
  assert.deepEqual(await npmCommand({ PATH: "/nowhere" }, execPath), [execPath, [real]]);
  const calls = [],
    runner = async (b, a) => {
      calls.push([b, ...a]);
      return a.includes("-x") || a[0] === "-x"
        ? { code: 0, stdout: "4096\t/x\n" }
        : { code: 0, stdout: "", stderr: "", timedOut: false };
    };
  const list = await listFixes({ env: { PATH: "/nowhere" }, runner, home: "/home/w", execPath });
  assert.equal(list[0]?.id, "npm", "offered although npm isn't on PATH");
  const r = await clean("npm", {
    env: { PATH: "/nowhere" },
    runner,
    home: "/home/w",
    execPath,
    fsStatfs: async () => ({ bsize: 1, bavail: 1 }),
  });
  assert.equal(r.ok, true);
  assert.deepEqual(calls.at(-1), [
    execPath,
    real,
    "cache",
    "clean",
    "--force",
    "--cache=/home/w/.npm",
    "--logs-max=0",
  ]);
  assert.equal(await npmCommand({ PATH: "/nowhere" }, LONE_NODE), null);
});

test("inside a container with its own cgroup namespace ('0::/'), the root it can see is read, and the hidden limit is said plainly", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ns-"));
  const put = (p, v) => {
    fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
    fs.writeFileSync(path.join(root, p), v);
  };
  put("proc/self/cgroup", "0::/\n");
  put("sys/fs/cgroup/memory.current", "1200000000\n");
  put("sys/fs/cgroup/memory.max", "max\n");
  put("sys/fs/cgroup/memory.stat", "inactive_file 200000000\n");
  put("sys/fs/cgroup/cpu.max", "max 100000\n");
  put("sys/fs/cgroup/cpu.stat", "usage_usec 5\n");
  put("proc/loadavg", "0.40 0.60 0.50 1/200 4000\n");
  put("proc/meminfo", "MemTotal: 8000000 kB\nMemAvailable: 5000000 kB\n");
  const s = await readSystem({ root, platform: "linux", home: os.tmpdir(), sampleMs: 5 });
  assert.equal(s.cgroup, "/");
  assert.equal(s.memory.scope, "machine");
  assert.equal(s.memory.workspaceUsedBytes, 1000000000);
  assert.deepEqual(s.notes, [
    "Any limits set from outside this machine can't be seen from here, so memory and CPU show the whole machine.",
  ]);
  assert.equal(
    s.cpu.basis,
    "machine load (5 min) per core",
    "the container's own CPU use isn't called the workspace's",
  );
  put("sys/fs/cgroup/memory.max", "2000000000\n"); // a limit the container itself carries is the workspace's limit, and no note
  const t = await readSystem({ root, platform: "linux", home: os.tmpdir(), sampleMs: 5 });
  assert.equal(t.memory.scope, "workspace");
  assert.equal(t.memory.limitBytes, 2000000000);
  assert.deepEqual(t.notes, []);
});

test("storage: under 1 GB free is at least 'Getting full', whatever the percentage", async () => {
  const fsOf = (bsize, blocks, bfree) => async () => ({
    bsize,
    blocks,
    bfree,
    bavail: bfree,
    files: 0,
    ffree: 0,
  });
  const tight = await storage("/w", fsOf(1000, 4_100_000, 884_000)); // 4.1 GB, 884 MB free: 78% used
  assert.equal(tight.state, "warn");
  assert.equal(tight.lowFree, true);
  assert.ok(tight.fraction < WARN);
  const roomy = await storage("/w", fsOf(1000, 40_000_000, 20_000_000));
  assert.equal(roomy.state, "ok");
  assert.equal(roomy.lowFree, undefined);
  const full = await storage("/w", fsOf(1000, 4_100_000, 100_000)); // already urgent stays urgent
  assert.equal(full.state, "urgent");
  assert.equal(full.lowFree, undefined);
});

test("a process outside its cgroup namespace's root ('0::/../x.service') reads no cgroup: the mounted root is another unit, not the workspace", async () => {
  // The provider reads '0::/../studio.service'; /sys/fs/cgroup is the container's anchor unit (a few MB), and OpenRig and the agents
  // are a sibling service. Nothing visible is the workspace.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "esc-"));
  const put = (p, v) => {
    fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
    fs.writeFileSync(path.join(root, p), v);
  };
  put("proc/self/cgroup", "0::/../studio.service\n");
  put("sys/fs/cgroup/memory.current", "38000000\n");
  put("sys/fs/cgroup/memory.max", "3400000000\n");
  put("sys/fs/cgroup/cpu.stat", "usage_usec 5\n");
  put("studio.service/memory.current", "1\n"); // what a naive join would reach, outside /sys/fs/cgroup
  put("proc/meminfo", "MemTotal: 8000000 kB\nMemAvailable: 5000000 kB\n");
  put("proc/loadavg", "0.40 0.60 0.50 1/200 4000\n");
  const read = async (p) => {
    try {
      return fs.readFileSync(path.join(root, p), "utf8");
    } catch {
      return null;
    }
  };
  assert.equal(await cgroupDir(read), null);
  const s = await readSystem({ root, platform: "linux", home: os.tmpdir(), sampleMs: 5 });
  assert.equal(s.cgroup, null);
  assert.equal(s.memory.scope, "machine");
  assert.equal(s.oom, null);
  assert.equal(s.cpu.basis, "machine load (5 min) per core");
  assert.deepEqual(s.notes, [
    "Any limits set from outside this machine can't be seen from here, so memory and CPU show the whole machine.",
  ]);
});

test("npm on PATH runs as found, by its own name (a mise or Volta shim, or the usual .js symlink); the fallbacks are only for no npm on PATH", async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "shim-")),
    real = path.join(bin, "mise");
  fs.writeFileSync(real, '#!/bin/sh\necho "$(basename "$0")"\n', { mode: 0o755 });
  fs.symlinkSync("mise", path.join(bin, "npm"));
  assert.deepEqual(
    await npmCommand({ PATH: bin }, LONE_NODE),
    [path.join(bin, "npm"), []],
    "a shim is never run by its resolved path",
  );
  const js = fs.mkdtempSync(path.join(os.tmpdir(), "jsnpm-")),
    cli = path.join(js, "cli.js");
  fs.writeFileSync(cli, "// npm\n", { mode: 0o755 });
  fs.symlinkSync("cli.js", path.join(js, "npm"));
  assert.deepEqual(
    await npmCommand({ PATH: js }, LONE_NODE),
    [path.join(js, "npm"), []],
    "a .js npm on PATH runs with the node on PATH",
  );
  // PATH wins over a bundled Node's npm
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "node-"));
  fs.mkdirSync(path.join(root, "bin"));
  fs.writeFileSync(path.join(root, "bin", "npm"), "#!/bin/sh\n", { mode: 0o755 });
  assert.deepEqual(await npmCommand({ PATH: bin }, path.join(root, "bin", "node")), [
    path.join(bin, "npm"),
    [],
  ]);
  // with no npm on PATH, a non-script npm beside this Node runs as found too
  assert.deepEqual(await npmCommand({ PATH: "/nowhere" }, path.join(root, "bin", "node")), [
    path.join(root, "bin", "npm"),
    [],
  ]);
});

test("the 1 GB floor is half the disk on a disk of 2 GB or less, so an empty small disk isn't called full", async () => {
  const fsOf = (bsize, blocks, bfree) => async () => ({
    bsize,
    blocks,
    bfree,
    bavail: bfree,
    files: 0,
    ffree: 0,
  });
  assert.equal((await storage("/w", fsOf(1000, 800_000, 784_000))).state, "ok"); // 800 MB disk, 2% used
  const half = await storage("/w", fsOf(1000, 1_600_000, 700_000)); // 1.6 GB disk, 700 MB free (56%)
  assert.equal(half.state, "warn");
  assert.equal(half.lowFree, true);
});

test("a workspace with a cgroup but no memory limit says why memory is the whole machine; its CPU use is still its own", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nolim-"));
  const put = (p, v) => {
    fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
    fs.writeFileSync(path.join(root, p), v);
  };
  const ws = "sys/fs/cgroup/w.slice";
  put("proc/self/cgroup", "0::/w.slice/apps.service\n");
  put(`${ws}/memory.current`, "5\n");
  put(`${ws}/memory.max`, "max\n");
  put(`${ws}/cpu.stat`, "usage_usec 5\n");
  put("sys/fs/cgroup/memory.max", "max\n");
  put("proc/meminfo", "MemTotal: 8000000 kB\nMemAvailable: 5000000 kB\n");
  const s = await readSystem({ root, platform: "linux", home: os.tmpdir(), sampleMs: 5 });
  assert.equal(s.cgroup, "/w.slice");
  assert.equal(s.memory.scope, "machine");
  assert.deepEqual(s.notes, [
    "This machine has no memory limit of its own, so memory shows the whole machine.",
  ]);
  assert.equal(s.cpu.basis, "this machine's use against the machine's cores");
});

test("no npm here (a standalone Node) but an npm cache left behind: its _cacache folder is offered and removed directly, nothing else", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "home-")),
    cache = path.join(home, ".npm", "_cacache");
  fs.mkdirSync(path.join(cache, "content-v2"), { recursive: true });
  fs.writeFileSync(path.join(cache, "content-v2", "blob"), "x".repeat(4096));
  fs.writeFileSync(path.join(home, ".npm", "keep.txt"), "not the cache");
  const runner = async (b, a) =>
    a.includes("-x") || a[0] === "-x" || a[0] === "-sk"
      ? { code: 0, stdout: "8\t" + cache + "\n" }
      : { code: 0, stdout: "" };
  const env = { PATH: "/nowhere" };
  const list = await listFixes({ env, runner, home, execPath: LONE_NODE });
  assert.equal(list[0]?.id, "npm", "offered without npm");
  const r = await clean("npm", {
    env,
    runner,
    home,
    execPath: LONE_NODE,
    fsStatfs: async () => ({ bsize: 1, bavail: 1 }),
  });
  assert.equal(r.ok, true);
  assert.equal(fs.existsSync(cache), false);
  assert.equal(fs.readFileSync(path.join(home, ".npm", "keep.txt"), "utf8"), "not the cache");
  // once it's gone the row stays with nothing to clear (so the page keeps showing what was freed), and a linked _cacache is never followed
  assert.deepEqual(
    (await listFixes({ env, runner, home, execPath: LONE_NODE })).map((f) => [f.id, f.frees]),
    [["npm", 0]],
  );
  assert.deepEqual(
    await listFixes({
      env: { PATH: "/nowhere" },
      runner,
      home: fs.mkdtempSync(path.join(os.tmpdir(), "home-")),
      execPath: LONE_NODE,
    }),
    [],
    "no npm folder at all: no row",
  );
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "elsewhere-"));
  fs.symlinkSync(elsewhere, cache);
  const linked = await listFixes({ env, runner, home, execPath: LONE_NODE });
  assert.deepEqual(
    linked.map((f) => [f.id, f.blocked, f.frees]),
    [["npm", true, null]],
    "a link shows why, with no button",
  );
  const lr = await clean("npm", {
    env,
    runner,
    home,
    execPath: LONE_NODE,
    fsStatfs: async () => ({ bsize: 1, bavail: 1 }),
  });
  assert.equal(lr.ok, false);
  assert.equal(lr.removed, "none");
  assert.ok(fs.existsSync(elsewhere));
  // a cache inside the project is never removed
  const proj = path.join(home, "work", "project"),
    pc = path.join(proj, ".npmc", "_cacache");
  fs.mkdirSync(pc, { recursive: true });
  const penv = {
    PATH: "/nowhere",
    npm_config_cache: path.join(proj, ".npmc"),
    OPENRIG_PROJECT_DIR: proj,
  };
  assert.deepEqual(await listFixes({ env: penv, runner, home, execPath: LONE_NODE }), []);
  assert.equal(
    (
      await clean("npm", {
        env: penv,
        runner,
        home,
        execPath: LONE_NODE,
        fsStatfs: async () => ({ bsize: 1, bavail: 1 }),
      })
    ).removed,
    "none",
  );
  assert.ok(fs.existsSync(pc));
});

test("a folder swapped for a link between the list and the clear: nothing is removed, and the answer says so", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "home-")),
    cache = path.join(home, ".npm", "_cacache");
  fs.mkdirSync(cache, { recursive: true });
  const env = { PATH: "/nowhere" },
    runner = async () => ({ code: 0, stdout: "" });
  // swap after the command is chosen: clean() picks the direct removal, then the folder becomes a link before it runs
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "elsewhere-"));
  let swapped = false;
  const fsStatfs = async () => {
    if (!swapped) {
      swapped = true;
      fs.rmSync(cache, { recursive: true });
      fs.symlinkSync(elsewhere, cache);
    }
    return { bsize: 1, bavail: 1 };
  };
  const r = await clean("npm", { env, runner, home, execPath: LONE_NODE, fsStatfs });
  assert.equal(r.ok, false);
  assert.equal(r.removed, "none");
  assert.match(r.why, /its cache folder changed/);
  assert.ok(fs.existsSync(elsewhere));
});

test("with no project folder bound, nothing is marked as the project and the home and disk root are still never cleared", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "noproj-"));
  fs.mkdirSync(path.join(home, "work"));
  fs.writeFileSync(path.join(home, "work", "f"), "x".repeat(4096));
  const r = await bigFolders({ home, env: { PATH: process.env.PATH }, timeoutMs: 3000 });
  assert.ok(r.folders.length >= 1);
  assert.ok(r.folders.every((f) => f.inProject === false));
  const env = { PATH: "" };
  assert.equal(safeCacheDir(home, { env, home }), false, "the home itself");
  assert.equal(safeCacheDir("/", { env, home }), false, "the disk root");
  assert.equal(
    safeCacheDir(path.join(home, ".npm"), { env, home }),
    true,
    "a cache inside the home",
  );
  assert.equal(
    safeCacheDir("/home/workspace/work/project/.npm", { env, home }),
    true,
    "no fixed project path is assumed",
  );
});

test("the steps a deployment's people can take come from OPENRIG_SYSTEM_STEPS, and none is assumed", async () => {
  assert.deepEqual(stepsFrom({}), { lead: false });
  assert.deepEqual(stepsFrom({ OPENRIG_SYSTEM_STEPS: "lead" }), { lead: true });
  assert.deepEqual(stepsFrom({ OPENRIG_SYSTEM_STEPS: " other , lead " }), { lead: true });
  assert.deepEqual(stepsFrom({ OPENRIG_SYSTEM_STEPS: "leader" }), { lead: false });
});

test("Machine's page shows a hosted step only when this deployment has it", () => {
  // "Ask your lead" only with status.steps.lead; "Sign in to this machine" only when the refusal says a sign-in would help.
  const page = fs.readFileSync(
    new URL("../../../apps/system/app/system.html", import.meta.url),
    "utf8",
  );
  for (const line of page.split("\n").filter((l) => /ask your lead/i.test(l)))
    assert.match(line, /steps\.lead \?/, line.trim());
  // The sign-in line follows the one check that reads both signs: the provider's signIn, or the front door's 401/marked 403.
  assert.match(
    page,
    /const signIn = j\?\.signIn \|\| r\.status === 401 \|\| \(r\.status === 403 && r\.headers\.has\("x-openrig-front-door"\)\)/,
  );
  for (const line of page.split("\n").filter((l) => /Sign in to this machine/.test(l)))
    assert.match(line, /if \(signIn\)/, line.trim());
  assert.match(
    page,
    /steps = s\.steps \|\| \{\}/,
    "the page takes the steps from the status reply",
  );
});
