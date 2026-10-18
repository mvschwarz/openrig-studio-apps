// Fleet Studio: the fleet-ops know-how and the launch rig that carries it.
//
// The know-how only helps if any agent can find it by what it is for, and if every command it tells
// an agent to run actually exists with those options. These checks need no daemon: they read the packs,
// the rig and the shared agent's text. A separate hermetic check runs the packs through a real daemon.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseYaml } from "./observatory-yaml.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const rigDir = path.resolve(here, "../rigs/fleet-studio");
const packsDir = path.join(rigDir, "context/fleet-ops");
const agentDir = path.resolve(here, "../rigs/agents/starter-ops");

export function loadPacks(dir = packsDir) {
  return fs.readdirSync(dir).sort().map((name) => {
    const manifestText = fs.readFileSync(path.join(dir, name, "manifest.yaml"), "utf8");
    return { dir: path.join(dir, name), name, manifestText, manifest: parseYaml(manifestText) };
  });
}

// The rules OpenRig's own installer and library apply (name, version, taxonomy, files with path and
// role), plus ours: every pack has a purpose written to be found, and summaries on its files.
const TAXONOMIES = ["world", "lore", "skills", "mission"];
export function packProblems(packs) {
  const p = [];
  for (const { dir, name, manifest: m } of packs) {
    if (!m || typeof m !== "object") { p.push(`${name}: manifest is not a mapping`); continue; }
    if (m.name !== `fleet-ops/${name}`) p.push(`${name}: name must be fleet-ops/${name}, got ${m.name}`);
    if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,31}$/.test(String(m.version ?? ""))) p.push(`${name}: bad version`);
    if (!TAXONOMIES.includes(m.taxonomy)) p.push(`${name}: taxonomy must be one of ${TAXONOMIES.join(", ")}`);
    if (typeof m.purpose !== "string" || m.purpose.length < 40) p.push(`${name}: needs a purpose written for discovery`);
    if (!Array.isArray(m.files) || !m.files.length) p.push(`${name}: no files`);
    for (const f of m.files ?? []) {
      if (!f.path || !f.role) p.push(`${name}: a file needs path and role`);
      else if (!fs.existsSync(path.join(dir, f.path))) p.push(`${name}: ${f.path} is missing`);
      if (!f.summary) p.push(`${name}: ${f.path} has no summary`);
    }
  }
  return p;
}

// What an agent following the shipped router does: list the library and match its moment against
// each entry's purpose. These are the moments the practices exist for.
export const SEARCHES = [
  { words: ["usage limit"], expect: "fleet-ops/recover-a-stranded-seat" },
  { words: ["stranded seat"], expect: "fleet-ops/recover-a-stranded-seat" },
  { words: ["lost its login", "lost login", "login"], expect: "fleet-ops/recover-a-stranded-seat" },
  { words: ["subscription usage"], expect: "fleet-ops/read-usage-honestly" },
  { words: ["resets"], expect: "fleet-ops/read-usage-honestly" },
  { words: ["context"], expect: "fleet-ops/keep-context-healthy" },
  { words: ["compaction"], expect: "fleet-ops/keep-context-healthy" },
];
export function searchProblems(entries) {
  const p = [];
  for (const s of SEARCHES) {
    const hits = entries.filter((e) => s.words.some((w) => String(e.purpose ?? "").toLowerCase().includes(w)));
    if (!hits.some((h) => h.ref === s.expect)) p.push(`searching "${s.words[0]}" does not find ${s.expect}`);
  }
  return p;
}

// Every `rig ...` command the know-how and the agent's text name, with the options checked against
// `rig <command> --help` and the CLI source (see the increment's notes for the cites).
const VERIFIED = {
  "rig ps": ["--nodes", "--json", "--all-hosts", "--hosts"],
  "rig parked": ["--rig", "--json"],
  "rig capture": [],
  "rig send": [],
  "rig provider status": ["--json", "--refresh", "--all-hosts", "--hosts", "--provider"],
  "rig auth status": ["--runtime"],
  "rig seat restart": ["--keep-conversation", "--reason", "--plan", "--json"],
  "rig seat launch": [],
  "rig seat handover": ["--dry-run", "--reason", "--source", "--json"],
  "rig up": ["--existing", "--plan", "--json"],
  "rig grow": [],
  "rig config set": [],
  "rig usage": [],
  "rig health": [],
  "rig compact-plan": ["--rig", "--refresh", "--json"],
  "rig watchdog": [],
  "rig watchdog register": ["--policy", "--spec", "--target-session", "--interval-seconds", "--registered-by", "--threshold-mb", "--threshold-bytes", "--message", "--help"],
  "rig queue": [],
  "rig host pair": [],
  "rig context": [],
  "rig context list": ["--json"],
  "rig context get": [],
  "rig context add": [],
  "rig whoami": ["--json"],
  "rig env status": [],
  "rig env logs": [],
  // Named in the agent's role as things it must not do to another rig or seat.
  "rig down": [],
  "rig seat": [],
};
const ANY_COMMAND_FLAGS = ["--help"];
const COMMAND_NAMES = Object.keys(VERIFIED).sort((a, b) => b.length - a.length);

export function commandProblems(texts) {
  const p = [];
  for (const [file, text] of texts) {
    for (const m of text.matchAll(/`(rig [^`]+)`/g)) {
      const cmd = m[1].replace(/\s+/g, " ");
      if (/<command>/.test(cmd)) continue; // "rig <command> --help" is a pointer, not a command
      const name = COMMAND_NAMES.find((n) => cmd === n || cmd.startsWith(`${n} `));
      if (!name) { p.push(`${file}: \`${cmd}\` is not a verified command`); continue; }
      for (const flag of cmd.match(/(?<=\s|^)--[a-z][a-z-]*/g) ?? []) {
        if (!VERIFIED[name].includes(flag) && !ANY_COMMAND_FLAGS.includes(flag)) p.push(`${file}: \`${name}\` has no verified option ${flag}`);
      }
    }
  }
  return p;
}

const read = (p) => fs.readFileSync(p, "utf8");
const knowHowTexts = () => [
  ...loadPacks().map((pk) => [`${pk.name}/practice.md`, read(path.join(pk.dir, "practice.md"))]),
  ["fleet-studio-startup.md", read(path.join(rigDir, "fleet-studio-startup.md"))],
  ["starter-ops role.md", read(path.join(agentDir, "guidance/role.md"))],
  ["starter-ops startup/context.md", read(path.join(agentDir, "startup/context.md"))],
];

test("each fleet-ops pack is a valid context pack with a purpose written for discovery", () => {
  assert.deepEqual(packProblems(loadPacks()), []);
});

test("a search by purpose finds the right practice", () => {
  const entries = loadPacks().map((pk) => ({ ref: pk.manifest.name, purpose: pk.manifest.purpose }));
  assert.deepEqual(searchProblems(entries), []);
});

test("every command the know-how and the agent's text name exists, with those options", () => {
  assert.deepEqual(commandProblems(knowHowTexts()), []);
});

test("the know-how never prices usage, never measures it with a model request, and leaves moves to their owners", () => {
  for (const [file, text] of knowHowTexts().slice(0, 3)) {
    assert.doesNotMatch(text, /\$\s?\d|\bUSD\b|\bdollars?\b|\bcost of\b/i, `${file} mentions money`);
    assert.doesNotMatch(text, /\/v1\/messages|api\.anthropic\.com|api\.openai\.com|curl\s/i, `${file} measures by a model request`);
    assert.doesNotMatch(text, /`rig provider switch|`rig auth switch/, `${file} gives account-move steps`);
  }
  const usage = read(path.join(packsDir, "read-usage-honestly/practice.md"));
  assert.match(usage, /Sending a model request to "check" usage\./);
  assert.match(usage, /Adding readings from several machines into one total\./);
  assert.match(usage, /Unknown is unknown\./);
});

test("the Fleet Studio rig has one ops seat on the shared agent, no services yet, and the know-how step", () => {
  const rig = parseYaml(read(path.join(rigDir, "rig.yaml")));
  assert.equal(rig.version, "0.2");
  assert.equal(rig.name, "fleet-studio");
  assert.equal(rig.services, undefined, "no services until the app that shows the fleet is chosen");
  const members = rig.pods.flatMap((p) => p.members);
  assert.equal(members.length, 1);
  assert.equal(members[0].agent_ref, "local:../agents/starter-ops");
  assert.ok(fs.existsSync(path.join(rigDir, members[0].agent_ref.slice(6), "agent.yaml")));
  const own = members[0].startup.files.map((f) => f.path);
  assert.deepEqual(own, ["fleet-studio-startup.md"]);
  const startup = read(path.join(rigDir, own[0]));
  for (const pk of loadPacks()) {
    assert.ok(startup.includes(`\`${pk.manifest.name}\``), `the startup step names ${pk.manifest.name}`);
  }
  assert.match(startup, /`rig context add context\/fleet-ops\/<name>`/);
  assert.match(startup, /Add only the ones that are missing/);
  assert.doesNotMatch(read(path.join(rigDir, "rig.yaml")), /openrig-observatory|observatory[./-](compose|startup)|rigs\/observatory/, "Fleet Studio references no Observatory files or project");
});

test("the shared agent names the fleet routes and carries the know-how without owning it", () => {
  const role = read(path.join(agentDir, "guidance/role.md"));
  const routes = role.match(/## Routes you work with([\s\S]*?)\n## /)?.[1] ?? "";
  for (const r of ["rig ps", "rig queue", "rig provider status", "rig auth status", "rig compact-plan", "rig host pair", "rig up", "rig grow", "rig watchdog", "rig context list", "openrig-upgrade"]) {
    assert.ok(routes.includes(r), `the routes name ${r}`);
  }
  assert.match(routes, /`rig up` and `rig grow`: bring up or grow \*\*your own\*\* rig/);
  assert.match(role, /They are not yours alone: any agent on the\s+machine can find and use them the same way\./);
});

// Each check above must catch the mistake it exists for.
test("a missing purpose, a purpose that no search finds, and a broken manifest are caught", () => {
  const packs = loadPacks();
  const noPurpose = packs.map((pk, i) => (i === 0 ? { ...pk, manifest: { ...pk.manifest, purpose: undefined } } : pk));
  assert.ok(packProblems(noPurpose).some((m) => /needs a purpose/.test(m)));
  const vague = packs.map((pk) => ({ ref: pk.manifest.name, purpose: pk.name === "read-usage-honestly" ? "Assorted notes for operators." : pk.manifest.purpose }));
  assert.ok(searchProblems(vague).some((m) => /subscription usage/.test(m)));
  const broken = packs.map((pk, i) => (i === 1 ? { ...pk, manifest: { ...pk.manifest, taxonomy: "notes", files: [{ path: "missing.md" }] } } : pk));
  const bp = packProblems(broken);
  assert.ok(bp.some((m) => /taxonomy/.test(m)) && bp.some((m) => /path and role|missing/.test(m)));
});

test("an invented command or option is caught", () => {
  assert.ok(commandProblems([["x", "run `rig fleet rebalance` now"]]).some((m) => /not a verified command/.test(m)));
  assert.ok(commandProblems([["x", "`rig provider status --everything`"]]).some((m) => /no verified option --everything/.test(m)));
});
