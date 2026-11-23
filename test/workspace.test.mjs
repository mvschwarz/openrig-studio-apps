// Workspace: what the runtime reports is shown as text. The page's own script runs in a small stand-in DOM, against answers
// that carry markup, and nothing in them becomes an element. Copyright 2026 mvschwarz. Licensed under the Apache License,
// Version 2.0.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = fs.readFileSync(path.join(ROOT, "apps/workspace/app/workspace.html"), "utf8");
const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];

function element(tag) {
  const el = {
    tag,
    children: [],
    hidden: false,
    className: "",
    _text: "",
    _html: "",
    set textContent(v) {
      this._text = String(v);
      this.children = [];
    },
    get textContent() {
      return (
        this._text + this.children.map((c) => (typeof c === "string" ? c : c.textContent)).join("")
      );
    },
    set innerHTML(v) {
      this._html = String(v);
      this.children = [];
    },
    get innerHTML() {
      return this._html;
    },
    appendChild(c) {
      this.children.push(c);
      return c;
    },
    append(...c) {
      this.children.push(...c);
    },
    replaceChildren(...c) {
      this._text = "";
      this._html = "";
      this.children = c;
    },
  };
  return el;
}

test("the files root's path goes in as text: a path with markup in it is never parsed", async () => {
  const nodes = new Map();
  const $ = (sel) => {
    if (!nodes.has(sel)) nodes.set(sel, element(sel));
    return nodes.get(sel);
  };
  const hostile = "/home/x/<img src=x onerror=alert(1)>";
  const answers = {
    "/api/factory/state": { seats: [] },
    "/surfaces.json": { surfaces: [] },
    "/api/files/tree": { ok: true, path: hostile, dirs: [], files: [{ name: "a.md" }] },
    "/api/contract": {},
  };
  const ctx = vm.createContext({
    document: { querySelector: $, createElement: element },
    window: { open() {} },
    fetch: async (url) => ({ ok: true, status: 200, json: async () => answers[url] }),
  });
  vm.runInContext(script, ctx);
  await new Promise((r) => setTimeout(r, 20));
  const wspath = $("#wspath");
  assert.equal(wspath.innerHTML, "", "nothing was written as markup");
  assert.equal(wspath.textContent, `files root ${hostile}`);
  assert.equal(wspath.children[0].tag, "b", "the label is the page's own element");
  assert.equal(wspath.children[1], ` ${hostile}`, "the path is a plain string");
});
