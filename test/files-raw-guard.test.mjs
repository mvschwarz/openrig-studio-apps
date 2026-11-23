// Files: a file anyone wrote (an agent included) never runs as this Studio. Over real HTTP against studio-host: /api/files/raw
// sandboxes HTML (its own script still runs, as Files' preview frame allows, in an opaque origin), SVG and XML (no script; XML
// downloads), on the 200 and the 206 Range answer alike; PDF, images and media are unchanged. A write a browser sends must come
// from this Studio's own origin, as JSON; a caller that names no Origin (an agent or a script on this machine) still writes.
// Copyright 2026 mvschwarz. Licensed under the Apache License, Version 2.0.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { rawGuard, notTextFile, MIME } from "../providers/studio-host/host-backend.mjs";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const freePort = () =>
  new Promise((r) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => r(p));
    });
  });
async function host() {
  const port = await freePort(),
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "raw-guard-")));
  const env = { PATH: path.dirname(process.execPath), HOME: root, OPENRIG_STUDIO_DIR: root };
  const child = spawn(
    process.execPath,
    [
      path.join(REPO, "providers/studio-host/host-server.mjs"),
      "--port",
      String(port),
      "--root",
      root,
    ],
    { env, cwd: root, stdio: "ignore" },
  );
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`${base}/__ready`);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  return {
    base,
    root,
    stop: () => {
      child.kill();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
const FILES = {
  "page.html": [
    "<script>parent.x=1</script>",
    "text/html; charset=utf-8",
    "sandbox allow-scripts",
    undefined,
  ],
  "PAGE.HTM": ["<p>hi</p>", "text/html; charset=utf-8", "sandbox allow-scripts", undefined],
  "pic.svg": [
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    "image/svg+xml",
    "sandbox",
    undefined,
  ],
  "data.xml": ["<a/>", "application/octet-stream", "sandbox", "attachment"],
  "doc.pdf": ["%PDF-1.4\n%%EOF\n", "application/pdf", undefined, undefined],
  "shot.png": ["\x89PNG\r\n\x1a\n", "image/png", undefined, undefined],
  "clip.mp4": ["0000ftypmp42", "video/mp4", undefined, undefined],
  "notes.txt": ["hello", "text/plain; charset=utf-8", undefined, undefined],
};

test("rawGuard: html keeps its own script in a sandbox; svg/xml run nothing; xml downloads; pdf, images, media and text get nothing", () => {
  for (const [name, [, , csp, disp]] of Object.entries(FILES))
    assert.deepEqual(
      rawGuard("/w/" + name),
      {
        ...(csp ? { "content-security-policy": csp } : {}),
        ...(disp ? { "content-disposition": disp } : {}),
      },
      name,
    );
});

test("HTTP /api/files/raw: every type answers its own type, nosniff and its sandbox, on the full and the Range answer alike", async () => {
  const h = await host();
  try {
    for (const [name, [bytes, type, csp, disp]] of Object.entries(FILES)) {
      const f = path.join(h.root, name);
      fs.writeFileSync(f, bytes, "latin1");
      for (const range of [undefined, "bytes=0-1"]) {
        const r = await fetch(`${h.base}/api/files/raw?path=${encodeURIComponent(f)}`, {
          headers: range ? { range } : {},
        });
        const at = `${name}${range ? " (range)" : ""}`;
        assert.equal(r.status, range ? 206 : 200, at);
        assert.equal(r.headers.get("content-type"), type, at);
        assert.equal(r.headers.get("x-content-type-options"), "nosniff", at);
        assert.equal(r.headers.get("content-security-policy") ?? undefined, csp, at);
        assert.equal(r.headers.get("content-disposition") ?? undefined, disp, at);
        await r.arrayBuffer();
      }
    }
  } finally {
    h.stop();
  }
});

test("HTTP writes: a sandboxed page (Origin null), another origin or a non-JSON browser post is refused and changes nothing; Files' own JSON save and an agent's post (no Origin) still write", async () => {
  const h = await host();
  try {
    const f = path.join(h.root, "note.md");
    fs.writeFileSync(f, "before");
    const post = (route, headers, body) =>
      fetch(`${h.base}${route}`, { method: "POST", headers, body: JSON.stringify(body) }).then(
        async (r) => ({ status: r.status, j: await r.json().catch(() => null) }),
      );
    const save = (headers, content) =>
      post("/api/files/write", headers, { path: f, content, baseMtime: fs.statSync(f).mtimeMs });
    for (const [why, headers, words] of [
      [
        "sandboxed page",
        { origin: "null", "content-type": "application/json" },
        /didn't come from this machine's Studio/,
      ],
      [
        "another site",
        { origin: "https://example.invalid", "content-type": "application/json" },
        /didn't come from this machine's Studio/,
      ],
      [
        "another local port",
        { origin: "http://127.0.0.1:1", "content-type": "application/json" },
        /didn't come from this machine's Studio/,
      ],
      ["simple text post", { origin: h.base, "content-type": "text/plain" }, /as JSON/],
      [
        "form post",
        { origin: h.base, "content-type": "application/x-www-form-urlencoded" },
        /as JSON/,
      ],
    ]) {
      const r = await save(headers, "attacker");
      assert.equal(r.status, 403, why);
      assert.match(r.j.error, words, why);
      assert.equal(fs.readFileSync(f, "utf8"), "before", why);
    }
    for (const [why, route] of [
      ["goto", "/api/files/goto"],
      ["roots", "/api/files/roots"],
    ]) {
      assert.equal(
        (await post(route, { origin: "null", "content-type": "application/json" }, { path: f }))
          .status,
        403,
        why,
      );
    }
    assert.equal(
      (await save({ origin: h.base, "content-type": "application/json" }, "from the page")).status,
      200,
      "Files' own save",
    );
    assert.equal(fs.readFileSync(f, "utf8"), "from the page");
    assert.equal(
      (await save({ "content-type": "application/json" }, "from an agent")).status,
      200,
      "an agent on this machine (no Origin)",
    );
    assert.equal(
      (
        await post(
          "/api/files/goto",
          { "content-type": "application/x-www-form-urlencoded" },
          { path: f },
        )
      ).status,
      200,
      "an agent's bare curl -d goto still works",
    );
  } finally {
    h.stop();
  }
});

test("HTTP: a request whose Host isn't loopback (a page that pointed its own name at 127.0.0.1) is refused, reads included", async () => {
  const h = await host();
  try {
    fs.writeFileSync(path.join(h.root, "secret.txt"), "mine");
    const get = (hostHeader) =>
      new Promise((resolve, reject) => {
        const u = new URL(
          `${h.base}/api/files/read?path=${encodeURIComponent(path.join(h.root, "secret.txt"))}`,
        );
        http
          .get(
            {
              host: "127.0.0.1",
              port: u.port,
              path: u.pathname + u.search,
              headers: { host: hostHeader },
            },
            (r) => {
              let b = "";
              r.on("data", (c) => (b += c));
              r.on("end", () => resolve({ status: r.statusCode, body: b }));
            },
          )
          .on("error", reject);
      });
    const evil = await get("rebound.example.invalid:80");
    assert.equal(evil.status, 403);
    assert.doesNotMatch(evil.body, /mine/);
    for (const name of ["127.0.0.1:1234", "localhost:1234", "[::1]:1234"])
      assert.equal((await get(name)).status, 200, name);
  } finally {
    h.stop();
  }
});

test(
  "a named pipe is never opened by the write check (it would block the server); it isn't a regular file",
  { skip: process.platform === "win32" },
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "raw-fifo-")),
      fifo = path.join(root, "pipe");
    try {
      const { execFileSync } = await import("node:child_process");
      execFileSync("mkfifo", [fifo]);
      assert.equal(notTextFile(fifo), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

test("page: following a folder link removes the old editor at once (nothing typed while the tree opens is lost unasked)", () => {
  const html = fs.readFileSync(new URL("../apps/files/app/files.html", import.meta.url), "utf8");
  assert.match(html, /say\("Opening this folder…"\);[^\n]*\n\s*return revealOrSay\(p, version\);/);
});

// Drift guard: any type a browser runs script in when it's opened directly must be sandboxed by the raw route. A new entry in
// the MIME table with such a type fails here until rawGuard covers it.
test("every active type in the MIME table is sandboxed on the raw route", () => {
  const ACTIVE =
    /^(text\/html|application\/xhtml\+xml|image\/svg\+xml|(text|application)\/([\w.+-]+\+)?xml|application\/xslt\+xml)\b/i;
  const active = Object.entries(MIME).filter(([, type]) => ACTIVE.test(type));
  assert.ok(active.length >= 3, "the table's html/htm/svg are found: " + active.map(([e]) => e));
  for (const [ext] of active)
    assert.match(rawGuard("/w/x" + ext)["content-security-policy"] || "", /^sandbox\b/, ext);
});
