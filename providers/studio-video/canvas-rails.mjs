// CANVAS rails — validate → backup → apply → history for <bundle>/canvas.json.
// The doc is a thin wrapper over the NATIVE tldraw snapshot (pinned bundle
// app/vendor/tldraw-v5.2.5): { rev, updated_at, updated_by, document:{schema,store} }.
// Agents READ canvas.json directly; agents and the UI WRITE through
// /api/canvas/apply with baseRev discipline (409 + current doc on mismatch).
// Design:  . No staged-draft
// step by design — undo depth = coalesced backups + history.

// The provider carries its OWN copy of the tldraw vector codec. It used to
// reach ../../vendor across a shared repo -- an implicit dependency that only
// worked while the app and the provider lived in one tree. Splitting the repos
// turned it into a MODULE_NOT_FOUND, which is the honest form of it: the
// browser BUNDLE is an app asset, this codec is a provider dependency, and
// they are two different things that happened to sit in one folder.
import fs from "node:fs";
import path from "node:path";
import { b64Vecs } from "./vendor/b64Vecs.mjs";

const MAX_DOC_BYTES = 8 * 1024 * 1024;
const MAX_RECORDS = 5000;
const BACKUP_COALESCE_MS = 10 * 60 * 1000;

export function canvasPaths(sliceRoot) {
  return {
    docPath: path.join(sliceRoot, "canvas.json"),
    backupsDir: path.join(sliceRoot, "canvas-backups"),
    historyPath: path.join(sliceRoot, "canvas-history.jsonl"),
  };
}

export function readCanvas(sliceRoot) {
  const { docPath } = canvasPaths(sliceRoot);
  if (!fs.existsSync(docPath)) return { rev: 0, updated_at: null, updated_by: null, document: null };
  return JSON.parse(fs.readFileSync(docPath, "utf8"));
}

// Media src law: shapes reference media ONLY through the same-origin rails so
// the asset allowlist keeps holding on the canvas. No http(s), no base64 blobs.
function validateSrc(src, { isAllowed }) {
  const value = String(src || "");
  if (!value) return null;
  if (value.startsWith("data:") || /^https?:\/\//.test(value)) {
    return `asset src must use the media rails (/api/media?path=... or /api/library/media?path=...), got: ${value.slice(0, 80)}`;
  }
  const match = /^\/api\/(media|library\/media|thumb)\?/.exec(value);
  if (!match) return `asset src is not a recognized media rail: ${value.slice(0, 80)}`;
  const wanted = new URL(value, "http://x").searchParams.get(match[1] === "thumb" ? "abs" : "path")
    || new URL(value, "http://x").searchParams.get("src") || "";
  if (wanted && !isAllowed(wanted, match[1])) {
    return `asset src path is not an indexed project asset or under a media root: ${wanted.slice(0, 120)}`;
  }
  return null;
}

export function validateCanvasDoc(document, { isAllowed }) {
  const errors = [];
  if (!document || typeof document !== "object") return { ok: false, errors: ["document is required"] };
  if (!document.schema || typeof document.schema !== "object") errors.push("document.schema missing (native tldraw snapshot expected)");
  const store = document.store;
  if (!store || typeof store !== "object") errors.push("document.store missing");
  const records = store ? Object.values(store) : [];
  if (records.length > MAX_RECORDS) errors.push(`record count ${records.length} exceeds clamp ${MAX_RECORDS}`);
  for (const [key, record] of Object.entries(store || {})) {
    if (!record || typeof record !== "object" || !record.typeName || record.id !== key) {
      errors.push(`malformed record at key ${key}`);
      continue;
    }
    if (record.typeName === "asset") {
      const srcError = validateSrc(record.props?.src, { isAllowed });
      if (srcError) errors.push(`${key}: ${srcError}`);
    }
  }
  const bytes = Buffer.byteLength(JSON.stringify(document));
  if (bytes > MAX_DOC_BYTES) errors.push(`document is ${bytes} bytes, clamp is ${MAX_DOC_BYTES}`);
  return { ok: errors.length === 0, errors, recordCount: records.length, bytes };
}

// Coalesced backups: a sketch surface autosaving every ~1.5s must not mint a
// backup per stroke. One backup per actor per burst window; a NEW actor always
// backs up (that boundary is exactly what a restore wants to reach).
function maybeBackup({ backupsDir, current, actor }) {
  if (!current.document) return null;
  fs.mkdirSync(backupsDir, { recursive: true });
  const latest = fs.readdirSync(backupsDir).filter((name) => name.endsWith(".json")).sort().pop();
  if (latest) {
    const stat = fs.statSync(path.join(backupsDir, latest));
    const sameActor = latest.includes(`-by-${String(actor).replace(/[^a-zA-Z0-9.@-]+/g, "_")}`);
    if (sameActor && Date.now() - stat.mtimeMs < BACKUP_COALESCE_MS) return null;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeActor = String(actor).replace(/[^a-zA-Z0-9.@-]+/g, "_");
  const backupPath = path.join(backupsDir, `canvas-${stamp}-by-${safeActor}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(current, null, 2));
  return backupPath;
}

function diffCounts(before, after) {
  const a = before?.store || {};
  const b = after?.store || {};
  let added = 0, removed = 0, updated = 0;
  for (const key of Object.keys(b)) {
    if (!(key in a)) added++;
    else if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) updated++;
  }
  for (const key of Object.keys(a)) if (!(key in b)) removed++;
  return { added, removed, updated };
}

// Collaboration rails : agents get capability PARITY
// through plain data — the rail does the format lifting.
// 1. Ink normalization: agents write draw segments as honest
//    {type, points:[{x,y,z?}]} — the rail encodes to tldraw 5.x's packed
//    {type, path} storage form (vendored codec, dim 3, z = pressure 0.5).
// 2. Authorship: every record ADDED by an apply gets meta.author = actor
//    (unless the author already set it) — on-canvas provenance is stamped
//    by code, never left to caller diligence.
function normalizeForCollab(document, currentDocument, actor) {
  const before = currentDocument?.store || {};
  for (const record of Object.values(document.store || {})) {
    if (record?.typeName === "shape" && record.type === "draw" && Array.isArray(record.props?.segments)) {
      record.props.segments = record.props.segments.map((segment) => {
        if (!segment || segment.path !== undefined || !Array.isArray(segment.points)) return segment;
        const points = segment.points.map((p) => ({ x: Number(p.x) || 0, y: Number(p.y) || 0, z: p.z == null ? 0.5 : Number(p.z) }));
        return { type: segment.type || "free", path: b64Vecs.encodePoints(points, 3) };
      });
    }
    if (record && typeof record === "object" && !(record.id in before)) {
      record.meta = { ...(record.meta || {}) };
      if (!record.meta.author) record.meta.author = String(actor || "unknown");
    }
  }
}

export function applyCanvas({ sliceRoot, baseRev, document, actor, reason, isAllowed }) {
  const paths = canvasPaths(sliceRoot);
  const current = readCanvas(sliceRoot);
  if (Number(baseRev) !== current.rev) {
    return { ok: false, status: 409, error: `rev mismatch: base ${baseRev}, current ${current.rev} — re-read and merge`, rev: current.rev, document: current.document };
  }
  if (document && typeof document === "object") normalizeForCollab(document, current.document, actor);
  const validation = validateCanvasDoc(document, { isAllowed });
  if (!validation.ok) return { ok: false, status: 400, error: "validation failed", errors: validation.errors, rev: current.rev };
  const backupPath = maybeBackup({ backupsDir: paths.backupsDir, current, actor });
  const next = {
    rev: current.rev + 1,
    updated_at: new Date().toISOString(),
    updated_by: String(actor || "unknown"),
    document,
  };
  const tmp = `${paths.docPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 1));
  fs.renameSync(tmp, paths.docPath);
  const counts = diffCounts(current.document, document);
  fs.appendFileSync(paths.historyPath, JSON.stringify({
    ts: next.updated_at, actor: next.updated_by, rev: next.rev,
    reason: String(reason || "").slice(0, 200), ...counts,
    records: validation.recordCount,
  }) + "\n");
  return { ok: true, rev: next.rev, backup: backupPath ? path.relative(sliceRoot, backupPath) : null, ...counts };
}
