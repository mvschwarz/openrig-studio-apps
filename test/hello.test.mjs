// The Hello pair, the README's walkthrough: the provider answers its one route over real HTTP, and the page, run with a
// stand-in browser, asks that route and shows the answer. Copyright 2026 mvschwarz. Licensed under the Apache License, Version 2.0.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import vm from "node:vm";
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

async function provider() {
  const port = await freePort();
  const child = spawn(
    process.execPath,
    [path.join(ROOT, "providers/studio-hello/hello-server.mjs"), "--port", String(port)],
    {
      stdio: "ignore",
    },
  );
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`${base}/api/hello`);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  return { base, stop: () => child.kill() };
}

test("the provider answers GET /api/hello with a greeting, and nothing else", async (t) => {
  const p = await provider();
  t.after(p.stop);
  const ok = await fetch(`${p.base}/api/hello?name=${encodeURIComponent("Ada <3")}`);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("content-type"), "application/json");
  assert.deepEqual(await ok.json(), { ok: true, message: "Hello, Ada <3." });
  assert.deepEqual(await (await fetch(`${p.base}/api/hello`)).json(), {
    ok: true,
    message: "Hello, there.",
  });
  assert.equal(
    (await fetch(`${p.base}/api/hello?name=${"x".repeat(500)}`).then((r) => r.json())).message
      .length,
    "Hello, .".length + 80,
  );
  assert.equal(
    (
      await fetch(`${p.base}/api/hello`, {
        method: "POST",
        body: "{}",
        headers: { "content-type": "application/json" },
      })
    ).status,
    405,
  );
  assert.equal((await fetch(`${p.base}/api/other`)).status, 404);
});

test("the provider answers only this machine's Studio: a Host that isn't loopback is refused", async (t) => {
  const p = await provider();
  t.after(p.stop);
  const { port } = new URL(p.base);
  const status = await new Promise((resolve, reject) => {
    const req = net.connect(Number(port), "127.0.0.1", () =>
      req.write(
        "GET /api/hello HTTP/1.1\r\nHost: rebound.example.invalid\r\nConnection: close\r\n\r\n",
      ),
    );
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => resolve(Number(b.split(" ")[1])));
    req.on("error", reject);
  });
  assert.equal(status, 403);
});

test("the page asks /api/hello (a relative URL, on the Studio's origin) and shows the answer, or says why it couldn't", async (t) => {
  const p = await provider();
  t.after(p.stop);
  const html = fs.readFileSync(path.join(ROOT, "apps/hello/app/hello.html"), "utf8");
  const nodes = { name: { value: "Grace" }, answer: { textContent: "" }, ask: {} };
  let submit;
  nodes.ask.addEventListener = (ev, fn) => (submit = fn);
  const asked = [];
  const ctx = vm.createContext({
    document: { getElementById: (id) => nodes[id] },
    fetch: (url, opts) => (asked.push(url), fetch(new URL(url, p.base), opts)),
    encodeURIComponent,
  });
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], ctx);
  await submit({ preventDefault() {} });
  assert.deepEqual(asked, ["/api/hello?name=Grace"]);
  assert.equal(nodes.answer.textContent, "Hello, Grace.");
  ctx.fetch = async () => {
    throw new Error("connection refused");
  };
  await submit({ preventDefault() {} });
  assert.equal(nodes.answer.textContent, "Couldn't reach the provider: connection refused");
});

test("the manifest pairs the page with its provider through the one verb both name", () => {
  const app = JSON.parse(fs.readFileSync(path.join(ROOT, "apps/hello/app.json"), "utf8"));
  const prov = JSON.parse(
    fs.readFileSync(path.join(ROOT, "providers/studio-hello/provider.json"), "utf8"),
  );
  assert.equal(app.provider.package, prov.package);
  assert.deepEqual(Object.keys(app.calls), prov.verbs);
  assert.ok(
    fs.readFileSync(path.join(ROOT, "apps/hello/app/hello.html"), "utf8").split("\n").length <= 40,
    "Hello stays small",
  );
});

test("the README's walkthrough shows Hello's two manifests exactly as they are", () => {
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  for (const file of ["apps/hello/app.json", "providers/studio-hello/provider.json"]) {
    const at = readme.indexOf(`\`${file}\``);
    assert.ok(at >= 0, `the README names ${file}`);
    const block = readme.slice(at).match(/```json\n([\s\S]*?)```/)?.[1];
    assert.equal(block, fs.readFileSync(path.join(ROOT, file), "utf8"), file);
  }
});
