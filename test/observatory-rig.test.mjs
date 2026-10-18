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

export function rigProblems({ dir, rig, compose }) {
  const p = [];
  const s = rig.services ?? {};
  if (rig.version !== "0.2") p.push(`rig version is ${rig.version}, expected "0.2"`);
  if (!rig.name) p.push("rig has no name");
  if (s.kind !== "compose") p.push("services.kind must be compose");
  const cf = String(s.compose_file ?? "");
  if (!cf || cf.startsWith("/") || cf.split(/[\\/]/).includes("..")) p.push(`compose_file must be relative and inside the rig directory, got "${cf}"`);
  else if (!fs.existsSync(path.join(dir, cf))) p.push(`compose_file ${cf} does not exist`);
  if (s.project_name !== PROJECT) p.push(`project_name must be ${PROJECT}`);
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

export function composeProblems({ compose, dockerfile }) {
  const p = [];
  const declaredVolumes = new Set(Object.keys(compose.volumes ?? {}));
  for (const [name, svc] of Object.entries(compose.services ?? {})) {
    const image = String(svc.image ?? "");
    if (!image) p.push(`${name}: no image name`);
    if (/:latest$|:main$|^[^:]+$/.test(image)) p.push(`${name}: image "${image}" is not pinned to a version`);
    if (svc.restart !== "unless-stopped") p.push(`${name}: restart must be unless-stopped, got ${svc.restart}`);
    if (!Array.isArray(svc.healthcheck?.test) || !svc.healthcheck.test.length) p.push(`${name}: no healthcheck`);
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
  /^rig env (status|logs) observatory( studio)?$/,
  /^rig watchdog register --policy periodic-reminder$/,
  /^rig (whoami|ps)( --json| --all-hosts)*$/,
];

export function scopeProblems({ role }) {
  const p = [];
  const yours = role.match(/## What is yours([\s\S]*?)\n## /)?.[1] ?? "";
  if (!yours.includes(PROJECT)) p.push("the guidance does not name the app's own Compose project");
  const mayRun = yours.match(/You may run:([\s\S]*)$/)?.[1] ?? "";
  for (const cmd of [...mayRun.matchAll(/`([^`]+)`/g)].map((m) => m[1])) {
    if (!ALLOWED.some((re) => re.test(cmd))) p.push(`the guidance lets the agent run \`${cmd}\``);
  }
  const notYours = role.match(/## What is not yours([\s\S]*?)\n## /)?.[1] ?? "";
  for (const must of ["other Compose project", "rig up", "rig down", "daemon settings", "credentials"]) {
    if (!notYours.includes(must)) p.push(`the guidance does not rule out: ${must}`);
  }
  if (!/stopped on purpose/i.test(role) || !/leave it\s+stopped/i.test(role)) p.push("the guidance does not tell an intentional stop apart from a failure");
  for (const m of role.matchAll(/`docker compose(?! -p openrig-observatory)[^`]*`/g)) p.push(`a docker compose command without the app's project: ${m[0]}`);
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

test("the agent's startup files exist and say where the app is", () => {
  const { agentDir, agent } = loadRig();
  for (const f of agent.startup.files) assert.ok(fs.existsSync(path.join(agentDir, f.path)), `${f.path} is missing`);
  const ctx = fs.readFileSync(path.join(agentDir, "startup/context.md"), "utf8");
  assert.match(ctx, /127\.0\.0\.1:9440\/surfaces\/observatory\.html/);
  assert.match(ctx, /periodic-reminder/);
});

test("the build context sends only the observatory app and provider", () => {
  const ignore = fs.readFileSync(path.join(rigDir, "Dockerfile.dockerignore"), "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  assert.deepEqual(ignore, ["*", "!apps/observatory/**", "!providers/studio-observatory/**"]);
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

test("the rig's restart and healthcheck checks are not decorative", () => {
  assert.ok(planted((r) => { delete r.compose.services.studio.restart; }).some((m) => /restart must be unless-stopped/.test(m)));
  assert.ok(planted((r) => { delete r.compose.services.studio.healthcheck; }).some((m) => /no healthcheck/.test(m)));
  assert.ok(planted((r) => { r.rig.services.compose_file = "../elsewhere.yaml"; }).some((m) => /relative and inside/.test(m)));
});
