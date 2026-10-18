// The observatory launch rig: checks that need no Docker and no OpenRig install.
//
// What these pin: the rig is a well-formed OpenRig rig spec whose services block points at a
// relative compose file in this directory; the compose project is pinned (no floating image tags
// or branches), keeps itself running, checks its own health, and stores data only in its own named
// volume, with nothing from the host's home, OpenRig's home, ssh or credentials mounted; and the
// agent's guidance gives it its own Compose project and nothing else to act on.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseYaml } from "./observatory-yaml.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const rigDir = path.resolve(here, "../rigs/observatory");
const PROJECT = "openrig-observatory";

export function loadRig(dir = rigDir) {
  const read = (p) => fs.readFileSync(path.join(dir, p), "utf8");
  const rig = parseYaml(read("rig.yaml"));
  const compose = parseYaml(read(rig.services.compose_file));
  const memberRefs = rig.pods.flatMap((p) => p.members.map((m) => m.agent_ref));
  const agentDir = path.join(dir, memberRefs[0].replace(/^local:/, ""));
  return { dir, rig, compose, dockerfile: read("Dockerfile"), agentDir, agent: parseYaml(fs.readFileSync(path.join(agentDir, "agent.yaml"), "utf8")), role: fs.readFileSync(path.join(agentDir, "guidance/role.md"), "utf8") };
}

// The Fleet Studio rig runs the same shape with its own project, port and provider.
export function rigProblems({ dir, rig, compose }, { project = PROJECT, port = 9440, providerRoute = "/api/observatory/" } = {}) {
  const p = [];
  const s = rig.services ?? {};
  if (rig.version !== "0.2") p.push(`rig version is ${rig.version}, expected "0.2"`);
  if (!rig.name) p.push("rig has no name");
  if (s.kind !== "compose") p.push("services.kind must be compose");
  const cf = String(s.compose_file ?? "");
  if (!cf || cf.startsWith("/") || cf.split(/[\\/]/).includes("..")) p.push(`compose_file must be relative and inside the rig directory, got "${cf}"`);
  else if (!fs.existsSync(path.join(dir, cf))) p.push(`compose_file ${cf} does not exist`);
  if (s.project_name !== project) p.push(`project_name must be ${project}`);
  if (!["down", "leave_running", "down_and_volumes"].includes(s.down_policy)) p.push(`down_policy ${s.down_policy} is not one OpenRig accepts`);
  if (s.down_policy === "down_and_volumes") p.push("down_policy would delete the app's data on every rig down");
  const waits = s.wait_for ?? [];
  if (!waits.length) p.push("wait_for is empty");
  for (const w of waits) {
    const kinds = ["url", "tcp", "service"].filter((k) => w[k] !== undefined);
    if (kinds.length !== 1) p.push(`wait_for entry needs exactly one of url/tcp/service: ${JSON.stringify(w)}`);
    if (w.service !== undefined && (w.condition !== "healthy" || !compose.services?.[w.service])) p.push(`wait_for service ${w.service} must be a compose service with condition healthy`);
  }
  if (!(s.surfaces?.urls ?? []).length) p.push("surfaces.urls names no link for the person");
  // The rig comes up on the studio alone. Provider health is a runtime reading for the agent: waiting on
  // it (the ready verb, or the compose health, which is provider-level) would roll the rig back.
  if (!waits.some((w) => w.url === `http://127.0.0.1:${port}/api/contract`)) p.push(`wait_for must wait for the studio (/api/contract on ${port})`);
  if (waits.some((w) => String(w.url ?? "").includes(providerRoute))) p.push("wait_for must not wait on the provider");
  if (waits.some((w) => w.service !== undefined)) p.push("wait_for must not wait on compose health, which is provider-level");
  const pods = rig.pods ?? [];
  const members = pods.flatMap((pod) => pod.members ?? []);
  if (members.length !== 1) p.push(`expected one agent member, found ${members.length}`);
  for (const m of members) {
    if (!/^local:[^/]/.test(m.agent_ref ?? "")) p.push(`agent_ref must be a relative local: reference, got ${m.agent_ref}`);
    else if (!fs.existsSync(path.join(dir, m.agent_ref.slice(6), "agent.yaml"))) p.push(`agent_ref ${m.agent_ref} has no agent.yaml`);
    for (const k of ["id", "runtime", "profile", "cwd"]) if (!m[k]) p.push(`member is missing ${k}`);
  }
  return p;
}

const CREDENTIALISH = /credential|auth\.json|\.ssh|\.openrig|\.claude|\.codex|docker\.sock|token|secret|password/i;

export function composeProblems({ compose, dockerfile }, { provider = "studio-observatory" } = {}) {
  const p = [];
  const declaredVolumes = new Set(Object.keys(compose.volumes ?? {}));
  for (const [name, svc] of Object.entries(compose.services ?? {})) {
    const image = String(svc.image ?? "");
    if (!image) p.push(`${name}: no image name`);
    if (/:latest$|:main$|^[^:]+$/.test(image)) p.push(`${name}: image "${image}" is not pinned to a version`);
    if (svc.restart !== "unless-stopped") p.push(`${name}: restart must be unless-stopped, got ${svc.restart}`);
    if (!Array.isArray(svc.healthcheck?.test) || !svc.healthcheck.test.length) p.push(`${name}: no healthcheck`);
    // Without an init as PID 1 the studio itself is PID 1, which the kernel protects from signals sent
    // inside the container, so a crash could not be tested and children would not be reaped.
    if (svc.init !== true) p.push(`${name}: init must be true`);
    // Health is the provider's ready verb through the studio's port, not the studio alone.
    if (!(svc.healthcheck?.test ?? []).some((a) => String(a).endsWith(`/providers/${provider}/healthcheck.mjs`))) p.push(`${name}: the healthcheck must run the provider's healthcheck (ready verb through the studio)`);
    if (svc.privileged) p.push(`${name}: privileged`);
    for (const v of svc.volumes ?? []) {
      const source = String(v).split(":")[0];
      if (!declaredVolumes.has(source)) p.push(`${name}: mounts "${source}", which is not one of its own named volumes`);
      if (CREDENTIALISH.test(String(v))) p.push(`${name}: mount "${v}" names a credential or home path`);
    }
    for (const k of Object.keys(svc.environment ?? {})) if (CREDENTIALISH.test(k)) p.push(`${name}: environment passes ${k}`);
    for (const k of Object.keys(svc.env_file ? { env_file: 1 } : {})) p.push(`${name}: ${k} is not allowed (it can carry secrets)`);
  }
  if (!declaredVolumes.size) p.push("no named volume for the app's data");
  const from = dockerfile.match(/^FROM\s+(\S+)/m)?.[1] ?? "";
  if (!/@sha256:[0-9a-f]{64}$/.test(from)) p.push(`Dockerfile base "${from}" is not pinned by digest`);
  if (/:latest\b/.test(from)) p.push("Dockerfile base uses latest");
  const sdk = dockerfile.match(/^ARG SDK_COMMIT=(\S*)/m)?.[1] ?? "";
  if (!/^[0-9a-f]{40}$/.test(sdk)) p.push(`SDK_COMMIT "${sdk}" is not a full commit id`);
  if (!/test "\$\(git -C \/studio\/sdk rev-parse HEAD\)" = "\$SDK_COMMIT"/.test(dockerfile)) p.push("the build does not verify the SDK commit it fetched");
  if (CREDENTIALISH.test(dockerfile.replace(/^#.*$/gm, ""))) p.push("Dockerfile mentions a credential or home path");
  return p;
}

// The commands the agent's guidance says it may run. Anything else in that list is a grant this
// rig does not make.
const ALLOWED = [
  new RegExp(`^docker compose -p ${PROJECT}( (ps|logs|up -d studio|restart studio))?(, .*)?$`),
  /^(ps|logs|up -d studio|restart studio)$/,
  /^docker compose -p openrig-fleet-studio( (ps|logs|up -d studio|restart studio))?(, .*)?$/,
  /^rig env (status|logs) (observatory|fleet-studio)( studio)?$/,
  /^rig watchdog register --policy periodic-reminder$/,
  /^rig (whoami|ps)( --json| --all-hosts)*$/,
];

export function scopeProblems({ role }) {
  const p = [];
  const yours = role.match(/## What is yours([\s\S]*?)\n## /)?.[1] ?? "";
  if (!yours.includes(PROJECT)) p.push("the guidance does not name the app's own Compose project");
  const mayRun = yours.match(/You may run[^:\n]*:([\s\S]*)$/)?.[1] ?? "";
  if (!mayRun.trim()) p.push("the guidance has no list of what the agent may run");
  for (const cmd of [...mayRun.matchAll(/`([^`]+)`/g)].map((m) => m[1])) {
    if (!ALLOWED.some((re) => re.test(cmd))) p.push(`the guidance lets the agent run \`${cmd}\``);
  }
  const notYours = role.match(/## What is not yours([\s\S]*?)\n## /)?.[1] ?? "";
  for (const must of ["other Compose project", "rig up", "rig down", "daemon settings", "credentials",
    "publish or push the app's code upstream", "another rig", "a host service", "the OpenRig daemon", "alert or retention policy",
    "any other\n  team's live stack", "new collector", "credential store", "new upstream API", "control plane"]) {
    if (!notYours.includes(must)) p.push(`the guidance does not rule out: ${must.replace(/\s+/g, " ")}`);
  }

  // Customizing: the app's own code and data only, and the reading rules that go with it.
  const custom = role.match(/## Customizing the Observatory([\s\S]*?)\n## /)?.[1] ?? "";
  if (!custom) p.push("the guidance does not grant customizing the app");
  const OWN = new Set(["apps/observatory/", "providers/studio-observatory/", "observatory-data"]);
  for (const ref of [...custom.matchAll(/`([^`]+)`/g)].map((m) => m[1])) if (!OWN.has(ref)) p.push(`customizing reaches outside the app: \`${ref}\``);
  for (const line of custom.split("\n").filter((l) => /^\s*-/.test(l))) {
    if (/collector|credential store|upstream API|control plane/i.test(line)) p.push(`a customization grant mentions what it must never add: ${line.trim()}`);
  }
  if (!/A customization never adds a new collector, a credential store, a new upstream API or a control\s+plane\./.test(custom)) p.push("the guidance does not say a customization never adds a collector, credential store, upstream API or control plane");
  if (!/Activity is activity\. Do not call it productivity\./.test(role)) p.push("the guidance does not say activity is not productivity");
  if (!/The oversight team defines ceremony and productivity\./.test(role) || !/never make up your own/.test(role)) p.push("the guidance does not leave ceremony and productivity definitions to the oversight team");
  if (/productivity (score|metric|measure) (is|=|means)|define (a |your own )?productivity/i.test(role)) p.push("the guidance has the agent define productivity");

  // The role: a starter operations agent that may grow its own rig, not an Observatory-only role.
  const opening = role.split("\n## ")[0];
  if (!/You are the starter operations agent for this person's OpenRig setup\./.test(opening)) p.push("the role does not open as the starter operations agent");
  if (/Observatory[- ]only|only (job|role|purpose) is the Observatory|you (only|just) run the Observatory|exists (only|just) (to|for) (run|the) (the )?Observatory/i.test(role)) p.push("the role reads as Observatory-only");
  if (!/You may add to and change this rig \(its members, its services and its app data\)/.test(yours)) p.push("the role does not let the agent grow its own rig");
  // Growing its own rig never reaches another one.
  if (!/for another rig, seat or daemon/.test(notYours) || !/change another rig/.test(notYours)) p.push("another rig is not kept out of reach");
  // The intended role is not live permission.
  if (!/It is not, by itself, permission on any particular\s+machine: what you may do on a given machine is what its owner has actually enabled there\./.test(role)) p.push("the role does not separate itself from live permissions");

  // Rotation only once its owner has enabled it; otherwise nothing moves.
  const rotation = role.match(/## Subscription rotation([\s\S]*?)\n## /)?.[1] ?? "";
  if (!/only when its owner has separately enabled it for you/.test(rotation) || !/Unless it has been enabled, you never move seats or accounts\./.test(rotation)) p.push("subscription rotation is not conditional on a separate enablement");
  for (const sentence of role.split(/(?<=\.)\s+/).filter((t) => /rotation/i.test(t))) {
    if (!/only when|only once|enabled|never/i.test(sentence)) p.push(`an unconditional rotation sentence: ${sentence.trim().slice(0, 80)}`);
    if (/Observatory/.test(sentence)) p.push(`rotation is tied to the Observatory: ${sentence.trim().slice(0, 80)}`);
  }
  if (!/stopped on purpose/i.test(role) || !/leave it\s+stopped/i.test(role)) p.push("the guidance does not tell an intentional stop apart from a failure");
  // The path for a provider that is not serving: see unhealthy, read the logs, restart once, report.
  const path = role.match(/studio: running \(unhealthy\)[\s\S]*?logs studio[\s\S]*?restart `studio` once[\s\S]*?say what happened/);
  if (!path) p.push("the guidance does not name the unhealthy -> logs -> restart once -> report path");
  for (const m of role.matchAll(/`docker compose(?! -p openrig-(observatory|fleet-studio)\b)[^`]*`/g)) p.push(`a docker compose command without the app's project: ${m[0]}`);
  return p;
}

test("the rig is a well-formed rig spec with a relative compose file and one agent", () => {
  assert.deepEqual(rigProblems(loadRig()), []);
});

test("the compose project is pinned, keeps itself running, and stores data only in its own volume", () => {
  assert.deepEqual(composeProblems(loadRig()), []);
});

test("the agent may act on its own Compose project only, and tells an intentional stop from a failure", () => {
  assert.deepEqual(scopeProblems(loadRig()), []);
});

test("the agent's startup files exist, and the Observatory rig's own startup says where the app is", () => {
  const { dir, rig, agentDir, agent } = loadRig();
  for (const f of agent.startup.files) assert.ok(fs.existsSync(path.join(agentDir, f.path)), `${f.path} is missing`);
  const general = fs.readFileSync(path.join(agentDir, "startup/context.md"), "utf8");
  // A periodic reminder needs a spec file; the general startup shows the form that works.
  assert.match(general, /rig watchdog register --policy periodic-reminder --spec <file> --target-session <you>\s+--interval-seconds \d+ --registered-by <you>/);
  const member = rig.pods[0].members[0];
  const own = member.startup.files.map((f) => f.path);
  assert.deepEqual(own, ["observatory-startup.md"]);
  const ctx = fs.readFileSync(path.join(dir, own[0]), "utf8");
  assert.match(ctx, /127\.0\.0\.1:9440\/surfaces\/observatory\.html/);
});

test("the build context sends only the observatory app and provider", () => {
  const ignore = fs.readFileSync(path.join(rigDir, "Dockerfile.dockerignore"), "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  assert.deepEqual(ignore, ["*", "!apps/observatory/**", "!providers/studio-observatory/**", "!providers/shared/**"]);
});

// Each check above must actually catch the mistake it exists for.
function planted(edit) {
  const r = loadRig();
  edit(r);
  return [...rigProblems(r), ...composeProblems(r), ...scopeProblems(r)];
}

test("a floating image tag is caught", () => {
  assert.ok(planted((r) => { r.compose.services.studio.image = "openrig-observatory-studio:latest"; }).some((m) => /not pinned/.test(m)));
  assert.ok(planted((r) => { r.dockerfile = r.dockerfile.replace(/^FROM \S+/m, "FROM node:latest"); }).some((m) => /not pinned by digest/.test(m)));
  assert.ok(planted((r) => { r.dockerfile = r.dockerfile.replace(/^ARG SDK_COMMIT=\S+/m, "ARG SDK_COMMIT=main"); }).some((m) => /not a full commit/.test(m)));
});

test("a mount of OpenRig's home or of credentials is caught", () => {
  assert.ok(planted((r) => { r.compose.services.studio.volumes.push("~/.openrig:/openrig:ro"); }).some((m) => /not one of its own named volumes/.test(m)));
  assert.ok(planted((r) => { r.compose.services.studio.volumes.push("/home/someone/.claude/.credentials.json:/creds"); }).some((m) => /credential or home path/.test(m)));
  assert.ok(planted((r) => { r.compose.services.studio.environment.OPENRIG_AUTH_BEARER_TOKEN = "x"; }).some((m) => /environment passes/.test(m)));
});

test("guidance that lets the agent bring down another rig is caught", () => {
  assert.ok(planted((r) => { r.role = r.role.replace("- `rig env status observatory`", "- `rig down other-rig`\n- `rig env status observatory`"); }).some((m) => /lets the agent run `rig down other-rig`/.test(m)));
  assert.ok(planted((r) => { r.role = r.role.replace("- `docker compose -p openrig-observatory ps`", "- `docker compose ps`"); }).some((m) => /lets the agent run|without the app's project/.test(m)));
  assert.ok(planted((r) => { r.role = r.role.replace(/leave it\s+stopped/i, "start it again"); }).some((m) => /intentional stop/.test(m)));
});

test("readiness that only proves the studio is caught", () => {
  assert.ok(planted((r) => { r.compose.services.studio.healthcheck.test = ["CMD", "node", "-e", "fetch('http://127.0.0.1:9440/api/contract')"]; }).some((m) => /provider's healthcheck/.test(m)));
  // ...while the rig's wait stays on the studio alone.
  assert.ok(planted((r) => { r.rig.services.wait_for[0].url = "http://127.0.0.1:9440/api/observatory/ready"; }).some((m) => /must not wait on the provider/.test(m)));
  assert.ok(planted((r) => { r.rig.services.wait_for.push({ service: "studio", condition: "healthy" }); }).some((m) => /compose health/.test(m)));
});

test("guidance without the unhealthy -> logs -> restart once -> report path is caught", () => {
  assert.ok(planted((r) => { r.role = r.role.replace("restart `studio` once if that is the", "restart `studio` if that is the"); }).some((m) => /restart once -> report/.test(m)));
});

test("guidance letting a customization add a collector is caught", () => {
  assert.ok(planted((r) => { r.role = r.role.replace("- `apps/observatory/` (the page)", "- `apps/observatory/` (the page)\n- a new collector for readings the daemon does not serve"); }).some((m) => /mentions what it must never add/.test(m)));
  assert.ok(planted((r) => { r.role = r.role.replace("- add a new collector, a credential store, a new upstream API or a control plane\n", ""); }).some((m) => /rule out: new collector/.test(m)));
});

test("unconditional subscription rotation is caught", () => {
  assert.ok(planted((r) => { r.role = r.role.replace("You may run the subscription-rotation job only when its owner has separately enabled it for you.\nUnless it has been enabled, you never move seats or accounts.", "You may run the subscription-rotation job to balance accounts."); }).some((m) => /not conditional|unconditional rotation/.test(m)));
});

test("guidance in which the agent defines productivity is caught", () => {
  assert.ok(planted((r) => { r.role = r.role.replace("The oversight team defines ceremony and productivity. Show their definitions and readings when they\n  publish them; never make up your own.", "Define a productivity score from activity and queue throughput and show it."); }).some((m) => /oversight team|define productivity/.test(m)));
});

test("customizing outside the app's own files is caught", () => {
  assert.ok(planted((r) => { r.role = r.role.replace("- `providers/studio-observatory/` (the reader behind it)", "- `providers/studio-fleet/` (another provider)"); }).some((m) => /reaches outside the app/.test(m)));
});

test("an Observatory-only role is caught", () => {
  assert.ok(planted((r) => { r.role = r.role.replace("The Observatory is one\napp you may run and shape; your other work does not depend on it.", "You are the Observatory-only agent:\nyou run the Observatory and nothing else."); }).some((m) => /Observatory-only/.test(m)));
});

test("growing its own rig is allowed, and removing that is caught", () => {
  assert.deepEqual(scopeProblems(loadRig()).filter((m) => /grow its own rig/.test(m)), []);
  assert.ok(planted((r) => { r.role = r.role.replace("You may add to and change this rig (its members, its services and its app data)\nas normal, reviewed changes to its own files.", "Leave this rig as it is."); }).some((m) => /grow its own rig/.test(m)));
});

test("removing the line that separates the role from live permissions is caught", () => {
  assert.ok(planted((r) => { r.role = r.role.replace("This describes the role you are built for. It is not, by itself, permission on any particular\nmachine: what you may do on a given machine is what its owner has actually enabled there.\n\n", ""); }).some((m) => /live permissions/.test(m)));
});

test("rotation tied to the Observatory is caught", () => {
  assert.ok(planted((r) => { r.role = r.role.replace("Unless it has been enabled, you never move seats or accounts.", "Unless it has been enabled, you never move seats or accounts. The Observatory needs rotation enabled to work."); }).some((m) => /rotation is tied to the Observatory/.test(m)));
});

test("removing the init is caught", () => {
  assert.ok(planted((r) => { delete r.compose.services.studio.init; }).some((m) => /init must be true/.test(m)));
});

test("the rig's restart and healthcheck checks are not decorative", () => {
  assert.ok(planted((r) => { delete r.compose.services.studio.restart; }).some((m) => /restart must be unless-stopped/.test(m)));
  assert.ok(planted((r) => { delete r.compose.services.studio.healthcheck; }).some((m) => /no healthcheck/.test(m)));
  assert.ok(planted((r) => { r.rig.services.compose_file = "../elsewhere.yaml"; }).some((m) => /relative and inside/.test(m)));
});
