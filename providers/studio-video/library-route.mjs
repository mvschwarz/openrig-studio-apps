// WHERE A ROUTED ASSET IS ALLOWED TO LAND.
//
// Extracted into one function with one definition, because the defect it fixes
// came from the destination being computed inline where nobody was looking. The
// source of this route was always validated properly — realpath, then checked
// against the configured media roots — and a caller-supplied `slot` was
// interpolated straight into the destination path one line after the FILE NAME
// was carefully sanitised.
//
// `path.join` collapses `../` for you, so `slot: "../../../tmp/evil"` produced a
// path outside the project, `mkdirSync(..., {recursive:true})` created it, and
// `copyFileSync` wrote there. Measured, not theorised.
//
// A VALIDATED SOURCE NEVER IMPLIES A VALIDATED DESTINATION. That is the whole
// lesson: every review looked at the source check, found it careful, and stopped.
// Read and write are separate operations and each end of each one needs its own
// answer.
//
// BOTH HALVES, NOT EITHER. The slot is sanitised to a single safe segment, AND
// the resolved destination is checked against the root. Sanitising alone is one
// careless concatenation away from the same bug; the boundary check alone accepts
// junk names that happen to stay inside. The boundary is the load-bearing half —
// it holds no matter how the name was built.
import path from "node:path";

export function routeDestination({ sliceRoot, destDir, baseName, slot }) {
  const root = path.resolve(sliceRoot);
  const safeBase = String(baseName || "").replace(/[^A-Za-z0-9._-]+/g, "-");

  // One segment, same charset the file name already used. A slot is a take
  // identifier — it was never meant to be a path, and nothing legitimate needs a
  // separator in it.
  const raw = String(slot ?? "");
  const safeSlot = raw.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "").slice(0, 64);
  if (raw && !safeSlot) {
    return { ok: false, error: `slot ${JSON.stringify(raw)} has nothing usable in it after sanitising` };
  }
  // A slot that CHANGED under sanitising is refused rather than quietly accepted
  // in its cleaned form. Silently routing "../../evil" to "-evil" would do
  // something the caller did not ask for, and a caller reaching for a traversal
  // should hear about it rather than get a surprise filename.
  if (raw && safeSlot !== raw) {
    return { ok: false, error: `slot ${JSON.stringify(raw)} must be a single name — letters, numbers, dot, dash, underscore` };
  }

  const destName = safeSlot ? `${safeSlot}-lib-${safeBase}` : `lib-${safeBase}`;
  const dest = path.resolve(root, destDir, destName);

  // THE LOAD-BEARING CHECK. Resolved, after everything is incorporated, rather
  // than any assertion about the pieces it was built from.
  if (dest !== root && !dest.startsWith(root + path.sep)) {
    return { ok: false, error: "destination resolves outside the slice root" };
  }
  return { ok: true, dest };
}
