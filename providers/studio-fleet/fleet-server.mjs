#!/usr/bin/env node
// Fleet provider — reads which account each box is on and how much of it is left.
//
// READ PATH ONLY. There is deliberately no switch verb yet: rotating an account
// kills sessions and relaunches seats, so it lands behind a dry-run that shows
// the plan and a separate act that commits it. Shipping the read half first
// means the dashboard is useful before anything here can break a box.
//
// Sampling is EXPLICIT. There is no background timer, because a poll spends real
// requests against the very budget it reports — an instrument that quietly
// consumes what it measures is not an instrument. The caller asks.
//
// Usage: node fleet-server.mjs --port <n> --fleet <dir>
//
// ONE bound root, not two knobs. `<dir>/fleet.json` is the declared fleet;
// `<dir>/samples.jsonl` is what we have read from it. They were separate flags
// and that was a latent split: config in one place and its samples in another
// can silently disagree about which fleet you are looking at, and the operator
// has two things to bind correctly instead of one.
//
// It also has to be a ROOT rather than the runtime's state dir. The box list is
// AUTHORED (declared, never discovered — see loadConfig), and the state dir
// lives inside the disposable composed runtime directory. Authored config in a
// disposable location is a file that vanishes on a reset nobody connected to it.
import http from "node:http";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileP = promisify(execFile);
import path from "node:path";
import { probeBox } from "./probe.mjs";
import { appendSample, readSamples, buildView, updateAccountOverride } from "./fleet-state.mjs";

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i > -1 && argv[i + 1] ? argv[i + 1] : d; };
const PORT = Number(arg("--port", 8798));
const FLEET_DIR = arg("--fleet", path.join(process.cwd(), ".fleet"));
const CONFIG = path.join(FLEET_DIR, "fleet.json");
const STORE = FLEET_DIR;

const json = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };

// The fleet is DECLARED, never discovered. Scanning a tailnet for boxes would
// make the dashboard's contents depend on network reachability at boot, so a box
// that was merely asleep would silently vanish from the list. A named list can
// be wrong out loud; a discovered one is wrong quietly.
function loadConfig() {
  if (!fs.existsSync(CONFIG)) return {
    boxes: [], labels: {}, boxLabels: {},
    // Say what is missing AND the shape that fixes it. "No config" alone sends
    // the reader looking for a file whose contents they then have to guess.
    error: `no fleet config at ${CONFIG} — create it as {"boxes":["<ssh-host>"],"labels":{"<org-id>":"<your name for it>"}}`,
  };
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
    return {
      boxes: Array.isArray(c.boxes) ? c.boxes : [],
      labels: c.labels || {},
      boxLabels: c.boxLabels || {},
      operator: c.operator || null,
      error: null,
    };
  } catch (e) { return { boxes: [], labels: {}, boxLabels: {}, error: `fleet config unreadable: ${e.message}` }; }
}


// Operator-supplied facts live beside the samples and never inside them: a typed
// value must never be mistaken for something we measured.
const OVERRIDES = path.join(FLEET_DIR, "overrides.json");
function loadOverrides() {
  try {
    const o = JSON.parse(fs.readFileSync(OVERRIDES, "utf8"));
    return { accounts: o.accounts || {}, assignments: o.assignments || {} };
  } catch { return { accounts: {}, assignments: {} }; }
}
function saveOverrides(o) {
  fs.mkdirSync(FLEET_DIR, { recursive: true });
  fs.writeFileSync(OVERRIDES, JSON.stringify(o, null, 2) + "\n");
}
const readBody = (req) => new Promise((resolve) => {
  let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => resolve(b));
});
function viewNow() {
  const cfg = loadConfig();
  const ov = loadOverrides();
  return { ...buildView({ samples: readSamples(STORE), boxes: cfg.boxes, labels: cfg.labels,
                         boxLabels: cfg.boxLabels, overrides: ov }),
           configError: cfg.error };
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (url.pathname === "/") return json(res, 200, { ok: true, provider: "@openrig/studio-fleet", store: STORE });

    // What we know, without touching anything. Cheap, spends nothing, and is
    // what the surface polls — so opening the dashboard costs no budget.
    if (url.pathname === "/api/fleet/state") {
      return json(res, 200, { ok: true, ...viewNow() });
    }

    // Spend real requests, deliberately, because someone asked. Never on a timer.
    if (url.pathname === "/api/fleet/sample" && req.method === "POST") {
      const cfg = loadConfig();
      if (cfg.error) return json(res, 400, { ok: false, error: cfg.error });
      if (!cfg.boxes.length) return json(res, 400, { ok: false, error: "no boxes declared in the fleet config" });
      const only = url.searchParams.get("host");
      const targets = only ? cfg.boxes.filter((b) => b === only) : cfg.boxes;
      if (!targets.length) return json(res, 404, { ok: false, error: `host not in the fleet config: ${only}` });

      const results = [];
      for (const host of targets) {
        const r = await probeBox(host);
        appendSample(STORE, r);
        results.push(r);
      }
      return json(res, 200, { ok: true, sampled: results.length, spentCalls: results.length, ...viewNow() });
    }

    // WHAT THE OPERATOR KNOWS THAT THE PROBE CANNOT READ. Two facts fall in this
    // category and both are permanent, not stopgaps:
    //
    //   the account's NAME — the credential exposes an opaque org id, and the
    //     human-meaningful identity is the email on the subscription;
    //   the CAPACITY — a live percentage needs a live credential, which an idle
    //     machine does not have, and the provider warns the human directly long
    //     before this dashboard could.
    //
    // So the operator types them, and a measured reading overrides a typed one
    // whenever a measurement actually happens. Typed values are marked as typed
    // rather than blended into readings — a number whose provenance is unknown
    // cannot be trusted at a glance, which is the whole point of the surface.
    if (url.pathname === "/api/fleet/account" && req.method === "POST") {
      const body = JSON.parse(await readBody(req) || "{}");
      const id = String(body.account || "").trim();
      if (!id) return json(res, 400, { ok: false, error: "account id is required" });
      const ov = loadOverrides();
      try { ov.accounts[id] = updateAccountOverride(ov.accounts[id] || {}, body); }
      catch (e) { return json(res, 400, { ok: false, error: String(e.message || e) }); }
      saveOverrides(ov);
      return json(res, 200, { ok: true, ...viewNow() });
    }

    // WHICH ACCOUNT A MACHINE IS ON. This RECORDS the assignment; it does not
    // perform the switch. Saying so plainly matters — a control that looks like
    // it rotated a credential and only wrote a note would be worse than no
    // control at all.
    if (url.pathname === "/api/fleet/assign" && req.method === "POST") {
      const body = JSON.parse(await readBody(req) || "{}");
      const host = String(body.host || "").trim();
      const provider = String(body.provider || "").trim();
      if (!host) return json(res, 400, { ok: false, error: "host is required" });
      if (provider !== "claude" && provider !== "codex") {
        return json(res, 400, { ok: false, error: "provider must be claude or codex" });
      }
      const ov = loadOverrides();
      const cur = ov.assignments[host] || {};
      cur[provider] = String(body.account || "").trim() || undefined;
      cur[provider + "SetAt"] = cur[provider] ? new Date().toISOString() : undefined;
      ov.assignments[host] = cur;
      saveOverrides(ov);
      return json(res, 200, { ok: true, recorded: true, performed: false, ...viewNow() });
    }

    // THE SWITCH. This dispatches the work to an agent; it does not rotate the
    // credential itself, and the response says which of those happened.
    //
    // WHY AN AGENT AND NOT THIS SERVER. The two providers need different things.
    // A Claude switch is close to programmatic — one token file on the machine,
    // and every session picks it up on its next login shell. A Codex switch is
    // per-agent: each running session holds its own copy and has to be restarted
    // individually. Encoding both here would put credential-rotation logic in a
    // dashboard, on every machine, forever. An agent on the target machine already
    // has the reach and the judgement, so the dashboard states the intent and the
    // agent carries it out.
    if (url.pathname === "/api/fleet/switch" && req.method === "POST") {
      const body = JSON.parse(await readBody(req) || "{}");
      const host = String(body.host || "").trim();
      const provider = String(body.provider || "").trim();
      const account = String(body.account || "").trim();
      if (!host || !account) return json(res, 400, { ok: false, error: "host and account are required" });
      if (provider !== "claude" && provider !== "codex") {
        return json(res, 400, { ok: false, error: "provider must be claude or codex" });
      }
      const cfg = loadConfig();
      const seat = cfg.operator || null;
      if (!seat) {
        return json(res, 400, { ok: false,
          error: 'no operator seat declared — add "operator": "<session>" to fleet.json so the request has somewhere to go' });
      }

      // Record the intent FIRST. If the dispatch fails the operator still has a
      // durable note of what was asked for, rather than a button that did nothing.
      const ov = loadOverrides();
      ov.assignments[host] = { ...(ov.assignments[host] || {}),
        [provider]: account, [provider + "SetAt"]: new Date().toISOString(),
        [provider + "Pending"]: true };
      saveOverrides(ov);

      const instruction = [
        `Switch the ${provider} account on ${host} to ${account}.`,
        provider === "claude"
          ? "Claude reads one token file per machine and every session picks it up on its next login shell, so this is a single credential update plus whatever re-auth link the operator needs."
          : "Codex holds a copy per running session, so each agent on that machine has to be restarted individually after the credential changes.",
        "Report back what you actually changed and what still needs the operator.",
      ].join(" ");

      try {
        await execFileP("rig", ["send", seat, instruction]);
        return json(res, 200, { ok: true, dispatchedTo: seat, performed: false, instruction, ...viewNow() });
      } catch (e) {
        return json(res, 502, { ok: false, recorded: true, dispatchedTo: null,
          error: `recorded the intent, but could not reach ${seat}: ${String(e.message || e).split("\n")[0]}` });
      }
    }

    res.writeHead(404); res.end();
  } catch (e) { json(res, 500, { ok: false, error: String(e.message || e) }); }
}).listen(PORT, "127.0.0.1", () => {
  const cfg = loadConfig();
  console.log(`studio-fleet: http://127.0.0.1:${PORT}/  boxes=${cfg.boxes.length}${cfg.error ? ` (${cfg.error})` : ""}`);
  // Say it at boot rather than only in a doc: this provider reaches OUT to boxes
  // and never holds their credentials.
  console.log("studio-fleet: reads usage BY SSHING INTO each box — no account token is ever stored here");
});
