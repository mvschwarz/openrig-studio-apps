// Who a provider answers: this machine's own Studio, reached on loopback.
// Copyright 2026 mvschwarz. Licensed under the Apache License, Version 2.0.
//
// A provider listens on 127.0.0.1 behind the Studio's one origin, and the Studio only proxies to it. Two more rules keep a page
// on some other site from using it through the person's browser:
//
// - The request's Host is a loopback name (127.0.0.1, localhost or [::1], any port). A web page that points its own domain at
//   127.0.0.1 (DNS rebinding) sends its own name as the Host, so it is refused here.
// - A write that comes from a browser (it names an Origin) is from the same loopback origin the Host names. A sandboxed page
//   (Origin "null"), such as a file Files serves raw, is refused. A browser POST must also be JSON, which a page elsewhere can't
//   send without a preflight. A write that names no Origin is a script or an agent on this machine, not a browser page.
//
// A Studio reached from another machine (behind the SDK's server hooks) has a different owner, and needs its own version of this
// module: these rules refuse every request whose Host isn't loopback. A deployment replaces this file with one that exports the
// same two functions: ownerCheck(req), answering { ok: true } or { ok: false, why } at once or as a promise (a check that asks a
// sign-in service is async), and refuse(res, why), which writes the refusal. Providers never call ownerCheck directly: they go
// through admit.mjs, which waits for it and refuses unless it said yes.

export const NOT_HERE = "This request didn't come from this machine's Studio.";
export const JSON_ONLY = "Send this as JSON (content-type: application/json).";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const hostOf = (req) => {
  const host = req?.headers?.host;
  if (typeof host !== "string" || !host || host.length > 300) return null;
  try {
    return new URL(`http://${host}`);
  } catch {
    return null;
  }
};

/** The request names a loopback Host. No Host, or one that doesn't parse, is not loopback. */
export function loopbackHost(req) {
  const u = hostOf(req);
  return !!u && LOOPBACK.has(u.hostname);
}

/** No Origin (not a browser page), or exactly the origin the Host names. */
export function sameOrigin(req) {
  const origin = req?.headers?.origin;
  if (origin === undefined) return true;
  const u = hostOf(req);
  return !!u && origin === u.origin;
}

const isJson = (req) => /^application\/json\b/i.test(req?.headers?.["content-type"] || "");

/**
 * { ok: true } when this machine's Studio may make this request, else { ok: false, why }.
 * A write is any method but GET and HEAD.
 */
export function ownerCheck(req) {
  if (!loopbackHost(req)) return { ok: false, why: NOT_HERE };
  const write = req.method !== "GET" && req.method !== "HEAD";
  if (!write || req.headers.origin === undefined) return { ok: true };
  if (!sameOrigin(req)) return { ok: false, why: NOT_HERE };
  if (req.method === "POST" && !isJson(req)) return { ok: false, why: JSON_ONLY };
  return { ok: true };
}

/** The refusal every provider sends: 403, plain words, never the data. */
export function refuse(res, why) {
  res.writeHead(403, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify({ ok: false, error: why }));
}
