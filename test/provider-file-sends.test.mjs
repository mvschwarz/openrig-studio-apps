// No one request ends a provider, and nothing Canvas stores runs as this Studio. Over real HTTP against Files' provider
// (studio-host) and Canvas's (studio-artifacts): a range that can't be served is a 416, a file that can't be read is a plain
// refusal, and a request target that isn't a URL is a 400, each with the provider still answering afterwards. Canvas serves
// a stored document and a board with no script of its own, a saved view with no script at all, and its page frames them
// without script. Copyright 2026 mvschwarz. Licensed under the Apache License, Version 2.0.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { byteRange } from "../providers/lib/send-file.mjs";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOTED = typeof process.getuid === "function" && process.getuid() === 0;
const freePort = () =>
  new Promise((r) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => r(p));
    });
  });

async function provider(t, script, args) {
  const port = await freePort(),
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "file-sends-")));
  let log = "";
  const child = spawn(
    process.execPath,
    [path.join(REPO, script), "--port", String(port), ...args(root)],
    {
      env: { PATH: path.dirname(process.execPath), HOME: root, OPENRIG_STUDIO_DIR: root },
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    if ((await fetch(base).catch(() => null))?.ok) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  t.after(() => {
    child.kill();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const alive = async (why) => {
    assert.equal(child.exitCode, null, `${why}: the provider exited\n${log}`);
    assert.equal((await fetch(base)).status, 200, `${why}: the provider still answers`);
  };
  return { base, root, alive };
}

// A request target fetch won't send: the raw path goes on the request line as is.
const rawGet = (base, target) =>
  new Promise((resolve, reject) => {
    const u = new URL(base);
    http
      .get({ host: u.hostname, port: u.port, path: target }, (r) => {
        r.resume();
        r.on("end", () => resolve(r.statusCode));
      })
      .on("error", reject);
  });

test("byteRange: what a Range header asks of a file, and when it can't be served", () => {
  for (const [header, size, want] of [
    [undefined, 10, null],
    ["", 10, null],
    ["bytes=0-1", 10, { start: 0, end: 1 }],
    ["bytes=5-", 10, { start: 5, end: 9 }],
    ["bytes=5-200", 10, { start: 5, end: 9 }],
    ["bytes=-3", 10, { start: 7, end: 9 }],
    ["bytes=-30", 10, { start: 0, end: 9 }],
    ["bytes=5-2", 10, "unsatisfiable"],
    ["bytes=10-", 10, "unsatisfiable"],
    ["bytes=-0", 10, "unsatisfiable"],
    ["bytes=0-0", 0, "unsatisfiable"],
    ["bytes=99999999999999999999-", 10, "unsatisfiable"],
    ["bytes=-", 10, null],
    ["items=0-1", 10, null],
  ])
    assert.deepEqual(byteRange(header, size), want, `${header} of ${size}`);
});

test("Files: a backwards or past-the-end range is a 416, an unreadable file a refusal, a bad target a 400; the provider keeps answering", async (t) => {
  const h = await provider(t, "providers/studio-host/host-server.mjs", (root) => ["--root", root]);
  const file = path.join(h.root, "ten.txt");
  fs.writeFileSync(file, "0123456789");
  const raw = (f, range) =>
    fetch(`${h.base}/api/files/raw?path=${encodeURIComponent(f)}`, {
      headers: range ? { range } : {},
    });

  for (const range of ["bytes=5-2", "bytes=10-", "bytes=-0"]) {
    const r = await raw(file, range);
    assert.equal(r.status, 416, range);
    assert.equal(r.headers.get("content-range"), "bytes */10", range);
    await r.arrayBuffer();
    await h.alive(range);
  }
  for (const [range, status, body] of [
    [undefined, 200, "0123456789"],
    ["bytes=2-4", 206, "234"],
    ["bytes=-3", 206, "789"],
  ]) {
    const r = await raw(file, range);
    assert.equal(r.status, status, String(range));
    assert.equal(await r.text(), body, String(range));
  }

  if (!ROOTED) {
    const locked = path.join(h.root, "locked.txt");
    fs.writeFileSync(locked, "secret");
    fs.chmodSync(locked, 0o000);
    for (const range of [undefined, "bytes=0-1"]) {
      const r = await raw(locked, range);
      assert.equal(r.status, 403, `unreadable (${range})`);
      assert.doesNotMatch(await r.text(), /secret/);
      await h.alive(`unreadable (${range})`);
    }
  }

  assert.equal(await rawGet(h.base, "//x:99999/a"), 400);
  await h.alive("a target that isn't a URL");
});

test("Canvas: stored documents and boards run no script of their own, a saved view runs none; unreadable files and bad targets don't end the provider", async (t) => {
  const h = await provider(t, "providers/studio-artifacts/artifacts-server.mjs", (root) => [
    "--root",
    root,
  ]);
  const post = (route, body) =>
    fetch(`${h.base}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  assert.equal(
    (await post("/api/artifacts", { id: "doc", html: "<script>fetch('/api/artifacts')</script>" }))
      .status,
    201,
  );
  assert.equal((await post("/api/artifacts", { id: "board", type: "canvas" })).status, 201);
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
  const added = await (
    await post("/api/artifacts/assets?artifact=board", { mime: "image/png", data: png })
  ).json();
  assert.equal(
    (await post("/api/artifacts/screenshot?artifact=doc", { svg: "<svg><script/></svg>" })).status,
    200,
  );

  const headers = async (route) => {
    const r = await fetch(`${h.base}${route}`);
    await r.arrayBuffer();
    assert.equal(r.status, 200, route);
    return {
      csp: r.headers.get("content-security-policy"),
      nosniff: r.headers.get("x-content-type-options"),
    };
  };
  for (const route of ["/artifacts/doc/artifact.html", "/artifacts/board/artifact.html"]) {
    const { csp, nosniff } = await headers(route);
    assert.equal(nosniff, "nosniff", route);
    for (const rule of [
      "sandbox allow-same-origin",
      "script-src 'none'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'self'",
    ])
      assert.ok(csp?.split(/;\s*/).includes(rule), `${route}: ${rule} in ${csp}`);
  }
  assert.deepEqual(await headers("/api/artifacts/screenshot?artifact=doc"), {
    csp: "sandbox",
    nosniff: "nosniff",
  });
  assert.equal((await headers(added.item.src)).nosniff, "nosniff");

  if (!ROOTED) {
    const assetFile = path.join(h.root, "board", "assets", path.basename(added.item.src));
    for (const [why, file, route] of [
      ["document", path.join(h.root, "doc", "artifact.html"), "/artifacts/doc/artifact.html"],
      [
        "saved view",
        path.join(h.root, "doc", "screenshot.svg"),
        "/api/artifacts/screenshot?artifact=doc",
      ],
      ["asset", assetFile, added.item.src],
    ]) {
      fs.chmodSync(file, 0o000);
      const r = await fetch(`${h.base}${route}`);
      assert.equal(r.status, 403, why);
      await r.arrayBuffer();
      await h.alive(`unreadable ${why}`);
      fs.chmodSync(file, 0o644);
    }
  }

  assert.equal(await rawGet(h.base, "//x:99999/a"), 400);
  await h.alive("a target that isn't a URL");
});

test("Canvas's page frames a document without script, and keeps it same-origin so the page can reach into it", () => {
  const page = fs.readFileSync(path.join(REPO, "apps/canvas/app/canvas.html"), "utf8");
  const frame = page.match(/<iframe id="artifactFrame"[^>]*>/)?.[0] || "";
  const sandbox = frame.match(/\ssandbox="([^"]*)"/);
  assert.ok(sandbox, `the document frame has a sandbox: ${frame}`);
  assert.deepEqual(
    sandbox[1].split(/\s+/).filter(Boolean),
    ["allow-same-origin"],
    "allow-scripts beside allow-same-origin would let a document lift its own sandbox",
  );
});
