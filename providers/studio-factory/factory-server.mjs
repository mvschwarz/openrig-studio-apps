#!/usr/bin/env node
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

function arg(name, fallback = "") {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const port = Number(arg("--port", "9391"));
const root = path.resolve(arg("--root", process.cwd()));
const store = path.join(root, ".openrig-factory");
const stateFile = path.join(store, "state.json");
const eventsFile = path.join(store, "events.jsonl");
const currentRig = String(process.env.OPENRIG_SESSION_NAME || "").split("@")[1] || "";
fs.mkdirSync(store, { recursive: true });

function json(res, status, value) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}

async function body(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 256_000) throw new Error("request too large");
  }
  return raw ? JSON.parse(raw) : {};
}

function run(args, options = {}) {
  return execFileSync("rig", args, {
    encoding: "utf8",
    timeout: options.timeout ?? 20_000,
    cwd: options.cwd ?? root,
  }).trim();
}

function runJson(args, fallback) {
  try { return JSON.parse(run(args)); } catch { return fallback; }
}

function readState() {
  try { return JSON.parse(fs.readFileSync(stateFile, "utf8")); }
  catch { return { title: "", intent: "", plan: [], selectedRig: currentRig, selectedHost: "local", selectedWorkflow: "linear-build", launch: null }; }
}

function writeState(next) {
  fs.writeFileSync(stateFile, JSON.stringify(next, null, 2) + "\n");
}

function event(type, detail = {}) {
  const rec = { ts: new Date().toISOString(), type, ...detail };
  fs.appendFileSync(eventsFile, JSON.stringify(rec) + "\n");
  return rec;
}

function events() {
  try { return fs.readFileSync(eventsFile, "utf8").trim().split("\n").filter(Boolean).slice(-20).map((line) => JSON.parse(line)); }
  catch { return []; }
}

function topology(host = "local") {
  const rigs = runJson(["ps", ...(host !== "local" ? ["--host", host] : []), "--json"], []);
  const hosts = runJson(["host", "list", "--json"], []);
  const workflows = runJson(["workflow", "specs", "--json"], { specs: [] });
  return {
    rigs: (Array.isArray(rigs) ? rigs : []).filter((r) => !r.isArchived).map((r) => ({
      id: r.rigName || r.name,
      status: r.status,
      lifecycleState: r.lifecycleState,
      nodes: r.nodeCount || 0,
      running: r.runningCount || 0,
    })),
    hosts: [
      { id: "local", transport: "local", status: "reachable", notes: "this box" },
      ...(Array.isArray(hosts) ? hosts : []).map((h) => ({ id: h.id, transport: h.transport, status: h.status, notes: h.notes || "" })),
    ],
    workflows: ((workflows && workflows.specs) || []).map((w) => ({
      id: w.name,
      version: w.version,
      purpose: String(w.purpose || "").trim(),
      targetRig: w.targetRig || null,
    })),
  };
}

function safeSlug(input) {
  return String(input || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 42) || "new-build";
}

function exactRig(rigs, id) {
  return rigs.find((rig) => rig.id === id) || null;
}

function proofItems() {
  const state = readState();
  const dir = state.launch?.sliceDir;
  if (!dir) return [];
  const sources = ["FACTORY-BRIEF.md", "README.md", "IMPLEMENTATION-PRD.md", "PROGRESS.md"];
  const seen = new Set();
  const items = [];
  for (const file of sources) {
    const full = path.join(dir, file);
    let lines = [];
    try { lines = fs.readFileSync(full, "utf8").split("\n"); } catch { continue; }
    lines.forEach((line, index) => {
      const hit = line.match(/^\s*-\s*\[([ xX])\]\s+(.+)$/);
      if (!hit || /^\[/.test(hit[2]) || seen.has(hit[2])) return;
      seen.add(hit[2]);
      items.push({ id: `proof-${items.length + 1}`, text: hit[2], delivered: hit[1].toLowerCase() === "x", source: `${file}:${index + 1}` });
    });
  }
  const approvals = state.proofApprovals || {};
  return items.map((item) => ({ ...item, approved: Boolean(approvals[item.id]), approval: approvals[item.id] || null }));
}

function chooseLead(rig, host = "local", preferred = "") {
  const nodes = runJson(["ps", "--nodes", "--rig", rig, ...(host !== "local" ? ["--host", host] : []), "--json"], []);
  const rows = Array.isArray(nodes) ? nodes : [];
  const requested = rows.find((n) => n.sessionName === preferred || n.canonicalSessionName === preferred);
  if (requested) return requested.sessionName || requested.canonicalSessionName;
  const hit = rows.find((n) => /(^|\.)(orch|lead|manager)(\.|$)/i.test(n.logicalId || "")) || rows.find((n) => /lead|orch/i.test(n.sessionName || "")) || rows[0];
  return hit?.sessionName || hit?.canonicalSessionName || null;
}

function plannedCommands(input, target, mission, slice, lead) {
  const commands = [];
  if (!target || target.status === "stopped") {
    commands.push(["rig", "up", input.rig, "--existing", "--yes", ...(input.host !== "local" ? ["--host", input.host] : [])]);
  }
  if (input.host === "local") {
    commands.push(["rig", "scope", "mission", "create", mission, "--title", input.title]);
    commands.push(["rig", "scope", "slice", "create", mission, slice, "--template", "release-feature", "--title", input.title]);
  }
  if (lead) commands.push(["rig", "queue", "create", "--destination", lead, ...(input.host !== "local" ? ["--host", input.host] : []), "--summary", `Factory kickoff: ${input.title}`]);
  return commands;
}

async function kickoff(input) {
  const title = String(input.title || "").trim().slice(0, 100);
  const intent = String(input.intent || "").trim().slice(0, 12_000);
  const plan = Array.isArray(input.plan) ? input.plan.slice(0, 12).map((x) => String(x).trim().slice(0, 300)).filter(Boolean) : [];
  const host = String(input.host || "local");
  const workflow = String(input.workflow || "linear-build");
  if (!title || !intent) throw new Error("title and intent are required");

  const top = topology(host);
  const rig = String(input.rig || currentRig || top.rigs.find((row) => row.id !== "kernel" && row.status !== "stopped")?.id || "");
  if (!rig) throw new Error("no target rig is available on this host");
  const target = exactRig(top.rigs, rig);
  const preferredLead = String(input.lead || "");
  const lead = target && target.status !== "stopped" ? chooseLead(rig, host, preferredLead) : null;
  const stamp = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const slug = safeSlug(title);
  const mission = `factory-${stamp}-${slug}`;
  const slice = slug;
  const commands = plannedCommands({ title, intent, plan, rig, host, workflow }, target, mission, slice, lead);
  if (input.dryRun) return { ok: true, dryRun: true, mission, slice, lead, commands };

  if (!target || target.status === "stopped") {
    const upArgs = ["up", rig, "--existing", "--yes", "--json"];
    if (host !== "local") upArgs.push("--host", host);
    run(upArgs, { timeout: 120_000 });
  }

  let missionCreated = false;
  const missionDir = path.join(root, "missions", mission);
  if (host === "local" && !fs.existsSync(missionDir)) {
    run(["scope", "mission", "create", mission, "--title", title, "--json"]);
    missionCreated = true;
  }
  const created = host === "local"
    ? runJson(["scope", "slice", "create", mission, slice, "--template", "release-feature", "--title", title, "--json"], null)
    : { remote: true };
  if (!created) throw new Error("scope creation returned no JSON");
  const slicesRoot = path.join(missionDir, "slices");
  const sliceDirName = host === "local" ? (fs.readdirSync(slicesRoot).find((name) => name === slice || name.endsWith(`-${slug}`)) || slice) : slice;
  const sliceDir = host === "local" ? path.join(slicesRoot, sliceDirName) : null;
  const brief = [
    `# ${title}`,
    "",
    `_Launched by OpenRig Studio Factory · ${new Date().toISOString()}_`,
    "",
    "## Intent",
    "",
    intent,
    "",
    "## Build plan",
    "",
    ...(plan.length ? plan.map((step) => `- [ ] ${step}`) : ["- [ ] Shape the smallest working implementation from the intent."]),
    "",
    "## Machine",
    "",
    `- rig: ${rig}`,
    `- host: ${host}`,
    `- workflow: ${workflow}`,
    "",
  ].join("\n");
  if (sliceDir) fs.writeFileSync(path.join(sliceDir, "FACTORY-BRIEF.md"), brief);

  const actualLead = lead || chooseLead(rig, host, preferredLead);
  if (!actualLead) throw new Error(`rig ${rig} has no addressable seat`);
  const qbody = [
    `FACTORY KICKOFF — ${title}`,
    sliceDir ? `Intent and plan: ${path.join(sliceDir, "FACTORY-BRIEF.md")}` : `Create mission ${mission} and slice ${slice} on THIS host from the intent below.`,
    `Workflow: ${workflow}. Host: ${host}. Rig: ${rig}.`,
    !sliceDir ? `INTENT:\n${intent}\n\nPLAN:\n${plan.map((step) => `- ${step}`).join("\n")}` : "",
    "Read the slice, onboard the relevant seats, and start the smallest working build now. Keep proof on the observable outcomes in the brief.",
  ].join("\n\n");
  const qargs = [
    "queue", "create", "--source", `factory-ui@${rig}`, "--destination", actualLead,
    "--priority", "urgent", "--tier", "fast", "--mission", mission, "--slice", slice,
    "--summary", `Factory kickoff: ${title}`, "--body", qbody,
    ...(sliceDir ? ["--evidence-ref", path.join(sliceDir, "PROOF.md")] : []),
    ...(host !== "local" ? ["--host", host] : []), "--json",
  ];
  const q = runJson(qargs, null);
  if (!q) throw new Error("queue handoff returned no JSON");

  const launch = {
    ts: new Date().toISOString(), title, intent, plan, rig, host, workflow,
    mission, slice: sliceDirName, sliceDir, lead: actualLead,
    qitemId: q.qitemId || q.id || null, missionCreated,
  };
  const current = readState();
  writeState({ ...current, title, intent, plan, selectedRig: rig, selectedHost: host, selectedWorkflow: workflow, launch });
  event("kickoff", { mission, slice: sliceDirName, rig, host, workflow, lead: actualLead, qitemId: launch.qitemId });
  return { ok: true, launch, commands };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  try {
    if (req.method === "GET" && url.pathname === "/api/software-factory/state") {
      const selectedHost = url.searchParams.get("host") || readState().selectedHost || "local";
      return json(res, 200, { ok: true, project: readState(), ...topology(selectedHost), catalogHost: selectedHost, events: events(), generatedAt: new Date().toISOString() });
    }
    if (req.method === "POST" && url.pathname === "/api/software-factory/intent") {
      const input = await body(req);
      const current = readState();
      const next = {
        ...current,
        title: String(input.title ?? current.title ?? "").slice(0, 100),
        intent: String(input.intent ?? current.intent ?? "").slice(0, 12_000),
        plan: Array.isArray(input.plan) ? input.plan.slice(0, 12).map(String) : current.plan,
        selectedRig: String(input.rig ?? current.selectedRig ?? currentRig),
        selectedHost: String(input.host ?? current.selectedHost ?? "local"),
        selectedWorkflow: String(input.workflow ?? current.selectedWorkflow ?? "linear-build"),
      };
      writeState(next);
      event("intent", { title: next.title, planSteps: next.plan.length });
      return json(res, 200, { ok: true, project: next });
    }
    if (req.method === "POST" && url.pathname === "/api/software-factory/kickoff") {
      return json(res, 200, await kickoff(await body(req)));
    }
    if (req.method === "GET" && url.pathname === "/api/software-factory/proof") {
      return json(res, 200, { ok: true, items: proofItems() });
    }
    if (req.method === "POST" && url.pathname === "/api/software-factory/proof") {
      const input = await body(req);
      const current = readState();
      if (!current.launch) throw new Error("nothing has been launched yet");
      const available = proofItems();
      const ids = input.op === "approve-all"
        ? available.filter((item) => item.delivered).map((item) => item.id)
        : [String(input.id || "")].filter((id) => available.some((item) => item.id === id && item.delivered));
      if (!ids.length) throw new Error("only delivered proof can be approved");
      const proofApprovals = { ...(current.proofApprovals || {}) };
      const ts = new Date().toISOString();
      ids.forEach((id) => { proofApprovals[id] = { ts, actor: String(input.actor || "founder-ui") }; });
      writeState({ ...current, proofApprovals });
      event("proof-approved", { ids, actor: String(input.actor || "founder-ui") });
      const allDelivered = available.length > 0 && available.every((item) => item.delivered && proofApprovals[item.id]);
      const note = allDelivered
        ? `ALL DELIVERED PROOF APPROVED for ${current.launch.title}. Continue to the next unblocked step.`
        : `PROOF APPROVED for ${current.launch.title}: ${ids.join(", ")}. Continue any work this approval unblocks.`;
      run(["send", current.launch.lead, note]);
      return json(res, 200, { ok: true, ids, allDelivered, items: proofItems() });
    }
    return json(res, 404, { ok: false, error: `no factory route ${req.method} ${url.pathname}` });
  } catch (error) {
    event("error", { message: String(error.message || error) });
    return json(res, 400, { ok: false, error: String(error.message || error).split("\n")[0] });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`studio-factory on 127.0.0.1:${port} · root ${root}`);
});
