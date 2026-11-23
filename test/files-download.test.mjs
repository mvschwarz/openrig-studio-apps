// Files' Download and Save actions, run against the page's own script with a stand-in browser. Copyright 2026 mvschwarz. Licensed
// under the Apache License, Version 2.0.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const html = fs.readFileSync(
  process.env.FILES_HTML || new URL("../apps/files/app/files.html", import.meta.url),
  "utf8",
);
async function page(mode = "files", embedded = false) {
  const nodes = new Map(),
    messages = [],
    downloads = [],
    requests = [],
    blobs = new Map(),
    timers = [];
  const node = (id) => {
    if (!nodes.has(id))
      nodes.set(id, {
        hidden: false,
        innerHTML: "",
        textContent: "",
        value: "",
        classList: { add() {}, remove() {} },
        addEventListener() {},
      });
    return nodes.get(id);
  };
  let rawStatus = 200,
    readOK = true,
    deferReads = false,
    discard = true;
  const confirmations = [];
  const pending = [];
  const bytes = Buffer.from([0, 255, 13, 10, 195, 169, 0]);
  const document = {
    getElementById: node,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    body: { appendChild() {} },
    createElement: () => ({
      click() {
        downloads.push({ name: this.download, blob: blobs.get(this.href) });
      },
      remove() {},
    }),
  };
  const window = {
    addEventListener(name, fn) {
      this[name] = fn;
    },
    postMessage(m) {
      messages.push(m);
    },
  };
  const parent = embedded
    ? {
        postMessage(m) {
          messages.push(m);
        },
      }
    : window;
  class ObjectURL extends URL {
    static createObjectURL(blob) {
      const key = "blob:test-" + blobs.size;
      blobs.set(key, blob);
      return key;
    }
    static revokeObjectURL(key) {
      blobs.delete(key);
    }
  }
  const fetch = async (path, opts = {}) => {
    requests.push({ path, method: opts.method || "GET" });
    if (path.startsWith("/api/files/raw?"))
      return { ok: rawStatus === 200, blob: async () => new Blob([bytes]) };
    if (deferReads && path.startsWith("/api/files/read?"))
      return new Promise((resolve) =>
        pending.push((data) => resolve({ status: 200, json: async () => data })),
      );
    const data =
      path === "/api/studio/place"
        ? { workspace: mode }
        : path === "/api/files/roots"
          ? { roots: [] }
          : path.startsWith("/api/files/read?")
            ? { ok: readOK, kind: "text", content: "preview is not original bytes", mtime: 1 }
            : {};
    return { status: 200, json: async () => data };
  };
  const ctx = vm.createContext({
    window,
    parent,
    document,
    fetch,
    URL: ObjectURL,
    URLSearchParams,
    AbortSignal,
    location: { hash: "" },
    addEventListener() {},
    setInterval() {},
    clearInterval() {},
    clearTimeout() {},
    setTimeout(fn) {
      timers.push(fn);
    },
    confirm: (message) => {
      confirmations.push(message);
      return discard;
    },
    console,
  });
  await vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], ctx);
  return {
    node,
    messages,
    downloads,
    requests,
    bytes,
    blobs,
    timers,
    state: window.__files.st,
    open: (p) => window.__files.openFile(p),
    click: () => node("downloadFile").onclick?.(),
    shellClick: async () => {
      window.message({ data: { t: "header-action", id: "download" } });
      await new Promise((r) => setImmediate(r));
    },
    pending,
    deferReads: () => {
      deferReads = true;
    },
    denyRaw: () => {
      rawStatus = 403;
    },
    denyRead: () => {
      readOK = false;
    },
    confirmations,
    allowDiscard: (value) => {
      discard = value;
    },
  };
}

test("opening a folder protects unsaved text; accepting clears the old file and its shell actions", async () => {
  const p = await page("full", true);
  await p.open("/work/notes.txt");
  p.node("ed").value = "unsaved text";
  p.state.dirty = true;
  p.allowDiscard(false);
  const viewer = p.node("viewer").innerHTML;
  await p.open("/work/folder/");
  assert.equal(p.confirmations.length, 1, "folder links ask before replacing the editor");
  assert.match(p.confirmations[0], /Discard unsaved changes/);
  assert.equal(p.node("viewer").innerHTML, viewer);
  assert.equal(p.node("ed").value, "unsaved text");
  assert.equal(p.state.file, "/work/notes.txt");
  assert.equal(p.state.dirty, true);
  p.allowDiscard(true);
  await p.open("/work/folder/");
  assert.equal(p.state.file, null);
  assert.equal(p.state.dirty, false);
  assert.equal(p.messages.at(-1).actions.length, 0);
  assert.equal(p.messages.at(-1).crumb, "");
  assert.equal(p.node("downloadFile").hidden, true);
});

test("standalone limited Files offers Download only after authorized selection; original binary bytes and filename survive", async () => {
  const p = await page();
  assert.equal(p.node("downloadFile").hidden, true);
  await p.open("/work/été + report.bin");
  assert.equal(p.node("downloadFile").hidden, false);
  await p.click();
  assert.equal(p.downloads.length, 1);
  assert.equal(p.downloads[0].name, "été + report.bin");
  assert.deepEqual(Buffer.from(await p.downloads[0].blob.arrayBuffer()), p.bytes);
  assert.equal(
    p.requests.find((r) => r.path.startsWith("/api/files/raw?")).path,
    "/api/files/raw?path=%2Fwork%2F%C3%A9t%C3%A9%20%2B%20report.bin",
  );
  assert.ok(p.requests.every((r) => r.method === "GET"));
  assert.ok(!p.messages.at(-1).actions.some((a) => a.id === "save"));
  p.timers.forEach((fn) => fn());
  assert.equal(p.blobs.size, 0);
});

test("full embedded Files declares Download and Save; download ignores unsaved editor bytes", async () => {
  const p = await page("full", true);
  await p.open("/work/report.txt");
  p.node("ed").value = "unsaved edit";
  assert.equal(p.node("filesAccess").hidden, true);
  assert.ok(p.messages.at(-1).actions.some((a) => a.id === "download"));
  assert.ok(p.messages.at(-1).actions.some((a) => a.id === "save"));
  await p.shellClick();
  assert.deepEqual(Buffer.from(await p.downloads[0].blob.arrayBuffer()), p.bytes);
  assert.ok(!p.requests.some((r) => r.path === "/api/files/write"));
});

test("authorization refusal after selection creates no download and reports failure", async () => {
  const p = await page();
  await p.open("/work/report.txt");
  p.denyRaw();
  await p.click();
  assert.equal(p.downloads.length, 0);
  assert.match(p.node("filesStatus").textContent, /Could not download/);
});

test("failed selection removes the previous download action instead of downloading the wrong file", async () => {
  const p = await page();
  await p.open("/work/report.txt");
  p.denyRead();
  await p.open("/elsewhere/denied.txt");
  assert.equal(p.node("downloadFile").hidden, true);
  await p.click();
  assert.equal(p.downloads.length, 0);
  assert.ok(!p.messages.at(-1).actions.some((a) => a.id === "download"));
});

for (const latestOK of [false, true])
  test(`latest selection wins over a late previous read; latest ok=${latestOK}`, async () => {
    const p = await page();
    p.deferReads();
    const a = p.open("/work/older.txt"),
      b = p.open("/work/latest.txt");
    p.pending[1]({ ok: latestOK, kind: "text", content: "latest", mtime: 2 });
    await b;
    p.pending[0]({ ok: true, kind: "text", content: "older", mtime: 1 });
    await a;
    assert.equal(p.state.file, latestOK ? "/work/latest.txt" : null);
    await p.click();
    assert.equal(p.downloads.length, latestOK ? 1 : 0);
    if (latestOK) assert.equal(p.downloads[0].name, "latest.txt");
  });
