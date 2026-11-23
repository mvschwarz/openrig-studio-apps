// The local owner check every provider shares (providers/lib/owner-check.mjs): a loopback Host, and a browser write from the
// Studio's own origin, as JSON for a POST. Copyright 2026 mvschwarz. Licensed under the Apache License, Version 2.0.
import test from "node:test";
import assert from "node:assert/strict";
import {
  ownerCheck,
  loopbackHost,
  sameOrigin,
  refuse,
  NOT_HERE,
  JSON_ONLY,
} from "../providers/lib/owner-check.mjs";

const req = (method, headers) => ({ method, headers });

test("only a loopback Host is this machine's Studio, at any port; anything else, or none, is refused", () => {
  for (const host of ["127.0.0.1", "127.0.0.1:8890", "localhost:9", "[::1]:8890"])
    assert.equal(loopbackHost(req("GET", { host })), true, host);
  for (const host of [
    undefined,
    "",
    "example.invalid",
    "127.0.0.1.example.invalid",
    "10.0.0.2:8890",
    "x".repeat(400),
  ])
    assert.equal(ownerCheck(req("GET", { host })).ok, false, String(host));
  assert.deepEqual(ownerCheck(req("GET", { host: "rebound.example.invalid" })), {
    ok: false,
    why: NOT_HERE,
  });
});

test("reads need only the loopback Host; a browser read from another origin is the browser's own business", () => {
  assert.deepEqual(ownerCheck(req("GET", { host: "127.0.0.1:8890" })), { ok: true });
  assert.deepEqual(
    ownerCheck(req("HEAD", { host: "127.0.0.1:8890", origin: "https://example.invalid" })),
    { ok: true },
  );
});

test("a browser write must come from the Host's own origin; a sandboxed page (Origin null) or another port is refused", () => {
  const host = "127.0.0.1:8890";
  assert.equal(sameOrigin(req("POST", { host, origin: "http://127.0.0.1:8890" })), true);
  for (const origin of [
    "null",
    "http://127.0.0.1:8891",
    "https://127.0.0.1:8890",
    "http://localhost:8890",
    "https://example.invalid",
  ])
    assert.deepEqual(
      ownerCheck(req("POST", { host, origin, "content-type": "application/json" })),
      { ok: false, why: NOT_HERE },
      origin,
    );
  for (const method of ["DELETE", "PUT"])
    assert.deepEqual(
      ownerCheck(req(method, { host, origin: "null" })),
      { ok: false, why: NOT_HERE },
      method,
    );
});

test("a browser POST must be JSON (a page elsewhere can't send that without a preflight); other methods and scripts need not be", () => {
  const host = "localhost:8890",
    origin = "http://localhost:8890";
  for (const type of [
    undefined,
    "text/plain",
    "application/x-www-form-urlencoded",
    "multipart/form-data; boundary=x",
  ])
    assert.deepEqual(
      ownerCheck(req("POST", { host, origin, ...(type ? { "content-type": type } : {}) })),
      { ok: false, why: JSON_ONLY },
      String(type),
    );
  assert.deepEqual(
    ownerCheck(req("POST", { host, origin, "content-type": "application/json; charset=utf-8" })),
    { ok: true },
  );
  assert.deepEqual(
    ownerCheck(req("DELETE", { host, origin })),
    { ok: true },
    "a DELETE has no body to check",
  );
  assert.deepEqual(
    ownerCheck(req("POST", { host, "content-type": "text/plain" })),
    { ok: true },
    "no Origin: a script or agent here",
  );
});

test("the refusal is a 403 with plain words and never the data", () => {
  let head, body;
  refuse({ writeHead: (s, h) => (head = [s, h]), end: (b) => (body = b) }, NOT_HERE);
  assert.equal(head[0], 403);
  assert.equal(head[1]["cache-control"], "no-store");
  assert.deepEqual(JSON.parse(body), { ok: false, error: NOT_HERE });
});
