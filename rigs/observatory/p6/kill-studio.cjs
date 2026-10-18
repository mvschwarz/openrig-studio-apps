// Crash the Observatory's studio process from inside its container, for testing that Compose
// restarts it.
//
//   docker compose -p openrig-observatory -f rigs/observatory/observatory.compose.yaml \
//     exec -T studio node - < rigs/observatory/p6/kill-studio.cjs
//
// With `init: true` the container's PID 1 is Docker's init, and the studio (`node tools/studio.mjs`)
// is its child, so a SIGKILL to the studio is a real crash: init exits with the studio's status, the
// container exits non-zero, and `restart: unless-stopped` starts it again. (A signal sent from inside
// the container to PID 1 itself is ignored by the kernel unless PID 1 handles it, and `docker stop` or
// `docker kill` mark the container as stopped on purpose, so none of those test a crash.)
//
// It finds the process by its arguments in /proc, never kills itself, prints the pid it killed, and
// exits non-zero if nothing matched, so a no-op is never mistaken for a crash. No ps or pgrep needed.
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const ENTRY = "tools/studio.mjs";

function listProcesses(procRoot = "/proc") {
  const out = [];
  for (const name of fs.readdirSync(procRoot)) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const raw = fs.readFileSync(path.join(procRoot, name, "cmdline"), "utf8");
      out.push({ pid: Number(name), argv: raw.split("\0").filter(Boolean) });
    } catch {
      // The process exited while we were looking, or is not ours to read.
    }
  }
  return out;
}

// The studio is a node process whose script argument (its first argument that is not an option) is
// the studio entry. Docker's init also carries the studio's command line in its own arguments, and
// this script's text names the entry, so matching anywhere in a command line would pick them too.
function scriptOf(argv) {
  if (path.basename(argv[0] ?? "") !== "node") return null;
  return argv.slice(1).find((a) => !a.startsWith("-")) ?? null;
}

function pickTarget(processes, selfPid) {
  const matches = processes.filter((p) => {
    const script = p.pid !== selfPid ? scriptOf(p.argv) : null;
    return script === ENTRY || (script !== null && script.endsWith(`/${ENTRY}`));
  });
  if (matches.length === 0) return { error: `no process running ${ENTRY} was found; nothing was killed` };
  if (matches.length > 1) return { error: `more than one process runs ${ENTRY} (${matches.map((m) => m.pid).join(", ")}); nothing was killed` };
  return { pid: matches[0].pid, argv: matches[0].argv };
}

function main() {
  const target = pickTarget(listProcesses(), process.pid);
  if (target.error) {
    console.error(target.error);
    process.exit(2);
  }
  process.kill(target.pid, "SIGKILL");
  console.log(`killed pid ${target.pid}: ${target.argv.join(" ")}`);
}

module.exports = { pickTarget, listProcesses, ENTRY };
if (module.id === "[stdin]" || require.main === module) main();
