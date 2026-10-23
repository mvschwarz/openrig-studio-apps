#!/usr/bin/env node
// The Observatory container's healthcheck. It asks the provider's ready verb THROUGH THE STUDIO'S PORT,
// so passing means the studio and the observatory provider are both serving. It never reads a daemon:
// whether the fleet can be read is a reading the app shows, not a reason to call the app unhealthy.
//
// Exit 0 only when /api/observatory/ready answers ready from this provider. Otherwise exit 1 with a
// line saying what is known. When only the studio answers, that line is "shell answers; provider not
// confirmed", which is a failure, never a pass.
import { pathToFileURL } from "node:url";

export const PROVIDER = "@openrig/studio-observatory";
export const LABELS = {
  ready: "provider ready: the studio and the observatory provider are serving",
  shellOnly: "shell answers; provider not confirmed",
  down: "studio not answering",
};

async function get(fetchImpl, url, timeoutMs) {
  try {
    const r = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    const text = await r.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    return { ok: r.ok, status: r.status, body };
  } catch (err) {
    return { ok: false, status: null, error: String(err?.cause?.code ?? err?.message ?? err) };
  }
}

export async function check({ base = "http://127.0.0.1:9440", fetch: fetchImpl = globalThis.fetch, timeoutMs = 4000 } = {}) {
  const ready = await get(fetchImpl, `${base}/api/observatory/ready`, timeoutMs);
  if (ready.ok && ready.body?.ready === true && ready.body?.provider === PROVIDER) return { healthy: true, label: LABELS.ready };
  const shell = await get(fetchImpl, `${base}/api/contract`, timeoutMs);
  const why = ready.status ? `ready verb answered HTTP ${ready.status}${ready.body?.reason ? ` (${ready.body.reason})` : ""}` : `ready verb: ${ready.error ?? "no answer"}`;
  if (shell.ok) return { healthy: false, label: LABELS.shellOnly, detail: why };
  return { healthy: false, label: LABELS.down, detail: why };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const r = await check({ base: process.env.OBSERVATORY_HEALTH_BASE || undefined });
  console.log(r.detail ? `${r.label} (${r.detail})` : r.label);
  process.exit(r.healthy ? 0 : 1);
}
