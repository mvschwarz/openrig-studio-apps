// A deployment replaces providers/lib/owner-check.mjs to change who the providers answer, and its check may be async (one that
// asks a sign-in service). Every provider here, run over real HTTP with such a replacement: a request goes on only when the check
// says yes, a no is the replacement's own refusal, and a check that rejects refuses. Copyright 2026 mvschwarz. Licensed under the
// Apache License, Version 2.0.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const freePort = () =>
  new Promise((r) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => r(p));
    });
  });

// The replacement: it answers only after a while, says yes for one header value, and throws for another.
const SWAP = `
export async function ownerCheck(req) {
  await new Promise((r) => setTimeout(r, 40));
  const who = req.headers["x-check-says"];
  if (who === "throw") throw new Error("the sign-in service is down");
  if (who === "hang") await new Promise(() => {});
  return who === "yes" ? { ok: true } : { ok: false, why: "not the signed-in owner" };
}
export function refuse(res, why) {
  res.writeHead(403, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: false, error: why, signIn: true }));
}
`;

// Each provider, a request it answers once admitted, and that answer's status.
const PROVIDERS = [
  ["studio-host", "host-server.mjs", (root) => ["--root", root], "/api/files/roots", 200],
  ["studio-artifacts", "artifacts-server.mjs", (root) => ["--root", root], "/api/artifacts", 200],
  ["studio-system", "system-server.mjs", () => [], "/api/system/nope", 404],
  ["studio-hello", "hello-server.mjs", () => [], "/api/hello?name=x", 200],
];

for (const [pkg, file, args, route, admitted] of PROVIDERS)
  test(`${pkg}: an async owner check from a replaced owner-check.mjs is awaited, and nothing goes on before it says yes`, async (t) => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "owner-swap-")));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.cpSync(path.join(REPO, "providers", "lib"), path.join(dir, "providers", "lib"), {
      recursive: true,
    });
    fs.cpSync(path.join(REPO, "providers", pkg), path.join(dir, "providers", pkg), {
      recursive: true,
    });
    fs.writeFileSync(path.join(dir, "providers", "lib", "owner-check.mjs"), SWAP);
    const root = path.join(dir, "root");
    fs.mkdirSync(root);
    const port = await freePort();
    let log = "";
    const child = spawn(
      process.execPath,
      [path.join(dir, "providers", pkg, file), "--port", String(port), ...args(root)],
      {
        env: {
          PATH: path.dirname(process.execPath),
          HOME: dir,
          OPENRIG_STUDIO_DIR: dir,
          OPENRIG_OWNER_CHECK_MS: "400",
        },
        cwd: dir,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout.on("data", (d) => (log += d));
    child.stderr.on("data", (d) => (log += d));
    t.after(() => child.kill());
    const get = (who) =>
      fetch(`http://127.0.0.1:${port}${route}`, { headers: who ? { "x-check-says": who } : {} });
    for (let i = 0; i < 100; i++) {
      if (await get("no").catch(() => null)) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    const yes = await get("yes");
    await yes.arrayBuffer();
    assert.equal(yes.status, admitted, `admitted: ${log}`);
    for (const who of ["no", null]) {
      const r = await get(who);
      assert.equal(r.status, 403, `${who}: refused`);
      assert.deepEqual(await r.json(), {
        ok: false,
        error: "not the signed-in owner",
        signIn: true,
      });
    }
    // A write that isn't JSON, from someone who isn't the owner, gets the owner refusal: who's asking is checked first.
    const notJson = await fetch(`http://127.0.0.1:${port}${route}`, {
      method: "POST",
      headers: { "content-type": "text/plain", "x-check-says": "no" },
      body: "x",
    });
    assert.equal(
      notJson.status,
      403,
      `${pkg}: a stranger's non-JSON write is refused as a stranger`,
    );
    await notJson.arrayBuffer();
    const down = await get("throw");
    assert.equal(down.status, 403, "a check that throws refuses");
    assert.equal((await down.json()).signIn, true);
    // A check that never answers is a refusal once its time is up, so one hung sign-in service can't hold every request.
    const started = Date.now();
    const hung = await get("hang");
    assert.equal(hung.status, 403, "a check that never answers refuses");
    await hung.arrayBuffer();
    assert.ok(Date.now() - started < 5000, "within the bound");
    assert.equal(child.exitCode, null, `the provider still runs\n${log}`);
  });
