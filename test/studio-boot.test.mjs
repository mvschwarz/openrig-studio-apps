// End to end on the public Studio SDK: boot a Studio from the SDK's own launcher (tools/studio.mjs) with every app in this
// repository enabled, in a temporary Studio folder with its own home and port 0, and check that each app's page and the vendor
// files it loads are served, that each provider answers through the Studio's one origin, and that Hello round-trips from its
// page. Copyright 2026 mvschwarz. Licensed under the Apache License, Version 2.0.
//
//   STUDIO_SDK_DIR=<a checkout of the Studio SDK> npm test -- test/studio-boot.test.mjs
//
// Without STUDIO_SDK_DIR (or the SDK installed at node_modules/@openrig/studio) the test is skipped and says why. It is
// hermetic: a stand-in `rig` that always fails comes first on PATH, so the Studio never reads a real OpenRig, and HOME is a
// temporary folder. It stops the Studio it started and checks that none of its processes are left.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SDK = [process.env.STUDIO_SDK_DIR, path.join(ROOT, "node_modules/@openrig/studio")]
  .filter(Boolean)
  .map((d) => path.resolve(d))
  .find((d) => fs.existsSync(path.join(d, "tools/studio.mjs")));
const SKIP = SDK ? false : "set STUDIO_SDK_DIR to a checkout of the Studio SDK to boot one";
const onPath = (name) =>
  (process.env.PATH || "")
    .split(path.delimiter)
    .map((d) => path.join(d, name))
    .find((f) => {
      try {
        fs.accessSync(f, fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
const TTYD = onPath("ttyd");
const APPS = fs
  .readdirSync(path.join(ROOT, "apps"))
  .filter((a) => fs.existsSync(path.join(ROOT, "apps", a, "app.json")))
  .sort();

// Every process whose command line names this run's folder: the Studio's children all do (their roots, state and surfaces
// live under it), so after a stop this must be empty.
const leftovers = (dir) =>
  execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" })
    .split("\n")
    .filter((l) => l.includes(dir) && !l.includes("ps -axo"));

// apps and roots: which apps this Studio enables and which root kinds it binds (each named kind gets its own folder); by default
// every app, with a project and an artifacts root.
async function bootStudio(
  t,
  extraEnv = {},
  { apps = APPS, roots = ["project", "artifacts"] } = {},
) {
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "studio-boot-")));
  const studio = path.join(work, "studio"),
    home = path.join(work, "home"),
    bin = path.join(work, "bin");
  const project = path.join(work, "project"),
    artifacts = path.join(work, "artifacts");
  for (const d of [studio, home, bin, project, artifacts]) fs.mkdirSync(d, { recursive: true });
  const bound = Object.fromEntries(
    roots.map((kind) => {
      const dir = path.join(work, kind);
      fs.mkdirSync(dir, { recursive: true });
      return [kind, dir];
    }),
  );
  fs.writeFileSync(
    path.join(project, "README.md"),
    "# A project\n\nBound to the Studio's project root.\n",
  );
  fs.writeFileSync(
    path.join(bin, "rig"),
    "#!/bin/sh\necho 'rig: not here in this test' >&2\nexit 3\n",
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(studio, "studio.json"),
    JSON.stringify({ apps, appsRoot: ROOT, port: 0, roots: bound }, null, 2),
  );
  // No agents in this Studio: the roster is declared empty, so the launcher attaches no seat terminals.
  fs.writeFileSync(path.join(studio, "surfaces.json"), JSON.stringify({ chatSeats: [] }));

  const child = spawn(process.execPath, [path.join(SDK, "tools/studio.mjs"), "--port", "0"], {
    cwd: studio,
    env: {
      PATH: [bin, path.dirname(process.execPath), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(
        path.delimiter,
      ),
      HOME: home,
      TMPDIR: work,
      OPENRIG_STUDIO_DIR: studio,
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  const origin = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`the Studio didn't start in 30 s:\n${log}`)),
      30000,
    );
    const seen = (d) => {
      log += d;
      const m = /studio: (http:\/\/127\.0\.0\.1:\d+)\//.exec(log);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    };
    child.stdout.on("data", seen);
    child.stderr.on("data", (d) => (log += d));
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`the Studio exited (${code}) before it started:\n${log}`));
    });
  });
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((r) => child.once("exit", r));
      child.kill("SIGTERM");
      await exited;
    }
    for (let i = 0; i < 40 && leftovers(work).length; i++)
      await new Promise((r) => setTimeout(r, 100));
  };
  t.after(async () => {
    await stop();
    fs.rmSync(work, { recursive: true, force: true });
  });
  // Every child up and listening: the launcher's own health check.
  let health = null;
  for (let i = 0; i < 100; i++) {
    const r = await fetch(`${origin}/healthz`).catch(() => null);
    health = r && (await r.json().catch(() => null));
    if (r?.status === 200 && health?.ok) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  return { origin, work, studio, project, bound, child, stop, health, log: () => log };
}

test(
  "a Studio booted from the public SDK serves every app, every provider answers, and Hello round-trips",
  { skip: SKIP, timeout: 120000 },
  async (t) => {
    const s = await bootStudio(t);
    const { origin } = s;
    const get = async (p, init) => {
      const r = await fetch(origin + p, init);
      const text = await r.text();
      let body = null;
      try {
        body = JSON.parse(text);
      } catch {}
      return { status: r.status, type: r.headers.get("content-type") || "", text, body };
    };
    const post = (p, body) =>
      get(p, {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify(body),
      });

    await t.test(
      "the launcher composed every app, started every provider and reports them all healthy",
      () => {
        assert.ok(s.health?.ok, `health: ${JSON.stringify(s.health)}\n${s.log()}`);
        const labels = s.health.children.map((c) => c.label ?? c.name ?? "").join(" ");
        for (const p of [
          "@openrig/studio-hello",
          "@openrig/studio-artifacts",
          "@openrig/studio-host",
          "@openrig/studio-system",
        ])
          assert.ok(labels.includes(p), `${p} runs (${labels})`);
        assert.doesNotMatch(s.log(), /MISSING|refusing|Refusing/, s.log());
        const rail = JSON.parse(
          fs.readFileSync(path.join(s.studio, ".runtime/surfaces/surfaces.json"), "utf8"),
        );
        for (const id of APPS)
          assert.ok(
            rail.surfaces.some((r) => r.id === id),
            `${id} is on the rail`,
          );
      },
    );

    await t.test(
      "each app's page loads, and every vendor file it links answers with its own type",
      async () => {
        for (const id of APPS) {
          const m = JSON.parse(fs.readFileSync(path.join(ROOT, "apps", id, "app.json"), "utf8"));
          const page = await get(m.surface.path);
          assert.equal(page.status, 200, `${id}: ${m.surface.path}`);
          assert.match(page.type, /text\/html/, id);
          assert.match(page.text, /<title>/, id);
          const links = [
            ...page.text.matchAll(/["'(](\/vendor\/[\w./-]+(?:\?v=[0-9a-f]{64})?)/g),
          ].map((x) => x[1]);
          for (const link of links) {
            const r = await get(link);
            assert.equal(r.status, 200, `${id}: ${link}`);
            if (link.includes(".css")) assert.match(r.type, /text\/css/, link);
            if (/\.m?js\b/.test(link)) assert.match(r.type, /javascript/, link);
            for (const [, imp] of r.text.matchAll(/@import url\("([^"]+)"\)/g))
              assert.equal((await get(imp)).status, 200, `${link} imports ${imp}`);
          }
        }
      },
    );

    await t.test(
      "Hello: the provider answers through the Studio, and the page it serves round-trips",
      async () => {
        assert.deepEqual((await get("/api/hello?name=Proof")).body, {
          ok: true,
          message: "Hello, Proof.",
        });
        const html = (await get("/surfaces/hello.html")).text;
        const nodes = { name: { value: "Round trip" }, answer: { textContent: "" }, ask: {} };
        let submit;
        nodes.ask.addEventListener = (ev, fn) => (submit = fn);
        const ctx = vm.createContext({
          document: { getElementById: (id) => nodes[id] },
          fetch: (u, o) => fetch(new URL(u, origin), o),
          encodeURIComponent,
        });
        vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], ctx);
        await submit({ preventDefault() {} });
        assert.equal(nodes.answer.textContent, "Hello, Round trip.");
      },
    );

    await t.test(
      "Canvas: studio-artifacts creates, lists and reads back a document, and serves it on its byte route",
      async () => {
        assert.equal((await get("/api/artifacts")).status, 200);
        const made = await post("/api/artifacts", {
          id: "proof",
          name: "Proof",
          html: "<h1>Proof page</h1>",
        });
        assert.equal(made.status, 201, made.text);
        assert.ok((await get("/api/artifacts")).body.artifacts.some((a) => a.id === "proof"));
        const item = await get("/api/artifacts/item?id=proof");
        assert.equal(item.status, 200, item.text);
        assert.match(JSON.stringify(item.body), /Proof page/);
        assert.equal((await get("/api/annotations")).status, 200);
        // A pasted image is stored with the document and served on the provider's /artifacts/ byte route, through the Studio.
        const png = Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg==",
          "base64",
        );
        const pasted = await post("/api/artifacts/assets?artifact=proof", {
          mime: "image/png",
          data: png.toString("base64"),
          name: "dot",
        });
        assert.equal(pasted.status, 201, pasted.text);
        const bytes = await fetch(origin + pasted.body.item.src);
        assert.equal(bytes.status, 200);
        assert.equal(bytes.headers.get("content-type"), "image/png");
        assert.deepEqual(Buffer.from(await bytes.arrayBuffer()), png);
        const refused = await get("/api/artifacts", {
          method: "POST",
          headers: { "content-type": "application/json", origin: "https://example.invalid" },
          body: JSON.stringify({ id: "nope", name: "Nope", html: "x" }),
        });
        assert.equal(
          refused.status,
          403,
          "a write from another origin is refused through the Studio too",
        );
      },
    );

    await t.test(
      "Files: studio-host lists the bound project root, reads it, and writes through the Studio's origin",
      async () => {
        const roots = (await get("/api/files/roots")).body;
        assert.deepEqual(roots.roots, [s.project]);
        const tree = (await get("/api/files/tree")).body;
        assert.equal(tree.path, s.project);
        assert.ok(tree.files.some((f) => f.name === "README.md"));
        const file = path.join(s.project, "README.md");
        const read = (await get(`/api/files/read?path=${encodeURIComponent(file)}`)).body;
        assert.equal(read.kind, "markdown");
        const wrote = await post("/api/files/write", {
          path: file,
          content: "# Edited in Files\n",
          baseMtime: read.mtime,
        });
        assert.equal(wrote.status, 200, wrote.text);
        assert.equal(fs.readFileSync(file, "utf8"), "# Edited in Files\n");
        assert.equal(
          (await get(`/api/files/read?path=${encodeURIComponent("/etc/hosts")}`)).status,
          400,
          "outside the roots",
        );
      },
    );

    await t.test("Machine: studio-system reads this machine and lists its safe fixes", async () => {
      const st = await get("/api/system/status");
      assert.equal(st.status, 200, st.text);
      assert.equal(st.body.ok, true);
      assert.ok(["ok", "warn", "urgent", "unknown"].includes(st.body.storage.state));
      assert.ok(Array.isArray(st.body.fixes));
      assert.equal(
        (
          await get("/api/system/clean", {
            method: "POST",
            headers: { "content-type": "text/plain" },
            body: "{}",
          })
        ).status,
        415,
      );
    });

    await t.test(
      "Workspace: the runtime's verbs answer, and the observe state is the live companion's honest 'no rig here'",
      async () => {
        assert.equal((await get("/api/contract")).status, 200);
        assert.ok(Array.isArray((await get("/surfaces.json")).body?.surfaces));
        let fsState = null;
        for (let i = 0; i < 50; i++) {
          fsState = (await get("/api/factory/state")).body;
          if (fsState?.attached === false) break;
          await new Promise((r) => setTimeout(r, 200));
        }
        assert.equal(fsState.ok, true);
        assert.equal(fsState.attached, false, JSON.stringify(fsState));
        assert.equal(
          fsState.reason,
          "rig-error",
          "the stand-in rig failed, and the floor says so instead of inventing a rig",
        );
        assert.deepEqual(fsState.seats, []);
      },
    );

    await t.test("Rig Designer: its own drive slot round-trips an op an agent posts", async () => {
      const op = {
        surface: "rig-designer",
        designer: { action: "add-pod", pod: "dev", role: "writes the code" },
      };
      const sent = await post("/api/drive", op);
      assert.equal(sent.status, 200, sent.text);
      const slot = (await get("/api/drive?surface=rig-designer")).body;
      assert.deepEqual(slot.op.designer, op.designer);
      assert.equal((await get("/vendor/rig-designer/spec.mjs")).status, 200);
    });

    await t.test(
      "Terminal: the place says no terminal is set up here, and why, so the page can say so",
      async () => {
        const place = (await get("/api/studio/place")).body;
        assert.equal(place.terminal, null);
        assert.equal(place.terminals.terminal.state, "not-configured");
        // An SDK that starts its own shell says to install ttyd; an older one says to set the socket. Either is a reason.
        assert.match(
          place.terminals.terminal.reason,
          /STUDIO_TERMINAL_SOCKET|ttyd isn't installed/,
        );
      },
    );

    await t.test("stopping the Studio leaves none of its processes behind", async () => {
      await s.stop();
      assert.deepEqual(leftovers(s.work), []);
    });
  },
);

test(
  "Terminal with a real shell listener: the SDK's start-terminal serves /terminal/, the place names it, and the Studio serves its page",
  {
    skip: SKIP || (TTYD ? false : "ttyd isn't installed, so no terminal listener can start"),
    timeout: 120000,
  },
  async (t) => {
    // A Unix socket path is limited to about 100 bytes, so the listener's folder is kept short.
    let sockDir = fs.mkdtempSync(path.join(os.tmpdir(), "t-"));
    if (Buffer.byteLength(path.join(sockDir, "shell.sock")) > 100) {
      fs.rmSync(sockDir, { recursive: true, force: true });
      sockDir = fs.mkdtempSync("/tmp/sbt-");
    }
    const socket = path.join(sockDir, "shell.sock");
    const env = { STUDIO_TERMINAL_SOCKET: socket, STUDIO_TTYD_BIN: TTYD, SHELL: "/bin/sh" };
    const listener = spawn(
      process.execPath,
      [path.join(SDK, "tools/start-terminal.mjs"), "shell"],
      {
        env: {
          PATH: [path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter),
          HOME: sockDir,
          ...env,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let out = "";
    t.after(async () => {
      if (listener.exitCode === null && listener.signalCode === null) {
        const exited = new Promise((r) => listener.once("exit", r));
        listener.kill("SIGTERM");
        await exited;
      }
      for (let i = 0; i < 40 && leftovers(sockDir).length; i++)
        await new Promise((r) => setTimeout(r, 100));
      assert.deepEqual(leftovers(sockDir), [], "the listener and its ttyd are gone");
      fs.rmSync(sockDir, { recursive: true, force: true });
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`the terminal listener didn't start:\n${out}`)),
        15000,
      );
      const seen = (d) => {
        out += d;
        if (/Terminal ready: \/terminal\//.test(out)) {
          clearTimeout(timer);
          resolve();
        }
      };
      listener.stdout.on("data", seen);
      listener.stderr.on("data", (d) => (out += d));
    });
    const s = await bootStudio(t, env);
    const place = await (await fetch(`${s.origin}/api/studio/place`)).json();
    assert.equal(place.terminal, "/terminal/");
    const page = await fetch(`${s.origin}/terminal/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<html/i, "ttyd's page, through the Studio's origin");
    const app = await fetch(`${s.origin}/surfaces/terminal.html`);
    assert.equal(app.status, 200);
    await s.stop();
    assert.deepEqual(leftovers(s.work), []);
  },
);

// Files names three root kinds and needs none in particular: a box binds whichever it has. One that binds only media and work
// (as a hosted box does) composes Files, and its folder list is exactly those two.
test(
  "Files declares no single root as required, and a Studio that binds only media and work serves it with those two folders",
  { skip: SKIP, timeout: 120000 },
  async (t) => {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "apps/files/app.json"), "utf8"));
    for (const [kind, spec] of Object.entries(manifest.roots))
      assert.equal(spec.required, false, `Files must not require the ${kind} root`);
    const s = await bootStudio(t, {}, { apps: ["files"], roots: ["media", "work"] });
    assert.equal((await fetch(`${s.origin}/surfaces/files.html`)).status, 200, s.log());
    const r = await fetch(`${s.origin}/api/files/roots`);
    assert.equal(r.status, 200, s.log());
    assert.deepEqual((await r.json()).roots.sort(), [s.bound.media, s.bound.work].sort());
    await s.stop();
  },
);
