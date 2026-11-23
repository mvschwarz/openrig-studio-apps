// studio-host --socket: a unix socket, owner-only (0600) from the moment it exists, answering Files there; a leftover socket at the
// path is replaced, and anything else at the path refuses to start. Copyright 2026 mvschwarz. Licensed under the Apache License,
// Version 2.0.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SERVER = fileURLToPath(new URL("../providers/studio-host/host-server.mjs", import.meta.url));
const start = (sock, root) =>
  new Promise((resolve) => {
    const c = spawn(process.execPath, [SERVER, "--socket", sock, "--root", root], {
      env: { PATH: path.dirname(process.execPath), HOME: root, OPENRIG_STUDIO_DIR: root },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    c.stdout.on("data", (d) => {
      out += d;
      if (/unix:/.test(out)) resolve({ c, out });
    });
    c.stderr.on("data", (d) => (out += d));
    c.on("exit", (code) => resolve({ c, out, code }));
    // A provider that never says it's on the socket (one that ignored --socket) fails the test rather than hanging it.
    setTimeout(() => {
      c.kill();
      resolve({ c, out, code: "no socket in 5 s" });
    }, 5000).unref();
  });
const get = (sock, p) =>
  new Promise((resolve) =>
    http
      .get({ socketPath: sock, path: p, headers: { host: "localhost" } }, (r) => {
        let b = "";
        r.on("data", (d) => (b += d));
        r.on("end", () => resolve({ status: r.statusCode, body: b }));
      })
      .on("error", () => resolve({ status: 0 })),
  );

test("studio-host on a unix socket: 0600, answers Files there, replaces a leftover socket, refuses a file at the path", async (t) => {
  // The socket path stays short: a unix socket path has a small length limit.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sh-")));
  fs.chmodSync(dir, 0o700);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "note.txt"), "hello");
  const sock = path.join(dir, "files.sock");
  // A socket another running instance serves is never taken over: that start refuses and the socket keeps working.
  const live = net.createServer((x) => x.end()).listen(sock);
  await new Promise((r) => live.once("listening", r));
  const busy = await start(sock, dir);
  t.after(() => busy.c.kill());
  assert.equal(busy.code, 1, "a socket in use refuses to start");
  assert.match(busy.out, /in use by another running instance/, busy.out);
  assert.ok(fs.lstatSync(sock).isSocket(), "and the live socket is left alone");
  await new Promise((r) => live.close(r));
  // A socket a crashed run left behind (nothing answers on it) is replaced.
  const crashed = spawn(process.execPath, [
    "-e",
    `require("net").createServer().listen(${JSON.stringify(sock)}, () => process.kill(process.pid, "SIGKILL"))`,
  ]);
  await new Promise((r) => crashed.once("exit", r));
  assert.ok(fs.lstatSync(sock).isSocket(), "the crashed run's socket is still there");
  const { c, out } = await start(sock, dir);
  t.after(() => c.kill());
  assert.match(out, /unix:/, out);
  assert.equal(fs.statSync(sock).mode & 0o777, 0o600);
  const r = await get(sock, `/api/files/tree?dir=${encodeURIComponent(dir)}`);
  assert.equal(r.status, 200, r.body);
  assert.ok(JSON.parse(r.body).files.some((f) => f.name === "note.txt"));
  c.kill();
  const bad = path.join(dir, "not-a.sock");
  fs.writeFileSync(bad, "x");
  const res = await start(bad, dir);
  assert.equal(res.code, 1, "a regular file at the socket path refuses to start");
  assert.equal(fs.readFileSync(bad, "utf8"), "x", "and it isn't touched");
});

test("studio-host --socket refuses a folder others can write to", async (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sh-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.chmodSync(dir, 0o777);
  const res = await start(path.join(dir, "files.sock"), dir);
  t.after(() => res.c.kill());
  assert.equal(res.code, 1, res.out);
  assert.match(res.out, /writable by others/);
  assert.equal(fs.existsSync(path.join(dir, "files.sock")), false);
});
