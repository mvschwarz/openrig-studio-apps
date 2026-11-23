// The local OpenRig, read through its own `rig` command: one JSON answer per call, never a shell.
// Copyright 2026 mvschwarz. Licensed under the Apache License, Version 2.0.
//
// `rig` picks this user's own daemon from its own configuration, so a provider reads the same team the person sees in their
// terminal. Each call is bounded in time and output, and every failure comes back as data with a reason a page can show:
//   no-rig-cli   the rig command isn't installed (or isn't on this provider's PATH)
//   rig-error    it ran and failed, timed out, or didn't answer with JSON
import { execFile } from "node:child_process";

/** -> { ok: true, value } or { ok: false, reason, detail }. */
export function rigJson(args, { timeout = 6000, env = process.env, run = execFile } = {}) {
  return new Promise((resolve) => {
    run("rig", args, { timeout, maxBuffer: 8 * 1024 * 1024, env }, (err, stdout) => {
      if (err?.code === "ENOENT")
        return resolve({
          ok: false,
          reason: "no-rig-cli",
          detail: "the rig command isn't installed on this machine",
        });
      if (err) {
        const outcome = err.killed ? "timed out" : `failed with ${err.code || "an unknown error"}`;
        return resolve({ ok: false, reason: "rig-error", detail: `rig ${args[0]} ${outcome}` });
      }
      try {
        resolve({ ok: true, value: JSON.parse(stdout) });
      } catch {
        resolve({ ok: false, reason: "rig-error", detail: `rig ${args[0]} returned invalid JSON` });
      }
    });
  });
}
