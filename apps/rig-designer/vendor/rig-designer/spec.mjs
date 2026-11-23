// Rig Designer's output: a design (pods and seats, as an agent drives them in) turned into an OpenRig rig spec, the agent
// folders it points at, and the commands that start it. Pure, so the page and the tests share one implementation.
// Copyright 2026 mvschwarz. Licensed under the Apache License, Version 2.0.
//
// The spec follows OpenRig's RigSpec 0.2 (pods of members, each with an id, agent_ref, profile, runtime and cwd). Every seat that
// runs an agent gets its own agent folder, agents/<pod>-<seat>/agent.yaml, with the smallest valid AgentSpec; a seat's context
// becomes a startup message it receives once it's ready. A seat whose runtime is a terminal (or a person) is a plain terminal
// node, which needs no agent folder.

export const RUNTIMES = ["claude-code", "codex", "terminal"];

/** An id OpenRig accepts in a session name: lowercase letters, digits and dashes, no dots. */
export function idOf(name, fallback = "x") {
  const id = String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return id || fallback;
}

/** The free-text runtime a driver gave ("Claude", "codex", "human") as one OpenRig runtime. Unset is claude-code. */
export function runtimeOf(text) {
  const s = String(text ?? "");
  if (/codex/i.test(s)) return "codex";
  if (/terminal|shell|human|person|operator/i.test(s)) return "terminal";
  return "claude-code";
}

const unique = (ids) => {
  const seen = new Map();
  return ids.map((id) => {
    const n = (seen.get(id) || 0) + 1;
    seen.set(id, n);
    return n === 1 ? id : `${id}-${n}`;
  });
};

/** design = { rig, summary, pods: [{ name, role, seats: [{ name, runtime, model, context, skills }] }] } -> the RigSpec object. */
export function rigSpec(design) {
  const pods = design?.pods ?? [];
  const podIds = unique(pods.map((p, i) => idOf(p.name, `pod${i + 1}`)));
  const spec = { version: "0.2", name: idOf(design?.rig, "my-rig") };
  if (design?.summary) spec.summary = String(design.summary);
  spec.pods = pods.map((p, i) => {
    const seats = p.seats ?? [];
    const memberIds = unique(seats.map((s, j) => idOf(s.name, `seat${j + 1}`)));
    return {
      id: podIds[i],
      label: String(p.role || p.name || podIds[i]),
      members: seats.map((s, j) => {
        const runtime = runtimeOf(s.runtime);
        const m =
          runtime === "terminal"
            ? {
                id: memberIds[j],
                agent_ref: "builtin:terminal",
                profile: "none",
                runtime,
                cwd: ".",
              }
            : {
                id: memberIds[j],
                agent_ref: `local:agents/${podIds[i]}-${memberIds[j]}`,
                profile: "default",
                runtime,
                cwd: ".",
              };
        if (s.name && String(s.name) !== memberIds[j]) m.label = String(s.name);
        if (s.model && runtime !== "terminal") m.model = String(s.model);
        return m;
      }),
      edges: [],
    };
  });
  spec.edges = [];
  return spec;
}

/** What would stop `rig up` from taking this spec, in plain words (OpenRig's documented validation rules). [] when it's ready. */
export function problems(spec) {
  const out = [];
  if (!spec.pods.length) out.push("The rig has no pods yet.");
  for (const p of spec.pods) if (!p.members.length) out.push(`Pod ${p.id} has no seats yet.`);
  const ids = new Set();
  for (const p of spec.pods) {
    if (ids.has(p.id)) out.push(`Two pods are both called ${p.id}.`);
    ids.add(p.id);
    for (const m of p.members) {
      if (!RUNTIMES.includes(m.runtime)) out.push(`${p.id}.${m.id} has an unknown runtime.`);
      if (/\./.test(m.id) || /\./.test(p.id)) out.push(`${p.id}.${m.id}: ids can't contain dots.`);
    }
  }
  return out;
}

// YAML scalars are written as JSON strings, which YAML reads unchanged, so no value can break the document's structure.
const q = (v) => JSON.stringify(String(v));
// Text that goes into a YAML comment stays on that one line: a line break would end the comment, and in the start script it
// would put the rest of the text on a line of its own (a here-document delimiter, or a command once that ends the file).
const oneLine = (v) =>
  String(v)
    // eslint-disable-next-line no-control-regex -- control characters are exactly what this removes
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ")
    .trim();

/** The RigSpec as YAML, in the field order OpenRig's own examples use. */
export function specYaml(spec) {
  const out = [`version: ${q(spec.version)}`, `name: ${q(spec.name)}`];
  if (spec.summary) out.push(`summary: ${q(spec.summary)}`);
  out.push("", spec.pods.length ? "pods:" : "pods: []");
  for (const p of spec.pods) {
    out.push(
      `  - id: ${q(p.id)}`,
      `    label: ${q(p.label)}`,
      p.members.length ? "    members:" : "    members: []",
    );
    for (const m of p.members) {
      out.push(`      - id: ${q(m.id)}`);
      for (const k of ["label", "agent_ref", "profile", "runtime", "model", "cwd"])
        if (m[k] != null) out.push(`        ${k}: ${q(m[k])}`);
    }
    out.push("    edges: []");
  }
  out.push("", "edges: []");
  return out.join("\n") + "\n";
}

/** The agent folders the spec points at: [{ path, yaml }], one per seat that runs an agent. */
export function agentFiles(design, spec = rigSpec(design)) {
  const files = [];
  spec.pods.forEach((p, i) =>
    p.members.forEach((m, j) => {
      if (m.runtime === "terminal") return;
      const seat = design.pods[i].seats[j];
      const lines = [
        `name: ${q(`${p.id}-${m.id}`)}`,
        `version: "1.0"`,
        `description: ${q(`${m.label || m.id} in the ${p.id} pod${p.label && p.label !== p.id ? ` — ${p.label}` : ""}`)}`,
      ];
      const skills = []
        .concat(seat.skills ?? [])
        .filter(Boolean)
        .map(oneLine)
        .filter(Boolean);
      if (skills.length) lines.push(`# Skills this seat should have: ${skills.join(", ")}.`);
      lines.push(
        "",
        "profiles:",
        "  default:",
        "    uses:",
        "      skills: []",
        "      guidance: []",
        "      subagents: []",
        // OpenRig 0.7.21 refuses `hooks` here ("removed in plugin-primitive"); plugins are the current field.
        "      plugins: []",
        "      runtime_resources: []",
        "",
        "resources: {}",
        "",
        "startup:",
        "  files: []",
      );
      if (seat.context)
        lines.push(
          "  actions:",
          "    - type: send_text",
          `      value: ${q(seat.context)}`,
          "      phase: after_ready",
          "      idempotent: true",
        );
      else lines.push("  actions: []");
      files.push({ path: `agents/${p.id}-${m.id}/agent.yaml`, yaml: lines.join("\n") + "\n" });
    }),
  );
  return files;
}

/**
 * Shell commands that write the rig into a new folder named after it and start it with `rig up`. Each file goes in with a
 * quoted here-document, so nothing in it is expanded; no line of the YAML can equal a delimiter, because every line is
 * indented or starts with a key.
 */
export function startScript(design) {
  const spec = rigSpec(design);
  const lines = [
    `# Starts the rig "${spec.name}" with OpenRig. Paste into a terminal where you want its folder.`,
    `mkdir -p ${spec.name} && cd ${spec.name}`,
    "cat > rig.yaml <<'RIG'",
    specYaml(spec).trimEnd(),
    "RIG",
  ];
  for (const f of agentFiles(design, spec)) {
    lines.push(`mkdir -p ${f.path.replace(/\/agent\.yaml$/, "")}`, `cat > ${f.path} <<'AGENT'`);
    lines.push(f.yaml.trimEnd(), "AGENT");
  }
  lines.push("rig up rig.yaml");
  return lines.join("\n") + "\n";
}
