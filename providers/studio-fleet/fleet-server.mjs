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
import path from "node:path";
import { probeBox } from "./probe.mjs";
import { appendSample, readSamples, buildView } from "./fleet-state.mjs";

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
    boxes: [], labels: {},
    // Say what is missing AND the shape that fixes it. "No config" alone sends
    // the reader looking for a file whose contents they then have to guess.
    error: `no fleet config at ${CONFIG} — create it as {"boxes":["<ssh-host>"],"labels":{"<org-id>":"<your name for it>"}}`,
  };
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
    return { boxes: Array.isArray(c.boxes) ? c.boxes : [], labels: c.labels || {}, error: null };
  } catch (e) { return { boxes: [], labels: {}, error: `fleet config unreadable: ${e.message}` }; }
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (url.pathname === "/") return json(res, 200, { ok: true, provider: "@openrig/studio-fleet", store: STORE });

    // What we know, without touching anything. Cheap, spends nothing, and is
    // what the surface polls — so opening the dashboard costs no budget.
    if (url.pathname === "/api/fleet/state") {
      const cfg = loadConfig();
      const view = buildView({ samples: readSamples(STORE), boxes: cfg.boxes, labels: cfg.labels });
      return json(res, 200, { ok: true, ...view, configError: cfg.error });
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
      const view = buildView({ samples: readSamples(STORE), boxes: cfg.boxes, labels: cfg.labels });
      return json(res, 200, { ok: true, sampled: results.length, spentCalls: results.length, ...view });
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
