// Terminal on a real Studio that serves the agents view: the public SDK's own launcher behind a stand-in admission hook (it admits
// everyone as the owner), with stand-in Herdr and ttyd listeners on private Unix sockets. The place advertises the agents' watch and
// type paths, the page shows a tile per agent from the Studio's own /api/agents/terminals, and each tile's frame is the advertised
// watch path, which the Studio serves (its page over HTTP, its WebSocket at <watch>ws). Copyright 2026 mvschwarz. Licensed under the
// Apache License, Version 2.0.
//
//   STUDIO_SDK_DIR=<a checkout of the Studio SDK> npm test -- test/terminal-agents.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { T, all, runPage } from "./terminal-page.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SDK = [process.env.STUDIO_SDK_DIR, path.join(ROOT, "node_modules/@openrig/studio")]
  .filter(Boolean)
  .map((d) => path.resolve(d))
  .find((d) => fs.existsSync(path.join(d, "tools/hosted-terminals.mjs")));
const SKIP = SDK
  ? false
  : "set STUDIO_SDK_DIR to a checkout of the Studio SDK (one with tools/hosted-terminals.mjs) to boot one";
const ORIGIN = "https://box.example.invalid";
const T1 = "term_65ec4de94ab672",
  T2 = "term_65ec4de94c37a4";
const delay = (n) => new Promise((r) => setTimeout(r, n));

// Admits every request and upgrade as the owner. Only for this test: a real deployment's hook signs people in.
const HOOK = `export default function install() {
  const owner = () => ({ workspace: "full", access: "owner", email: "owner@example.invalid", exp: Math.floor(Date.now() / 1000) + 3600 });
  return {
    describe: "test door: everyone is the owner",
    admission: { http: (req, res, next) => next(owner()), upgrade: (req, socket, head, next) => next(owner()) },
  };
}
`;

// A stand-in Herdr: two labelled agent panes, each a tmux attach in the foreground.
function fakeHerdr(dir) {
  const bin = path.join(dir, "herdr");
  const panes = [
    { pane_id: "w1:p2", terminal_id: T1, label: "app.builder", agent_status: "working" },
    { pane_id: "w1:p4", terminal_id: T2, label: "app.checker", agent_status: "idle" },
  ];
  fs.writeFileSync(
    bin,
    `#!${process.execPath}
const a = process.argv.slice(2), out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
if (a[0] === "pane" && a[1] === "list") out({ result: { type: "pane_list", panes: ${JSON.stringify(panes)} } });
else if (a[0] === "pane" && a[1] === "process-info") out({ result: { process_info: { foreground_processes: [{ argv0: "tmux", argv: ["tmux", "attach", "-t", "x"] }] } } });
`,
    { mode: 0o755 },
  );
  return bin;
}

// A stand-in ttyd on a private Unix socket: its page over HTTP and a WebSocket that answers 101; records what reached it.
async function fakeTtyd(t, socketPath) {
  const seen = [],
    sockets = new Set();
  const server = http.createServer((req, res) => {
    seen.push(`GET ${req.url}`);
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><title>ttyd</title><p>tile ${req.url}</p>`);
  });
  server.on("upgrade", (req, socket) => {
    seen.push(`WS ${req.url}`);
    const accept = crypto
      .createHash("sha1")
      .update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ${accept}\r\n\r\n`,
    );
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
  });
  await new Promise((r) => server.listen(socketPath, r));
  fs.chmodSync(socketPath, 0o600);
  t.after(
    () =>
      new Promise((r) => {
        for (const s of sockets) s.destroy();
        server.closeAllConnections?.();
        server.close(r);
      }),
  );
  return seen;
}

const upgrade = (port, p, headers) =>
  new Promise((resolve) => {
    const c = net.connect(port, "127.0.0.1", () =>
      c.write(
        `GET ${p} HTTP/1.1\r\nhost: 127.0.0.1:${port}\r\nupgrade: websocket\r\nconnection: Upgrade\r\n` +
          `sec-websocket-key: ${crypto.randomBytes(16).toString("base64")}\r\nsec-websocket-version: 13\r\n` +
          Object.entries(headers)
            .map(([k, v]) => `${k}: ${v}\r\n`)
            .join("") +
          "\r\n",
      ),
    );
    let b = "";
    c.on("data", (d) => {
      b += d;
      if (b.includes("\r\n\r\n")) {
        resolve(b.split("\r\n")[0]);
        c.destroy();
      }
    });
    c.on("error", () => resolve("error"));
    c.on("close", () => resolve(b.split("\r\n")[0] || "closed"));
  });

test(
  "a Studio that serves the agents view: the place advertises it, and the page's tiles frame the advertised watch path",
  { skip: SKIP },
  async (t) => {
    const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "term-agents-")));
    t.after(() => fs.rmSync(work, { recursive: true, force: true }));
    const studio = path.join(work, "studio"),
      sock = path.join(work, "s"),
      bin = path.join(work, "bin");
    for (const d of [studio, sock, bin]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    fs.symlinkSync(process.execPath, path.join(bin, "node"));
    const watched = await fakeTtyd(t, path.join(sock, "w.sock"));
    await fakeTtyd(t, path.join(sock, "y.sock"));
    fs.writeFileSync(path.join(studio, "door.mjs"), HOOK);
    fs.writeFileSync(path.join(studio, "surfaces.json"), JSON.stringify({ chatSeats: [] }));
    fs.writeFileSync(
      path.join(studio, "studio.json"),
      JSON.stringify({
        port: 0,
        apps: ["terminal"],
        appsRoot: ROOT,
        rig: false,
        serverHooks: "door.mjs",
      }),
    );
    const child = spawn(process.execPath, [path.join(SDK, "tools/studio.mjs")], {
      env: {
        PATH: bin,
        HOME: work,
        TMPDIR: work,
        OPENRIG_STUDIO_DIR: studio,
        SIGNIN_ORIGINS: ORIGIN,
        STUDIO_AGENTS_WATCH_SOCKET: path.join(sock, "w.sock"),
        STUDIO_AGENTS_TYPE_SOCKET: path.join(sock, "y.sock"),
        STUDIO_HERDR_BIN: fakeHerdr(work),
        STUDIO_RIG_NAME: "rig1",
      },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "",
      port = null;
    child.stdout.on("data", (b) => {
      log += b;
      port ??= Number(log.match(/studio: http:\/\/127\.0\.0\.1:(\d+)\//)?.[1]) || null;
    });
    child.stderr.on("data", (b) => (log += b));
    t.after(async () => {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        /* already gone */
      }
      await delay(200);
    });
    const origin = () => `http://127.0.0.1:${port}`;
    for (let i = 0; i < 300; i++) {
      if (child.exitCode !== null) throw new Error(log);
      if (port && (await fetch(`${origin()}/healthz`).catch(() => null))?.status === 200) break;
      await delay(50);
    }
    assert.ok(port, log);

    const place = await (await fetch(`${origin()}/api/studio/place`)).json();
    assert.equal(place.profile, "hosted");
    assert.ok(
      T.agentsOf(place),
      `the place advertises the agents view: ${JSON.stringify(place.agents)}`,
    );
    assert.equal((await fetch(`${origin()}/surfaces/terminal.html`)).status, 200);

    // The page itself, its requests answered by this Studio.
    const p = await runPage((url, init) => fetch(origin() + url, init), { hash: "#agents" });
    for (let i = 0; i < 40 && !all(p.nodes.screen).some((e) => e.tagName === "IFRAME"); i++) {
      await delay(50);
      await p.settle();
    }
    assert.ok(p.fetched.includes("/api/agents/terminals"), p.fetched.join(" "));
    const frames = all(p.nodes.screen).filter((e) => e.tagName === "IFRAME");
    const paths = T.agentsOf(place);
    assert.deepEqual(
      frames.map((f) => f.src),
      [T1, T2].map((id) => T.tileUrl(paths, id)),
      log,
    );
    const heads = all(p.nodes.screen)
      .filter((e) => /class="tile-head"/.test(e.markup ?? ""))
      .map((e) => e.markup)
      .join("");
    assert.match(heads, /app-builder@rig1/, "named by the session the Studio gives");

    // Each tile's frame is served by this Studio from the agents' watch listener, and its WebSocket is <watch>ws.
    const page = await fetch(origin() + frames[0].src);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /tile /);
    assert.ok(watched.some((s) => s.startsWith("GET ")));
    const ws = await upgrade(port, `${paths.watch}ws?arg=${T1}`, { origin: ORIGIN });
    assert.match(ws, / 101 /);
    assert.ok(
      watched.includes(`WS ${paths.watch}ws?arg=${T1}`),
      `the watch listener got the tile's own terminal: ${watched.join(" | ")}`,
    );
  },
);
