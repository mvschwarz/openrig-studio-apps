#!/usr/bin/env node
// Scaffold a new Studio video bundle per the workspace contract .
// Usage: node video-new.mjs <name> [--parent <dir>] [--port <n>]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BUNDLE_DIRS, doctrineSeed, mutationOwnerSeed, placementText, seededReceivers, templatesSeedPath, timelineSkeleton } from "./studio-bundle.mjs";
import { bootstrapHistory, defaultPaths, rebuildSlots } from "./timeline-history.mjs";

export function briefSeed(name, idea) {
  return [
    `# ${name} - brief`,
    "",
    "## THE IDEA (your words, verbatim - never rewrite this section)",
    "",
    idea ? idea.trim() : "(paste your rough idea here, verbatim)",
    "",
    "## Angle (propose competing one-liners as TAKES; you pick)",
    "",
    "## Audience + the one takeaway",
    "",
    "## Beats sketch (becomes the storyboard's first beats)",
    "",
    "## Demo plan (what you record; marker phrases for the cut)",
    "",
  ].join("\n");
}

export function scaffoldBundle(name, { parent = process.cwd(), idea = "", port = 8792 } = {}) {
  const root = path.join(parent, name);
  if (fs.existsSync(root)) throw new Error(`already exists: ${root}`);

  for (const entry of BUNDLE_DIRS) fs.mkdirSync(path.join(root, entry.dir), { recursive: true });
  fs.writeFileSync(path.join(root, "PLACEMENT.md"), placementText());
  fs.writeFileSync(path.join(root, "doctrine", "current-rules.md"), doctrineSeed());
  fs.writeFileSync(path.join(root, "timeline.json"), JSON.stringify(timelineSkeleton(name), null, 2));
  fs.writeFileSync(path.join(root, "current-audio.json"), JSON.stringify({
    _note: "No active audio package installed yet. Install the first narration package via Re-conform.",
    active: null,
    previous: null,
  }, null, 2));
  fs.writeFileSync(path.join(root, "current-export.json"), JSON.stringify({
    _note: "No export has been written yet. Run assemble-timeline.mjs to populate review/final pointers.",
  }, null, 2));
  const historyPaths = defaultPaths(root);
  bootstrapHistory(historyPaths);
  if (!fs.existsSync(historyPaths.historyPath)) fs.writeFileSync(historyPaths.historyPath, "");
  rebuildSlots(historyPaths);
  // bundles are born knowing the topology (seat<->surface duality)
  fs.writeFileSync(path.join(root, "reports", "notes", "receivers.json"), JSON.stringify(seededReceivers(), null, 2));
  fs.writeFileSync(path.join(root, "mutation-owner.json"), JSON.stringify(mutationOwnerSeed(), null, 2));
  // bundles speak the template vocabulary from birth
  fs.copyFileSync(templatesSeedPath(), path.join(root, "templates.json"));
  fs.writeFileSync(path.join(root, "brief.md"), briefSeed(name, idea));
  fs.writeFileSync(path.join(root, "script.md"), `# ${name} - script\n\n(locked script beats become placeholder slots; see the template-board slice)\n`);
  fs.writeFileSync(path.join(root, "README.md"), [
    `# ${name}`,
    "",
    "Studio video bundle (workspace contract v1). Front doors:",
    "",
    "- filing map: PLACEMENT.md - unsure where a file goes? intake/",
    "- rules: doctrine/current-rules.md (rendered in the mini-NLE Info panel)",
    `- open the cockpit: open http://127.0.0.1:${port}/mini-nle.html (or run the studio-video provider directly with --port ${port} --slice-root .)`,
    "- check filing: node <tools>/bundle-check.mjs --root .",
    "- agent onboarding: the studio-instrument skill (openrig-work/skills/studio-instrument/)",
    "",
    "timeline.json starts empty: install the first audio master package via",
    "Re-conform, or seed placeholders from the locked script.",
    "",
  ].join("\n"));
  return { ok: true, root, dirs: BUNDLE_DIRS.length };
}

function main() {
  const argv = process.argv.slice(2);
  const name = argv[0];
  if (!name || name.startsWith("-")) {
    console.log("Usage: node video-new.mjs <name> [--parent <dir>] [--port <n>] [--json]");
    process.exit(1);
  }
  let parent = process.cwd();
  let idea = "";
  let port = 8792;
  let json = false;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--parent") parent = path.resolve(argv[++i]);
    else if (argv[i] === "--idea") idea = argv[++i];
    else if (argv[i] === "--port") port = Number(argv[++i]);
    else if (argv[i] === "--json") json = true;
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  const result = scaffoldBundle(name, { parent, idea, port });
  console.log(json ? JSON.stringify(result, null, 2) : `bundle ready: ${result.root}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
