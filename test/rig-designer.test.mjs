// Rig Designer's output is a rig OpenRig can start: the spec follows RigSpec 0.2's documented rules, each agent seat gets a
// valid agent folder, and the start commands, run for real by bash against a stand-in `rig`, write those files and call
// `rig up rig.yaml`. The page wires them to its buttons. Copyright 2026 mvschwarz. Licensed under the Apache License, Version 2.0.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const S = await import(
  pathToFileURL(path.join(ROOT, "apps/rig-designer/vendor/rig-designer/spec.mjs"))
);

const DESIGN = {
  rig: "Docs Team",
  summary: 'Writes the docs; says "hi"',
  pods: [
    {
      name: "dev",
      role: "writes the code",
      seats: [
        {
          name: "writer",
          runtime: "Claude",
          model: "claude-opus",
          context: "Read README.md first.\nThen wait.",
          skills: ["tdd", "review"],
        },
        { name: "checker", runtime: "codex" },
      ],
    },
    {
      name: "ops.team",
      role: "",
      seats: [{ name: "Shell 1", runtime: "terminal", model: "ignored" }],
    },
  ],
};

// The checks `rig spec validate` documents for the fields this spec uses (OpenRig's RigSpec reference, "Validation Rules Summary").
function rigSpecProblems(s) {
  const out = [];
  if (s.version !== "0.2") out.push("version");
  if (!s.name) out.push("name");
  if (!Array.isArray(s.pods) || !s.pods.length) out.push("pods");
  const podIds = new Set();
  for (const p of s.pods ?? []) {
    if (!p.id || p.id.includes(".") || podIds.has(p.id)) out.push(`pod id ${p.id}`);
    podIds.add(p.id);
    if (!p.label) out.push(`pod label ${p.id}`);
    if (!p.members?.length) out.push(`pod members ${p.id}`);
    const ids = new Set();
    for (const m of p.members ?? []) {
      if (!m.id || m.id.includes(".") || ids.has(m.id)) out.push(`member id ${m.id}`);
      ids.add(m.id);
      for (const k of ["agent_ref", "profile", "runtime", "cwd"])
        if (!m[k]) out.push(`${p.id}.${m.id} ${k}`);
      if (!["claude-code", "codex", "terminal"].includes(m.runtime))
        out.push(`${p.id}.${m.id} runtime`);
      const terminal = [
        m.runtime === "terminal",
        m.agent_ref === "builtin:terminal",
        m.profile === "none",
      ];
      if (terminal.some(Boolean) && !terminal.every(Boolean))
        out.push(`${p.id}.${m.id} terminal triple`);
      if (m.agent_ref !== "builtin:terminal" && !/^local:(?!\/)(?!.*\.\.)/.test(m.agent_ref))
        out.push(`${p.id}.${m.id} agent_ref`);
    }
    if (!Array.isArray(p.edges)) out.push(`pod edges ${p.id}`);
  }
  if (!Array.isArray(s.edges)) out.push("edges");
  return out;
}

test("the design becomes a RigSpec 0.2 that meets the documented rules: ids without dots, the three runtimes, the terminal triple", () => {
  const spec = S.rigSpec(DESIGN);
  assert.deepEqual(rigSpecProblems(spec), []);
  assert.deepEqual(S.problems(spec), []);
  assert.equal(spec.name, "docs-team");
  assert.deepEqual(
    spec.pods.map((p) => p.id),
    ["dev", "ops-team"],
  );
  assert.deepEqual(
    spec.pods[0].members.map((m) => [m.id, m.runtime, m.agent_ref]),
    [
      ["writer", "claude-code", "local:agents/dev-writer"],
      ["checker", "codex", "local:agents/dev-checker"],
    ],
  );
  assert.deepEqual(spec.pods[1].members[0], {
    id: "shell-1",
    agent_ref: "builtin:terminal",
    profile: "none",
    runtime: "terminal",
    cwd: ".",
    label: "Shell 1",
  });
  assert.equal(spec.pods[1].label, "ops.team", "a pod with no role is labelled by its name");
});

test("names that collide or are empty still give unique, valid ids; an unfinished design says what's missing", () => {
  const spec = S.rigSpec({
    pods: [
      { name: "a", seats: [{ name: "x" }, { name: "X" }, { name: "" }] },
      { name: "A", seats: [] },
    ],
  });
  assert.equal(spec.name, "my-rig");
  assert.deepEqual(
    spec.pods.map((p) => p.id),
    ["a", "a-2"],
  );
  assert.deepEqual(
    spec.pods[0].members.map((m) => m.id),
    ["x", "x-2", "seat3"],
  );
  assert.deepEqual(S.problems(spec), ["Pod a-2 has no seats yet."]);
  assert.deepEqual(S.problems(S.rigSpec({ pods: [] })), ["The rig has no pods yet."]);
});

test("the YAML says exactly the spec, every value quoted so nothing in a name or summary can break it", () => {
  const yaml = S.specYaml(S.rigSpec(DESIGN));
  assert.equal(
    yaml,
    [
      'version: "0.2"',
      'name: "docs-team"',
      'summary: "Writes the docs; says \\"hi\\""',
      "",
      "pods:",
      '  - id: "dev"',
      '    label: "writes the code"',
      "    members:",
      '      - id: "writer"',
      '        agent_ref: "local:agents/dev-writer"',
      '        profile: "default"',
      '        runtime: "claude-code"',
      '        model: "claude-opus"',
      '        cwd: "."',
      '      - id: "checker"',
      '        agent_ref: "local:agents/dev-checker"',
      '        profile: "default"',
      '        runtime: "codex"',
      '        cwd: "."',
      "    edges: []",
      '  - id: "ops-team"',
      '    label: "ops.team"',
      "    members:",
      '      - id: "shell-1"',
      '        label: "Shell 1"',
      '        agent_ref: "builtin:terminal"',
      '        profile: "none"',
      '        runtime: "terminal"',
      '        cwd: "."',
      "    edges: []",
      "",
      "edges: []",
      "",
    ].join("\n"),
  );
});

test("each agent seat gets the smallest valid AgentSpec; its context becomes a startup message, its skills a note", () => {
  const files = S.agentFiles(DESIGN);
  assert.deepEqual(
    files.map((f) => f.path),
    ["agents/dev-writer/agent.yaml", "agents/dev-checker/agent.yaml"],
    "no folder for a terminal seat",
  );
  const impl = files[0].yaml;
  for (const line of [
    'name: "dev-writer"',
    'version: "1.0"',
    "profiles:",
    "  default:",
    "      skills: []",
    "resources: {}",
    "startup:",
    "  files: []",
    "    - type: send_text",
    '      value: "Read README.md first.\\nThen wait."',
    "      phase: after_ready",
    "      idempotent: true",
  ])
    assert.ok(impl.split("\n").includes(line), line);
  assert.match(impl, /^# Skills this seat should have: tdd, review\.$/m);
  assert.ok(files[1].yaml.split("\n").includes("  actions: []"));
});

test("the start commands, run by bash, write rig.yaml and the agent folders exactly, then call `rig up rig.yaml`", () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "designer-")),
    bin = path.join(work, "bin");
  fs.mkdirSync(bin);
  // A stand-in rig: records how it was called and from where. The real one is never run here.
  fs.writeFileSync(
    path.join(bin, "rig"),
    '#!/bin/sh\nprintf "%s\\n" "$PWD" "$@" > "$RIG_CALLS"\n',
    { mode: 0o755 },
  );
  try {
    execFileSync("bash", ["-e", "-c", S.startScript(DESIGN)], {
      cwd: work,
      env: { PATH: `${bin}:/usr/bin:/bin`, RIG_CALLS: path.join(work, "calls") },
    });
    const dir = path.join(work, "docs-team");
    assert.equal(
      fs.readFileSync(path.join(dir, "rig.yaml"), "utf8"),
      S.specYaml(S.rigSpec(DESIGN)),
    );
    for (const f of S.agentFiles(DESIGN))
      assert.equal(fs.readFileSync(path.join(dir, f.path), "utf8"), f.yaml, f.path);
    assert.deepEqual(fs.readFileSync(path.join(work, "calls"), "utf8").trim().split("\n"), [
      fs.realpathSync(dir),
      "up",
      "rig.yaml",
    ]);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test("a seat's skills can't add lines to the start commands: a line break in one stays inside its comment", () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "designer-")),
    bin = path.join(work, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "rig"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const probe = "ok\nAGENT\necho INJECTED > injected.txt\ncat <<'AGENT'";
  const design = {
    rig: "probe",
    pods: [
      {
        name: "dev",
        seats: [{ name: "impl", runtime: "claude-code", skills: [probe, "tidy\r\u2028more"] }],
      },
    ],
  };
  const script = S.startScript(design);
  assert.doesNotMatch(script, /^echo INJECTED/m, "the probe's command is not a line of its own");
  assert.match(
    script,
    /^# Skills this seat should have: ok AGENT echo INJECTED > injected\.txt cat <<'AGENT', tidy more\.$/m,
  );
  try {
    execFileSync("bash", ["-e", "-c", script], {
      cwd: work,
      env: { PATH: `${bin}:/usr/bin:/bin` },
    });
    assert.equal(fs.existsSync(path.join(work, "probe", "injected.txt")), false);
    assert.equal(fs.existsSync(path.join(work, "injected.txt")), false);
    const [file] = S.agentFiles(design);
    assert.equal(fs.readFileSync(path.join(work, "probe", file.path), "utf8"), file.yaml);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test("page: the drive channel builds the design, the panel shows the spec and the start commands, and the buttons use them", async () => {
  const html = fs.readFileSync(path.join(ROOT, "apps/rig-designer/app/rig-designer.html"), "utf8");
  assert.doesNotMatch(html, /build requested|id="build"/, "no button that only prints a note");
  const nodes = {};
  const node = (id) =>
    (nodes[id] ??= {
      id,
      textContent: "",
      innerHTML: "",
      disabled: false,
      children: [],
      querySelectorAll: () => [],
      prepend(c) {
        this.children.unshift(c);
      },
      get lastChild() {
        return this.children.at(-1);
      },
    });
  const copied = [],
    downloads = [],
    polled = [];
  const ctx = vm.createContext({
    document: {
      getElementById: node,
      createElement: (tag) =>
        tag === "a"
          ? {
              click() {
                downloads.push(this.download);
              },
            }
          : { classList: { remove() {} } },
    },
    navigator: { clipboard: { writeText: async (t) => copied.push(t) } },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: (u) => (polled.push(u), new Promise(() => {})),
    setTimeout: () => 0,
    structuredClone,
    URLSearchParams,
    URL: { createObjectURL: () => "blob:x", revokeObjectURL() {} },
    Blob,
    window: {},
  });
  Object.assign(ctx, S);
  const src = html
    .match(/<script type="module">([\s\S]*?)<\/script>/)[1]
    .replace(/^import .*$/m, "");
  vm.runInContext(src, ctx);
  const d = ctx.window.designer;
  assert.deepEqual(
    polled,
    ["/api/drive?surface=rig-designer"],
    "it polls its own drive slot (an unaddressed poll is refused)",
  );
  assert.equal(nodes.start.disabled, true, "nothing to start yet");
  d.apply({ designer: { action: "set-rig", rig: "Docs Team", summary: DESIGN.summary } });
  d.apply({ designer: { action: "add-pod", pod: "dev", role: "writes the code" } });
  d.apply({
    designer: {
      action: "add-seat",
      pod: "dev",
      seat: "writer",
      runtime: "Claude",
      model: "claude-opus",
      context: "Read README.md first.\nThen wait.",
      skills: ["tdd", "review"],
    },
  });
  d.apply({ designer: { action: "add-seat", pod: "dev", seat: "checker", runtime: "codex" } });
  d.apply({
    designer: {
      action: "add-seat",
      pod: "ops.team",
      seat: "Shell 1",
      runtime: "terminal",
      model: "ignored",
    },
  });
  assert.equal(nodes.spec.textContent, S.specYaml(S.rigSpec(DESIGN)));
  assert.equal(nodes.script.textContent, S.startScript(DESIGN));
  assert.equal(nodes.ready.textContent, "Ready to start.");
  assert.equal(nodes.start.disabled, false);
  await nodes.start.onclick();
  assert.deepEqual(copied, [S.startScript(DESIGN)]);
  nodes.save.onclick();
  assert.deepEqual(downloads, ["rig.yaml"]);
});

test("the agent files the start commands write are ones current OpenRig accepts (no removed `hooks` field)", async () => {
  const { agentFiles } = await import("../apps/rig-designer/vendor/rig-designer/spec.mjs");
  const design = {
    rig: "qa",
    summary: "",
    pods: [
      { name: "dev", role: "writes the code", seats: [{ name: "impl", runtime: "claude-code" }] },
    ],
  };
  const files = agentFiles(design);
  const yaml = files.map((f) => f.yaml).join("\n");
  assert.doesNotMatch(
    yaml,
    /^\s*hooks:/m,
    "OpenRig 0.7.21's rig up refuses profiles.default.uses.hooks",
  );
  assert.match(yaml, /^\s*plugins: \[\]/m);
  assert.match(yaml, /description: "impl in the dev pod — writes the code"/);
});
