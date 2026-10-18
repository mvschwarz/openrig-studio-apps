// The crash used to test Compose's restart: it must hit the studio process and only that, never
// itself, and must fail loudly when there is nothing to hit. Runs against fake /proc listings; no
// Docker, and nothing is killed.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { pickTarget, listProcesses, ENTRY } = require("../rigs/observatory/p6/kill-studio.cjs");

// What /proc looks like inside the container with `init: true`: init as PID 1, the studio as its
// child, the studio's own children, and the exec'd crash script, whose own text names the entry.
const container = [
  { pid: 1, argv: ["/sbin/docker-init", "--", "node", "tools/studio.mjs", "--port", "9440"] },
  { pid: 7, argv: ["node", "tools/studio.mjs", "--port", "9440"] },
  { pid: 19, argv: ["/usr/local/bin/node", "/studio/sdk/app/serve-studio.mjs", "--port", "40111"] },
  { pid: 23, argv: ["/usr/local/bin/node", "/studio/apps/providers/studio-observatory/observatory-server.mjs", "--port", "40112"] },
  { pid: 41, argv: ["node", "-"] },
];

test("the target is the studio process, not init, its children or the crash script itself", () => {
  // init's arguments name the entry after "--", but init is not node running it.
  const t = pickTarget(container, 41);
  assert.equal(t.pid, 7);
  assert.deepEqual(t.argv, ["node", "tools/studio.mjs", "--port", "9440"]);
});

test("two studio processes are refused rather than guessed between", () => {
  const t = pickTarget([...container, { pid: 50, argv: ["node", "/studio/sdk/tools/studio.mjs"] }], 41);
  assert.match(t.error, /more than one process runs tools\/studio\.mjs \(7, 50\); nothing was killed/);
});

test("the script never picks itself, even when its own command line names the entry", () => {
  // The worst case: this process looks exactly like the studio. Only its own pid keeps it out.
  const self = { pid: 41, argv: ["node", ENTRY] };
  assert.match(pickTarget([self], 41).error, /no process running tools\/studio\.mjs was found; nothing was killed/);
  assert.equal(pickTarget([self, container[1]], 41).pid, 7);
});

test("no studio process is a loud failure, not a silent no-op", () => {
  const t = pickTarget(container.filter((p) => p.pid !== 7 && p.pid !== 1), 41);
  assert.match(t.error, /nothing was killed/);
});

test("it reads a /proc listing, skipping entries it cannot read", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fake-proc-"));
  try {
    for (const p of container) {
      fs.mkdirSync(path.join(root, String(p.pid)));
      fs.writeFileSync(path.join(root, String(p.pid), "cmdline"), p.argv.join("\0") + "\0");
    }
    fs.mkdirSync(path.join(root, "99")); // exited between listing and reading: no cmdline
    fs.mkdirSync(path.join(root, "self"));
    const listed = listProcesses(root);
    assert.deepEqual(listed.map((p) => p.pid).sort((a, b) => a - b), [1, 7, 19, 23, 41]);
    assert.deepEqual(listed.find((p) => p.pid === 7).argv, ["node", "tools/studio.mjs", "--port", "9440"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("run from stdin as documented, with nothing to kill, it exits non-zero and kills nothing", async () => {
  const { spawnSync } = await import("node:child_process");
  const src = fs.readFileSync(new URL("../rigs/observatory/p6/kill-studio.cjs", import.meta.url));
  // On this machine no process runs the studio entry, so the documented invocation must refuse.
  const r = spawnSync(process.execPath, ["-"], { input: src, encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /nothing was killed/);
});

test("it announces the pid before killing, so the line survives the container going down", () => {
  const src = fs.readFileSync(new URL("../rigs/observatory/p6/kill-studio.cjs", import.meta.url), "utf8");
  const announce = src.indexOf("fs.writeSync(1, `killing pid");
  const kill = src.indexOf('process.kill(target.pid, "SIGKILL")');
  assert.ok(announce > 0 && kill > 0 && announce < kill, "the pid is written, synchronously, before the kill");
});
