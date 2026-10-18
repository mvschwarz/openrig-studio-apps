// A container healthcheck for a read-only provider behind the Studio. It asks the provider's ready route
// THROUGH THE STUDIO'S PORT, so passing means the studio and that provider are both serving. It never
// reads a daemon: whether the fleet can be read is a reading the app shows, not a reason to call the app
// unhealthy.
//
// Healthy only when the ready route answers ready from the named provider. Otherwise unhealthy, with a
// line saying what is known. When only the studio answers, that line is "shell answers; provider not
// confirmed", which is a failure, never a pass.
export const LABELS = {
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

export async function checkProvider({ base, readyPath, provider, readyLabel, fetch: fetchImpl = globalThis.fetch, timeoutMs = 4000 }) {
  const ready = await get(fetchImpl, `${base}${readyPath}`, timeoutMs);
  if (ready.ok && ready.body?.ready === true && ready.body?.provider === provider) return { healthy: true, label: readyLabel };
  const shell = await get(fetchImpl, `${base}/api/contract`, timeoutMs);
  const why = ready.status ? `ready verb answered HTTP ${ready.status}${ready.body?.reason ? ` (${ready.body.reason})` : ""}` : `ready verb: ${ready.error ?? "no answer"}`;
  if (shell.ok) return { healthy: false, label: LABELS.shellOnly, detail: why };
  return { healthy: false, label: LABELS.down, detail: why };
}

export async function runHealthcheck(opts) {
  const r = await checkProvider(opts);
  console.log(r.detail ? `${r.label} (${r.detail})` : r.label);
  process.exit(r.healthy ? 0 : 1);
}
