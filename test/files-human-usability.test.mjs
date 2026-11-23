// Files, readable by people: the server never hands a binary file to the editor as text, and never saves text over one; a PDF
// opens in the browser's viewer; anything else unviewable offers Download; the tree keeps names readable. The #open=<place>
// contract is unchanged. Copyright 2026 mvschwarz. Licensed under the Apache License, Version 2.0.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import {
  filesRead,
  filesWrite,
  looksBinary,
  fileKind,
  mimeFor,
} from "../providers/studio-host/host-backend.mjs";

const tmpRoot = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "files-usable-")));
const PDF = Buffer.from(
  "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n",
  "latin1",
);
const DOCX = Buffer.concat([
  Buffer.from("PK\x03\x04\x14\x00\x06\x00", "latin1"),
  Buffer.alloc(64, 0),
  Buffer.from("word/document.xml"),
]);

test("a PDF is its own kind and comes back as a raw URL, never as text", () => {
  const root = tmpRoot(),
    f = path.join(root, "report.pdf");
  fs.writeFileSync(f, PDF);
  const r = filesRead(f, [root]);
  assert.equal(r.kind, "pdf");
  assert.equal(r.content, undefined);
  assert.match(r.raw, /^\/api\/files\/raw\?path=/);
  assert.equal(fileKind("a/B.PDF"), "pdf");
  assert.equal(mimeFor("x.pdf"), "application/pdf");
});

test('a small .docx (or any binary of an unknown type) stays "other" with a raw URL; a small text file of an unknown type is still text', () => {
  const root = tmpRoot();
  const docx = path.join(root, "fonts.docx");
  fs.writeFileSync(docx, DOCX);
  const r = filesRead(docx, [root]);
  assert.equal(r.kind, "other");
  assert.equal(r.content, undefined, "never the bytes as text");
  assert.match(r.raw, /^\/api\/files\/raw\?path=/);
  assert.equal(
    mimeFor("fonts.docx"),
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );
  const latin = path.join(root, "legacy.dat");
  fs.writeFileSync(latin, Buffer.from("caf\xe9 au lait", "latin1")); // not UTF-8, no NUL
  assert.equal(filesRead(latin, [root]).kind, "other");
  const plain = path.join(root, "Dockerfile");
  fs.writeFileSync(plain, "FROM node:22\nRUN echo héllo\n");
  assert.deepEqual(
    [filesRead(plain, [root]).kind, filesRead(plain, [root]).content],
    ["text", "FROM node:22\nRUN echo héllo\n"],
  );
});

test("looksBinary: a NUL or invalid UTF-8 is binary; a multibyte character cut at the 64 KB edge is not", () => {
  assert.equal(looksBinary(Buffer.from("a\x00b", "latin1")), true);
  assert.equal(looksBinary(Buffer.from([0x63, 0x61, 0x66, 0xe9])), true);
  assert.equal(looksBinary(Buffer.from("plain ✓ text")), false);
  const edge = Buffer.concat([Buffer.alloc(65535, 0x61), Buffer.from("é")]); // é's two bytes straddle the 64 KB edge
  assert.equal(looksBinary(edge), false);
  assert.equal(
    looksBinary(Buffer.from("ok \xc3", "latin1")),
    true,
    "a file that ENDS in a cut sequence is binary",
  );
});

test("CONTROL: saving text over a binary, a PDF or an image is refused and changes nothing (no backup written either)", () => {
  const root = tmpRoot();
  for (const [name, bytes] of [
    ["fonts.docx", DOCX],
    ["report.pdf", PDF],
    ["shot.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0])],
  ]) {
    const f = path.join(root, name);
    fs.writeFileSync(f, bytes);
    const mtime = fs.statSync(f).mtimeMs;
    assert.throws(
      () => filesWrite(f, "mojibake from a text view", mtime, [root]),
      (e) => e.notText === true && /isn't text/.test(e.message),
      name,
    );
    assert.deepEqual(fs.readFileSync(f), bytes, `${name}: bytes unchanged`);
  }
  assert.equal(
    fs.existsSync(path.join(root, ".files-backups")),
    false,
    "refused before any backup or write",
  );
  assert.throws(
    () => filesWrite(path.join(root, "new.pdf"), "text", null, [root]),
    (e) => e.notText === true,
    "a new .pdf is never written as text",
  );
  const md = path.join(root, "notes.md");
  fs.writeFileSync(md, "# a");
  assert.ok(filesWrite(md, "# b", fs.statSync(md).mtimeMs, [root]) > 0);
  assert.equal(fs.readFileSync(md, "utf8"), "# b", "text still saves");
});

test("binary content stays out of the editor and cannot be overwritten, even with a text extension or a long text prefix", () => {
  const root = tmpRoot();
  const early = Buffer.from([0x61, 0, 0xff, 0x62]);
  const lateNul = Buffer.concat([Buffer.alloc(16384, 0x61), Buffer.from([0])]);
  const lateInvalid = Buffer.concat([Buffer.alloc(70000, 0x61), Buffer.from([0xff])]);
  const cutAtEnd = Buffer.concat([Buffer.alloc(70000, 0x61), Buffer.from([0xc3])]);
  for (const [name, bytes] of [
    ["binary.txt", early],
    ["binary.md", early],
    ["binary.html", early],
    ["late-nul.dat", lateNul],
    ["late-invalid.dat", lateInvalid],
    ["late-invalid.txt", lateInvalid],
    ["unfinished-utf8.txt", cutAtEnd],
  ]) {
    const f = path.join(root, name);
    fs.writeFileSync(f, bytes);
    const read = filesRead(f, [root]);
    assert.equal(read.kind, "other", name);
    assert.equal(read.content, undefined, name);
    assert.throws(
      () => filesWrite(f, "replacement", fs.statSync(f).mtimeMs, [root]),
      (e) => e.notText === true,
      name,
    );
    assert.deepEqual(fs.readFileSync(f), bytes, name);
  }
  assert.equal(fs.existsSync(path.join(root, ".files-backups")), false);
  const f = path.join(root, "valid-utf8.txt"),
    text = "a".repeat(65535) + "é✓".repeat(2000);
  fs.writeFileSync(f, text);
  assert.equal(
    filesRead(f, [root]).content,
    text,
    "a UTF-8 character crossing a read chunk is preserved",
  );
  filesWrite(f, text + "\nupdated", fs.statSync(f).mtimeMs, [root]);
  assert.equal(
    fs.readFileSync(f, "utf8"),
    text + "\nupdated",
    "valid multibyte text remains writable",
  );
});

test("the raw route sends its own content type and nosniff; a refused save answers 415", () => {
  const src = fs.readFileSync(
    new URL("../providers/studio-host/host-server.mjs", import.meta.url),
    "utf8",
  );
  assert.match(
    src,
    /const base = \{\s*"content-type": f\.mime,\s*"x-content-type-options": "nosniff"/,
  );
  // sendFile puts the same headers on the 200 and the 206 (test/files-raw-guard.test.mjs checks both over HTTP).
  assert.match(src, /sendFile\(res, f\.path, base, req\.headers\.range\)/, "200 and 206 both");
  assert.match(src, /e\.notText \? 415 : 400/);
});

// ---- the page --------------------------------------------------------------------------------------------------------------
const html = fs.readFileSync(new URL("../apps/files/app/files.html", import.meta.url), "utf8");
async function page(read) {
  const nodes = new Map();
  const node = (id) => {
    if (!nodes.has(id))
      nodes.set(id, {
        hidden: false,
        innerHTML: "",
        textContent: "",
        value: "",
        style: { setProperty() {} },
        classList: { add() {}, remove() {}, contains: () => false },
        addEventListener() {},
        setAttribute() {},
        querySelectorAll: () => [],
      });
    return nodes.get(id);
  };
  const document = {
    getElementById: node,
    querySelectorAll: () => [],
    addEventListener() {},
    body: { appendChild() {} },
  };
  const window = { addEventListener() {}, postMessage() {} };
  const fetch = async (p) => ({
    status: 200,
    json: async () =>
      p === "/api/studio/place"
        ? { workspace: "files" }
        : p === "/api/files/roots"
          ? { roots: [] }
          : p.startsWith("/api/files/read?")
            ? read
            : {},
  });
  const ctx = vm.createContext({
    window,
    parent: window,
    document,
    fetch,
    URL,
    URLSearchParams,
    AbortSignal,
    location: { hash: "" },
    addEventListener() {},
    setInterval() {},
    clearInterval() {},
    clearTimeout() {},
    setTimeout() {},
    confirm: () => true,
    console,
  });
  await vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], ctx);
  return { node, open: (p) => window.__files.openFile(p) };
}

test("page: a PDF opens in the browser viewer (no sandbox, which would stop it rendering), with a Download fallback inside", async () => {
  const p = await page({
    ok: true,
    kind: "pdf",
    raw: "/api/files/raw?path=%2Fw%2Freport.pdf",
    mtime: 1,
  });
  await p.open("/w/report.pdf");
  const v = p.node("viewer").innerHTML;
  assert.match(
    v,
    /<object class="doc" type="application\/pdf" data="\/api\/files\/raw\?path=%2Fw%2Freport\.pdf"/,
  );
  assert.doesNotMatch(v, /sandbox/);
  assert.match(
    v,
    /This browser can&#39;t show the PDF here\..*class="or-btn btn dl-here">Download</s,
  );
});

test("page: a file it can't show says so with its name and a Download, never its bytes and never an editor", async () => {
  const p = await page({
    ok: true,
    kind: "other",
    raw: "/api/files/raw?path=%2Fw%2Ffonts.docx",
    mtime: 1,
  });
  await p.open("/w/fonts.docx");
  const v = p.node("viewer").innerHTML;
  assert.match(
    v,
    /class="noview" role="status"><p class="fname">fonts\.docx<\/p><p>This file can&#39;t be previewed here\. Download it to open it on your computer\.<\/p>/,
  );
  assert.doesNotMatch(v, /<textarea|no viewer for this type/);
});

test("page: rows carry no per-row icon, names wrap instead of being cut, indent is smaller, and the folder column can be resized", () => {
  assert.doesNotMatch(html, /class="ic" aria-hidden="true">\$\{ICONS|const ICONS/);
  assert.doesNotMatch(html, /<span class="ic" aria-hidden="true">▦<\/span>/);
  const after = html.slice(html.indexOf("files-page/files.css")); // these rules must come AFTER the theme to win
  assert.match(after, /\.kids \{ margin-left:8px; \}/);
  assert.match(
    after,
    /\.node \.name \{ overflow:visible; text-overflow:clip; overflow-wrap:anywhere; \}/,
  );
  assert.match(after, /grid-template-columns:var\(--rail-w, 280px\) 6px minmax\(0,1fr\)/);
  assert.match(
    html,
    /<div id="railGrip" role="separator" aria-orientation="vertical" aria-label="Resize the folder column" tabindex="0"><\/div>/,
  );
});

test('page: the #open= contract still opens a file by place, and a place ending in "/" reveals that folder', () => {
  assert.match(html, /addEventListener\("hashchange", openFromHash\)/);
  assert.match(
    html,
    /const p = pathOfPlace\(want, d\.roots\);\n\s*if \(p\) openFile\(p, null\);/,
    "the pinned file contract, unchanged",
  );
  assert.match(
    html,
    /if \(typeof p === "string" && p\.endsWith\("\/"\)\) \{[\s\S]*?return revealOrSay\(p, version\);/,
    "a folder place (or absolute folder path) reveals the folder",
  );
  assert.match(
    html,
    /const folder = want\.endsWith\("\/"\)/,
    'a trailing "/" no longer fails the place check',
  );
});

test("page: opening a file moves focus off a folder a folder link focused, so only one row looks current", () => {
  const src = html.match(/  function setActive\(el\) \{[\s\S]*?\n  \}\n/)[0];
  const row = (name) => {
    const cls = new Set(["node"]);
    const r = {
      name,
      classList: {
        add: (c) => cls.add(c),
        remove: (c) => cls.delete(c),
        contains: (c) => cls.has(c),
        has: (c) => cls.has(c),
      },
      isConnected: true,
      closest: (q) => (q === "#tree" ? {} : null),
      focus() {
        doc.activeElement = r;
      },
      blur() {
        if (doc.activeElement === r) doc.activeElement = null;
      },
    };
    return r;
  };
  const folder = row("app"),
    file = row("page.tsx"),
    rows = [folder, file];
  const doc = {
    activeElement: null,
    querySelectorAll: (q) =>
      rows.filter((r) =>
        q === ".node.on"
          ? r.classList.contains("on")
          : q === ".node.kbd"
            ? r.classList.contains("kbd")
            : false,
      ),
  };
  const setActive = new Function("document", src + "; return setActive;")(doc);
  setActive(folder);
  folder.focus();
  folder.classList.add("kbd");
  assert.equal(doc.activeElement, folder);
  setActive(file);
  assert.equal(doc.activeElement, file, "focus follows the row now open");
  assert.ok(
    file.classList.contains("on") &&
      !folder.classList.contains("on") &&
      !folder.classList.contains("kbd"),
  );
  file.focus();
  setActive(null);
  assert.equal(doc.activeElement, null, "with no row open, a tree row keeps no focus ring");
  const outside = { classList: { contains: () => false } };
  doc.activeElement = outside;
  setActive(file);
  assert.equal(
    doc.activeElement,
    outside,
    "focus elsewhere (the editor, a search box) is never taken",
  );
});
