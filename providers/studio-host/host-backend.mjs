// The Files provider's file operations: the bound folders, the one containment resolver, and the read, write, search, tag
// and go-to verbs built on it. Copyright 2026 mvschwarz. Licensed under the Apache License, Version 2.0.
//
// The resolver is for robustness, not a threat model against the machine's own user: a malformed path from a page, an agent
// acting on a path it misread, or a forgotten symlink can damage files just as effectively as malice. Every read and every write
// goes through resolveInsideRoots, and verify-containment.mjs checks that nothing in this provider contains paths any other way.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Where this Studio keeps its own state: the folder it runs from (the launcher starts providers there).
const STUDIO_DIR = path.resolve(process.env.OPENRIG_STUDIO_DIR || process.cwd());

// ---- roots -----------------------------------------------------------------
// The folders the Studio binds (studio.json's roots, passed as --root), plus any the owner added from the page. There are no
// fallback folders: a Studio that binds none shows none, and the page says so.
export function fileRoots(config = {}) {
  const home = os.homedir();
  return [...(config.filesRoots ?? []), ...readOverlay()]
    .map((p) => (p.startsWith("~") ? path.join(home, p.slice(1)) : p))
    .map((p) => path.resolve(p))
    .filter((p) => fs.existsSync(p))
    .filter((p, i, a) => a.indexOf(p) === i);
}

// ---- THE BOUNDARY ----------------------------------------------------------
// Both the path and the root resolve symlinks. Checking a plain path.resolve
// against the root would let a symlink INSIDE a root that points OUTSIDE it pass
// the check and be written through. One function, used by every read and every
// write, resolving the same way on both paths.
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
  // Resolving only the immediate parent is not enough: a write can create several
  // folders on the way, so the parent may not exist either.
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
// /api/files/tree answers in the runtime's documented shape, { path, dirs, files },
// whoever serves it (contract/runtime-api.md). With no dir it lists the FIRST bound
// root, and the answer names its `path`, so a caller can see which root it got.
// The list of roots has its own verb, /api/files/roots.
export function filesTree(dirPath, roots) {
  const target = dirPath || roots[0];
  if (!target) return null; // no roots bound: nothing to answer with
  const r = resolveInsideRoots(target, roots);
  if (!r) return null;
  const dirs = [],
    files = [];
  let names;
  try {
    names = fs.readdirSync(r).sort();
  } catch {
    return null;
  } // missing, or not a folder: the route's plain answer, not the system's error with its path
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const full = path.join(r, name);
    try {
      const st = fs.statSync(full);
      if (st.isDirectory()) dirs.push({ name, path: full });
      else files.push({ name, path: full, size: st.size, mtime: st.mtimeMs, kind: fileKind(name) });
    } catch {
      /* unreadable entry is skipped, not fatal */
    }
  }
  return { path: r, dirs, files };
}

// Text comes back inline; anything else comes back as a raw URL the page puts in
// an img/video/audio tag (reading a video as utf8 would corrupt it).
export function filesRead(p, roots) {
  const r = resolveInsideRoots(p, roots);
  if (!r || !fs.existsSync(r)) return null;
  const st = fs.statSync(r);
  if (st.isDirectory()) return null;
  const kind = fileKind(r);
  // HTML returns its content, not a raw URL: the SDK's shared viewer renders it into
  // a sandboxed iframe through `srcdoc`, so a page from somewhere else never gets
  // this Studio's origin or its verbs. A file of an unknown type is shown as text
  // only when its bytes ARE text; anything with a NUL or bytes that aren't UTF-8
  // stays "other" and comes back as a raw URL to download.
  if (
    kind === "markdown" ||
    kind === "text" ||
    kind === "html" ||
    (kind === "other" && st.size < 512 * 1024)
  ) {
    const buf = fs.readFileSync(r);
    if (looksBinary(buf))
      return {
        kind: "other",
        raw: "/api/files/raw?path=" + encodeURIComponent(r),
        mtime: st.mtimeMs,
      };
    return {
      kind: kind === "other" ? "text" : kind,
      content: buf.toString("utf8"),
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
  if (notTextFile(r)) {
    const err = new Error(
      "This file isn't text, so it can't be saved from Files. Nothing was changed.",
    );
    err.notText = true;
    throw err;
  }

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

// ---- the rest of the Files app --------------------------------------------
// The kind vocabulary is a contract with the page: files.html maps exactly these
// names to how it renders a file, and anything else is "other".
const FILE_KINDS = {
  image: /\.(png|jpe?g|gif|webp|svg)$/i,
  video: /\.(mp4|mov|webm)$/i,
  audio: /\.(mp3|wav|m4a|flac)$/i,
  markdown: /\.(md|markdown)$/i,
  html: /\.html?$/i,
  pdf: /\.pdf$/i,
  text: /\.(txt|json|jsonl|yaml|yml|mjs|js|ts|css|py|sh|toml|csv|vtt)$/i,
};
// A text view must decode every byte without loss, including files named .txt or .md. A sampled prefix alone can miss binary
// data later in a file. A caller passing an incomplete prefix can explicitly keep a split UTF-8 sequence open with stream mode.
export function looksBinary(buf, truncated = false) {
  if (buf.includes(0)) return true;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buf, { stream: truncated });
    return false;
  } catch {
    return true;
  }
}
// Never written as text from here: a media or PDF type, or an existing file whose bytes aren't text (a save over a .docx would
// otherwise replace it with the text of its bytes).
const NOT_TEXT = new Set(["image", "video", "audio", "pdf"]);
export function notTextFile(r) {
  if (NOT_TEXT.has(fileKind(r))) return true;
  // Only a regular file is opened: opening a named pipe for reading would block this server.
  let st;
  try {
    st = fs.statSync(r);
  } catch (e) {
    if (e.code === "ENOENT") return false;
    throw e;
  }
  if (!st.isFile()) return false;
  let fd;
  try {
    fd = fs.openSync(r, "r");
  } catch (e) {
    if (e.code === "ENOENT") return false;
    throw e;
  }
  try {
    if (!fs.fstatSync(fd).isFile()) return false;
    const decoder = new TextDecoder("utf-8", { fatal: true }),
      buf = Buffer.alloc(65536);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (!n) break;
      const chunk = buf.subarray(0, n);
      if (chunk.includes(0)) return true;
      try {
        decoder.decode(chunk, { stream: true });
      } catch {
        return true;
      }
    }
    try {
      decoder.decode();
      return false;
    } catch {
      return true;
    }
  } finally {
    fs.closeSync(fd);
  }
}
export const fileKind = (name) =>
  Object.entries(FILE_KINDS).find(([, re]) => re.test(name))?.[0] || "other";

export const MIME = {
  // exported for test/files-raw-guard.test.mjs: every type that can run code has a sandbox
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".flac": "audio/flac",
  ".aif": "audio/aiff",
  ".aiff": "audio/aiff",
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".json": "application/json",
  ".md": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  // A PDF is shown inline by the browser's own viewer; Office files are downloaded, so they keep their real type.
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".doc": "application/msword",
  ".xls": "application/vnd.ms-excel",
  ".ppt": "application/vnd.ms-powerpoint",
};
// A file an agent or anyone wrote must never run as this Studio when its raw URL is opened. HTML keeps running its
// own script, as Files' preview frame already allows, but in an opaque origin with no Studio access; SVG and XML run nothing, and XML
// downloads. A PDF gets neither (the browser's viewer won't render in a sandbox); images, media and text are unchanged.
const RAW_SANDBOX = {
  ".html": "sandbox allow-scripts",
  ".htm": "sandbox allow-scripts",
  ".xhtml": "sandbox allow-scripts",
  ".svg": "sandbox",
  ".xml": "sandbox",
  ".xsl": "sandbox",
  ".xslt": "sandbox",
};
const RAW_DOWNLOAD = new Set([".xml", ".xsl", ".xslt"]);
export function rawGuard(p) {
  const ext = path.extname(p).toLowerCase(),
    h = {};
  if (RAW_SANDBOX[ext]) h["content-security-policy"] = RAW_SANDBOX[ext];
  if (RAW_DOWNLOAD.has(ext)) h["content-disposition"] = "attachment";
  return h;
}
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
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (name.startsWith(".") || name === "node_modules" || name === "vendor") continue;
      const full = path.join(dir, name);
      let st;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
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
  const tagsPath = [path.join(r, "tags.jsonl")].find((p) => fs.existsSync(p));
  if (!tagsPath) return { tags: {} };
  const tags = {};
  for (const line of fs.readFileSync(tagsPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e.op === "add") (tags[e.tag] = tags[e.tag] || new Set()).add(e.asset);
      if (e.op === "remove") tags[e.tag]?.delete(e.asset);
    } catch {
      /* a malformed line is skipped, not fatal */
    }
  }
  return {
    tagsPath,
    tags: Object.fromEntries(
      Object.entries(tags)
        .filter(([, v]) => v.size)
        .map(([k, v]) => [k, [...v]]),
    ),
  };
}

// ---- agent-driven navigation ----------------------------------------------
// The agent in the sidebar POSTs a path and the open Files page jumps to it.
// In memory, per process.
let FILES_GOTO = null;
export function gotoGet() {
  return FILES_GOTO;
}
export function gotoSet(p, roots) {
  const r = resolveInsideRoots(p, roots);
  if (!r || !fs.existsSync(r)) return null;
  FILES_GOTO = { path: r, ts: Date.now() };
  return FILES_GOTO;
}

// ---- root overlay ----------------------------------------------------------
// The owner can add their own folders to the browsable set from the page, and
// they persist in the Studio's folder. rootAddable stops the owner exposing their
// own keys in a browsable pane by accident; it is a courtesy, not a security gate.
const OVERLAY_PATH = path.join(STUDIO_DIR, "studio.files-roots.json");
// Folders, relative to the home, where well-known tools keep keys and credentials. Neither one of these nor a folder that
// contains one (~/.config holds gcloud's) can be added.
export const CREDENTIAL_DIRS = [
  ".ssh",
  ".gnupg",
  ".aws",
  ".azure",
  ".kube",
  ".docker",
  ".config/gcloud",
  ".config/gh",
  ".config/rclone",
  ".password-store",
  ".secrets",
];

export function rootAddable(p) {
  let real, home;
  try {
    real = fs.realpathSync(p);
  } catch {
    return { ok: false, error: "That folder doesn't exist." };
  }
  try {
    home = fs.realpathSync(os.homedir());
  } catch {
    home = os.homedir();
  }
  if (!fs.statSync(real).isDirectory()) return { ok: false, error: "That's a file, not a folder." };
  if (real === home)
    return { ok: false, error: "Your whole home folder is too broad. Add a folder inside it." };
  if (!real.startsWith(home + path.sep))
    return { ok: false, error: "Add a folder inside your home folder." };
  for (const rel of CREDENTIAL_DIRS) {
    const d = path.join(home, rel);
    if (real === d || real.startsWith(d + path.sep))
      return { ok: false, error: `~/${rel} holds keys or credentials, so Files won't show it.` };
    if (d.startsWith(real + path.sep))
      return {
        ok: false,
        error: `That folder holds ~/${rel}, where keys or credentials live. Add a folder inside it instead.`,
      };
  }
  return { ok: true, real };
}

export function readOverlay() {
  try {
    return JSON.parse(fs.readFileSync(OVERLAY_PATH, "utf8")).add || [];
  } catch {
    return [];
  }
}

// The overlay path is the provider's own, and still goes through the resolver, so
// verify-containment's write rule holds without an exemption.
export function rootsMutate({ op, path: p }) {
  const dest = resolveInsideRoots(OVERLAY_PATH, [STUDIO_DIR]);
  if (!dest) return { ok: false, error: "the folder list isn't inside the Studio's folder" };
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
