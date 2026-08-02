import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = path.join(REPO, "providers", "studio-video", "export-server.mjs");

const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});

async function startProvider({ projectRoot, mediaRoot }) {
  const port = await freePort();
  const proc = spawn(process.execPath, [
    SERVER,
    "--port", String(port),
    "--slice-root", projectRoot,
    "--media-root", mediaRoot,
  ], { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  proc.stdout.on("data", (chunk) => { log += chunk; });
  proc.stderr.on("data", (chunk) => { log += chunk; });

  const endpoint = `http://127.0.0.1:${port}/api/library`;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (proc.exitCode != null) throw new Error(`provider exited ${proc.exitCode}:\n${log}`);
    try {
      const response = await fetch(endpoint);
      if (response.ok) return { proc, endpoint, log: () => log };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  proc.kill();
  throw new Error(`provider did not start:\n${log}`);
}

test("the library walks the media root the install actually declared", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "studio-media-root-"));
  const projectRoot = path.join(tmp, "project");
  const mediaRoot = path.join(tmp, "media");
  const outsideRoot = path.join(tmp, "outside");
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.mkdirSync(path.join(mediaRoot, "library"), { recursive: true });
  fs.mkdirSync(path.join(mediaRoot, "footage"), { recursive: true });
  fs.mkdirSync(outsideRoot, { recursive: true });

  const control = path.join(mediaRoot, "library", "known.mp4");
  const expected = path.join(mediaRoot, "footage", "expected.mp4");
  const outside = path.join(outsideRoot, "must-not-appear.mp4");
  fs.writeFileSync(control, "positive control");
  fs.writeFileSync(expected, "declared-root media");
  fs.writeFileSync(outside, "outside binding");

  const provider = await startProvider({ projectRoot, mediaRoot });
  t.after(() => { provider.proc.kill(); fs.rmSync(tmp, { recursive: true, force: true }); });

  const payload = await (await fetch(provider.endpoint)).json();
  assert.equal(payload.ok, true, JSON.stringify(payload));
  const paths = payload.assets.map((asset) => asset.path).sort();
  const realControl = fs.realpathSync(control);
  const realExpected = fs.realpathSync(expected);
  const realOutside = fs.realpathSync(outside);
  assert.ok(paths.includes(realControl), `positive control missing: the harness did not see root/library; payload=${JSON.stringify(payload)}`);
  assert.ok(paths.includes(realExpected), "media under the declared root's footage/ subtree was silently narrowed out");
  assert.ok(!paths.includes(realOutside), "provider escaped the declared media root");
});
