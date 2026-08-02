// The studio's own backend, ported from studio-box.
//
// THIS BOX IS TRUSTED. It belongs to the person using it. The orchestration
// capabilities — spawning an agent, driving a terminal, filing work into the
// owner's own rig queue — are FEATURES here, not hazards. The whole thesis is
// that an agent in the sidebar can run and reshape the app in front of you.
//
// An earlier revision of this file stripped those out and justified it with a
// threat model in which the machine's own owner was the adversary. That model
// was wrong and has been retracted. Nothing here is defended against the user.
//
// What the boundary below IS for is ROBUSTNESS — a different job, and a real
// one. A malformed slot id from a UI bug, an agent acting on a path it misread,
// or a forgotten symlink will corrupt an owner's disk just as effectively as
// malice would. resolveInsideRoots stops the tool wrecking the files of the
// person operating it. That is worth having on any box, and it is the only
// claim it makes.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(process.env.STUDIO_HOST_ROOT || process.cwd());

// ---- roots -----------------------------------------------------------------
// The studio's OWN SOURCE is a default root, deliberately. "Reshape it" is the
// product: the owner, through the agent, edits the app they are looking at.
// Removed once on the retracted threat model; restored.
export function fileRoots(config = {}) {
  const home = os.homedir();
  const declared = config.filesRoots?.length
    ? config.filesRoots
    : [REPO_ROOT, path.join(home, "openrig-videos")];
  return [...declared, ...readOverlay()]
    .map((p) => (p.startsWith("~") ? path.join(home, p.slice(1)) : p))
    .map((p) => path.resolve(p))
    .filter((p) => fs.existsSync(p))
    .filter((p, i, a) => a.indexOf(p) === i);
}

// ---- THE BOUNDARY ----------------------------------------------------------
// Both halves resolve symlinks. studio-box validated an ADDED root with
// realpathSync but gated reads/writes with plain path.resolve, so a symlink
// INSIDE an approved root pointing OUTSIDE it satisfied the gate and was
// written through. That asymmetry is the sandbox escape this function exists to
// close: one function, used by every read and every write, resolving the same
// way on both paths.
//
// Returns the REAL path when inside a root, else null. Callers must use the
// returned path — never the caller's original string.
export function resolveInsideRoots(p, roots) {
  if (typeof p !== "string" || !p) return null;
  const target = path.resolve(p);

  // Resolve as far as the filesystem allows. A path that does not exist yet — a new
  // file, or a whole directory chain about to be created — has no realpath, so walk up
  // to the deepest EXISTING ancestor, resolve THAT (defeating symlinks in the part that
  // exists), and re-attach the remaining segments.
  //
  // Resolving only the immediate parent is not enough: routing an asset into a fresh
  // project creates `media/captures/` on the way, so the parent does not exist either
  // and every legitimate create was rejected. A positive control caught that — an
  // over-restrictive boundary and a correct one look identical against an attack test.
  let real;
  try {
    real = fs.realpathSync(target);
  } catch {
    const segments = [];
    let probe = target;
    for (;;) {
      const parent = path.dirname(probe);
      if (parent === probe) return null; // walked to the filesystem root without finding one
      segments.unshift(path.basename(probe));
      probe = parent;
      let resolvedAncestor;
      try {
        resolvedAncestor = fs.realpathSync(probe);
      } catch {
        continue; // keep walking up
      }
      // `path.resolve` normalizes any `..` in the not-yet-existing tail, so a tail that
      // climbs back out is caught by the containment check below rather than slipping past.
      real = path.resolve(resolvedAncestor, ...segments);
      break;
    }
  }

  for (const root of roots) {
    let realRoot;
    try {
      realRoot = fs.realpathSync(root);
    } catch {
      continue;
    }
    // `root + sep` or exact match — never a bare prefix, so a sibling
    // directory like `<root>-evil` cannot masquerade as being inside `<root>`.
    if (real === realRoot || real.startsWith(realRoot + path.sep)) return real;
  }
  return null;
}

// ---- read verbs ------------------------------------------------------------
// SHAPE IS THE CONTRACT. No dir → the root list, which is how the surface
// populates its ROOTS pane. With a dir → { path, dirs, files }. An earlier
// hand-rewrite returned { dir, entries } instead; the verb answered 200 with
// real data and the pane rendered empty, because the field it reads was gone.
export function filesTree(dirPath, roots) {
  if (!dirPath) {
    return {
      roots: roots.map((p) => ({
        path: p,
        name: path.basename(path.dirname(p)) + "/" + path.basename(p),
      })),
    };
  }
  const r = resolveInsideRoots(dirPath, roots);
  if (!r) return null;
  const dirs = [], files = [];
  for (const name of fs.readdirSync(r).sort()) {
    if (name.startsWith(".")) continue;
    const full = path.join(r, name);
    try {
      const st = fs.statSync(full);
      if (st.isDirectory()) dirs.push({ name, path: full });
      else files.push({ name, path: full, size: st.size, mtime: st.mtimeMs, kind: fileKind(name) });
    } catch { /* unreadable entry is skipped, not fatal */ }
  }
  return { path: r, dirs, files };
}

// Text comes back inline; anything else comes back as a raw URL the surface
// puts in an img/video/audio tag. Reading a video as utf8 — which the earlier
// rewrite did — corrupts it and hangs the pane.
export function filesRead(p, roots) {
  const r = resolveInsideRoots(p, roots);
  if (!r || !fs.existsSync(r)) return null;
  const st = fs.statSync(r);
  if (st.isDirectory()) return null;
  const kind = fileKind(r);
  if (kind === "markdown" || kind === "text" || (st.size < 512 * 1024 && kind === "other")) {
    return {
      kind: kind === "other" ? "text" : kind,
      content: fs.readFileSync(r, "utf8"),
      mtime: st.mtimeMs,
    };
  }
  return { kind, raw: "/api/files/raw?path=" + encodeURIComponent(r), mtime: st.mtimeMs };
}

// ---- write verb ------------------------------------------------------------
// Same boundary function as every read. Backs up before replacing, and swaps
// atomically so a crash mid-write cannot truncate the original.
export function filesWrite(p, content, baseMtime, roots) {
  const r = resolveInsideRoots(p, roots);
  if (!r) throw new Error("path outside the pinned roots");

  if (fs.existsSync(r)) {
    const cur = fs.statSync(r).mtimeMs;
    if (baseMtime != null && Math.abs(cur - baseMtime) > 1) {
      const err = new Error("file changed since you loaded it");
      err.conflict = true;
      err.current = { content: fs.readFileSync(r, "utf8"), mtime: cur };
      throw err;
    }
    const bdir = path.join(path.dirname(r), ".files-backups");
    fs.mkdirSync(bdir, { recursive: true });
    fs.copyFileSync(r, path.join(bdir, `${path.basename(r)}.${Date.now()}`));
  }

  const tmp = `${r}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, r);
  return fs.statSync(r).mtimeMs;
}

// ---- media library ---------------------------------------------------------
// Extracted from studio-box's export-server. Every path decision below goes
// through resolveInsideRoots — including the DESTINATION, which the original
// did not validate.

const MEDIA_EXT = { video: /\.(mp4|mov|webm|mkv)$/i, image: /\.(png|jpe?g|webp|gif)$/i, audio: /\.(wav|mp3|aiff?|m4a|flac)$/i };
export function mediaKindOf(name) {
  for (const [kind, re] of Object.entries(MEDIA_EXT)) if (re.test(name)) return kind;
  return "unknown";
}

// Safe by construction: takes no caller path at all, walks server-derived roots.
export function libraryList(roots, { maxDepth = 4 } = {}) {
  const assets = [];
  const walk = (dir, rootLabel, depth) => {
    if (depth > maxDepth || !fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith(".") || name === "node_modules") continue;
      const full = path.join(dir, name);
      let stat;
      try { stat = fs.statSync(full); } catch { continue; }
      if (stat.isDirectory()) { walk(full, rootLabel, depth + 1); continue; }
      const kind = mediaKindOf(name);
      if (kind === "unknown") continue;
      // Listing is root-checked too. studio-box listed via statSync (which follows
      // symlinks), so a symlink out of the root appeared in the index with its
      // target's size and mtime — a metadata leak even though serving was gated.
      if (!resolveInsideRoots(full, roots)) continue;
      assets.push({ name, path: full, root: rootLabel, kind, size: stat.size, mtime: stat.mtimeMs });
    }
  };
  for (const root of roots) walk(root, path.basename(root), 0);
  return assets;
}

// ROUTE A LIBRARY ASSET INTO A PROJECT.
// The original validated the SOURCE with realpath and a root check, then built the
// DESTINATION from an unsanitized `slot` — `slot='../../../tmp/evil'` escaped the
// project root, creating directories on the way (measured). Defense in depth here:
// the slot is reduced to a single segment AND the resolved destination is validated.
// The boundary check is the load-bearing half; it holds however the name was built.
export function libraryRoute({ assetPath, slot, projectRoot, roots }) {
  const source = resolveInsideRoots(assetPath, roots);
  if (!source) return { ok: false, error: "asset must live under a configured media root" };

  const kind = mediaKindOf(source);
  const destDir = kind === "image" ? "media/images" : kind === "audio" ? "media/audio" : "media/captures";
  // Same character class studio-box already used for `slot` in /api/annotation — it
  // preserves dots, which real slot ids need (1.1 … 3.6), and strips separators.
  const safeSlot = String(slot || "").replace(/[^a-zA-Z0-9.]+/g, "-").replace(/^[.-]+|[.-]+$/g, "");
  const baseName = path.basename(source).replace(/[^A-Za-z0-9._-]+/g, "-");
  const destName = safeSlot ? `${safeSlot}-lib-${baseName}` : `lib-${baseName}`;

  const destPath = path.join(projectRoot, destDir, destName);
  // Validate the RESOLVED destination against the project root before any mkdir.
  const destOk = resolveInsideRoots(destPath, [projectRoot]);
  if (!destOk) return { ok: false, error: "destination escapes the project root" };

  fs.mkdirSync(path.dirname(destOk), { recursive: true });
  fs.copyFileSync(source, destOk);
  const projReal = resolveInsideRoots(projectRoot, [projectRoot]) || projectRoot;
  return { ok: true, dest: path.relative(projReal, destOk) };
}

// ---- live seats ------------------------------------------------------------
// THE FIRST ORCHESTRATION VERB BACK IN. The studio asks the rig who is actually
// seated, so the agent sidebar shows real seats instead of the SDK's fixture
// placeholder. This shells out to `rig`, which the earlier posture forbade on
// the theory that the box's owner was an adversary; on a trusted box, an app
// that can see and talk to your agents is the entire point.
//
// Fixed argv, no caller input reaches it — not because a gate demands it, but
// because this verb genuinely has nothing to parameterise.
export function listSeats() {
  return new Promise((resolve) => {
    execFile("rig", ["ps", "--nodes", "--json"], { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve({ ok: false, error: `rig ps failed: ${err.message}`, seats: [] });
      let nodes;
      try {
        const parsed = JSON.parse(stdout);
        nodes = Array.isArray(parsed) ? parsed : parsed.nodes || [];
      } catch (e) {
        return resolve({ ok: false, error: `could not parse rig ps: ${e.message}`, seats: [] });
      }
      const seats = nodes
        .filter((n) => n.canonicalSessionName || n.logicalId)
        .map((n) => ({
          seat: n.canonicalSessionName || `${n.logicalId}@${n.rigName}`,
          name: (n.logicalId || "").toUpperCase() || n.canonicalSessionName,
          rig: n.rigName,
          // agentActivity is an OBJECT ({state:"unknown"}) on this host, not a
          // string — live-state.mjs already normalized it and this verb did
          // not, so every seat row rendered a literal "[object Object]".
          // Normalized here, once, rather than in each surface that shows it.
          //
          // Still reported rather than interpreted: "unknown" is the honest
          // value for claude-code seats because the daemon-ingest link is
          // down, and "idle" would be inventing a fact about a live seat.
          activity: (typeof n.agentActivity === "string"
            ? n.agentActivity
            : n.agentActivity?.state) ?? "unknown",
          lifecycle: n.lifecycleState,
          pendingWork: n.pendingWorkCount ?? 0,
        }));
      resolve({ ok: true, seats });
    });
  });
}

// ---- talking to a seat -----------------------------------------------------
// THE COLLABORATION SURFACE, RESTORED. studio-box had this as /api/demo/say
// (tmux send-keys, inject + submit). It was deleted as an "escalation class"
// verb under the threat model that has since been retracted — the one that
// treated the box's own owner as the adversary. On a trusted box, a human and
// an agent working the same surface IS the product thesis, and the SDK leaves
// this to the consumer on purpose: its shell says "live seat attach requires a
// seat backend, which this fixture-backed runtime does not include."
//
// This is that backend.
//
// Two deliberate choices:
//   - `rig send` / `rig capture` rather than raw tmux send-keys. Same effect,
//     but it is the sanctioned surface, it resolves seats across rigs, and it
//     reports delivery instead of firing keystrokes into a pane by index.
//   - the seat is validated against the LIVE ROSTER before it reaches argv.
//     Not because anyone is attacking: a mistyped or stale seat name would
//     otherwise be handed straight to a subprocess, and "which seat did that
//     go to" is a question you never want to ask.

const seatIsReal = async (seat) => {
  const r = await listSeats();
  if (!r.ok) return { ok: false, error: r.error };
  return r.seats.some((s) => s.seat === seat)
    ? { ok: true }
    : { ok: false, error: `not a live seat: ${seat}` };
};

export async function sendSeat(seat, text) {
  const body = String(text ?? "").trim();
  if (!body) return { ok: false, error: "nothing to send" };
  const real = await seatIsReal(String(seat || ""));
  if (!real.ok) return real;

  return new Promise((resolve) => {
    // argv array, never a shell string — the message is one argument, so
    // backticks and $(...) in what a human types stay literal text. That class
    // has bitten four seats on two rigs in a single day through `rig send`.
    execFile("rig", ["send", seat, body, "--verify"], { timeout: 15000 }, (err, stdout, stderr) => {
      const out = `${stdout || ""}${stderr || ""}`;
      if (err && !out.includes("Sent to")) {
        return resolve({ ok: false, error: `rig send failed: ${err.message}` });
      }
      // `Verified: no` is NOT a failure — it is dead for claude-code targets on
      // this host and carries real signal only for codex ones. Report what the
      // tool said and let the surface show it; do not translate it into
      // success or failure here.
      resolve({
        ok: true,
        delivered: /Sent to/.test(out),
        verified: /Verified:\s*yes/i.test(out),
        detail: out.trim().split("\n").slice(0, 3).join(" · "),
      });
    });
  });
}

export async function captureSeat(seat, lines = 60) {
  const real = await seatIsReal(String(seat || ""));
  if (!real.ok) return real;
  const n = Math.max(10, Math.min(400, Number(lines) || 60));
  return new Promise((resolve) => {
    execFile("rig", ["capture", seat, "--lines", String(n)], { timeout: 15000 }, (err, stdout) => {
      if (err) return resolve({ ok: false, error: `rig capture failed: ${err.message}` });
      // Bounded by scrollback: absence here is weak evidence, never proof.
      resolve({ ok: true, seat, lines: n, text: String(stdout || "") });
    });
  });
}

// ---- the rest of the Files app --------------------------------------------
// Ported from studio-box serve-shell.mjs. Behaviour preserved; every path goes
// through the one resolver, which is the only thing that changed.

// The kind vocabulary is a CONTRACT with the surface — files.html maps exactly
// these names to icons and to how it renders a file. Ported verbatim; an
// earlier hand-rewrite of this returned "file" instead of "other" and dropped
// markdown/html entirely, which silently broke the pane.
const FILE_KINDS = {
  image: /\.(png|jpe?g|gif|webp|svg)$/i, video: /\.(mp4|mov|webm)$/i,
  audio: /\.(mp3|wav|m4a|flac)$/i, markdown: /\.(md|markdown)$/i,
  html: /\.html?$/i,
  text: /\.(txt|json|jsonl|yaml|yml|mjs|js|ts|css|py|sh|toml|csv|vtt)$/i,
};
export const fileKind = (name) =>
  Object.entries(FILE_KINDS).find(([, re]) => re.test(name))?.[0] || "other";

const MIME = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".svg": "image/svg+xml", ".mp4": "video/mp4", ".mov": "video/quicktime",
  ".webm": "video/webm", ".mkv": "video/x-matroska", ".mp3": "audio/mpeg", ".wav": "audio/wav",
  ".m4a": "audio/mp4", ".flac": "audio/flac", ".aif": "audio/aiff", ".aiff": "audio/aiff",
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
  ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript",
  ".json": "application/json", ".md": "text/plain; charset=utf-8", ".txt": "text/plain; charset=utf-8",
};
export const mimeFor = (p) => MIME[path.extname(p).toLowerCase()] || "application/octet-stream";

// Resolve for byte-serving. Returns the validated path plus what the front
// needs to stream it; the front owns ranges because that is an HTTP concern.
export function filesRaw(p, roots) {
  const r = resolveInsideRoots(p, roots);
  if (!r || !fs.existsSync(r)) return null;
  const st = fs.statSync(r);
  if (st.isDirectory()) return null;
  return { path: r, mime: mimeFor(r), size: st.size };
}

// Bounded filename search across the roots. Caps at 60 hits and depth 6 so a
// deep tree cannot stall the UI. Each hit is re-checked against the roots: the
// walk starts inside one, but a symlinked subdirectory could still leave it.
export function filesSearch(q, roots) {
  const needle = String(q || "").toLowerCase();
  const hits = [];
  const walk = (dir, depth) => {
    if (hits.length >= 60 || depth > 6) return;
    let names;
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const name of names) {
      if (name.startsWith(".") || name === "node_modules" || name === "vendor") continue;
      const full = path.join(dir, name);
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (st.isDirectory()) { walk(full, depth + 1); continue; }
      if (!name.toLowerCase().includes(needle)) continue;
      if (!resolveInsideRoots(full, roots)) continue;
      hits.push({ name, path: full, kind: fileKind(name) });
      if (hits.length >= 60) return;
    }
  };
  for (const root of roots) walk(root, 0);
  return hits;
}

// tags.jsonl is an append-only add/remove log; replay it into current state.
export function filesTags(rootDir, roots) {
  const r = resolveInsideRoots(rootDir, roots);
  if (!r) return null;
  const tagsPath = [path.join(r, "tags.jsonl"), path.join(r, "wedding/tags.jsonl")]
    .find((p) => fs.existsSync(p));
  if (!tagsPath) return { tags: {} };
  const tags = {};
  for (const line of fs.readFileSync(tagsPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e.op === "add") (tags[e.tag] = tags[e.tag] || new Set()).add(e.asset);
      if (e.op === "remove") tags[e.tag]?.delete(e.asset);
    } catch { /* a malformed line is skipped, not fatal */ }
  }
  return {
    tagsPath,
    tags: Object.fromEntries(
      Object.entries(tags).filter(([, v]) => v.size).map(([k, v]) => [k, [...v]]),
    ),
  };
}

// ---- agent-driven navigation ----------------------------------------------
// THIS IS THE COLLABORATION SURFACE, not a hazard: the agent in the sidebar
// POSTs a path and the open Files surface jumps to it. In-memory, per-process.
let FILES_GOTO = null;
export function gotoGet() { return FILES_GOTO; }
export function gotoSet(p, roots) {
  const r = resolveInsideRoots(p, roots);
  if (!r || !fs.existsSync(r)) return null;
  FILES_GOTO = { path: r, ts: Date.now() };
  return FILES_GOTO;
}

// ---- root overlay ----------------------------------------------------------
// The owner can add their own directories to the browsable set at runtime, and
// it persists. rootAddable is NOT a threat-model gate — it stops the owner
// accidentally exposing their own keys in a browsable pane, which is a UI
// courtesy their own tool already had.
const OVERLAY_PATH = path.join(REPO_ROOT, "studio.files-roots.json");

export function rootAddable(p) {
  let real, home;
  try { real = fs.realpathSync(p); } catch { return { ok: false, error: "path does not exist" }; }
  try { home = fs.realpathSync(os.homedir()); } catch { home = os.homedir(); }
  if (!fs.statSync(real).isDirectory()) return { ok: false, error: "not a directory" };
  if (real === home) return { ok: false, error: "HOME itself is too broad — add a subdirectory" };
  if (!real.startsWith(home + path.sep)) return { ok: false, error: "roots must live inside the home directory" };
  const denied = [path.join(home, ".ssh"), path.join(home, ".secrets"), path.join(home, ".config/rclone")];
  if (denied.some((d) => real === d || real.startsWith(d + path.sep)))
    return { ok: false, error: "that directory holds keys/secrets — not exposable" };
  return { ok: true, real };
}

export function readOverlay() {
  try { return JSON.parse(fs.readFileSync(OVERLAY_PATH, "utf8")).add || []; } catch { return []; }
}

// The overlay path is server-derived and routed through the resolver anyway, so
// claim (b) holds structurally rather than by exemption.
export function rootsMutate({ op, path: p }) {
  const dest = resolveInsideRoots(OVERLAY_PATH, [REPO_ROOT]);
  if (!dest) return { ok: false, error: "overlay path is not inside the studio repo" };
  const add = readOverlay();
  if (op === "add") {
    const v = rootAddable(p || "");
    if (!v.ok) return { ok: false, error: v.error };
    if (!add.includes(v.real)) add.push(v.real);
  } else if (op === "remove") {
    const i = add.indexOf(p);
    if (i > -1) add.splice(i, 1);
  } else {
    return { ok: false, error: "op must be add|remove" };
  }
  if (fs.existsSync(dest)) fs.copyFileSync(dest, `${dest}.${Date.now()}.bak`);
  fs.writeFileSync(dest, JSON.stringify({ add }, null, 2) + "\n");
  return { ok: true };
}
