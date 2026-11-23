// A request target the URL parser rejects (GET //x:99999/a) is answered 400 and the provider keeps serving; it used to throw an
// unhandled rejection in the async handler and Node exited, so one request took the provider down.
// Copyright 2026 mvschwarz. Licensed under the Apache License, Version 2.0.
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const freePort = () =>
  new Promise((r) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => r(p));
    });
  });
// One raw request, so the target reaches the server exactly as written.
const raw = (port, line) =>
  new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1", () =>
      s.end(`${line}\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`),
    );
    let out = "";
    s.on("data", (b) => (out += b));
    s.on("close", () => resolve(out));
    s.on("error", () => resolve(out));
  });

for (const [name, file] of [
  ["studio-system", "providers/studio-system/system-server.mjs"],
  ["studio-hello", "providers/studio-hello/hello-server.mjs"],
]) {
  test(`${name}: a target the URL parser rejects gets 400, and the provider keeps serving`, async (t) => {
    const port = await freePort();
    const child = spawn(process.execPath, [path.join(ROOT, file), "--port", String(port)], {
      stdio: "ignore",
    });
    t.after(() => child.kill());
    for (let i = 0; i < 100; i++) {
      if ((await raw(port, "GET / HTTP/1.1")).startsWith("HTTP/1.1")) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const bad = await raw(port, "GET //x:99999/a HTTP/1.1");
    assert.match(bad, /^HTTP\/1\.1 400/, bad);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(child.exitCode, null, "the provider is still running");
    assert.match(
      await raw(port, "GET / HTTP/1.1"),
      /^HTTP\/1\.1 \d{3}/,
      "and answers the next request",
    );
  });
}
